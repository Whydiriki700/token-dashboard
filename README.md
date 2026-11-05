# Token Dashboard

**See what your agent actually costs, while it works.**

A Hermes Desktop plugin that turns token usage into a live cost dashboard: a right-hand pane with totals, a per-model breakdown, and your most recent sessions, plus a status bar chip that keeps the running cost of the focused session always visible.

## Features

* Live totals for input tokens, output tokens, and estimated cost across your recent sessions (last 50 via the Desktop host API)
* Per-model breakdown, so you can see which model is eating the budget
* Recent sessions list (10) with per-session token and cost figures
* Status bar chip showing the focused session's usage, with a tooltip and click notification
* Auto-refresh every 10 seconds

## Pricing

Costs are estimated from a built-in per-model price table (USD per 1M tokens) covering gpt-4o, gpt-4o-mini, claude-3.5-sonnet, claude-3-opus, deepseek-v3, gemini-1.5-pro, and gemini-1.5-flash, with a default rate for anything else. Prices are approximate and marked as such in the code; treat the figures as budgeting guidance, not billing records.

Model matching is longest-key-first, so `gpt-4o-mini` sessions are priced at mini rates, not full gpt-4o rates.

## Install

```bash
hermes plugins install token-dashboard --enable
```

Then reload plugins in Hermes Desktop (Settings, Plugins, Reload). The dashboard appears as a right pane and the cost chip in the right side of the status bar.

For local development, the standalone `desktop/plugin.js` can also be dropped into your Hermes `desktop-plugins/token-dashboard/` folder.

## Disclosure

The plugin reads session usage data through the Desktop host API (`sessions.list` and the focused-session usage state) and renders it locally. It makes no network calls, stores nothing, and sends nothing anywhere.

## License

MIT
