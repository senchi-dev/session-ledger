#!/usr/bin/env python3
"""Read-only MT5 bridge for the Session Ledger.

Runs on your Mac, reads the deals of one electronic trading day from the MetaTrader 5 app that is already
open and logged in, and hands them to the Ledger page as trades. It never sends orders, never modifies a
position, and never returns the account number or balance.

    GET /ping                    -> {"ok": true}
    GET /trades?date=YYYY-MM-DD  -> the trades of the trading day that ENDS on that date

A trading day runs from the 18:00 ET candle of the evening before to the 16:00 ET candle of the date asked.
Positions opened at the same moment (the EA splits one trade into two sizes) come back as one trade.
"""
import json
import os
import signal
import sys
import threading
import time
from types import SimpleNamespace
from datetime import date as Date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import mt5_mac as mt5

PORT = 8765
ALLOWED_ORIGINS = {'https://senchi-dev.github.io', 'http://127.0.0.1:8812', 'http://localhost:8812'}
ALLOWED_HOSTS = {f'127.0.0.1:{PORT}', f'localhost:{PORT}'}
SERVER_TO_ET_H = 7            # FTMO server time runs 7 hours ahead of New York, all year
SAME_MOMENT_S = 2             # positions opened within 2 seconds of each other are one trade
MT5_TIMEOUT_S = 25            # MT5 never takes this long unless the bridge is talking to a dead MT5 session
LOCK = threading.Lock()
_ready = False
_term_pid = None              # the MT5 terminal process the current connection belongs to


def terminal_pid():
    """PID of the running MT5 terminal (Wine process), or None when MT5 is closed."""
    for line in os.popen('pgrep -f "Program Files.MetaTrader 5.terminal64.exe"'):
        try:
            return int(line)
        except ValueError:
            pass
    return None


def ensure_mt5():
    global _ready, _term_pid
    if not _ready:
        _term_pid = terminal_pid()
        if _term_pid is None or not mt5.initialize():
            raise RuntimeError('MetaTrader 5 is not reachable: open the app and log in to your account')
        _ready = True
    if mt5.account_info() is None:       # connected to a terminal that is not logged in (or a dead one): never return an empty day
        raise RuntimeError('MetaTrader 5 is not logged in to your account')


def raw(action, key, lo, hi):
    """The library's own deal/order objects drop MT5's position id, so read the agent's reply as it is."""
    res = mt5._backend._send({'action': action, 'from': lo, 'to': hi}) or {}
    return [SimpleNamespace(**r) for r in (res.get(key) or [])]


def server_dt(ts):            # deal times are server wall-clock seconds
    return datetime.utcfromtimestamp(ts)


def et_of(ts):
    return server_dt(ts) - timedelta(hours=SERVER_TO_ET_H)


def stop_move(direction, entry, first, last):
    """How the stop moved between placement and close, seen from the trade's direction."""
    if first is None or last is None or entry is None:
        return ''
    tol = max(0.01, abs(entry - first) * 0.02)
    sgn = 1 if direction == 'long' else -1
    if abs(last - first) <= tol:
        return 'held'
    if (last - first) * sgn < 0:
        return 'widened'
    vs_entry = (last - entry) * sgn
    return 'be' if abs(vs_entry) <= tol else 'trailed' if vs_entry > 0 else 'tightened'


def comment_price(comment):
    """'[sl 27800.5]' / '[tp 27900]' -> the price in the broker's comment."""
    try:
        return float(comment.split(' ', 1)[1].rstrip(']'))
    except (IndexError, ValueError, AttributeError):
        return None


def trading_day_window(day):
    """Server-time bounds of the trading day that ends on `day` at 16:00 ET."""
    start_et = datetime.combine(day - timedelta(days=1), datetime.min.time()).replace(hour=18)
    end_et = datetime.combine(day, datetime.min.time()).replace(hour=16)
    epoch = datetime(1970, 1, 1)
    to_server = lambda et: int((et + timedelta(hours=SERVER_TO_ET_H) - epoch).total_seconds())
    return to_server(start_et), to_server(end_et)


def positions_of(deals, orders, still_open):
    by_pos = {}
    for d in deals:
        if d.type in (0, 1) and d.position_id:        # buy / sell deals; balance rows have no position
            by_pos.setdefault(d.position_id, []).append(d)
    out = []
    for pid, ds in by_pos.items():
        ins = sorted((d for d in ds if d.entry == 0), key=lambda d: d.time_msc)
        outs = sorted((d for d in ds if d.entry in (1, 3)), key=lambda d: d.time_msc)
        if not ins:
            continue
        vol = sum(d.volume for d in ins)
        order = orders.get(ins[0].order)
        sl = order.sl if order and order.sl else None
        tp = order.tp if order and order.tp else None
        out.append({
            'pid': pid, 'dir': 'long' if ins[0].type == 0 else 'short', 'symbol': ins[0].symbol,
            'at': ins[0].time, 'volume': vol, 'open': sum(d.price * d.volume for d in ins) / vol,
            'sl': sl, 'tp': tp, 'outs': outs, 'still_open': pid in still_open,
            'pnl': sum(d.profit + d.commission + d.swap + d.fee for d in ds),
        })
    return sorted(out, key=lambda p: p['at'])


def merge_same_moment(positions):
    groups = []
    for p in positions:
        for g in groups:
            if g[0]['symbol'] == p['symbol'] and g[0]['dir'] == p['dir'] and abs(p['at'] - g[0]['at']) <= SAME_MOMENT_S:
                g.append(p)
                break
        else:
            groups.append([p])
    return groups


def exit_why(d, is_last, move, partial):
    if d.reason == 4:                                      # stop loss hit
        return 'Trailed out' if move == 'trailed' else 'Break-even stop' if move == 'be' else 'Stopped out'
    if d.reason == 5:                                      # take profit hit
        return 'Partial at target' if partial or not is_last else 'Final target'
    return 'Manual'


def trade_of(group):
    first = group[0]
    vol = sum(p['volume'] for p in group)
    entry = sum(p['open'] * p['volume'] for p in group) / vol
    sl_list = [p['sl'] for p in group if p['sl'] is not None]
    stop = sl_list[0] if sl_list else None
    tp_list = [p['tp'] for p in group if p['tp'] is not None]
    outs = sorted((d for p in group for d in p['outs']), key=lambda d: d.time_msc)

    # the same exit hit by both halves (one second apart, same price) is one exit
    merged = []
    for d in outs:
        m = merged[-1] if merged else None
        if m and abs(m['price'] - d.price) < 1e-9 and d.time - m['time'] <= SAME_MOMENT_S and m['reason'] == d.reason:
            m['volume'] += d.volume
        else:
            merged.append({'price': d.price, 'volume': d.volume, 'time': d.time, 'reason': d.reason, 'comment': d.comment, 'deal': d})
    last_stop = next((comment_price(m['comment']) for m in reversed(merged) if m['reason'] == 4), None)
    move = stop_move(first['dir'], entry, stop, last_stop if last_stop is not None else stop)
    closed = not any(p['still_open'] for p in group)

    exits = []
    for i, m in enumerate(merged):
        is_last = i == len(merged) - 1
        exits.append({'pct': round(m['volume'] / vol * 100, 2), 'price': m['price'],
                      'why': exit_why(m['deal'], is_last, move, partial=len(merged) > 1 and not is_last)})
    single = len(exits) == 1 and abs(exits[0]['pct'] - 100) < 0.5
    et = et_of(first['at'])
    return {
        'mt5': '+'.join(str(p['pid']) for p in group),
        'date': et.strftime('%Y-%m-%d'), 'time': et.strftime('%H:%M'),
        'instrument': first['symbol'], 'dir': first['dir'], 'entryTf': '',
        'entry': round(entry, 5), 'stop': stop if stop is not None else '', 'target': tp_list[0] if tp_list else '',
        'exit': exits[0]['price'] if single else '', 'exits': [] if single or not exits else exits,
        'size': round(vol, 2), 'pnl': round(sum(p['pnl'] for p in group), 2) if closed else '',
        'stopMgmt': move, 'closedBy': exits[-1]['why'] if exits and closed else '',
        'open': not closed, 'parts': len(group),
    }


class MT5Stuck(RuntimeError):
    pass


def restart_self():
    """MT5 was restarted under a running bridge and the old session never answers again: start over clean."""
    time.sleep(1)                                    # let the error reply go out first
    for line in os.popen(f'pgrep -P {os.getpid()}'):  # the Wine agent is our child
        try:
            os.kill(int(line), signal.SIGKILL)
        except (ValueError, OSError):
            pass
    os.execv(sys.executable, [sys.executable] + sys.argv)


def watch_terminal():
    """A bridge left running across an MT5 restart keeps talking to the dead session and answers with empty days."""
    while True:
        time.sleep(5)
        if _ready and terminal_pid() != _term_pid:
            restart_self()


def fetch_mt5(day, out):
    try:
        ensure_mt5()
        lo, hi = trading_day_window(day)
        # fetch a little wider, then cut on the exact opening time
        deals = raw('history_deals', 'deals', lo - 6 * 3600, hi + 6 * 3600)
        orders = {o.ticket: o for o in raw('history_orders', 'orders', lo - 6 * 3600, hi + 6 * 3600)}
        still_open = {p.ticket for p in (mt5.positions_get() or [])}
        out['res'] = (lo, hi, deals, orders, still_open)
    except Exception as e:
        out['err'] = e


def trades_for(day):
    out = {}
    with LOCK:
        t = threading.Thread(target=fetch_mt5, args=(day, out), daemon=True)
        t.start()
        t.join(MT5_TIMEOUT_S)
        if t.is_alive():
            threading.Thread(target=restart_self, daemon=True).start()
            raise MT5Stuck('MetaTrader 5 did not answer (it was probably restarted). The bridge is restarting itself: try again in a few seconds')
    if 'err' in out:
        raise out['err']
    lo, hi, deals, orders, still_open = out['res']
    in_window = lambda p: lo <= p['at'] < hi
    positions = [p for p in positions_of(deals, orders, still_open) if in_window(p)]
    return [trade_of(g) for g in merge_same_moment(positions)]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write('[bridge] ' + fmt % args + '\n')

    def _cors(self):
        origin = self.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _allowed(self):
        origin = self.headers.get('Origin')
        return self.headers.get('Host') in ALLOWED_HOSTS and (origin is None or origin in ALLOWED_ORIGINS)

    def do_OPTIONS(self):
        if not self._allowed():
            return self._send(403, {'error': 'forbidden'})
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if not self._allowed():
            return self._send(403, {'error': 'forbidden'})
        url = urlparse(self.path)
        if url.path == '/ping':
            return self._send(200, {'ok': True})
        if url.path == '/trades':
            try:
                day = Date.fromisoformat(parse_qs(url.query).get('date', [''])[0])
            except ValueError:
                return self._send(400, {'error': 'date must be YYYY-MM-DD'})
            try:
                return self._send(200, {'date': day.isoformat(), 'trades': trades_for(day)})
            except Exception as e:                                      # MT5 closed, not logged in, Wine hiccup
                global _ready
                _ready = False
                return self._send(503, {'error': str(e)})
        self._send(404, {'error': 'not found'})


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=watch_terminal, daemon=True).start()
    print(f'MT5 bridge on http://127.0.0.1:{PORT} (read-only). Keep this window open; Ctrl+C stops it.', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if _ready:
            mt5.shutdown()
