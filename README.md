# Session Ledger

A minimalist, local-first trading journal. Every entry carries a fixed pre-session read (written before 9:30) and a four-question post-session review, so bias accuracy can be measured over time. Log trades and no-trade days, attach chart screenshots, and get R-based statistics: expectancy, win rate, profit factor, drawdown, equity curve, P&L calendar, and breakdowns by weekday, daily profile, entry time, rule adherence and mistakes.

**Your data never leaves your browser.** Entries and screenshots are stored in IndexedDB on the device you use. This repository only contains the app code. Use *Settings → Export full backup* regularly, and *Import backup* to move to another browser or device.

Plain HTML, CSS and JavaScript, with no build step and no dependencies. Open `index.html` through any static host (GitHub Pages works).

Shortcuts: `N` new entry · `⌘/Ctrl + S` save · `⌘/Ctrl + V` paste a screenshot into an entry.
