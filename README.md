# Token Dashboard

**See what your focused session actually costs, while it works.**

A Hermes Desktop plugin that turns the live usage stream into a cost dashboard: a right-hand pane with the focused session's token counts, estimated cost, model, API calls, and context usage, a status bar chip that keeps the running session cost always visible, and an overview of your recent sessions.

## Features

* Live input and output token counts for the focused session, streamed from the backend (no polling of usage data)
* Session cost: uses the backend-reported `cost_usd` when available, otherwise estimates from the built-in price table and labels the figure as an estimate
* Context usage bar for the focused session
* Status bar chip with the focused session's token total, tooltip detail, and click notification
* Recent sessions overview (title, start time, message count) refreshed every 10 seconds

## An honest note on scope

Hermes does not expose per-session token history: the `session.list` RPC returns session metadata (title, start time, message count) with no token or model fields. Token figures in this plugin therefore describe the **focused session**, which is the data Hermes actually provides, and past sessions are listed with their message counts rather than invented token totals.

## Pricing

Estimates use a built-in per-model price table (USD per 1M tokens) covering gpt-4o, gpt-4o-mini, claude-3.5-sonnet, claude-3-opus, deepseek-v3, gemini-1.5-pro, and gemini-1.5-flash, with a default rate for anything else. Prices are approximate; treat estimated figures as budgeting guidance, not billing records.

Model matching is longest-key-first, so `gpt-4o-mini` sessions are priced at mini rates, not full gpt-4o rates.

## Reliability details

* Session list requests never overlap: if the gateway is cold-spawning a profile backend (which can make `session.list` slow), the pane shows an "unavailable" note instead of stacking requests, and error logging is throttled to the first failure in a streak.

## Install

```bash
hermes plugins install token-dashboard --enable
```

Then reload plugins in Hermes Desktop (Settings, Plugins, Reload). The dashboard appears as a right pane and the cost chip in the right side of the status bar.

For local development, the standalone `desktop/plugin.js` can also be dropped into your Hermes `desktop-plugins/token-dashboard/` folder.

## Disclosure

The plugin reads the focused session's usage state and the session list through the Desktop host API and renders them locally. It makes no network calls of its own, stores nothing, and sends nothing anywhere.

## License

MIT
