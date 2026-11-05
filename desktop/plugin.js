/**
 * Hermes Desktop Plugin: Token Cost & Usage Dashboard
 * Real-time token usage, cost tracking, and session analytics.
 * Hackathon entry - usefulness, reliability, creativity.
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

function fmt(n) { return n.toLocaleString() }
function fmtCost(n) { return '$' + n.toFixed(4) }

function DashboardPane() {
  const t = usePluginI18n(ID)
  const focusedSession = useValue(host.state.focusedSessionId)
  const [sessions, setSessions] = useState([])
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 })
  const [totalCost, setTotalCost] = useState(0)
  const [modelBreakdown, setModelBreakdown] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      try {
        const result = await host.request('sessions.list', { limit: 50 })
        const sess = result?.sessions || result || []
        setSessions(sess)
        
        let inp = 0, out = 0, cost = 0
        const breakdown = {}
        sess.forEach(s => {
          const m = s.model || 'unknown'
          const i = s.input_tokens || s.tokens?.input || 0
          const o = s.output_tokens || s.tokens?.output || 0
          inp += i; out += o
          const c = calcCost(m, i, o)
          cost += c
          if (!breakdown[m]) breakdown[m] = { input: 0, output: 0, cost: 0, count: 0 }
          breakdown[m].input += i
          breakdown[m].output += o
          breakdown[m].cost += c
          breakdown[m].count += 1
        })
        setTotalTokens({ input: inp, output: out })
        setTotalCost(cost)
        setModelBreakdown(breakdown)
      } catch (e) {
        console.error('Token dashboard fetch error:', e)
      }
      setLoading(false)
    }
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return jsx('div', { className: 'flex h-full items-center justify-center text-(--ui-text-tertiary)', children: 'Loading...' })
  }

  return jsxs('div', {
    className: 'flex h-full flex-col gap-3 p-3 text-sm overflow-auto',
    children: [
      // Header
      jsx('div', { className: 'font-semibold text-base', children: 'Token & Cost Dashboard' }),
      
      // Summary cards
      jsxs('div', {
        className: 'grid grid-cols-3 gap-2',
        children: [
          jsxs('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) p-2', children: [
            jsx('div', { className: 'text-(--ui-text-tertiary) text-xs', children: 'Total Input' }),
            jsx('div', { className: 'font-mono font-bold', children: fmt(totalTokens.input) })
          ]}),
          jsxs('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) p-2', children: [
            jsx('div', { className: 'text-(--ui-text-tertiary) text-xs', children: 'Total Output' }),
            jsx('div', { className: 'font-mono font-bold', children: fmt(totalTokens.output) })
          ]}),
          jsxs('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) p-2', children: [
            jsx('div', { className: 'text-(--ui-text-tertiary) text-xs', children: 'Total Cost' }),
            jsx('div', { className: 'font-mono font-bold text-(--ui-accent)', children: fmtCost(totalCost) })
          ]})
        ]
      }),

      // Model breakdown
      jsx('div', { className: 'font-medium mt-2', children: 'By Model' }),
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: Object.entries(modelBreakdown).map(([model, data]) =>
          jsxs('div', {
            key: model,
            className: 'flex items-center justify-between rounded border border-(--ui-stroke-secondary) px-2 py-1 text-xs',
            children: [
              jsx('span', { className: 'font-mono truncate max-w-[120px]', children: model }),
              jsx('span', { children: `${data.count} sess` }),
              jsx('span', { children: fmt(data.input + data.output) + ' tok' }),
              jsx('span', { className: 'text-(--ui-accent)', children: fmtCost(data.cost) })
            ]
          })
        )
      }),

      // Recent sessions
      jsx('div', { className: 'font-medium mt-2', children: 'Recent Sessions' }),
      jsxs('div', {
        className: 'flex flex-col gap-1 max-h-48 overflow-auto',
        children: sessions.slice(0, 10).map((s, i) =>
          jsxs('div', {
            key: i,
            className: 'flex items-center justify-between text-xs rounded px-2 py-1 hover:bg-(--chrome-action-hover)',
            children: [
              jsx('span', { className: 'truncate max-w-[100px]', children: s.title || s.id || 'Session' }),
              jsx('span', { className: 'text-(--ui-text-tertiary)', children: s.model || '-' }),
              jsx('span', { children: fmt((s.input_tokens||0)+(s.output_tokens||0)) })
            ]
          })
        )
      })
    ]
  })
}

function StatusChip() {
  const focusedUsage = useValue(host.state.focusedUsage)
  const inp = focusedUsage?.input_tokens || 0
  const out = focusedUsage?.output_tokens || 0
  const model = focusedUsage?.model || ''
  const cost = calcCost(model, inp, out)

  return jsx(Tip, {
    label: `Input: ${fmt(inp)} | Output: ${fmt(out)} | Cost: ${fmtCost(cost)}`,
    children: jsx('button', {
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      type: 'button',
      onClick: () => host.notify({ kind: 'info', message: `Session: ${fmt(inp+out)} tokens, ${fmtCost(cost)}` }),
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
