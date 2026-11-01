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
// No network access is used; prices come from the local model catalog.

import { Plugin } from "@opencode/plugin/tui"
import { Show, createMemo } from "solid-js"
import { estimateSessionCost, formatCost, pickCostTier } from "./cost.js"
import { installCostOverride } from "./patch.js"

const TITLE = "OpenCode Go: стоимость сессии"

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

export default Plugin.define({
  id: "opencode.go-cost",

  setup(context) {
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
