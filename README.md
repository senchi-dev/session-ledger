# Session Ledger

A minimalist, local-first trading journal. Every entry carries a fixed pre-session read (written before 9:30) and a four-question post-session review, so bias accuracy can be measured over time. Log trades and no-trade days, attach chart screenshots, and get R-based statistics: expectancy, win rate, profit factor, drawdown, equity curve, P&L calendar, and breakdowns by weekday, daily profile, entry time, rule adherence and mistakes.

**Local first, with an optional cloud copy.** Entries and screenshots are written to IndexedDB on the device you use, so the journal works offline. Sign in from *Settings → Cloud sync* and every change is also copied to your own Supabase project (Postgres plus a private storage bucket), protected by row-level security so only your account can read it. *Settings → Export full backup* still gives you a file you hold yourself.

To set up the cloud copy: run `supabase-setup.sql` in the Supabase SQL editor, set the project URL and publishable key in `CLOUD_CFG` at the top of `app.js`, and add the site address under *Authentication → URL Configuration*.

Plain HTML, CSS and JavaScript, with no build step; the only dependency is the Supabase client, loaded from a CDN. Open `index.html` through any static host (GitHub Pages works).

Shortcuts: `N` new entry · `⌘/Ctrl + S` save · `⌘/Ctrl + V` paste a screenshot into an entry.
