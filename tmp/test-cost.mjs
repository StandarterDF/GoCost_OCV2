// Unit test for the pure cost logic in plugin/cost.js.
// Run: node tmp/test-cost.mjs

import assert from "node:assert/strict"
import {
  estimateCost,
  estimateSessionCost,
  formatCost,
  hasPricing,
  pickCostTier,
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

// 7. Plain USD formatting (the UI prefixes "≈").
{
  assert.equal(formatCost(0), "$0.00")
  assert.equal(formatCost(0.005), "<$0.01")
  assert.equal(formatCost(0.1193), "$0.12")
  assert.equal(formatCost(1234.5), "$1,234.50")
  assert.equal(formatCost(Number.NaN), "$0.00")
  console.log("ok: formatCost")
}

console.log("\nall tests passed")
