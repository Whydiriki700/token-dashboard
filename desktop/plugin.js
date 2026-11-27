/**
 * Hermes Desktop Plugin: Token Cost & Usage Dashboard
 * Live token usage and cost for the focused session, plus a session overview.
 * Hackathon entry - usefulness, reliability, creativity.
 *
 * Data sources (verified against the Hermes Desktop SDK and gateway):
 * - host.state.focusedUsage: live UsageStats for the focused session
 *   ({ model, input, output, reasoning, total, calls, context_percent,
 *      cost_usd? }). Streamed by the backend, no RPC needed.
 * - host.request('session.list', { limit }): session rows ({ id,
 *   resolved_id?, title, preview, started_at, message_count, source,
 *   _lineage_root_id }). Rows carry NO token or model fields, so this pane
 *   never invents per-session token totals; token figures describe the
 *   focused session only. The focused row's `started_at` (time since the
 *   session started — Hermes does not track cumulative active time) feeds
 *   the live session elapsed-time readout, matched against
 *   host.state.focusedSessionId / focusedStoredSessionId the way the desktop
 *   resolves a session itself (sessionMatchesStoredId): a row is the focused
 *   one when its id, the id a compressed conversation resolved to or its
 *   lineage root is either; the runtime id wins, the stored id is the
 *   fallback.
 * - host.request('session.transcript', { session_id, cursor, limit, order }):
 *   the session's stored transcript rows in display order, newest page first
 *   (order 'latest'; `next_cursor` names the page before). A row is the
 *   gateway's own display projection: { role, text, timestamp (epoch
 *   seconds), row_id, display_kind? }. Turn time is read from these
 *   timestamps alone; the pane's own clock never enters a reading.
 * - host.request('process.list' | 'subagent.list', { session_id }): the
 *   focused session's own background processes ({ status, started_epoch,
 *   exited_at }) and subagents ({ status, started_at }). Work a task handed
 *   to them keeps the task open after the chat itself stops streaming.
 * - host.request('session.info', { session_id }): session snapshot incl.
 *   reasoning_effort / reasoning_effort_wire — the configured thinking
 *   depth and the value the route actually accepts — and turn_started_at,
 *   the epoch seconds the current turn began (null once idle). The gateway
 *   pins it at the turn's first prompt and keeps it in memory: mid-task
 *   guidance is appended to the turn, never started as a new one, and a
 *   context compaction cannot displace it. It backs the turn timer whenever
 *   no prompt row is known.
 * - host.state.busy: true from the moment a prompt is submitted until its
 *   turn ends. It flips before the prompt's row is stored (the submit round
 *   trip can take seconds under load), so a new task's start waits for its
 *   own row instead of adopting the newest one on sight.
 * - host.request('session.context_breakdown', { session_id }): the gateway's
 *   estimate of the focused session's context, read while the live usage
 *   carries no context_percent and the pane is not busy — when the pane
 *   opens on a session, when the focused session changes and when a turn
 *   ends. With a resident agent
 *   it carries that agent's window (context_max) and share (context_percent,
 *   with context_estimated true while the share is estimated rather than
 *   measured); with no resident agent — a session not run since the gateway
 *   started, or an idle one's agent reaped — context_max is 0 and
 *   estimated_total is the count the session's frozen system prompt, tools
 *   and stored transcript add up to, its window unknown. A session outside
 *   the gateway's live table is refused (not_found). Read-only: no provider
 *   call and no prompt-cache impact.
 * - ctx.storage: the compression threshold the user entered for this plugin
 *   (compression.threshold of config.yaml, the same figure: 0.7, or 70 for
 *   70%) and, when one is given, the reserved output (a runtime `max_tokens`
 *   override, not a config.yaml key). The gateway offers a plugin no getter
 *   for the compression settings: its keyed config.get answers a fixed table
 *   of keys, none of them compression's, and the only call that reaches
 *   them is key 'full' — the whole user config, API keys and all — which
 *   this plugin does not pull. So the stored figure is the only source of
 *   the mark on the context bar, which stands where the gateway's threshold
 *   arithmetic puts the trigger from it.
 *   Per-model overrides, the threshold_tokens cap, the summariser model's
 *   window, output a route reserves by itself and whether compression is
 *   on are not read here, so the mark is an estimate of the trigger. The
 *   SDK's `host` export carries no storage — register(ctx) hands the pane
 *   ctx.storage as a prop.
 */

import { cn, host, Tip, usePluginI18n, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect, useRef } from 'react'

const ID = 'token-dashboard'

// Pricing per 1M tokens (approximate, USD)
const PRICING = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-3.5-sonnet': { input: 3, output: 15 },
  'claude-3-opus': { input: 15, output: 75 },
  'deepseek-v3': { input: 0.27, output: 1.1 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'default': { input: 1, output: 3 }
}

function getModelPricing(model) {
  const m = (model || '').toLowerCase()
  // Longest key first: 'gpt-4o-mini' must win over 'gpt-4o', otherwise
  // substring matching prices mini sessions at the full gpt-4o rate.
  const keys = Object.keys(PRICING)
    .filter(k => k !== 'default')
    .sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (m.includes(key)) return PRICING[key]
  }
  return PRICING['default']
}

function calcCost(model, inputTok, outputTok) {
  const p = getModelPricing(model)
  return (inputTok * p.input + outputTok * p.output) / 1e6
}

function fmt(n) { return (n || 0).toLocaleString() }
function fmtCost(n) { return '$' + (n || 0).toFixed(4) }

// `started_at`/`timestamp` are epoch seconds everywhere in the gateway
// today; tolerate a millisecond emitter rather than mis-render it as a
// date far in the future.
function toEpochMs(ts) { return ts > 1e12 ? ts : ts * 1000 }

function fmtTime(epochSec) {
  if (!epochSec) return ''
  const d = new Date(toEpochMs(epochSec))
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Clock time of an epoch-milliseconds instant, for a reading's tooltip.
function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Humanized elapsed time. Accepts milliseconds; returns an em dash for
// unknown/negative values so callers can render "—" instead of "NaNs".
function fmtDuration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n) => String(n).padStart(2, '0')
  if (d > 0) return d + 'd ' + h + 'h'
  if (h > 0) return h + 'h ' + pad(m) + 'm'
  if (m > 0) return m + 'm ' + pad(s % 60) + 's'
  return s + 's'
}

// Ticking clock so a duration readout re-renders without waiting for the
// 10-second session-list refresh. One interval per pane, cleaned up on
// unmount like every other effect here.
function useNow(intervalMs) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

// ---- Turn time: one task, from its prompt to its real end ---------------------
// A task starts with a prompt the user typed and ends when the session is next
// fully idle: the chat is not streaming AND none of its background processes or
// subagents is still running. Everything in between belongs to it and never
// moves its start — tool calls, interim replies, mid-task guidance (stored with
// display_kind 'steer'), a prompt queued behind the running turn (its row, as
// accepted, carries the gateway's queued mark and is never a start), context
// compaction, work handed to background processes and subagents, and the turns
// their completions trigger — as does a turn the queue starts straight behind
// a task. Only a prompt the user typed once the task was over starts the next
// one. Both ends are stored row timestamps — or the gateway's own turn
// start, when no prompt row is in reach — and no reading depends on when
// this pane was opened, once the start is the task's own prompt: only a
// pane that arrives mid-task estimates it. Arriving mid-task, the pane
// times the task from the newest prompt stored when it was filed for the
// running turn, or from the gateway's turn start in its place — for up to
// TASK.provisionalMs, should that prompt still be landing or lie beyond the
// newest page; TASK.landingGraceMs once it already times from a prompt of
// the turn. The task's own prompt replaces the turn start while it lands
// in time. Should none land, the task keeps the turn start — unless the
// transcript shows the backend opening the turn (TASK.backendTurnKinds): a
// turn that goes on with the task already running, which continues from the
// newest prompt stored. A prompt the gateway queued behind a running turn
// is stored a second time, unmarked and with a fresh timestamp, once its
// own turn begins — that row, not the moment it was typed, is where its
// task starts. A task that stored nothing to time reads '—'.

// Poll schedules only decide when to look again; they are never part of a reading.
const TASK = {
  tickMs: 1000, // live readout cadence
  tailRows: 40, // rows of the newest page a poll reads
  pageRows: 500, // session.transcript page cap, for the prompt search
  pageMax: 20, // pages walked back for the newest task prompt, while none is known
  landingRetryMs: [150, 400, 800, 1500, 2500, 4000, 6000],
  // The submit → stored round trip can take seconds under load. Also the
  // row-time tolerance around a known turn start, and before an epoch's
  // opening, for a prompt to count as the task's own; an arrival without a
  // turn start — or with the turn start standing in for the prompt — waits
  // the whole provisional window instead.
  landingGraceMs: 6000,
  // A start adopted with nothing to compare against (the previous task's
  // prompt, or the gateway's turn start) is not taken up before this long —
  // the previous reading stands while a new task's own prompt may still be
  // landing; on arrival there is none, and the gateway's turn start stands
  // in from the first read — and it stays correctable only within it: the
  // prompt that opened the task may still be landing or only reached by the
  // search, and its own stored time replaces the estimate while it lands in
  // time, the read that closes the window included. Past it a later prompt
  // no longer moves the start — the task keeps the one it has: the turn
  // start, or the newest prompt stored where the backend opened the turn.
  provisionalMs: 15000,
  // The display kinds of the rows the gateway stores as the backend opens a
  // turn of its own — a process or delegation completion, a notification, an
  // auto-continuation — right behind that turn's start. Proof that a turn
  // without a prompt in reach goes on with the task already running, and
  // so that the task continues from the newest prompt stored. Not the
  // whole of it: a turn the backend starts on its own without one of these
  // kinds — a heartbeat tick, a loop or goal follow-up — is stored as a
  // plain prompt, and reads as one.
  backendTurnKinds: new Set(['process_complete', 'async_delegation_complete', 'auto_continue', 'internal_notification']),
  queueWindowMs: 5000, // a turn opening this close behind a task's end continues it
  settleRetryMs: [500, 1500, 3000],
  confirmRetryMs: [700, 2000, 5000], // re-reads after a task settles, for a final row stored behind the idle flip
  bgPollMs: 5000, // chat idle, background work still running
  idlePollMs: 15000,
  // A gateway read the pane waits on is given up after this long, like a
  // failed one — the host's own per-request timeout, so a slow backward
  // search is never cut short.
  readTimeoutMs: 30000,
  listStallMs: 30000 // a session.list pending longer than this holds back neither a flip nor the 10s tick
}

// Milliseconds until the first retry time still ahead of `elapsedMs`, else null.
function untilRetry(schedule, elapsedMs) {
  for (const at of schedule) {
    if (at > elapsedMs) return at - elapsedMs
  }
  return null
}

function rowMs(row) {
  return row && typeof row.timestamp === 'number' && row.timestamp > 0 ? toEpochMs(row.timestamp) : null
}

function rowText(row) {
  const value = row?.text ?? row?.content
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
  return ''
}

// Prompts the gateway writes itself in the user role — known by their
// opening words, for the rows its display projection leaves untyped. The
// openings are the gateway's own scaffolding list
// (agent/context_compressor.py::_SYNTHETIC_USER_ROW_PREFIXES), its process,
// async and compaction notices, the cron and /reload-mcp notices
// (cron/scheduler_prompt.py, gateway/run_turn.py), every row that opens
// with "[System note:" — the interrupted-turn recovery
// (tui_gateway/session_auto_continue.py), the language-server verdict
// filed behind a turn (agent/turn_stop_gates.py), the onboarding notes; a
// list the gateway keeps adding to, so those rows are known by the two
// words and not one opening at a time — and the re-prompts of
// session_rules/turns.py.
// The task list it re-injects after every context compaction matters most:
// that row is stored untyped (no display_kind) at the compaction moment, so
// without this test it reads as a prompt the user typed right then and
// re-dates the running task. A skill the user invoked also opens with
// "[IMPORTANT: …" — its row's own kind marks it as theirs, and it does
// start a task. A prompt of the user's that merely begins with a bracket
// ("[16:01:57] …", pasted JSON) matches none of these and stays a prompt;
// one that opens with these very words is not told apart and reads as the
// gateway's — words a person is unlikely to type first.
const SYNTHETIC_PROMPT = /^\s*(?:\[System:|\[CONTEXT (?:COMPACTION|SUMMARY)|\[PRIOR CONTEXT|\[IMPORTANT: Background|\[IMPORTANT: \d+ background subagent delegations completed|\[IMPORTANT: MCP servers have been reloaded\.|\[IMPORTANT: You are running as a scheduled cron job\.|\[IMPORTANT: \d+ background process results arrived|\[IMPORTANT: \d+ background processes completed|\[Your active task list|\[Planning state preserved|\[ASYNC (?:DELEGATION|COMPLETE\b|BATCH COMPLETE\b)|\[OUT-OF-BAND|\[STILL IN PROGRESS\b|\[System note:|Cronjob Response:|Continue from the compressed conversation context above\.|You've reached the maximum number of tool-calling iterations allowed\.|Your previous turn indicated a tool call but none was included\.|You just executed tool calls but returned an empty response\.|A background fan-out (?:unit you dispatched earlier|of \d+ subagent\(s\) you dispatched earlier has finished\.)|A background subagent you dispatched earlier has finished\.)/i

// The display_metadata key the gateway sets on a user row it stored while
// accepting a prompt behind a running turn
// (tui_gateway/session_auto_continue.py). That prompt is stored anew, without
// the key, once its own turn begins — so a row still carrying it never opened
// the task shown, whatever its timestamp.
const QUEUED_PROMPT = '_queued_prompt'

// Is this stored row a prompt the user typed to start a task?
function isTaskPrompt(row) {
  if (row?.role !== 'user' || (row.row_kind && row.row_kind !== 'message')) return false
  // A row the gateway stored without a time cannot be placed on the
  // timeline, so it opens nothing.
  if (rowMs(row) == null) return false
  // A prompt queued behind a running turn, as accepted: typed while that
  // task ran, so never its start — nor its own task's, which opens with the
  // row stored anew.
  if (row.display_metadata?.[QUEUED_PROMPT]) return false
  if (row.display_kind === 'skill_invocation') return true
  // Mid-task guidance is typed too (display_kind 'steer') but it directs a
  // task already running: never a start. Every other typed row is the
  // gateway's own — completions, notifications, continuations.
  if (row.display_kind) return false
  const text = rowText(row).trim()
  return text !== '' && !SYNTHETIC_PROMPT.test(text)
}

// The newest task prompt of stored rows, by timestamp — not by position.
// Display order is not time order: a row re-parented onto an earlier slot
// keeps its own time, and a guidance row can be stored a few milliseconds
// behind the assistant row it follows. Null when the rows hold none.
// `beforeMs` (arrival mid-task with the gateway's turn start known) leaves
// out prompts stored later: those were typed while the task ran.
function scanRows(rows, beforeMs) {
  let prompt = null
  for (const row of rows || []) {
    const ms = rowMs(row)
    if (ms == null || !isTaskPrompt(row) || (beforeMs != null && ms > beforeMs)) continue
    if (!prompt || ms > prompt.ms) prompt = { ms, key: typeof row.row_id === 'number' ? row.row_id : null }
  }
  return { prompt }
}

function sameRow(a, b) {
  if (!a || !b) return false
  return a.key != null && b.key != null ? a.key === b.key : a.ms === b.ms
}

// On arrival mid-task, with the gateway's turn start known: a prompt already
// stored past this instant is not taken as the start at once — it was typed
// while an earlier turn of the task ran, on a gateway that does not mark a
// queued row — or it is the opening prompt itself, stored late. Either way
// the reads while the window is open leave that stored row alone: it is the
// newest prompt stored, and the one the task continues from where the
// backend opened the turn. An opening prompt landing after the arrival is
// another matter: not stored yet, it is not bound, and it is taken.
function promptBound(arriving, turnStartedMs) {
  return arriving && turnStartedMs != null ? turnStartedMs + TASK.landingGraceMs : null
}

// Was this stored prompt filed around a turn the gateway dated at `turnMs`?
// Within the landing grace on either side of it: the gateway files a prompt's
// row as it starts that prompt's turn, so one lying further back was typed
// for an earlier turn — this task's own, or one before it. Without that date
// every prompt can be the one.
function aroundTurnStart(ms, turnMs) {
  return turnMs == null || (ms >= turnMs - TASK.landingGraceMs && ms <= turnMs + TASK.landingGraceMs)
}

// The newest stored row at or after a start, the start row itself left out.
function eventAfter(rows, start) {
  let end = null
  for (const row of rows || []) {
    const ms = rowMs(row)
    if (ms == null || ms < start.ms) continue
    if (ms === start.ms && sameRow({ ms, key: typeof row.row_id === 'number' ? row.row_id : null }, start)) continue
    if (end == null || ms > end) end = ms
  }
  return end
}

// When a task ended: its newest stored row, or the exit of one of its own
// background processes if that came later.
function taskEnd(rows, start, work) {
  let end = eventAfter(rows, start)
  for (const w of work || []) {
    if (w.exitedMs != null && w.exitedMs >= start.ms && (end == null || w.exitedMs > end)) end = w.exitedMs
  }
  return end
}

// Can this stored prompt be the one that opened the epoch? Only a prompt
// stored since the previous task ended can — never a row of that task's
// own (a prompt queued behind its turn, a note of the gateway's its
// projection leaves untyped), whatever row it is and however recent it
// looks. When that task left no bracket there is nothing to guard
// against, and the gateway's turn start decides: a prompt stored around
// that start is the task's own, however late the pane came to look, and
// so is one stored right at the opening, while a prompt may still be
// landing. Without the turn start the prompt is the only start there is.
// On arrival there is no task to guard against either. Only with a prompt of
// the turn already in hand and the gateway's turn start known is it the
// landing window alone; with the turn start standing in for a prompt not in
// reach, with nothing to time from yet, or without a turn start, the first
// read is all that dates the task, and a prompt landing up to the
// provisional window after it may still be the opening one. The turn's date
// reaching a later read does not shorten that.
function opensEpoch(prompt, epoch) {
  if (!prompt || sameRow(prompt, epoch.basePrompt)) return false
  if (epoch.arrival) {
    const until = epoch.turnMs != null && !epoch.standIn && epoch.adopted ? TASK.landingGraceMs : TASK.provisionalMs
    return prompt.ms <= epoch.openedMs + until
  }
  if (epoch.priorEnd != null) return prompt.ms > epoch.priorEnd
  if (epoch.turnMs == null) return true
  return prompt.ms <= epoch.turnMs + TASK.landingGraceMs || prompt.ms >= epoch.openedMs - TASK.landingGraceMs
}

// Did the backend open the turn the gateway dated at `turnMs`? It stores a
// row of its own right behind that start — a completion, a notification, a
// continuation — typed with one of TASK.backendTurnKinds; a prompt the user
// typed carries none. Without a turn start nothing can show it. Where a
// later turn of the task is dated at `untilMs`, only a row stored well
// before it counts: one right behind that later start says nothing of the
// turn asked about — and where that later turn begins within the grace of
// the arrival turn's own start, the two cannot be told apart: a row right
// behind that earlier start counts no more. The same of one stored later
// than `latestMs`, the window past the pane's arrival: the pane stops
// reading once that window closes, a later turn's start then goes unread,
// and a row that late is that turn's own. Within the window a row counts
// as late as it lands, as a prompt does.
function backendOpened(rows, turnMs, untilMs, latestMs) {
  if (turnMs == null) return false
  const until = untilMs != null && untilMs > turnMs ? untilMs : turnMs
  const latest = latestMs != null ? latestMs : Infinity
  for (const row of rows || []) {
    if (row?.role !== 'user' || !TASK.backendTurnKinds.has(row.display_kind)) continue
    const ms = rowMs(row)
    if (ms == null || ms < turnMs - TASK.landingGraceMs || ms > latest) continue
    if (until === turnMs || ms < until - TASK.landingGraceMs) return true
  }
  return false
}

// The same of the turn the pane arrived in, asked of its own epoch: the
// window past the arrival bounds the late side alone, and no row stored
// later than its end can be that turn's own.
function arrivalOpened(rows, epoch) {
  return backendOpened(rows, epoch.arrivalTurnMs, epoch.turnMs, epoch.openedMs + TASK.provisionalMs)
}

// What prompt may take the place of a start adopted without it — the
// gateway's turn start standing in for a prompt not in reach, or the newest
// prompt stored where no turn start was known yet? With the gateway's turn
// start known, a prompt counts when filed for the turn or stored since the
// epoch opened — the pane's arrival, or the read that saw the session go
// busy; without it, when not before the start shown.
function opensFor(cand, epoch, live) {
  if (!opensEpoch(cand, epoch)) return false
  return epoch.turnMs != null
    ? aroundTurnStart(cand.ms, epoch.turnMs) || cand.ms >= epoch.openedMs
    : live == null || cand.ms >= live.ms
}

// Whether a prompt was stored within the window, by its own timestamp — a
// later task's no later than TASK.provisionalMs after the pane saw the
// session go busy; an arrival's window is opensEpoch's own. A read that comes
// late then still takes a prompt that landed in time, and one stored past the
// window is no start at the read that closes it or ends the turn.
function storedInWindow(prompt, epoch) {
  return prompt != null && (epoch.arrival || prompt.ms <= epoch.openedMs + TASK.provisionalMs)
}

// Whether such a prompt takes that place at the read that closes the window
// or ends the turn.
function closesOn(cand, epoch, live) {
  return storedInWindow(cand, epoch) && opensFor(cand, epoch, live)
}

// The start the task keeps while the gateway's turn start stands in for a
// prompt not in reach: the newest prompt stored where the backend opened
// the turn — it goes on with the task that prompt started — else the turn
// start, be the opening prompt late or out of reach.
function standInStart(epoch, live) {
  return epoch.backend && epoch.prior ? epoch.prior : live
}

// One evaluation of the focused session's task state.
// `i`: { now (ms), busy, tail (newest stored rows), found (the prompt of a
// search, when one ran), backendTurn (that search walked over a row of the
// backend's own turn opening), work (background items, null when unknown),
// turnStartedMs (the gateway's start of the current turn — null once the
// session is idle, on a backend without the field, or when the read failed) }.
// Pure: the same inputs give the same reading.
function advance(prev, i) {
  const st = prev
    ? { ...prev }
    : { pending: false, live: null, bracket: null, prompt: null, epoch: null, settling: null, confirm: null, work: null, bg: 0 }
  const bound = promptBound(!prev, i.turnStartedMs)
  const tail = scanRows(i.tail, bound)
  const landed = tail.prompt // a prompt inside the newest page
  if (tail.prompt) st.prompt = tail.prompt
  else if (i.found) st.prompt = i.found
  if (i.work) st.work = i.work
  const prompt = st.prompt

  // Background work counts from the task's own start: a process an earlier
  // task left running (a dev server) neither extends this one nor holds it open.
  const anchor = st.live ? st.live.ms : prompt ? prompt.ms : null
  const work = (st.work || []).filter((w) => w.startedMs == null || anchor == null || w.startedMs >= anchor - 1000)
  const running = work.filter((w) => w.exitedMs == null)
  const pending = !!i.busy || running.length > 0
  const wasPending = st.pending
  st.pending = pending
  st.bg = pending ? running.length : 0

  if (pending) {
    st.settling = null
    st.confirm = null
    if (!wasPending) {
      // A task epoch opens. `basePrompt` is the prompt of the task shown
      // settled — the newest one with output — else the newest prompt known:
      // what a new task's own prompt has to differ from. Both are null when
      // the pane arrived mid-task, with nothing to compare against.
      const settledEnd = prev && prev.bracket ? prev.bracket.endMs : null
      const follows = settledEnd != null && i.now - settledEnd <= TASK.queueWindowMs
      st.epoch = {
        openedMs: i.now,
        basePrompt: prev && prev.bracket
          ? { ms: prev.bracket.startMs, key: prev.bracket.startKey ?? null }
          : prev ? prev.prompt : null,
        adopted: false, provisional: false, awaiting: false, priorEnd: settledEnd, turnMs: null, arrival: !prev,
        arrivedBusy: !!i.busy, standIn: false, prior: null, backend: false, arrivalTurnMs: null
      }
      if (!prev) {
        // Arrived mid-task: the task's own prompt when it is in reach and
        // filed for the running turn, else the gateway's turn start —
        // correctable for a while in case the prompt that opened the task is
        // still landing or only reached by the search. The newest prompt
        // stored may open an earlier task, or an earlier turn of this one:
        // the turn start stands in, and that prompt — whichever turn it was
        // filed for — is the one the task continues from should no opening
        // prompt land within the window and the backend have opened the
        // turn (backendOpened above; standInStart decides).
        const turnMs = i.turnStartedMs
        st.epoch.arrivalTurnMs = turnMs
        const opener = prompt && aroundTurnStart(prompt.ms, turnMs) ? prompt : null
        const start = opener || (turnMs != null ? { ms: turnMs, key: null } : null)
        if (start) {
          st.live = start
          st.epoch.adopted = true
          st.epoch.provisional = true
          st.epoch.standIn = !opener && turnMs != null
          st.epoch.prior = st.epoch.standIn ? (scanRows(i.tail, null).prompt || i.found || null) : null
        }
      } else if (follows) {
        // A turn the queue or a completion started straight behind the last
        // one: the same task, its start kept — unless the prompt behind it
        // turns out to be the user's own (settled below once it lands).
        st.live = { ms: prev.bracket.startMs, key: prev.bracket.startKey ?? null }
        st.epoch.adopted = true
        st.epoch.awaiting = true
      }
    }
    const epoch = st.epoch
    if (i.turnStartedMs != null) epoch.turnMs = i.turnStartedMs
    // The turn's date reached a later read than the one the pane arrived on:
    // from here it dates the turn the pane arrived in.
    const dated = epoch.arrival && epoch.arrivalTurnMs == null && epoch.turnMs != null
    if (dated) epoch.arrivalTurnMs = epoch.turnMs
    // A row of the backend's own behind that turn's start — the grace running
    // a little before it as well — before any later turn of the task and
    // stored within the window past the arrival (arrivalOpened); in the
    // newest page of this read, or walked over by the search. It shows the
    // turn to go on with the task already running. Seen once, it stands.
    if (epoch.arrival && !epoch.backend && (i.backendTurn || arrivalOpened(i.tail, epoch))) {
      epoch.backend = true
    }
    // And the prompt taken for the opener as the pane arrived, without that
    // date, was stored before the arrival and lies well away from the turn's
    // start — an earlier task's, or one filed into a later turn of this one.
    // The turn start stands in for it as on arrival, and it is the prompt the
    // task continues from where the backend opened the turn.
    if (dated && epoch.adopted && !epoch.standIn && st.live && st.live.ms < epoch.openedMs &&
        !aroundTurnStart(st.live.ms, epoch.turnMs)) {
      epoch.prior = st.live
      epoch.standIn = true
      st.live = { ms: epoch.turnMs, key: null }
    }
    // With the turn start standing in and the backend's row seen, the task
    // goes on from the newest prompt stored — from the first read that
    // shows it; the window stays open for a prompt that may yet land.
    if (epoch.standIn) st.live = standInStart(epoch, st.live)
    if (!epoch.adopted) {
      if (opensEpoch(landed, epoch) && storedInWindow(landed, epoch)) {
        st.live = landed
        epoch.adopted = true
      } else if (i.now - epoch.openedMs >= TASK.provisionalMs) {
        // No new prompt within the window in which a landing one is still
        // looked for: a turn the backend started on its own (a delegation
        // or process completion, a goal follow-up) — the task continues
        // from the task shown settled; with no prompt known, from the
        // gateway's own turn start (a prompt sent from another surface,
        // stored with a display kind of its own, or out of the search's
        // reach). With neither, the task stays untimed until a prompt
        // lands.
        const start = epoch.basePrompt || (epoch.turnMs != null ? { ms: epoch.turnMs, key: null } : null)
        if (start) {
          st.live = start
          epoch.adopted = true
          epoch.provisional = true
        }
      }
    } else if (epoch.provisional) {
      const cand = landed || i.found || null
      if (i.now - epoch.openedMs >= TASK.provisionalMs) {
        epoch.provisional = false
        // The read that closes the window still takes the opening prompt it
        // brings, as the reads inside it would have — stored in time, by its
        // own timestamp; past it a later prompt no longer moves the start.
        // With the turn start standing in and no opening prompt: the task
        // goes on from the newest prompt stored where the backend opened
        // the turn, and otherwise keeps the turn start.
        if (closesOn(cand, epoch, st.live) && !sameRow(cand, st.live)) {
          st.live = cand
          epoch.standIn = false
        } else if (epoch.standIn) {
          st.live = standInStart(epoch, st.live)
        }
      } else {
        // The prompt that opened the epoch, if it was still landing or only
        // the search reached it: its own stored time replaces the estimate.
        // With the gateway's turn start known, a prompt counts only when
        // filed for the turn — around the turn start, or landing after the
        // epoch opened, stored late. One the pane found already stored
        // further into the turn, or one lying well before the turn start, is
        // not taken while the window is open: typed while an earlier turn
        // ran, or for a task before it. The start's own row, read again,
        // corrects nothing: it leaves the window open for a prompt that may
        // still be landing — with the turn start known, or on an arrival
        // that found a turn running. Without that date, a task held open by
        // nothing but background work takes any later prompt as typed on
        // top of it, so there the start's own row closes the window as before.
        const own = sameRow(cand, st.live)
        const waiting = epoch.turnMs != null || epoch.arrivedBusy
        if (epoch.standIn && !epoch.prior && i.found) epoch.prior = i.found
        if ((!own || !waiting) && opensFor(cand, epoch, st.live)) {
          st.live = cand
          epoch.provisional = false
          epoch.standIn = false
        }
      }
    } else if (epoch.awaiting && opensEpoch(landed, epoch)) {
      epoch.awaiting = false
      // The turn opened straight behind the last task. A prompt stored after
      // that task ended is the next one, typed once it was over; one stored
      // before it was queued while that task ran, belongs to it, and is not
      // offered here — nor is the row the gateway stored as accepting it,
      // which carries its queued mark. The row stored anew when the queued
      // prompt's own turn begins is that task's start.
      st.live = landed
    }
    return st
  }

  const ended = st.epoch
  st.epoch = null
  // Ended with the gateway's turn start standing in for a prompt not in
  // reach: the opening prompt this read brings, stored in time, is the
  // start, as it would have been inside the window; with none, the task
  // goes on from the newest prompt stored where the backend opened the
  // turn — as in the closed window — and otherwise from the turn start.
  if (ended && ended.arrival && arrivalOpened(i.tail, ended)) ended.backend = true
  if (ended && ended.standIn) {
    const cand = landed || i.found || null
    if (closesOn(cand, ended, st.live) && !sameRow(cand, st.live)) st.live = cand
    else st.live = standInStart(ended, st.live)
  }
  // The session went idle — or is idle, and a task that ended with nothing
  // stored after its prompt is still waiting out its settling retries.
  if (prev && (wasPending || st.live)) {
    // Freeze the task at its newest stored event.
    if (st.live) {
      const end = taskEnd(i.tail, st.live, work)
      if (end != null) {
        st.bracket = { startMs: st.live.ms, startKey: st.live.key, endMs: end }
        st.live = null
        st.settling = null
        st.confirm = i.now // a final row may still be stored behind the idle flip
      } else {
        // Nothing stored after the prompt yet: give the final rows their
        // retries, then the task was stopped before it timed anything.
        const tries = (st.settling ? st.settling.tries : 0) + 1
        st.settling = tries <= TASK.settleRetryMs.length
          ? { openedMs: st.settling ? st.settling.openedMs : i.now, tries }
          : null
        if (!st.settling) {
          st.bracket = null
          st.live = null
        }
      }
    } else {
      // Over before its prompt was adopted (shorter than the landing
      // retries): its prompt if it landed after all — in time, by its own
      // timestamp, as at the read that closes the window — else the task
      // shown settled, else the turn's own start.
      st.live = null
      const fallback = ended
        ? ended.basePrompt || (ended.turnMs != null ? { ms: ended.turnMs, key: null } : null)
        : null
      const start = landed && (!ended || closesOn(landed, ended, null)) ? landed : fallback
      const end = start ? taskEnd(i.tail, start, work) : null
      if (start && end != null) {
        st.bracket = { startMs: start.ms, startKey: start.key, endMs: end }
        st.confirm = i.now
      } else if (start === landed) {
        st.bracket = null // a prompt with nothing after it: stopped before any output
      }
    }
    return st
  }

  // Idle: arrival, or a routine poll. A prompt stored after the bracket shown
  // is a later task — one that began and ended between polls, or a prompt the
  // gateway queued behind it, stored anew as its turn began. If it has no
  // output yet it has not started (or stopped before any), and the bracket
  // shown stands. Otherwise the bracket's own task may have stored more since
  // (a late completion): only its end moves. A prompt stored inside the
  // bracket — guidance, a prompt queued while the task ran, a re-parented
  // copy — never moves it.
  const shown = st.bracket ? { ms: st.bracket.startMs, key: st.bracket.startKey } : null
  if (prompt && (!shown || prompt.ms > st.bracket.endMs || sameRow(prompt, shown))) {
    const end = taskEnd(i.tail, prompt, work)
    if (end != null) st.bracket = { startMs: prompt.ms, startKey: prompt.key, endMs: end }
  }
  return st
}

// What the readout shows: the live start while the task is open, else the
// last settled task. `bg` counts the background work holding the task open.
function present(st) {
  return {
    liveMs: st.pending && st.live ? st.live.ms : null,
    startMs: st.bracket ? st.bracket.startMs : null,
    endMs: st.bracket ? st.bracket.endMs : null,
    bg: st.pending ? st.bg : 0
  }
}

// When to read again: only while something can still change the reading.
function nextDelay(st, busy) {
  const elapsed = Date.now() - (st.epoch ? st.epoch.openedMs : st.settling ? st.settling.openedMs : 0)
  if (st.pending) {
    const epoch = st.epoch
    if (!epoch) return TASK.bgPollMs
    // Until the window closes in which a landing prompt can still be
    // taken as the start, a read each second past the retry ladder.
    if (!epoch.adopted || epoch.awaiting) {
      return untilRetry(TASK.landingRetryMs, elapsed) ??
        (elapsed < TASK.provisionalMs ? Math.min(1000, TASK.provisionalMs - elapsed) : busy ? null : TASK.bgPollMs)
    }
    if (epoch.provisional) {
      return untilRetry(TASK.landingRetryMs, elapsed) ??
        (elapsed < TASK.provisionalMs ? Math.min(1000, TASK.provisionalMs - elapsed) : null)
    }
    // Pinned: nothing moves the start until the chat stops. Only background
    // work needs watching, and only once the chat itself is idle.
    return busy ? null : TASK.bgPollMs
  }
  // A settling whose retries a slow read outlasted is read again at the
  // routine cadence, not left unpolled until the next busy flip.
  if (st.live) return st.settling ? untilRetry(TASK.settleRetryMs, elapsed) ?? TASK.idlePollMs : null
  // Just settled: a few confirming reads for a final row stored behind the
  // idle flip, then the routine cadence.
  if (st.confirm != null) return untilRetry(TASK.confirmRetryMs, Date.now() - st.confirm) ?? TASK.idlePollMs
  return TASK.idlePollMs
}

// A gateway read the task loop waits on, given up on after TASK.readTimeoutMs
// as a failed one: a request that never answers then holds the reading back by
// that long instead of for good, and its answer, should one come later, lands
// nowhere.
function ask(method, params) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(method + ' did not answer in time')), TASK.readTimeoutMs)
  })
  return Promise.race([host.request(method, params), timeout]).finally(() => clearTimeout(timer))
}

// The newest task prompt (stored no later than `beforeMs`, when given),
// walking older pages while the newest holds none. Null when the session
// stored none within reach. Of the pages it walks it also notes whether the
// backend opened the turn the gateway dated at `turnMs` (`backendTurn`): a
// row of its own behind that start and before the turn dated `untilMs`,
// stored no later than `latestMs` — the bounds of backendOpened — beyond
// the newest page.
async function findTaskPrompt(sessionId, beforeMs, turnMs, untilMs, latestMs) {
  let cursor
  let backendTurn = false
  for (let page = 0; page < TASK.pageMax; page++) {
    const result = await ask('session.transcript', {
      session_id: sessionId,
      ...(cursor ? { cursor } : {}),
      limit: TASK.pageRows,
      order: 'latest'
    })
    if (backendOpened(result?.rows, turnMs, untilMs, latestMs)) backendTurn = true
    if (page > 0 && result?.reset) return { prompt: null, backendTurn }
    const found = scanRows(result?.rows, beforeMs).prompt
    if (found) return { prompt: found, backendTurn }
    cursor = result?.next_cursor
    if (!cursor) return { prompt: null, backendTurn }
  }
  return { prompt: null, backendTurn }
}

// When the current turn started, per the gateway: epoch ms, or null when the
// session is idle, the backend predates the field, or the read failed. The
// gateway pins it at the turn's first prompt and keeps it in memory, so
// neither mid-task guidance nor a context compaction moves it.
async function readTurnStarted(sessionId) {
  const info = await ask('session.info', { session_id: sessionId }).catch(() => null)
  return typeof info?.turn_started_at === 'number' && info.turn_started_at > 0
    ? toEpochMs(info.turn_started_at) : null
}

// The session's own background processes and subagents, as
// { startedMs, exitedMs } each — a null `exitedMs` is still running. A
// lookup the gateway could not answer is no answer: null, so that the work
// read last stands rather than being taken for none.
async function readBackgroundWork(sessionId) {
  const read = (method, key) => ask(method, { session_id: sessionId }).then(
    (r) => (Array.isArray(r?.[key]) ? r[key] : null), () => null)
  const [processes, subagents] = await Promise.all([
    read('process.list', 'processes'),
    read('subagent.list', 'subagents')
  ])
  if (!processes || !subagents) return null
  const work = []
  for (const p of processes) {
    if (!(p?.started_epoch > 0)) continue
    if (p.status === 'exited') {
      if (p.exited_at > 0) work.push({ startedMs: toEpochMs(p.started_epoch), exitedMs: toEpochMs(p.exited_at) })
    } else {
      work.push({ startedMs: toEpochMs(p.started_epoch), exitedMs: null })
    }
  }
  for (const s of subagents) {
    if (s?.status === 'running' && s.started_at > 0) {
      work.push({ startedMs: toEpochMs(s.started_at), exitedMs: null })
    }
  }
  return work
}

// Normalize a UsageStats snapshot across the shapes the backend emits.
function readUsage(u) {
  if (!u) return null
  const input = u.input ?? u.input_tokens ?? u.prompt_tokens ?? 0
  const output = u.output ?? u.output_tokens ?? u.completion_tokens ?? 0
  const total = u.total ?? u.total_tokens ?? input + output
  return {
    model: u.model || '',
    input,
    output,
    reasoning: u.reasoning ?? u.reasoning_tokens ?? 0,
    total,
    calls: u.calls ?? u.api_calls ?? 0,
    contextPercent: u.context_percent ?? null,
    contextMax: u.context_max ?? null,
    costUsd: typeof u.cost_usd === 'number' ? u.cost_usd : null
  }
}

function usageCost(u, fallbackModel) {
  if (!u) return 0
  if (u.costUsd !== null) return u.costUsd
  return calcCost(u.model || fallbackModel, u.input, u.output)
}

// Where auto-compression fires, as the gateway computes it
// (agent/context_compressor.py) — as far as the figures entered here go.
// The threshold is compression.threshold of config.yaml as the user typed
// it into this plugin. For a window under 512K the percentage is raised to
// 75%; the share is then taken of the input budget — the window less the
// output reserved for the answer, here the runtime max_tokens override
// entered above. The result is floored at 64,000 tokens with that floor
// capped at 85% of the budget, and a threshold at or past the budget is
// pulled back to 85%. These arithmetic steps are reproduced here. The base
// percentage is not the gateway's but the typed one, taken for every model:
// the gateway settles on a per-model figure (its entry under
// compression.model_thresholds, else a built-in default), and the plugin
// stores no such table — modelThreshold resolves one the way the gateway
// does, should a table ever be passed. Not reproduced either: the
// threshold_tokens cap, the summariser model's window, output a route
// reserves by itself (a native Gemini route, 65,535 tokens while
// max_tokens is unset), and whether compression is on at all — so the mark
// is an estimate of the trigger, not the trigger itself.
const COMPRESSION = { smallWindow: 512000, smallWindowFloor: 0.75, minContext: 64000, triggerRatio: 0.85 }

// Plugin-storage keys. The stored figures mirror what the gateway is set
// to: the threshold as compression.threshold of config.yaml is written (0.7,
// or 70 for 70%), the reserved output as a runtime max_tokens override
// (optional; unset means none is reserved).
const SETTING = { threshold: 'compression.threshold', maxTokens: 'compression.max_tokens' }

// `compressionTrigger`'s input from the two stored figures, or null when no
// threshold is stored or the figure is not a share of the window. A stored
// threshold is a share of the window — 0.7 is 70% — and a figure above 1 is
// read as the percent config.yaml writes it (70), so a bare 1 is the whole
// window. The form hands its figure in already divided (see saveThreshold).
function storedCompression(threshold, maxTokens) {
  let share = Number(threshold)
  if (!Number.isFinite(share) || share <= 0) return null
  if (share > 1) share = share / 100
  if (!(share > 0 && share <= 1)) return null
  const reserve = Number(maxTokens)
  return { enabled: true, threshold: share, modelThresholds: null, maxTokens: Number.isFinite(reserve) && reserve > 0 ? reserve : 0 }
}

// What the plugin's storage holds, or null without a usable figure — also on
// a desktop build that has no plugin storage.
function readStoredCompression(storage) {
  if (!storage || typeof storage.get !== 'function') return null
  return storedCompression(storage.get(SETTING.threshold, null), storage.get(SETTING.maxTokens, null))
}

// Inline styles, so the form does not depend on which utility classes the
// app's stylesheet happens to carry.
const FIELD = { width: 56, background: 'transparent', border: '1px solid var(--ui-stroke-secondary)', borderRadius: 4, padding: '0 4px', color: 'inherit', font: 'inherit', textAlign: 'right' }
const FIELD_WIDE = { ...FIELD, width: 84 }
const ACTION = { padding: '0 6px', borderRadius: 4, color: 'inherit', font: 'inherit', cursor: 'pointer' }

// The threshold a model's entry in compression.model_thresholds carries, or
// `fallback`. As the gateway resolves it (resolve_model_threshold in
// agent/context_compressor.py): the key whose matching part is longest
// wins — a scoped key ("provider:substring") counts by its substring — and
// at equal length a scoped key beats a bare one, while two keys that are
// equally specific are decided by plain string order, the later one winning;
// the provider name is compared trimmed and lower-cased, as the gateway
// compares it.
function modelThreshold(perModel, model, provider, fallback) {
  provider = String(provider || '').trim().toLowerCase()
  if (!perModel || !model) return fallback
  let best = null
  for (const key of Object.keys(perModel)) {
    const value = Number(perModel[key])
    if (!Number.isFinite(value)) continue
    const i = key.indexOf(':')
    let rank = null
    if (i < 0) {
      if (model.includes(key)) rank = [key.length, 0]
    } else if (key.slice(0, i).trim().toLowerCase() === provider && model.includes(key.slice(i + 1))) {
      rank = [key.length - i - 1, 1]
    }
    if (rank && (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] &&
        (rank[1] > best.rank[1] || (rank[1] === best.rank[1] && key > best.key))))) {
      best = { rank, key, value }
    }
  }
  return best ? best.value : fallback
}

// `{ configured, tokens, pct, floored }` for a window of `windowTokens`, or
// null when compaction is off or the window is unknown. `pct` is where the
// mark goes on the context bar.
function compressionTrigger(c, windowTokens, model, provider) {
  if (!c || !c.enabled || !(windowTokens > 0)) return null
  const base = modelThreshold(c.modelThresholds, model, provider, c.threshold)
  const effective = windowTokens < COMPRESSION.smallWindow
    ? Math.max(base, COMPRESSION.smallWindowFloor) : base
  const budget = windowTokens - c.maxTokens > 0 ? windowTokens - c.maxTokens : windowTokens
  const share = Math.trunc(budget * effective)
  let tokens = Math.max(share, COMPRESSION.minContext)
  const cap = Math.trunc(budget * COMPRESSION.triggerRatio)
  if (budget > 0 && tokens > share && tokens > cap) tokens = Math.max(share, cap)
  if (budget > 0 && tokens >= budget) tokens = Math.max(1, Math.min(cap, budget - 1))
  return { configured: base, tokens, pct: tokens / windowTokens, floored: effective > base }
}

// Whether a session.list row is the session `id` names. A row carries three
// ids — its own, the id a compressed conversation resolved to, and the root
// of its lineage — and matches on any of them.
function rowIsSession(row, id) {
  return !!id && !!row && (row.id === id || row.resolved_id === id || row._lineage_root_id === id)
}

// The reading the context row shows for the focused session, or null when
// there is none and the row is not drawn. The live figure wins whenever the
// backend streams one (a null is no figure; 0% is one). Otherwise the
// gateway's estimate: with a window it gives the share and the window, the
// share marked approximate (the pane draws it with a '~') while
// context_estimated says it was not measured; with no window — no resident
// agent in this gateway process — only estimated_total, the count the
// session's frozen system prompt, tools and stored transcript add up to, so
// the row can say that much and no share. Pure: the same inputs give the
// same reading.
function contextReading(live, estimate) {
  const pct = live?.contextPercent
  if (pct !== null && pct !== undefined) {
    return { pct, max: live.contextMax ?? null, approximate: false, estimatedTotal: null }
  }
  if (estimate && Number(estimate.context_max) > 0) {
    return {
      pct: Number(estimate.context_percent) || 0,
      max: Number(estimate.context_max),
      approximate: !!estimate.context_estimated,
      estimatedTotal: null
    }
  }
  if (estimate && Number(estimate.estimated_total) > 0) {
    return { pct: null, max: null, approximate: false, estimatedTotal: Number(estimate.estimated_total) }
  }
  return null
}

function DashboardPane({ storage }) {
  const t = usePluginI18n(ID)
  const usage = readUsage(useValue(host.state.focusedUsage))
  const currentModel = useValue(host.state.model)
  const focusedRuntimeId = useValue(host.state.focusedSessionId)
  const focusedStoredId = useValue(host.state.focusedStoredSessionId)
  const busy = useValue(host.state.busy)
  const [sessions, setSessions] = useState([])
  const [listError, setListError] = useState('')
  // Turn time and the session's info are each kept against the session they
  // were read from, and shown only while that session is the focused one: the
  // reading of a session just left never shows against the next, not even for
  // the moment before the next one's own first read lands.
  const [taskOf, setTaskOf] = useState(null)
  const [infoOf, setInfoOf] = useState(null)
  // The gateway's context estimate, kept against the session it was read for
  // like the two above; a failed read leaves that session's last reading in
  // place rather than clearing it.
  const [contextOf, setContextOf] = useState(null)
  const taskTurn = taskOf && taskOf.sessionId === focusedRuntimeId ? taskOf.turn : null
  const sessionInfo = infoOf && infoOf.sessionId === focusedRuntimeId ? infoOf.info : null
  const contextEstimate = contextOf && contextOf.sessionId === focusedRuntimeId ? contextOf.estimate : null
  const [stored, setStored] = useState(() => readStoredCompression(storage))
  // Storage is a local key-value store; a build without it can neither read
  // nor keep a threshold, so the entry point stays hidden there.
  const canStore = typeof storage?.set === 'function' && typeof storage?.remove === 'function'
  const [editing, setEditing] = useState(false)
  const [saveError, setSaveError] = useState('')
  // The task loop lives outside render: it is poked on every busy flip and
  // reads `busy` as of the moment it evaluates.
  const busyRef = useRef(busy)
  busyRef.current = busy
  const pokeRef = useRef(null)
  const now = useNow(TASK.tickMs)

  // Session list; also re-fetched immediately when focus flips so a newly
  // focused session is matched without waiting for the next 10s tick. Under
  // normal circumstances at most one request is in flight at a time:
  // session.list can cold-spawn a profile backend and take a while, so a
  // flip that lands while a read is pending is read as soon as that read
  // returns — never stacked on top of it. A read pending for longer than
  // TASK.listStallMs is given up on instead: the next flip or tick reads
  // afresh rather than wait on it, since nothing says it will ever return.
  const listRef = useRef({ inFlight: false, since: 0, token: null, rerun: false, poke: null })
  useEffect(() => {
    let alive = true
    let failing = false
    // `behind`: the read was asked for while another may be pending (a
    // focus flip), and then waits behind that one — unless that one has
    // been pending so long (TASK.listStallMs) that it is given up on. The
    // 10s tick passes it only in that case, so it never stacks a read on a
    // pending one.
    async function fetchSessions(behind) {
      const list = listRef.current
      if (list.inFlight) {
        if (!behind || Date.now() - list.since < TASK.listStallMs) {
          if (behind) list.rerun = true
          return
        }
        // A flip may have asked for a read behind the one given up on: this
        // read is that one.
        list.rerun = false
      }
      const token = (list.token = {})
      list.inFlight = true
      list.since = Date.now()
      try {
        const result = await host.request('session.list', { limit: 25 })
        // A read given up on while it was pending lands nowhere: the read
        // that replaced it owns the list now.
        if (!alive || list.token !== token) return
        setSessions(result?.sessions || [])
        setListError('')
        failing = false
      } catch (e) {
        if (!alive || list.token !== token) return
        if (!failing) console.error('Token dashboard session.list error:', e)
        failing = true
        setListError('Session list unavailable (gateway slow or restarting)')
      } finally {
        // A read given up on while it was pending lands nowhere at all: the
        // read that replaced it owns the list, and any rerun asked since.
        if (list.token === token) {
          list.inFlight = false
          // Asked for while this read was pending: once more, for the
          // session focused now.
          if (list.rerun && list.poke) {
            list.rerun = false
            list.poke(true)
          }
        }
      }
    }
    fetchSessions(true)
    const interval = setInterval(() => {
      const list = listRef.current
      fetchSessions(list.inFlight && Date.now() - list.since >= TASK.listStallMs)
    }, 10000)
    listRef.current.poke = fetchSessions
    return () => { alive = false; clearInterval(interval); listRef.current.poke = null }
  }, [focusedRuntimeId, focusedStoredId])

  // Turn time, as a task bracket over the stored transcript (the section
  // above this component). One loop per focused session, reading only when
  // something can change the bracket: a busy flip (at once), a prompt still
  // landing, the final rows of a settling turn, or background work while the
  // chat is idle. A failed read keeps the last reading and tries again.
  useEffect(() => {
    // The newly focused session has no reading of its own yet; one of the
    // session just left is never shown in its place.
    setTaskOf(null)
    if (!focusedRuntimeId) return
    let alive = true
    let state = null
    let timer = null
    let deadline = Infinity
    let inFlight = false
    let rerun = false
    // The backward search runs while no prompt of the session is known: once
    // on arrival, and once per task epoch after it — a second time on arrival
    // only when the first search found nothing — never on a timer: a session
    // whose prompt is out of reach is not walked back again at every poll. A
    // failed search is not counted. The one other time is when the gateway's
    // turn start reaches a read later than the pane's arrival: then the pages
    // are walked once more for the backend's row, a prompt known or not.
    let seenEpoch = null
    let searchSlot = 0
    let searchedSlot = -1
    let searchedTurn = null
    let failing = false
    const sessionId = focusedRuntimeId

    function schedule(delayMs) {
      const at = Date.now() + delayMs
      if (at >= deadline) return
      deadline = at
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; deadline = Infinity; run() }, delayMs)
    }

    async function run() {
      if (!alive) return
      if (inFlight) {
        rerun = true
        return
      }
      inFlight = true
      let delay = TASK.idlePollMs
      try {
        // The gateway's own turn start backs the timer while the task's
        // prompt is out of reach or still landing; once the start is pinned,
        // nothing reads it.
        const arriving = !state
        let turnStartedMs = null
        if (busyRef.current && (arriving || (state.epoch && (!state.epoch.adopted || state.epoch.provisional)))) {
          turnStartedMs = await readTurnStarted(sessionId)
          if (!alive) return
        }
        const page = await ask('session.transcript', {
          session_id: sessionId, limit: TASK.tailRows, order: 'latest'
        })
        if (!alive) return
        const tail = Array.isArray(page?.rows) ? page.rows : []
        let found = null
        let backendTurn = false
        const bound = promptBound(arriving, turnStartedMs)
        const epoch = state ? state.epoch : null
        if (epoch && epoch !== seenEpoch) {
          seenEpoch = epoch
          searchSlot += 1
        }
        // Where the gateway's turn start is known, the search asks about the
        // turn the pane arrived in, not about a later turn of the task.
        if (arriving) searchedTurn = turnStartedMs
        const arrivalTurnMs = epoch && epoch.arrival ? epoch.arrivalTurnMs : null
        // A row of the backend's counts unless stored later than the window
        // past the pane's arrival (backendOpened): on the arriving read none
        // is later than that as yet.
        const latestMs = epoch && epoch.arrival ? epoch.openedMs + TASK.provisionalMs : null
        const redated = arrivalTurnMs != null && arrivalTurnMs !== searchedTurn
        if (redated || (!scanRows(tail, bound).prompt && !state?.prompt && searchedSlot !== searchSlot)) {
          const search = await findTaskPrompt(sessionId, bound, arrivalTurnMs ?? turnStartedMs, turnStartedMs, latestMs)
          if (!alive) return
          searchedTurn = arrivalTurnMs ?? turnStartedMs
          backendTurn = search.backendTurn
          if (!scanRows(tail, bound).prompt && !state?.prompt) {
            found = search.prompt
            searchedSlot = searchSlot
          }
        }
        // While the chat streams, the task is open whatever the background holds.
        const busyNow = busyRef.current
        const work = busyNow && state?.pending ? undefined : await readBackgroundWork(sessionId)
        if (!alive) return
        state = advance(state, { now: Date.now(), busy: busyNow, tail, found, backendTurn, work, turnStartedMs })
        setTaskOf({ sessionId, turn: present(state) })
        delay = nextDelay(state, busyNow)
        failing = false
      } catch (e) {
        if (!alive) return
        if (!failing) console.error('Token dashboard task bracket error:', e)
        failing = true
        delay = 2000
      } finally {
        inFlight = false
      }
      if (!alive) return
      deadline = Infinity
      if (rerun) {
        rerun = false
        delay = 0
      }
      if (delay != null) schedule(delay)
    }

    pokeRef.current = () => {
      deadline = Infinity
      run()
    }
    run()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      pokeRef.current = null
    }
  }, [focusedRuntimeId])

  // A busy flip is the one moment the bracket can open or settle: read now.
  useEffect(() => { pokeRef.current?.() }, [busy])

  // Reasoning effort for the focused session, refreshed like the session
  // list. reasoning_effort is the configured depth (a typed /reasoning); reasoning_effort_wire is what
  // the route actually accepts after clamping, so prefer it when present.
  // A failed read just hides the suffix — never a guess.
  useEffect(() => {
    // The newly focused session's suffix appears with its own read; the one
    // of the session just left never carries over to it.
    setInfoOf(null)
    let alive = true
    let inFlight = false
    async function fetchInfo() {
      if (inFlight || !focusedRuntimeId) return
      inFlight = true
      try {
        const result = await host.request('session.info', { session_id: focusedRuntimeId })
        if (!alive) return
        setInfoOf({ sessionId: focusedRuntimeId, info: result || null })
      } catch {
        if (alive) setInfoOf({ sessionId: focusedRuntimeId, info: null })
      } finally {
        inFlight = false
      }
    }
    fetchInfo()
    const id = setInterval(fetchInfo, 10000)
    return () => { alive = false; clearInterval(id) }
  }, [focusedRuntimeId])

  // The context row's fallback for the times the live usage carries no
  // context_percent: after a restart, or once the gateway has reaped an idle
  // session's agent, the row would otherwise be gone until the session speaks
  // again. Read when the pane opens on a session, and on the two moments a
  // reading can change with no turn streaming over it — the focused session
  // changing, and a turn ending — and
  // not while busy, when the live usage is what the turn reports and an
  // estimate read mid-turn would date the transcript at its own moment; nor
  // while a live figure is in hand, which is the one shown.
  const liveCtxPct = usage?.contextPercent
  const liveCtxRef = useRef(liveCtxPct)
  liveCtxRef.current = liveCtxPct
  const ctxFailRef = useRef({ sessionId: null, failing: false })
  useEffect(() => {
    if (!focusedRuntimeId || busy) return
    const live = liveCtxRef.current
    if (live !== null && live !== undefined) return
    // One log line per run of failures of this session, as the session list
    // read logs its own; another session that reads starts a fresh run.
    const fail = ctxFailRef.current
    if (fail.sessionId !== focusedRuntimeId) {
      fail.sessionId = focusedRuntimeId
      fail.failing = false
    }
    let alive = true
    async function readEstimate() {
      try {
        const result = await ask('session.context_breakdown', { session_id: focusedRuntimeId })
        // The session switched, or a turn began, while the read was out: the
        // answer describes a moment the pane is no longer showing.
        if (!alive || busyRef.current) return
        if (result && typeof result === 'object') {
          setContextOf({ sessionId: focusedRuntimeId, estimate: result })
        }
        fail.failing = false
      } catch (e) {
        if (!alive) return
        if (!fail.failing) console.error('Token dashboard session.context_breakdown error:', e)
        fail.failing = true
      }
    }
    readEstimate()
    return () => { alive = false }
  }, [focusedRuntimeId, busy])

  // The form opens and closes with its message: a write the storage did
  // not keep is said in it, and gone once the form is used again.
  function setForm(open) {
    setSaveError('')
    setEditing(open)
  }

  // Write both stored figures, or none. The host's storage does not report
  // a write it fails: it swallows a quota or permission error, and the
  // figure simply is not kept. So a write counts only once the storage
  // gives the figures back. Otherwise what it held is put back as far as it
  // still answers, the pane reads the storage again so the mark follows
  // what is really there, and false is returned: the figures were not kept.
  function writeThreshold(next) {
    const put = (figures) => {
      if (!figures) {
        storage.remove(SETTING.threshold)
        storage.remove(SETTING.maxTokens)
      } else {
        storage.set(SETTING.threshold, figures.threshold)
        if (figures.maxTokens > 0) storage.set(SETTING.maxTokens, figures.maxTokens)
        else storage.remove(SETTING.maxTokens)
      }
    }
    // Whether the storage holds exactly these figures (nothing, for a clear).
    const holds = (figures) => {
      const back = readStoredCompression(storage)
      return figures
        ? back !== null && back.threshold === figures.threshold && back.maxTokens === figures.maxTokens
        : back === null
    }
    try {
      put(next)
      if (holds(next)) return true
    } catch { /* a storage that throws: put back what it held, below */ }
    try { put(stored) } catch { /* the storage answers nothing now; the form says so */ }
    try { setStored(readStoredCompression(storage)) } catch { /* keep the reading shown */ }
    return false
  }

  // Keep what the threshold form holds: the threshold always, the reserved
  // output only while one is given (an empty field clears it).
  function saveThreshold(event) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    // The form takes a whole percent, 1 to 100, and stores the share it is:
    // 70 as 0.7, the way compression.threshold is written in config.yaml. A
    // 1 typed here is one percent — where a 1 met in the storage is the
    // whole window. A figure outside that range stores nothing.
    const percent = Number(data.get('threshold'))
    const next = storedCompression(percent >= 1 && percent <= 100 ? percent / 100 : null, data.get('reserve'))
    if (!next) return
    if (!writeThreshold(next)) {
      // Said where the user is looking; the form stays open on its figures.
      setSaveError('Could not save: the plugin storage did not keep the figures (it is full or unavailable).')
      return
    }
    setSaveError('')
    setStored(next)
    setEditing(false)
  }

  function clearThreshold() {
    if (!writeThreshold(null)) {
      setSaveError('Could not clear: the plugin storage did not keep the change (it is full or unavailable).')
      return
    }
    setSaveError('')
    setStored(null)
    setEditing(false)
  }

  const model = usage?.model || currentModel || 'unknown'
  // What to show after the model: the route's actual (clamped) effort when
  // the backend reports one, else the configured depth. 'none'/empty or a
  // failed session.info read → no suffix.
  const effort = sessionInfo
    ? (sessionInfo.reasoning_effort_wire ||
       (sessionInfo.reasoning_effort !== 'none' ? sessionInfo.reasoning_effort : '') ||
       '')
    : ''
  const cost = usageCost(usage, currentModel)
  // The context row's reading: the live figure while the backend streams one,
  // else the gateway's estimate for a session it has not measured in this
  // process — the estimate hidden while busy, when the turn streams the live
  // usage and a reading taken mid-turn would date the transcript at its own
  // moment; the live figure stays.
  const ctxReading = contextReading(usage, busy ? null : contextEstimate)
  // The mark on the context bar: an estimate of where the gateway's
  // threshold arithmetic puts the trigger on this session's window, from the
  // two stored figures (see COMPRESSION for what it cannot know). Placed on
  // the window the reading carries — the live figure's own, or the estimate's
  // when it knows one. Nothing to place while no threshold is stored or the
  // window is unknown.
  const trigger = compressionTrigger(stored, ctxReading ? ctxReading.max : null,
    usage?.model || currentModel || '', sessionInfo?.provider || '')
  const thresholdTitle = trigger
    ? 'Estimated compression threshold ' + trigger.configured +
      " — the mark sits where the gateway's threshold arithmetic puts the trigger from the two figures stored here: " + fmt(trigger.tokens) +
      ' tokens (' + Math.round(trigger.pct * 100) + '% of the window' +
      (trigger.floored ? '; the stored percentage is raised to 75% for windows under 512K' : '') + '). ' +
      "Figured from what was entered here: per-model overrides, the threshold_tokens cap, the summariser model's window and any output the route reserves by itself " +
      "move the real trigger too, and nothing compresses while compression is off — none of that is visible to this pane."
    : undefined
  // A windowless estimate has no share to mark: its hover text says what the
  // count is and why there is no window, in place of the mark's.
  const estimateTitle = ctxReading?.estimatedTotal != null
    ? "Estimated from the session's stored transcript: about " + fmt(ctxReading.estimatedTotal) +
      ' tokens. The context window is unknown, because the session has not run in the current gateway process yet.'
    : undefined

  // Elapsed time of the focused session: match it against the session list
  // (runtime id first, stored id only as fallback — two separate passes, so
  // an unrelated row can never win because it happens to sort first). A row
  // is the focused one on any of its three ids, so a compressed
  // conversation is still found once its runtime id differs from the stored
  // one. Diff its start time against the 1 Hz clock. Rows are the only
  // source of started_at, so until the list resolves — or if the focused
  // session is outside the fetched window — the readout shows "—" rather
  // than a guess. A clock rollback makes the difference negative, which
  // fmtDuration renders as "—"; no clamping to a fake 0s.
  const focusedRow =
    (focusedRuntimeId
      ? sessions.find((s) => rowIsSession(s, focusedRuntimeId))
      : undefined) ??
    (focusedStoredId
      ? sessions.find((s) => rowIsSession(s, focusedStoredId))
      : undefined)
  const elapsedMs = focusedRow && focusedRow.started_at > 0
    ? now - toEpochMs(focusedRow.started_at)
    : null

  // Turn time from stored timestamps — exact once the start is the task's
  // own prompt, estimated for a task the pane arrived in: live for the whole
  // task, then frozen at the completed duration until the next task starts.
  // While a new task's prompt is still being stored the previous reading
  // stays; with nothing stored to time it, '—'.
  const liveRaw = taskTurn?.liveMs != null ? now - taskTurn.liveMs : null
  // The clock is up to one tick old, so a prompt stored inside the current tick
  // reads as a task just started, not as a negative span ('—').
  const liveTurnMs = liveRaw != null && liveRaw > -TASK.tickMs ? Math.max(liveRaw, 0) : liveRaw
  const doneTurnMs = taskTurn?.endMs != null ? taskTurn.endMs - taskTurn.startMs : null
  const turnTitle = liveTurnMs != null
    ? 'Task started ' + fmtClock(taskTurn.liveMs) +
      (taskTurn.bg ? ' · ' + taskTurn.bg + ' background task' + (taskTurn.bg > 1 ? 's' : '') + ' running' : '')
    : doneTurnMs != null
      ? 'Last task ' + fmtClock(taskTurn.startMs) + ' → ' + fmtClock(taskTurn.endMs)
      : undefined

  return jsxs('div', {
    className: 'flex h-full flex-col gap-3 p-3 text-sm overflow-auto',
    children: [
      jsx('div', { className: 'font-semibold text-base', children: 'Token & Cost Dashboard' }),

      // Focused session summary cards
      jsxs('div', {
        className: 'grid grid-cols-3 gap-2',
        children: [
          jsxs('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) p-2', children: [
            jsx('div', { className: 'text-(--ui-text-tertiary) text-xs', children: 'Input Tokens' }),
            jsx('div', { className: 'font-mono font-bold', children: fmt(usage?.input) })
          ]}),
          jsxs('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) p-2', children: [
            jsx('div', { className: 'text-(--ui-text-tertiary) text-xs', children: 'Output Tokens' }),
            jsx('div', { className: 'font-mono font-bold', children: fmt(usage?.output) })
          ]}),
          jsxs('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) p-2', children: [
            jsx('div', { className: 'text-(--ui-text-tertiary) text-xs', children: usage?.costUsd !== null && usage ? 'Session Cost' : 'Est. Cost' }),
            jsx('div', { className: 'font-mono font-bold text-(--ui-accent)', children: fmtCost(cost) })
          ]})
        ]
      }),

      // Focused session detail
      jsxs('div', { className: 'flex flex-col gap-1 text-xs', children: [
        jsxs('div', { className: 'flex items-center justify-between', children: [
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'Focused session model' }),
          jsx('span', { className: 'font-mono truncate max-w-[160px]', children: effort ? model + ' · ' + effort : model })
        ]}),
        jsxs('div', { className: 'flex items-center justify-between', children: [
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'Session time' }),
          jsx('span', {
            className: 'font-mono',
            title: focusedRow && focusedRow.started_at > 0
              ? 'Started ' + fmtTime(focusedRow.started_at)
              : undefined,
            children: fmtDuration(elapsedMs)
          })
        ]}),
        jsxs('div', { className: 'flex items-center justify-between', children: [
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'Turn time' }),
          jsx('span', { className: 'font-mono', title: turnTitle, children: fmtDuration(liveTurnMs ?? doneTurnMs) })
        ]}),
        jsxs('div', { className: 'flex items-center justify-between', children: [
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'API calls' }),
          jsx('span', { children: fmt(usage?.calls) })
        ]}),
        ctxReading ? jsxs('div', { children: [
          jsxs('div', {
            className: 'flex items-center justify-between',
            title: ctxReading.estimatedTotal != null ? estimateTitle : thresholdTitle,
            children: [
              jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'Context used' }),
              jsxs('span', { style: { display: 'flex', alignItems: 'center' }, children: [
                jsx('span', {
                  children: ctxReading.estimatedTotal != null
                    ? '≈ ' + fmt(ctxReading.estimatedTotal) + ' tokens'
                    : (ctxReading.approximate ? '~' : '') + Math.round(ctxReading.pct) + '%'
                }),
                // The threshold's entry point, kept beside the bar it draws on.
                // It reads `edit` once a threshold is stored, whether the reading
                // knows a window to place the mark on or not: the form shows what
                // is stored either way.
                canStore ? jsx('button', {
                  type: 'button',
                  title: 'Compression threshold: the setting that places the mark on this bar',
                  onClick: () => setForm(!editing),
                  style: ACTION,
                  children: editing ? 'close' : stored ? 'edit' : 'set'
                }) : null
              ]})
            ]
          }),
          // A windowless estimate has no share to draw: neither a fill nor a mark.
          ctxReading.pct !== null && ctxReading.pct !== undefined ? jsxs('div', { style: { position: 'relative' }, children: [
            jsx('div', { className: 'h-1.5 rounded bg-(--ui-stroke-secondary) overflow-hidden', children:
              jsx('div', { className: 'h-full bg-(--ui-accent)', style: { width: Math.max(0, Math.min(100, ctxReading.pct)) + '%' } })
            }),
            // The compression threshold: a wide tick across the bar, standing
            // a little above and below it, the estimate in its hover text.
            trigger && trigger.pct < 1 ? jsx('div', {
              title: thresholdTitle,
              style: {
                position: 'absolute', left: trigger.pct * 100 + '%', top: -4, bottom: -4, width: 12,
                transform: 'translateX(-50%)', display: 'flex', justifyContent: 'center', cursor: 'help'
              },
              children: jsx('div', { style: { width: 6, borderRadius: 2, background: 'var(--ui-text-secondary)' } })
            }) : null
          ]}) : null,
          // The threshold form: the two figures config.yaml holds, typed by hand.
          editing ? jsxs('form', {
            onSubmit: saveThreshold,
            'aria-label': 'Compression threshold',
            style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
            children: [
              jsx('span', { children: 'Threshold' }),
              jsx('input', {
                name: 'threshold', type: 'number', min: 1, max: 100, step: 1, required: true, autoFocus: true,
                'aria-label': 'Compression threshold in percent',
                defaultValue: stored ? Math.round(stored.threshold * 100) : '', placeholder: '70', style: FIELD
              }),
              jsx('span', { children: '%' }),
              jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'reserved output' }),
              jsx('input', {
                name: 'reserve', type: 'number', min: 0, step: 1,
                'aria-label': 'Reserved output tokens (max_tokens), optional',
                defaultValue: stored && stored.maxTokens > 0 ? stored.maxTokens : '', placeholder: '0', style: FIELD_WIDE
              }),
              jsx('button', { type: 'submit', style: ACTION, children: 'Save' }),
              jsx('button', { type: 'button', style: ACTION, onClick: () => setForm(false), children: 'Cancel' }),
              stored ? jsx('button', { type: 'button', style: ACTION, onClick: clearThreshold, children: 'Clear' }) : null
            ]
          }) : null,
          editing ? jsx('div', { className: 'text-(--ui-text-tertiary) text-xs', children: 'compression.threshold of config.yaml and the reserved output (max_tokens), typed by hand. The pane does not read them back from the gateway.' }) : null,
          // A write the storage did not keep, said beside the form that made it.
          saveError ? jsx('div', { role: 'alert', className: 'text-xs text-(--ui-text-tertiary)', children: saveError }) : null
        ]}) : null
      ]}),

      jsx('div', { className: 'text-(--ui-text-tertiary) text-xs', children: 'Token figures track the focused session live. Hermes does not expose per-session token history, so past sessions are listed with their message counts.' }),

      // Sessions overview
      jsxs('div', { className: 'font-medium mt-1', children: ['Sessions', jsx('span', { className: 'text-(--ui-text-tertiary) font-normal', children: ' (' + sessions.length + ')' })] }),
      listError ? jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: listError }) : null,
      jsxs('div', {
        className: 'flex flex-col gap-1 max-h-56 overflow-auto',
        children: sessions.slice(0, 10).map((s, i) =>
          jsxs('div', {
            key: s.id || i,
            className: 'flex items-center justify-between text-xs rounded px-2 py-1 hover:bg-(--chrome-action-hover)',
            children: [
              jsx('span', { className: 'truncate max-w-[130px]', children: s.title || s.preview || 'Session' }),
              jsx('span', { className: 'text-(--ui-text-tertiary)', children: fmtTime(s.started_at) }),
              jsx('span', { children: fmt(s.message_count) + ' msgs' })
            ]
          })
        )
      })
    ]
  })
}

function StatusChip() {
  const usage = readUsage(useValue(host.state.focusedUsage))
  const currentModel = useValue(host.state.model)
  const inp = usage?.input || 0
  const out = usage?.output || 0
  const cost = usageCost(usage, currentModel)

  return jsx(Tip, {
    label: `Input: ${fmt(inp)} | Output: ${fmt(out)} | Cost: ${fmtCost(cost)}`,
    children: jsx('button', {
      className: cn(
        'inline-flex h-full items-center px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      type: 'button',
      onClick: () => host.notify({ kind: 'info', message: `Session: ${fmt(inp + out)} tokens, ${fmtCost(cost)}` }),
      children: [
        jsx('span', { children: '📊' }),
        jsx('span', { children: fmt(inp + out) })
      ]
    })
  })
}

export default {
  id: ID,
  name: 'Token Cost Dashboard',
  register(ctx) {
    ctx.i18n.register({
      en: {
        paneTitle: 'Token & Cost Dashboard',
        chipTip: 'Token usage & cost'
      }
    })

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'token dashboard',
      data: { placement: 'right', width: '320px' },
      render: () => jsx(DashboardPane, { storage: ctx.storage })
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 120,
      render: () => jsx(StatusChip, {})
    })
  }
}
