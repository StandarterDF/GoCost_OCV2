// GoCost — OpenCode V2 TUI plugin.
//
// OpenCode 2.2.5 reports session.cost = 0 for the `opencode-go` provider, so
// the built-in prompt footer has no cost at all:
//
//   470.3K (48%)
//
// This plugin patches the shared TUI data layer instead of appending a badge.
// `context.data.session.cost` is the exact method the built-in footer
// (`opencode.prompt.footer`) and the built-in sidebar Context component call,
// so the estimate lands in the original place, in the original format:
//
//   470.3K (48%) · $0.17
//
// The override lives in `patch.js`: it keeps native costs for non-Go sessions
// and otherwise sums the message history for the session and its subagent
// family. Every assistant message is priced with the model and context tier
// recorded on that message (`cost.js`), so switching models cannot reprice the
// whole conversation.
//
// If the data layer is not writable, `setup` falls back to the previous
// behaviour: an `≈$0.12` badge appended to `prompt.footer.status` with a
// clickable Russian breakdown.
//
// The same plugin adds the OpenCode Go allowance to the right sidebar:
//
//   OpenCode Go                              ↻
//   5-hour window   1% used     Resets in 3h 14m
//   █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
//   Weekly         49% used     Resets in 4h 10m
//   ██████████████████░░░░░░░░░░░░░░░░░░
//   Monthly        32% used     Resets in 22d 16h
//   ████████████░░░░░░░░░░░░░░░░░░░░░░░░
//
// The values come from `context.data.location.usage.limits(location)`, the
// same cached API the built-in Usage dialog reads. Click the header to refresh
// it; the countdown ticks locally every 30 seconds.
//
// Prices come from the local model catalog. Only the allowance refresh uses
// the OpenCode Console API, and only when the panel is visible.

import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { estimateSessionCost, formatCost, sumEstimatedCosts } from "./cost.js"
import { loadAllMessages, mergeMessages } from "./history.js"
import { installCostOverride } from "./patch.js"
import { BAR_WIDTH, barFill, meterPercent, meterTone, resetLabel, usageRows, usageSummary } from "./usage.js"

const TITLE = "OpenCode Go: стоимость сессии"
const PANEL_TITLE = "OpenCode Go"
const CLOCK_MS = 30_000
const RETRY_MS = 5_000
const MAX_RETRIES = 3
const FILLED = "█"
const TRACK = "░"

const INTEGER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 })

function formatInteger(value) {
  try {
    const number = Number(value)
    return Number.isFinite(number) ? INTEGER.format(number) : "0"
  } catch {
    return "0"
  }
}

function formatPrice(value) {
  try {
    const number = Number(value)
    return Number.isFinite(number) ? String(number) : "0"
  } catch {
    return "0"
  }
}

function tierLabel(tier) {
  if (!tier) return "не найден"
  if (!tier.tier) return "базовый (без tier)"
  const size = Number(tier.tier.size)
  return `контекстный: > ${formatInteger(size)} токенов`
}

function tokenLines(tokens, indent = "  ") {
  return [
    `${indent}вход: ${formatInteger(tokens?.input)}`,
    `${indent}выход: ${formatInteger(tokens?.output)}`,
    `${indent}reasoning: ${formatInteger(tokens?.reasoning)}`,
    `${indent}кэш, чтение: ${formatInteger(tokens?.cache?.read)}`,
    `${indent}кэш, запись: ${formatInteger(tokens?.cache?.write)}`,
  ]
}

function detailsMessage(session, estimate) {
  const tokens = estimate.tokens ?? session?.tokens ?? {}
  const lines = ["Стоимость по сообщениям:", ""]

  for (const row of estimate.breakdown ?? []) {
    const model = row.model ?? {}
    const modelID = model.id ?? model.modelID ?? "?"
    const price = row.tier ?? {}
    lines.push(
      `Модель: ${model.providerID ?? "?"}/${modelID}${model.variant ? `:${model.variant}` : ""}`,
      `  Сообщений: ${formatInteger(row.messages)}`,
      `  Источник: ${row.source === "reported" ? "стоимость OpenCode" : "оценка по каталогу"}`,
      ...tokenLines(row.tokens, "    "),
    )
    if (row.source === "estimated") {
      lines.push(
        `    Тариф: ${tierLabel(row.tier)}`,
        `    Цены за 1M токенов: вход $${formatPrice(price.input)}, выход $${formatPrice(price.output)}, ` +
          `кэш чтение $${formatPrice(price.cache?.read)}, кэш запись $${formatPrice(price.cache?.write)}`,
      )
    }
    lines.push(`  Сумма: ≈${formatCost(row.amount)} (${row.amount.toFixed(6)} USD)`, "")
  }

  lines.push(
    `Всего сообщений: ${formatInteger(estimate.messageCount)}`,
    "Токены всех сообщений:",
    ...tokenLines(tokens),
    "",
  )
  if (estimate.reported > 0) {
    lines.push(`Стоимость OpenCode: ${formatCost(estimate.reported)} (${estimate.reported.toFixed(6)} USD)`)
  }
  if (estimate.estimated > 0) {
    lines.push(`Оценка по каталогу: ≈${formatCost(estimate.estimated)} (${estimate.estimated.toFixed(6)} USD)`)
  }
  lines.push(
    `Итого: ≈${formatCost(estimate.amount)} (${estimate.amount.toFixed(6)} USD)`,
    "",
    "Каждое сообщение посчитано по своей модели и размеру контекста.",
    "В fallback-метке показана только оценка Go: нативная стоимость OpenCode",
    "уже выведена отдельно. Это оценка по каталогу, а не счёт провайдера:",
    "скидки, округления и изменения цен могут дать другую итоговую сумму.",
  )

  return lines.join("\n")
}

function showDetails(context, session, estimate) {
  if (!session || !estimate) return
  try {
    const pending = context.ui.dialog.alert({
      title: TITLE,
      message: detailsMessage(session, estimate),
    })
    if (pending && typeof pending.catch === "function") pending.catch(() => undefined)
  } catch {
    // A failed dialog must not break the footer.
  }
}

// The shared TUI message cache is paginated (newest 20 records initially).
// Keep a plugin-owned full history, fetched through the public client API, and
// merge the reactive cache into it so live token/cost updates still win.
function createHistoryReader(context) {
  const [version, setVersion] = createSignal(0)
  const cache = new Map()
  const pending = new Set()
  const attempts = new Map()
  const retryTimers = new Map()
  let disposed = false
  const canLoadAll = typeof context.client?.message?.list === "function"

  const liveMessages = (sessionID) => {
    const api = context.data.session.message
    if (typeof api?.list !== "function") return undefined
    try {
      const messages = api.list(sessionID)
      return Array.isArray(messages) ? messages : undefined
    } catch {
      return undefined
    }
  }

  const load = async (sessionID) => {
    if (
      !canLoadAll ||
      pending.has(sessionID) ||
      retryTimers.has(sessionID) ||
      (attempts.get(sessionID) ?? 0) > MAX_RETRIES
    ) {
      return
    }
    pending.add(sessionID)
    try {
      const messages = await loadAllMessages(context.client, sessionID)
      if (disposed) return
      cache.set(sessionID, mergeMessages(messages, liveMessages(sessionID)))
      attempts.delete(sessionID)
      // `read()` tracks this signal inside the built-in footer computation.
      setVersion((value) => value + 1)
    } catch {
      // Retry transient failures with a delay. A signal update is required so a
      // static session renders again; the attempt cap avoids endless failing
      // requests for deleted/inaccessible sessions.
      const attempt = (attempts.get(sessionID) ?? 0) + 1
      attempts.set(sessionID, attempt)
      if (!disposed && attempt <= MAX_RETRIES) {
        const timer = setTimeout(() => {
          retryTimers.delete(sessionID)
          setVersion((value) => value + 1)
        }, RETRY_MS)
        retryTimers.set(sessionID, timer)
      }
    } finally {
      pending.delete(sessionID)
    }
  }

  const read = (session, messages) => {
    version()
    const sessionID = session?.id
    if (typeof sessionID !== "string" || sessionID.length === 0) return messages

    const live = Array.isArray(messages) ? messages : liveMessages(sessionID)
    const full = cache.get(sessionID)
    if (full) {
      const merged = mergeMessages(full, live)
      cache.set(sessionID, merged)
      return merged
    }

    void load(sessionID)
    // A newest-page cache is not a valid session total. When full pagination is
    // available, wait for it instead of displaying a confident partial amount.
    return canLoadAll ? [] : live
  }

  const ready = (sessionID) =>
    typeof sessionID !== "string" || sessionID.length === 0 || !canLoadAll || cache.has(sessionID)

  const dispose = () => {
    disposed = true
    for (const timer of retryTimers.values()) clearTimeout(timer)
    retryTimers.clear()
  }

  return { read, ready, canLoadAll, dispose }
}

// Fallback badge, used only when `context.data.session.cost` cannot be patched.
function GoCost(props) {
  const context = props.context
  const theme = context.theme
  const history = props.history

  const session = createMemo(() => context.data.session.get(props.sessionID))
  const familyIDs = createMemo(() => {
    const current = session()
    if (!current) return []
    if (current.parentID) return [props.sessionID]

    let family = []
    if (typeof context.data.session.family === "function") {
      try {
        const listed = context.data.session.family(props.sessionID)
        if (Array.isArray(listed)) family = listed
      } catch {
        family = []
      }
    }
    return [...new Set([props.sessionID, ...family])]
  })

  // If the public full-history client is unavailable, initialize empty shared
  // caches through the data layer. Non-empty caches are never re-synced because
  // sync would replace older pages with only the newest one.
  const requested = new Set()
  const syncAttempts = new Map()
  const retryTimers = new Map()
  const [retryVersion, setRetryVersion] = createSignal(0)
  let disposed = false
  onCleanup(() => {
    disposed = true
    for (const timer of retryTimers.values()) clearTimeout(timer)
    retryTimers.clear()
  })

  const retrySync = (id) => {
    if (disposed) return
    const attempt = (syncAttempts.get(id) ?? 0) + 1
    syncAttempts.set(id, attempt)
    if (attempt > MAX_RETRIES || retryTimers.has(id)) return
    const timer = setTimeout(() => {
      retryTimers.delete(id)
      setRetryVersion((value) => value + 1)
    }, RETRY_MS)
    retryTimers.set(id, timer)
  }

  createEffect(() => {
    retryVersion()
    if (history.canLoadAll) return
    for (const id of familyIDs()) {
      if (requested.has(id) || retryTimers.has(id)) continue
      const api = context.data.session.message
      if (typeof api?.sync !== "function" || typeof api?.list !== "function") continue
      try {
        const cached = api.list(id)
        if (Array.isArray(cached) && cached.length > 0) {
          syncAttempts.delete(id)
          continue
        }
        requested.add(id)
        const pending = api.sync(id)
        if (pending && typeof pending.then === "function") {
          pending
            .then(() => syncAttempts.delete(id))
            .catch(() => {
              requested.delete(id)
              retrySync(id)
            })
        } else {
          syncAttempts.delete(id)
        }
      } catch {
        requested.delete(id)
        retrySync(id)
      }
    }
  })

  const estimates = createMemo(() =>
    familyIDs().map((id) => {
      const item = context.data.session.get(id)
      if (!item) return { ready: !history.canLoadAll }

      const location = item.location ?? context.data.location.default?.()
      let models = []
      if (location) {
        try {
          models = context.data.location.model.list(location) ?? []
        } catch {
          models = []
        }
      }

      let cached
      try {
        cached = context.data.session.message?.list?.(id)
      } catch {
        cached = undefined
      }
      const ready = history.ready(id)
      const messages = history.read(item, cached)
      return { ready, estimate: estimateSessionCost(item, models, messages) }
    }),
  )

  // OpenCode still renders its native family cost in the built-in footer. The
  // fallback badge therefore shows only the missing Go catalog estimate, and
  // only once every family member's full history is available.
  const visible = createMemo(() => {
    const entries = estimates()
    if (entries.some((entry) => !entry.ready)) return undefined
    return sumEstimatedCosts(entries.map((entry) => entry.estimate))
  })

  const label = createMemo(() => {
    const value = visible()
    return value === undefined ? "" : `≈${formatCost(value.amount)}`
  })

  return (
    <Show when={visible()}>
      <box flexShrink={0} onMouseDown={() => showDetails(context, session(), visible())}>
        <text fg={theme.text.base} wrapMode="none">
          <b>{label()}</b>
        </text>
      </box>
    </Show>
  )
}

function toneColor(theme, meter) {
  const tone = meterTone(meter)
  if (tone === "error") return theme.text.feedback.error.base
  if (tone === "warning") return theme.text.feedback.warning.base
  // The healthy state must use the theme accent, not feedback.success:
  // several themes (including `orng`) intentionally map success to blue.
  return (
    theme.text.action?.primary?.$selected ??
    theme.hue?.interactive?.["200"] ??
    theme.text.base
  )
}

// Right-sidebar panel with the OpenCode Go allowance. Hidden when the runtime
// has no usage API, the location is not signed in (limits() === null), or the
// workspace has no Go allowance (go === undefined).
function GoUsage(props) {
  const context = props.context
  const theme = context.theme
  const [now, setNow] = createSignal(Date.now())

  // Local clock: reset countdowns must move even when the cached limits do not.
  const timer = setInterval(() => setNow(Date.now()), CLOCK_MS)
  onCleanup(() => clearInterval(timer))

  const location = createMemo(() => {
    const session = context.data.session.get(props.sessionID)
    return session?.location ?? context.data.location.default()
  })

  const info = createMemo(() => {
    const target = location()
    const usage = context.data.location.usage
    if (!target || !usage) return undefined
    try {
      return usage.limits(target)
    } catch {
      return undefined
    }
  })

  // `invalidate()` clears the cached value for a tick, which would otherwise
  // make the whole panel blink on every refresh. Keep the last known payload;
  // a real `null` (signed out) still clears it.
  const [lastInfo, setLastInfo] = createSignal(undefined)
  createEffect(() => {
    const value = info()
    if (value !== undefined) setLastInfo(value ?? null)
  })

  const rows = createMemo(() => usageRows(lastInfo()))
  const summary = createMemo(() => usageSummary(rows()))

  // Persisted disclosure state, same pattern as MCPClassify: undefined means
  // open, false means collapsed.
  const [view, updateView] = context.storage.store("usage", { initial: {} })
  const isOpen = () => view.open !== false
  const toggle = () => {
    void updateView((draft) => {
      draft.open = !isOpen()
    }).catch(() => undefined)
  }

  const load = (fresh) => {
    const target = location()
    const usage = context.data.location.usage
    if (!target || !usage) return
    try {
      if (fresh) usage.invalidate(target)
    } catch {
      // A read-only data layer is not fatal: `limits()` may already be warm.
    }
    try {
      const pending = usage.sync(target)
      if (pending && typeof pending.catch === "function") pending.catch(() => undefined)
    } catch {
      // The panel keeps showing the cached values.
    }
  }

  // Same trigger as the built-in Usage dialog: refresh after a turn finishes.
  const stop = context.data.on?.("session.execution.succeeded", (event) => {
    if (event?.data?.sessionID === props.sessionID) load(true)
  })
  onCleanup(() => {
    if (typeof stop === "function") stop()
  })

  onMount(() => load(true))

  return (
    <Show when={rows().length > 0}>
      <box flexDirection="column" gap={1}>
        <box flexDirection="row" gap={1} minWidth={0}>
          <box flexDirection="row" gap={1} minWidth={0} onMouseDown={toggle}>
            <text fg={theme.text.base} wrapMode="none">
              {isOpen() ? "▼" : "▶"}
            </text>
            <text fg={theme.text.base} wrapMode="none" truncate flexShrink={1} minWidth={0}>
              <b>{PANEL_TITLE}</b>
            </text>
            <Show when={!isOpen()}>
              <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                {`(${summary()})`}
              </text>
            </Show>
          </box>
          <box flexGrow={1} />
          <text fg={theme.text.muted} wrapMode="none" onMouseUp={() => load(true)}>
            ↻
          </text>
        </box>
        <Show when={isOpen()}>
          <For each={rows()}>
            {(row) => {
              const percent = () => meterPercent(row.meter)
              const filled = () => barFill(row.meter, BAR_WIDTH)
              const empty = () => Math.max(0, BAR_WIDTH - filled())
              const tone = () => toneColor(theme, row.meter)
              return (
                <box flexDirection="column" minWidth={0}>
                  <box flexDirection="row" gap={1} minWidth={0}>
                    <text fg={theme.text.base} wrapMode="none" truncate flexShrink={1} minWidth={0}>
                      <b>{row.label}</b>
                    </text>
                    <text fg={tone()} wrapMode="none" flexShrink={0}>
                      <b>{`${percent()}% used`}</b>
                    </text>
                    <box flexGrow={1} />
                    <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
                      {resetLabel(row.meter?.resetsAt, now())}
                    </text>
                  </box>
                  <text wrapMode="none">
                    <span style={{ fg: tone() }}>{FILLED.repeat(filled())}</span>
                    <span style={{ fg: theme.text.muted }}>{TRACK.repeat(empty())}</span>
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.go-cost",

  setup(context) {
    // The allowance panel is independent of the cost patch: it is registered
    // first, so it also works when `session.cost` cannot be overridden.
    const unregisterUsage = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <GoUsage context={context} sessionID={input.sessionID} />,
    })

    // The shared cache contains only the newest page. Fetch complete histories
    // through the public client and merge live cache updates into them.
    const history = createHistoryReader(context)
    const estimate = (item, models, messages) => {
      const ready = history.ready(item?.id)
      const result = estimateSessionCost(item, models, history.read(item, messages))
      if (!ready) {
        return { amount: 0, hasGo: false, reported: 0, estimated: 0, ready: false }
      }
      return result ? { ...result, ready: true } : { ready: true }
    }

    // Normal path: patch the method the built-in footer and sidebar already
    // call. Nothing is registered, so the cost keeps its original position and
    // USD formatting. The returned function is the plugin cleanup and puts the
    // native method back.
    const restore = installCostOverride(context.data, estimate, {
      syncMessages: !history.canLoadAll,
      canLoadFullHistory: history.canLoadAll,
    })
    if (typeof restore === "function") {
      return () => {
        history.dispose()
        restore()
        if (typeof unregisterUsage === "function") unregisterUsage()
      }
    }

    // Fallback: the shared data layer is frozen or the API changed, so the
    // built-in footer cannot be fed a value. Append the old badge instead.
    const unregisterCost = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <GoCost context={context} history={history} sessionID={input.sessionID} />,
    })
    return () => {
      history.dispose()
      if (typeof unregisterCost === "function") unregisterCost()
      if (typeof unregisterUsage === "function") unregisterUsage()
    }
  },
})
