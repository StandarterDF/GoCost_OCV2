// GoCost — pure cost logic for the OpenCode Go TUI plugin.
//
// This module deliberately has no OpenCode imports. It works with the plain
// objects the TUI API returns and is unit-tested with plain Node:
//
//   node tmp/test-cost.mjs
//
// Prices in the model catalog are USD per 1,000,000 tokens.

export const OPENCODE_GO_PROVIDER = "opencode-go"

const TOKENS_PER_MILLION = 1_000_000

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function isObject(value) {
  return typeof value === "object" && value !== null
}

// Missing, negative, NaN and Infinity all count as zero. Token counters and
// prices come from an external catalog, so the pure layer must never produce
// NaN because of one malformed field.
function nonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

// Total number of tokens a session has processed. Used only as a presence
// check before estimating (and for the details dialog).
export function tokensTotal(tokens) {
  if (!isObject(tokens)) return 0
  return (
    nonNegative(tokens.input) +
    nonNegative(tokens.output) +
    nonNegative(tokens.reasoning) +
    nonNegative(tokens.cache?.read) +
    nonNegative(tokens.cache?.write)
  )
}

// OpenCode's tier rule: a context tier applies only while the conversation is
// strictly larger than its `size`, and the largest applicable tier wins. The
// base entry (no `tier`) is used otherwise.
//
// `total` intentionally excludes output/reasoning: it is the size of the input
// context, exactly as OpenCode computes it.
export function pickCostTier(costs, tokens) {
  if (!Array.isArray(costs) || costs.length === 0) return undefined

  const base = costs.find((entry) => isObject(entry) && entry.tier === undefined)

  if (!isObject(tokens)) return base

  const total =
    nonNegative(tokens.input) +
    nonNegative(tokens.cache?.read) +
    nonNegative(tokens.cache?.write)

  let selected
  let selectedSize = -Infinity

  for (const entry of costs) {
    if (!isObject(entry)) continue
    const tier = entry.tier
    if (!isObject(tier) || tier.type !== "context") continue

    const size = Number(tier.size)
    if (!Number.isFinite(size) || size < 0) continue
    if (total <= size) continue

    if (size > selectedSize) {
      selected = entry
      selectedSize = size
    }
  }

  return selected ?? base
}

// Estimated USD amount for one session's token counters at the prices of the
// selected tier. Output and reasoning are both billed at the output price.
// Returns undefined for unusable input; never returns NaN.
export function estimateCost(tokens, costs) {
  if (!isObject(tokens)) return undefined

  const tier = pickCostTier(costs, tokens)
  if (!isObject(tier)) return undefined

  const input = nonNegative(tokens.input)
  const output = nonNegative(tokens.output) + nonNegative(tokens.reasoning)
  const cacheRead = nonNegative(tokens.cache?.read)
  const cacheWrite = nonNegative(tokens.cache?.write)

  const amount =
    (input * nonNegative(tier.input) +
      output * nonNegative(tier.output) +
      cacheRead * nonNegative(tier.cache?.read) +
      cacheWrite * nonNegative(tier.cache?.write)) /
    TOKENS_PER_MILLION

  return Number.isFinite(amount) ? amount : undefined
}

// True when a catalog entry has at least one non-zero price. A model that is
// free (or has no prices at all) cannot produce a useful estimate.
export function hasPricing(costs) {
  if (!Array.isArray(costs)) return false
  return costs.some(
    (entry) =>
      isObject(entry) &&
      [entry.input, entry.output, entry.cache?.read, entry.cache?.write].some(
        (price) => Number(price) > 0,
      ),
  )
}

// Plain USD formatting, without the "≈" prefix (the UI adds it, so tests can
// assert exact amounts): "$0.00", "<$0.01", "$0.12", "$1,234.50".
export function formatCost(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return USD.format(0)
  if (amount < 0.01) return "<$0.01"
  return USD.format(amount)
}

// Decides whether the plugin should draw a cost badge for this session.
//
// The badge is only for OpenCode Go sessions whose built-in cost is missing
// (OpenCode 2.2.5 reports 0 for that provider and hides the footer cost). When
// the built-in cost is positive it is already shown, so the plugin stays out of
// the way and returns undefined.
export function estimateSessionCost(session, models) {
  if (!isObject(session)) return undefined

  const reference = session.model
  if (!isObject(reference) || reference.providerID !== OPENCODE_GO_PROVIDER) return undefined

  const reported = Number(session.cost)
  if (Number.isFinite(reported) && reported > 0) return undefined

  const tokens = session.tokens
  if (!isObject(tokens) || tokensTotal(tokens) <= 0) return undefined

  const ids = [reference.id, reference.modelID].filter(
    (id) => typeof id === "string" && id.length > 0,
  )
  if (ids.length === 0) return undefined

  const list = Array.isArray(models) ? models : []
  const model = list.find(
    (entry) =>
      isObject(entry) &&
      entry.providerID === reference.providerID &&
      (ids.includes(entry.id) || ids.includes(entry.modelID)),
  )
  if (!model) return undefined
  if (!hasPricing(model.cost)) return undefined

  const amount = estimateCost(tokens, model.cost)
  if (amount === undefined || amount <= 0) return undefined

  return { amount, model }
}
