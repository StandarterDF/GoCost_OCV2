// Unit test for the pure cost logic in plugin/cost.js.
// Run: node tmp/test-cost.mjs

import assert from "node:assert/strict"
import {
  estimateCost,
  estimateMessagesCost,
  estimateSessionCost,
  formatCost,
  hasPricing,
  pickCostTier,
  sumEstimatedCosts,
  tokensTotal,
} from "../plugin/cost.js"

function assertClose(actual, expected, epsilon = 1e-12) {
  assert.equal(typeof actual, "number")
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be close to ${expected}`,
  )
}

// The real opencode-go/deepseek-v4.1-flash catalog prices and a real session.
const DEEPSEEK_TOKENS = {
  input: 255_292,
  output: 24_317,
  reasoning: 45_282,
  cache: { read: 13_084_288, write: 0 },
}
const DEEPSEEK_COSTS = [
  { input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } },
]

// 1. Base tier on the real DeepSeek Go example.
{
  const amount = estimateCost(DEEPSEEK_TOKENS, DEEPSEEK_COSTS)
  assertClose(amount, 0.119306064)
  console.log("ok: base tier real DeepSeek Go example")
}

// 2. Output and reasoning are both billed at the output price; input uses the
//    input price and cache counters use their own prices.
{
  const costs = [{ input: 1, output: 2, cache: { read: 3, write: 4 } }]
  const tokens = {
    input: 1_000_000,
    output: 500_000,
    reasoning: 500_000,
    cache: { read: 1_000_000, write: 1_000_000 },
  }
  // 1 + (0.5 + 0.5) * 2 + 3 + 4 = 10
  assertClose(estimateCost(tokens, costs), 10)
  console.log("ok: output + reasoning billed as output")
}

// 3. Context tiers: strictly greater than size, largest applicable wins, and a
//    base entry is used at exactly the tier size.
{
  const base = { input: 1, output: 0, cache: { read: 0, write: 0 } }
  const tier1000 = {
    tier: { type: "context", size: 1000 },
    input: 2,
    output: 0,
    cache: { read: 0, write: 0 },
  }
  const tier5000 = {
    tier: { type: "context", size: 5000 },
    input: 3,
    output: 0,
    cache: { read: 0, write: 0 },
  }
  // Deliberately not sorted: the largest applicable size must win regardless
  // of array order.
  const costs = [tier5000, base, tier1000]

  const at = (input) => pickCostTier(costs, { input, cache: { read: 0, write: 0 } })

  assert.equal(at(1000), base, "exactly at the tier size must use the base entry")
  assert.equal(at(1001), tier1000)
  assert.equal(at(4000), tier1000)
  assert.equal(at(5000), tier1000, "exactly at the larger size must not activate it")
  assert.equal(at(5001), tier5000, "the largest applicable tier must win")

  // Cache read and write count towards the context size, output does not.
  assert.equal(
    pickCostTier(costs, { input: 0, output: 999_999, cache: { read: 1001, write: 0 } }),
    tier1000,
  )
  assert.equal(
    pickCostTier(costs, { input: 1, output: 0, cache: { read: 0, write: 1000 } }),
    tier1000,
  )

  // Tier entries of another type are ignored.
  const foreign = {
    tier: { type: "time", size: 10 },
    input: 99,
    output: 0,
    cache: { read: 0, write: 0 },
  }
  assert.equal(
    pickCostTier([base, foreign, tier1000], { input: 1001, cache: { read: 0, write: 0 } }),
    tier1000,
  )

  console.log("ok: context tier selection (strict >, largest wins)")
}

// 4. Base fallback when the context is below every tier.
{
  const base = { input: 1, output: 0, cache: { read: 0, write: 0 } }
  const tier = {
    tier: { type: "context", size: 10_000 },
    input: 5,
    output: 0,
    cache: { read: 0, write: 0 },
  }
  const tokens = { input: 100, output: 0, cache: { read: 0, write: 0 } }
  assert.equal(pickCostTier([base, tier], tokens), base)
  assertClose(estimateCost(tokens, [base, tier]), 0.0001)
  assert.equal(pickCostTier([tier], tokens), undefined)
  console.log("ok: base fallback below tier")
}

// 5. Pricing presence and token totals.
{
  assert.equal(hasPricing(DEEPSEEK_COSTS), true)
  assert.equal(hasPricing([{ input: 0, output: 0, cache: { read: 0, write: 0 } }]), false)
  assert.equal(hasPricing([]), false)
  assert.equal(hasPricing(undefined), false)

  assert.equal(tokensTotal(DEEPSEEK_TOKENS), 13_409_179)
  assert.equal(tokensTotal(undefined), 0)
  assert.equal(tokensTotal({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }), 15)
  assert.equal(tokensTotal({ input: Symbol("bad") }), 0)
  assert.equal(hasPricing([{ input: Symbol("bad") }]), false)
  console.log("ok: hasPricing and tokensTotal")
}

// 6. Session-level rules.
{
  const catalog = [
    {
      id: "deepseek-v4.1-flash",
      modelID: "deepseek-v4.1-flash",
      providerID: "opencode-go",
      cost: DEEPSEEK_COSTS,
    },
  ]

  const session = (overrides = {}) => ({
    id: "ses_test",
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    cost: 0,
    tokens: DEEPSEEK_TOKENS,
    location: { directory: "E:/projects/demo" },
    ...overrides,
  })

  const result = estimateSessionCost(session(), catalog)
  assert.ok(result)
  assertClose(result.amount, 0.119306064)
  assert.equal(result.model, catalog[0])

  // A catalog entry matched by modelID only is fine too.
  const byModelID = [
    { modelID: "deepseek-v4.1-flash", providerID: "opencode-go", cost: DEEPSEEK_COSTS },
  ]
  assert.ok(estimateSessionCost(session({ model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" } }), byModelID))

  // Free model: all catalog prices are zero.
  const freeCatalog = [
    {
      id: "free-model",
      modelID: "free-model",
      providerID: "opencode-go",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    },
  ]
  assert.equal(
    estimateSessionCost(session({ model: { providerID: "opencode-go", id: "free-model" } }), freeCatalog),
    undefined,
  )

  // Built-in cost is already visible: do not duplicate it.
  assert.equal(estimateSessionCost(session({ cost: 0.42 }), catalog), undefined)

  // Only OpenCode Go sessions.
  assert.equal(
    estimateSessionCost(session({ model: { providerID: "deepseek", id: "deepseek-v4.1-flash" } }), catalog),
    undefined,
  )

  // Missing or empty pieces.
  assert.equal(estimateSessionCost(undefined, catalog), undefined)
  assert.equal(estimateSessionCost(null, catalog), undefined)
  assert.equal(estimateSessionCost(session({ model: undefined }), catalog), undefined)
  assert.equal(estimateSessionCost(session({ model: { providerID: "opencode-go" } }), catalog), undefined)
  assert.equal(estimateSessionCost(session({ tokens: undefined }), catalog), undefined)
  assert.equal(
    estimateSessionCost(
      session({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      catalog,
    ),
    undefined,
  )
  assert.equal(estimateSessionCost(session(), []), undefined)
  assert.equal(estimateSessionCost(session(), undefined), undefined)
  const withJunk = estimateSessionCost(session(), [catalog[0], null, {}])
  assert.ok(withJunk)
  assertClose(withJunk.amount, result.amount)
  assert.equal(withJunk.model, catalog[0])

  console.log("ok: estimateSessionCost rules")
}

// 8. Message history: every assistant message uses its own model and context
//    size. Changing the session's current model must not reprice old messages.
{
  const catalog = [
    {
      id: "cheap",
      modelID: "cheap",
      providerID: "opencode-go",
      cost: [{ input: 1, output: 2, cache: { read: 3, write: 4 } }],
    },
    {
      id: "expensive",
      modelID: "expensive",
      providerID: "opencode-go",
      cost: [{ input: 10, output: 20, cache: { read: 30, write: 40 } }],
    },
    {
      id: "native",
      modelID: "native",
      providerID: "other",
      cost: [{ input: 999, output: 999, cache: { read: 999, write: 999 } }],
    },
  ]
  const cheap = { providerID: "opencode-go", id: "cheap" }
  const expensive = { providerID: "opencode-go", id: "expensive" }
  const messages = [
    {
      id: "msg_cheap",
      type: "assistant",
      model: cheap,
      cost: 0,
      tokens: {
        input: 1_000_000,
        output: 500_000,
        reasoning: 500_000,
        cache: { read: 1_000_000, write: 1_000_000 },
      },
    },
    {
      id: "msg_expensive",
      type: "assistant",
      model: expensive,
      cost: 0,
      tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ]
  const session = {
    model: expensive,
    cost: 0,
    tokens: {
      input: 2_000_000,
      output: 500_000,
      reasoning: 500_000,
      cache: { read: 1_000_000, write: 1_000_000 },
    },
  }

  // cheap = 1 + (0.5 + 0.5) * 2 + 3 + 4 = 10; expensive = 10.
  const result = estimateSessionCost(session, catalog, messages)
  assert.ok(result)
  assertClose(result.amount, 20)
  assert.equal(result.hasGo, true)
  assert.equal(result.estimated, 20)
  assert.equal(result.reported, 0)
  assert.equal(result.breakdown.length, 2)

  // The selected model is irrelevant when history is available.
  assertClose(estimateSessionCost({ ...session, model: cheap }, catalog, messages).amount, 20)
  assertClose(
    estimateSessionCost({ ...session, model: { providerID: "other", id: "native" } }, catalog, messages)
      .amount,
    20,
  )
  assert.equal(estimateSessionCost(session, catalog, []), undefined, "loaded empty history is authoritative")

  // Duplicate records and user messages must not be billed twice.
  assertClose(
    estimateMessagesCost([messages[0], messages[0], { type: "user", cost: 100 }], catalog).amount,
    10,
  )

  console.log("ok: message history keeps each model's own tokens and prices")
}

// 9. Context tiers are selected per assistant message, not from the cumulative
//    session counters (two 600-token inputs must not activate a >1000 tier).
{
  const costs = [
    { input: 1, output: 0, cache: { read: 0, write: 0 } },
    { tier: { type: "context", size: 1000 }, input: 10, output: 0, cache: { read: 0, write: 0 } },
  ]
  const model = { providerID: "opencode-go", id: "tiered", cost: costs }
  const messages = [1, 2].map((n) => ({
    id: `msg_${n}`,
    type: "assistant",
    model: { providerID: "opencode-go", id: "tiered" },
    cost: 0,
    tokens: { input: 600, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }))
  const result = estimateSessionCost({ model, cost: 0, tokens: { input: 1200 } }, [model], messages)
  assertClose(result.amount, 0.0012)
  assert.ok(result.breakdown.every((row) => row.tier === costs[0]))

  console.log("ok: context tiers are selected per message")
}

// 10. Real per-message costs win over catalog estimates, including non-Go
//     messages in a mixed-provider session. `hasGo` keeps pure native sessions
//     out of the plugin.
{
  const goModel = {
    id: "paid-go",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const messages = [
    {
      id: "go_estimated",
      type: "assistant",
      model: { providerID: "opencode-go", id: "paid-go" },
      cost: 0,
      tokens: { input: 1_000_000 },
    },
    {
      id: "native_reported",
      type: "assistant",
      model: { providerID: "other", id: "native" },
      cost: 0.42,
      tokens: { input: 1_000_000 },
    },
    {
      id: "go_reported",
      type: "assistant",
      model: { providerID: "opencode-go", id: "paid-go" },
      cost: 0.5,
      tokens: { input: 1_000_000 },
    },
  ]
  const result = estimateMessagesCost(messages, [goModel])
  assertClose(result.amount, 1.92)
  assertClose(result.reported, 0.92)
  assertClose(result.estimated, 1)
  assert.equal(result.hasGo, true)

  const compaction = {
    id: "compaction",
    type: "compaction",
    model: { providerID: "other", id: "native" },
    cost: 0.17,
    tokens: { input: 1_000_000 },
  }
  const withCompaction = estimateMessagesCost([...messages, compaction], [goModel])
  assertClose(withCompaction.amount, 2.09)
  assertClose(withCompaction.reported, 1.09)

  const goCompaction = estimateMessagesCost(
    [{ ...compaction, model: goModel, cost: 0 }],
    [goModel],
  )
  assertClose(goCompaction.amount, 1)
  assert.equal(goCompaction.hasGo, true)

  const nativeOnly = estimateMessagesCost([messages[1]], [goModel])
  assertClose(nativeOnly.amount, 0.42)
  assert.equal(nativeOnly.hasGo, false)

  const incomplete = estimateMessagesCost(
    [{ id: "streaming", type: "assistant", model: goModel, cost: 0 }],
    [goModel],
  )
  assert.equal(incomplete.amount, 0)
  assert.equal(incomplete.hasGo, true)

  console.log("ok: reported message costs and mixed providers are preserved")
}

// 11. Fallback aggregation excludes native costs (already shown by OpenCode)
//     and sums only Go catalog estimates across the session family.
{
  const model = {
    id: "paid-go",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const root = estimateMessagesCost(
    [
      { id: "go", type: "assistant", model, cost: 0, tokens: { input: 1_000_000 } },
      { id: "native", type: "assistant", model: { providerID: "other" }, cost: 0.42 },
    ],
    [model],
  )
  const child = estimateMessagesCost(
    [{ id: "child-go", type: "assistant", model, cost: 0, tokens: { input: 400_000 } }],
    [model],
  )
  const fallback = sumEstimatedCosts([root, child])
  assertClose(fallback.amount, 1.4)
  assertClose(fallback.estimated, 1.4)
  assert.equal(fallback.reported, 0)
  assert.equal(fallback.messageCount, 2)
  assert.equal(fallback.tokens.input, 1_400_000)
  assert.ok(fallback.breakdown.every((row) => row.source === "estimated"))
  assertClose(sumEstimatedCosts([root, undefined]).amount, 1)
  assert.equal(
    sumEstimatedCosts([estimateMessagesCost([{ id: "native", type: "assistant", cost: 1 }], [])]),
    undefined,
  )
  console.log("ok: fallback sums only estimated Go costs across the family")
}

// 12. Plain USD formatting (the UI prefixes "≈").
{
  assert.equal(formatCost(0), "$0.00")
  assert.equal(formatCost(0.005), "<$0.01")
  assert.equal(formatCost(0.1193), "$0.12")
  assert.equal(formatCost(1234.5), "$1,234.50")
  assert.equal(formatCost(Number.NaN), "$0.00")
  assert.equal(formatCost(Symbol("bad")), "$0.00")
  console.log("ok: formatCost")
}

console.log("\nall tests passed")
