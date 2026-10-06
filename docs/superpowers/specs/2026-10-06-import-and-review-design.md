# MT5 import, review pages, rule versions and FTMO tracker

## Goal
Cut manual logging to the read, the timeline and the review, and turn the data into decisions.

## MT5 import (`import.js`)
- Input: the HTML history report from MT5 desktop (History → Report → HTML), UTF-16, any language.
  Rows are classified by width: positions 14 cells, orders 11, deals 15.
- Each position becomes a trade: entry, stop as first placed (from the opening order, used for R),
  size, P&L (profit + commission + swap), time converted from server time (ET + 7 h) to New York.
- Closing deals give partials: the deal at the position's close time is the last exit; earlier deals
  in the window fill the remaining volume. One deal → single exit price; several → exits list.
- Stop handling compares the stop as placed with the final stop: held, moved closer, break-even,
  trailed, moved away (moved away also tags the "Moved stop away" mistake).
- Deduplication by MT5 position number. A trade logged by hand (same day, instrument, side, entry
  within 0.01%) is updated with MT5's numbers; its read, mistakes and review are kept.
- The preview lets any position be skipped (expert-advisor trades, scratches).
- The report's balances give an FTMO snapshot: balance, balance at the start of the FTMO day, trading days.

## Review (`review.js`)
- Rule versions: a version starts on a date; sessions belong to the version in effect on their date.
  Recorded from the playbook, the weekly review or the checkpoint. Dashboard filter by version.
- Weekly review (`#review/week/<monday>`): KPIs, sessions, mistakes, invalidations, lessons, one change.
- Checkpoint (`#review/checkpoint/<version>`): expectancy with ±2 SE range, followed vs broken,
  weakest part of the read, costliest mistakes, best and worst splits (≥10 trades), failure signs,
  one change. Dashboard banner every 20 sessions of the active version.
- FTMO tracker on the dashboard from the last import: balance, target by phase, room before the
  daily and overall floors, trading days. Closed trades only.

## Not in scope
Automatic sync from MT5 (expert advisor); scratch handling (not a practice any more).
