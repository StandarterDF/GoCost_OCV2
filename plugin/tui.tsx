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
// The override lives in `patch.js`: it keeps the native value when it is
// positive and otherwise sums estimates for the session and its subagent
// family. The amount is computed from the session token counters and the model
// catalog prices (`cost.js`).
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
import { estimateSessionCost, formatCost, pickCostTier } from "./cost.js"
import { installCostOverride } from "./patch.js"
import { BAR_WIDTH, barFill, meterPercent, meterTone, resetLabel, usageRows, usageSummary } from "./usage.js"

const TITLE = "OpenCode Go: стоимость сессии"
const PANEL_TITLE = "OpenCode Go"
const CLOCK_MS = 30_000
const FILLED = "█"
const TRACK = "░"

const INTEGER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 })

function formatInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) ? INTEGER.format(number) : "0"
}

function formatPrice(value) {
  const number = Number(value)
  return Number.isFinite(number) ? String(number) : "0"
}

function tierLabel(tier) {
  if (!tier) return "не найден"
  if (!tier.tier) return "базовый (без tier)"
  const size = Number(tier.tier.size)
  return `контекстный: > ${formatInteger(size)} токенов`
}

function detailsMessage(session, model, amount) {
  const tokens = session.tokens ?? {}
  const tier = pickCostTier(model.cost, tokens)
  const price = tier ?? {}
  const modelID = model.id ?? model.modelID ?? "?"

  const lines = [
    `Модель: ${model.providerID}/${modelID}`,
    "",
    "Токены сессии:",
    `  вход: ${formatInteger(tokens.input)}`,
    `  выход: ${formatInteger(tokens.output)}`,
    `  reasoning: ${formatInteger(tokens.reasoning)}`,
    `  кэш, чтение: ${formatInteger(tokens.cache?.read)}`,
    `  кэш, запись: ${formatInteger(tokens.cache?.write)}`,
    "",
    `Тариф: ${tierLabel(tier)}`,
    `Цены за 1M токенов: вход $${formatPrice(price.input)}, выход $${formatPrice(price.output)}, ` +
      `кэш чтение $${formatPrice(price.cache?.read)}, кэш запись $${formatPrice(price.cache?.write)}`,
    `Оценка: ≈${formatCost(amount)} (${amount.toFixed(6)} USD)`,
    "",
    "OpenCode Go сообщает нулевую стоимость сессии, поэтому сумма посчитана",
    "по каталогу модели. Это оценка, а не счёт провайдера: скидки, округления",
    "и изменения цен могут дать другую итоговую сумму.",
  ]

  return lines.join("\n")
}

function showDetails(context, session, estimate) {
  if (!session || !estimate) return
  try {
    const pending = context.ui.dialog.alert({
      title: TITLE,
      message: detailsMessage(session, estimate.model, estimate.amount),
    })
    if (pending && typeof pending.catch === "function") pending.catch(() => undefined)
  } catch {
    // A failed dialog must not break the footer.
  }
}

// Fallback badge, used only when `context.data.session.cost` cannot be patched.
function GoCost(props) {
  const context = props.context
  const theme = context.theme

  const session = createMemo(() => context.data.session.get(props.sessionID))

  // Read the catalog for the session's location reactively: switching models
  // or locations must update the badge without a restart.
  const models = createMemo(() => {
    const current = session()
    if (!current?.location) return []
    return context.data.location.model.list(current.location) ?? []
  })

  const estimate = createMemo(() => estimateSessionCost(session(), models()))

  // Guarded accessor: even if the badge is evaluated for one tick after the
  // estimate disappears, it renders an empty string instead of throwing.
  const label = createMemo(() => {
    const value = estimate()
    return value === undefined ? "" : `≈${formatCost(value.amount)}`
  })

  return (
    <Show when={estimate() !== undefined}>
      <box flexShrink={0} onMouseDown={() => showDetails(context, session(), estimate())}>
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
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <GoUsage context={context} sessionID={input.sessionID} />,
    })

    // Normal path: patch the method the built-in footer and sidebar already
    // call. Nothing is registered, so the cost keeps its original position and
    // USD formatting. The returned function is the plugin cleanup and puts the
    // native method back.
    const restore = installCostOverride(context.data, estimateSessionCost)
    if (typeof restore === "function") return restore

    // Fallback: the shared data layer is frozen or the API changed, so the
    // built-in footer cannot be fed a value. Append the old badge instead.
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <GoCost context={context} sessionID={input.sessionID} />,
    })
  },
})
