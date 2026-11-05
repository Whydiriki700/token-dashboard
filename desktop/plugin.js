/**
 * Hermes Desktop Plugin: Token Cost & Usage Dashboard
 * Live token usage and cost for the focused session, plus a session overview.
 * Hackathon entry - usefulness, reliability, creativity.
 *
 * Data sources (verified against the Hermes Desktop SDK and gateway):
 * - host.state.focusedUsage: live UsageStats for the focused session
 *   ({ model, input, output, reasoning, total, calls, context_percent,
 *      cost_usd? }). Streamed by the backend, no RPC needed.
 * - host.request('session.list', { limit, include_hidden }): session rows
 *   ({ id, title, preview, started_at, message_count, source }). Rows carry
 *   NO token or model fields, so this pane never invents per-session token
 *   totals; token figures describe the focused session only.
 */

import { cn, host, Tip, usePluginI18n, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect } from 'react'

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

function fmtTime(epochSec) {
  if (!epochSec) return ''
  const d = new Date(epochSec * 1000)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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
    costUsd: typeof u.cost_usd === 'number' ? u.cost_usd : null
  }
}

function usageCost(u, fallbackModel) {
  if (!u) return 0
  if (u.costUsd !== null) return u.costUsd
  return calcCost(u.model || fallbackModel, u.input, u.output)
}

function DashboardPane() {
  const t = usePluginI18n(ID)
  const usage = readUsage(useValue(host.state.focusedUsage))
  const currentModel = useValue(host.state.model)
  const [sessions, setSessions] = useState([])
  const [listError, setListError] = useState('')

  useEffect(() => {
    let alive = true
    let inFlight = false
    let failing = false
    async function fetchSessions() {
      // session.list can cold-spawn a profile backend and take a while;
      // never stack overlapping requests on a slow gateway.
      if (inFlight) return
      inFlight = true
      try {
        const result = await host.request('session.list', { limit: 25 })
        if (!alive) return
        setSessions(result?.sessions || [])
        setListError('')
        failing = false
      } catch (e) {
        if (!alive) return
        if (!failing) console.error('Token dashboard session.list error:', e)
        failing = true
        setListError('Session list unavailable (gateway slow or restarting)')
      } finally {
        inFlight = false
      }
    }
    fetchSessions()
    const interval = setInterval(fetchSessions, 10000)
    return () => { alive = false; clearInterval(interval) }
  }, [])

  const model = usage?.model || currentModel || 'unknown'
  const cost = usageCost(usage, currentModel)
  const ctxPct = usage?.contextPercent

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
          jsx('span', { className: 'font-mono truncate max-w-[160px]', children: model })
        ]}),
        jsxs('div', { className: 'flex items-center justify-between', children: [
          jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'API calls' }),
          jsx('span', { children: fmt(usage?.calls) })
        ]}),
        ctxPct !== null && ctxPct !== undefined ? jsxs('div', { children: [
          jsxs('div', { className: 'flex items-center justify-between', children: [
            jsx('span', { className: 'text-(--ui-text-tertiary)', children: 'Context used' }),
            jsx('span', { children: Math.round(ctxPct) + '%' })
          ]}),
          jsx('div', { className: 'h-1.5 rounded bg-(--ui-stroke-secondary) overflow-hidden', children:
            jsx('div', { className: 'h-full bg-(--ui-accent)', style: { width: Math.max(0, Math.min(100, ctxPct)) + '%' } })
          })
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
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
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
      render: () => jsx(DashboardPane, {})
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 120,
      render: () => jsx(StatusChip, {})
    })
  }
}
