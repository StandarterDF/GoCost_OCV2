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

function finiteNumber(value) {
  try {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  } catch {
    return undefined
  }
}

// Missing, negative, NaN and Infinity all count as zero. Token counters and
// prices come from an external catalog, so the pure layer must never produce
// NaN because of one malformed field.
function nonNegative(value) {
  const number = finiteNumber(value)
  return number !== undefined && number > 0 ? number : 0
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

    const size = finiteNumber(tier.size)
    if (size === undefined || size < 0) continue
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
        (price) => nonNegative(price) > 0,
      ),
  )
}

// Plain USD formatting, without the "≈" prefix (the UI adds it, so tests can
// assert exact amounts): "$0.00", "<$0.01", "$0.12", "$1,234.50".
export function formatCost(value) {
  const amount = finiteNumber(value)
  if (amount === undefined || amount <= 0) return USD.format(0)
  if (amount < 0.01) return "<$0.01"
  return USD.format(amount)
}

function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addTokens(target, tokens) {
  if (!isObject(tokens)) return
  target.input += nonNegative(tokens.input)
  target.output += nonNegative(tokens.output)
  target.reasoning += nonNegative(tokens.reasoning)
  target.cache.read += nonNegative(tokens.cache?.read)
  target.cache.write += nonNegative(tokens.cache?.write)
}

function findModel(reference, models) {
  if (!isObject(reference) || !Array.isArray(models)) return undefined
  const ids = [reference.id, reference.modelID].filter(
    (id) => typeof id === "string" && id.length > 0,
  )
  if (ids.length === 0) return undefined

  return models.find(
    (entry) =>
      isObject(entry) &&
      entry.providerID === reference.providerID &&
      (ids.includes(entry.id) || ids.includes(entry.modelID)),
  )
}

function isCostMessage(message) {
  if (!isObject(message)) return false
  if (message.type === "user" || message.role === "user") return false
  return (
    message.type === "assistant" ||
    message.role === "assistant" ||
    message.type === "compaction" ||
    message.role === "compaction" ||
    nonNegative(message.cost) > 0
  )
}

function modelLabel(model) {
  if (!isObject(model)) return "?"
  const provider = model.providerID ?? "?"
  const id = model.id ?? model.modelID ?? "?"
  const variant = model.variant ? `:${model.variant}` : ""
  return `${provider}/${id}${variant}`
}

function tierLabel(tier) {
  if (!isObject(tier?.tier)) return "base"
  return `${tier.tier.type}:${finiteNumber(tier.tier.size) ?? "?"}`
}

// Sums the actual history instead of applying the session's current model to
// cumulative counters. OpenCode stores the model, tokens and (when available)
// the real cost on assistant steps and compaction records. A positive message
// cost wins; zero-cost Go records are estimated with the model that produced
// them.
//
// Non-Go messages with a reported cost are included too, but `hasGo` lets the
// caller leave sessions that never used Go entirely to OpenCode's native cost.
export function estimateMessagesCost(messages, models) {
  if (!Array.isArray(messages)) return undefined

  const list = Array.isArray(models) ? models : []
  const seen = new Set()
  const rows = new Map()
  const tokens = emptyTokens()
  let amount = 0
  let reported = 0
  let estimated = 0
  let hasGo = false
  let messageCount = 0

  for (const message of messages) {
    if (!isCostMessage(message)) continue

    // Some data-layer versions may concatenate cached pages. Count a message
    // only once even if the same record appears more than once.
    const identity = typeof message.id === "string" && message.id ? message.id : message
    if (seen.has(identity)) continue
    seen.add(identity)

    messageCount += 1
    addTokens(tokens, message.tokens)

    const reference = message.model
    const go = isObject(reference) && reference.providerID === OPENCODE_GO_PROVIDER
    if (go) hasGo = true

    const native = nonNegative(message.cost)
    let contribution = 0
    let source
    let model
    let tier

    if (native > 0) {
      contribution = native
      source = "reported"
      model = findModel(reference, list)
    } else if (go) {
      model = findModel(reference, list)
      if (!model) continue
      tier = pickCostTier(model.cost, message.tokens)
      const value = estimateCost(message.tokens, model.cost)
      if (value === undefined || value <= 0) continue
      contribution = value
      source = "estimated"
    } else {
      continue
    }

    amount += contribution
    if (source === "reported") reported += contribution
    else estimated += contribution

    const labelModel = isObject(reference) ? { ...model, ...reference } : model
    const key = `${modelLabel(labelModel)}\0${source}\0${source === "estimated" ? tierLabel(tier) : "reported"}`
    let row = rows.get(key)
    if (!row) {
      row = {
        model: labelModel,
        tier: source === "estimated" ? tier : undefined,
        source,
        messages: 0,
        tokens: emptyTokens(),
        amount: 0,
      }
      rows.set(key, row)
    }
    row.messages += 1
    row.amount += contribution
    addTokens(row.tokens, message.tokens)
  }

  if (messageCount === 0 || (!hasGo && amount <= 0)) return undefined
  if (!Number.isFinite(amount)) return undefined

  return {
    amount,
    hasGo,
    reported,
    estimated,
    messageCount,
    tokens,
    breakdown: [...rows.values()],
  }
}

// Fallback badges are shown beside OpenCode's still-visible native cost, so
// they must contain only the catalog-estimated Go portion. This also lets the
// fallback aggregate a root session and its subagents without double counting.
export function sumEstimatedCosts(estimates) {
  if (!Array.isArray(estimates)) return undefined

  const breakdown = []
  const tokens = emptyTokens()
  let amount = 0
  let messageCount = 0

  for (const estimate of estimates) {
    const value = nonNegative(estimate?.estimated)
    if (value <= 0) continue
    amount += value
    for (const row of estimate.breakdown ?? []) {
      if (row?.source !== "estimated") continue
      breakdown.push(row)
      messageCount += nonNegative(row.messages)
      addTokens(tokens, row.tokens)
    }
  }

  if (amount <= 0 || !Number.isFinite(amount)) return undefined
  return {
    amount,
    hasGo: true,
    reported: 0,
    estimated: amount,
    messageCount,
    tokens,
    breakdown,
  }
}

// Decides whether the plugin should draw a cost badge for this session.
//
// When message history is available, each cost-bearing record is priced with
// its own model and its own context tier. The session's current model is
// irrelevant, so switching models cannot reprice the whole conversation.
// Without history (older data layers or a cache that has not loaded yet),
// retain the legacy single-model estimate as a best-effort fallback.
export function estimateSessionCost(session, models, messages) {
  if (!isObject(session)) return undefined

  if (Array.isArray(messages)) return estimateMessagesCost(messages, models)
  if (messages === null) return undefined

  const reference = session.model
  if (!isObject(reference) || reference.providerID !== OPENCODE_GO_PROVIDER) return undefined

  const reported = finiteNumber(session.cost)
  if (reported !== undefined && reported > 0) return undefined

  const tokens = session.tokens
  if (!isObject(tokens) || tokensTotal(tokens) <= 0) return undefined

  const model = findModel(reference, models)
  if (!model || !hasPricing(model.cost)) return undefined

  const result = estimateMessagesCost(
    [{ type: "assistant", model: reference, tokens, cost: 0 }],
    models,
  )
  if (!result || result.amount <= 0) return undefined

  return { ...result, model }
}
