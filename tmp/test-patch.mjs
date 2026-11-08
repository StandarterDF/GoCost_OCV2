// Unit test for plugin/patch.js — the shared TUI `session.cost` override.
// Run: node tmp/test-patch.mjs

import assert from "node:assert/strict"
import { estimateSessionCost } from "../plugin/cost.js"
import { installCostOverride } from "../plugin/patch.js"

function assertClose(actual, expected, epsilon = 1e-12) {
  assert.equal(typeof actual, "number")
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be close to ${expected}`,
  )
}

// The real opencode-go/deepseek-v4.1-flash catalog prices and a real session
// (same fixture as tmp/test-cost.mjs).
const DEEPSEEK_TOKENS = {
  input: 255_292,
  output: 24_317,
  reasoning: 45_282,
  cache: { read: 13_084_288, write: 0 },
}
const DEEPSEEK_COSTS = [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }]
const DEEPSEEK_AMOUNT = 0.119306064

const CATALOG = [
  {
    id: "deepseek-v4.1-flash",
    modelID: "deepseek-v4.1-flash",
    providerID: "opencode-go",
    cost: DEEPSEEK_COSTS,
  },
]

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

function goSession(id, overrides = {}) {
  return {
    id,
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    cost: 0,
    tokens: DEEPSEEK_TOKENS,
    location: { directory: "E:/projects/demo" },
    ...overrides,
  }
}

function catalogFor() {
  return CATALOG
}

// Mock of the shared TUI data layer. `session.cost` mirrors OpenCode 2.2.5:
// a subagent reports its own cost, a root session sums its family.
function createData({ sessions, family = {}, list = catalogFor, cost } = {}) {
  const session = {
    cost:
      cost ??
      function cost(sessionID) {
        const info = sessions[sessionID]
        if (!info) return 0
        if (info.parentID) return info.cost
        return (family[sessionID] ?? [sessionID]).reduce(
          (sum, id) => sum + (sessions[id]?.cost ?? 0),
          0,
        )
      },
    get: (sessionID) => sessions[sessionID],
    family: (sessionID) => family[sessionID] ?? [sessionID],
  }

  return { session, location: { model: { list } } }
}

// 1. Root session with zero native cost plus a Go subagent: the patched method
//    sums both estimates, and the built-in footer renders it as plain USD.
{
  const sessions = {
    root: goSession("root"),
    child: goSession("child", { parentID: "root" }),
  }
  const family = { root: ["root", "child"], child: ["child"] }
  const data = createData({ sessions, family })

  assert.equal(data.session.cost("root"), 0, "native cost must be zero")

  const restore = installCostOverride(data, estimateSessionCost)
  assert.equal(typeof restore, "function")

  const total = data.session.cost("root")
  assertClose(total, DEEPSEEK_AMOUNT * 2)
  assert.equal(USD.format(total), "$0.24", "built-in footer formatting")
  console.log("ok: root session sums its Go subagent family")
}

// 2. A positive native cost is returned untouched and no estimate is computed.
{
  const sessions = { root: goSession("root", { cost: 0.42 }) }
  const family = { root: ["root"] }
  let calls = 0
  const counting = (session, models) => {
    calls += 1
    return estimateSessionCost(session, models)
  }

  const data = createData({ sessions, family })
  const restore = installCostOverride(data, counting)
  assert.equal(typeof restore, "function")
  assert.equal(data.session.cost("root"), 0.42)
  assert.equal(calls, 0, "must not add estimates when the native cost exists")
  console.log("ok: positive native cost is returned untouched")
}

// 3. A subagent (parentID) estimates only itself, never the whole family.
{
  const sessions = {
    root: goSession("root", { cost: 0 }),
    child: goSession("child", { parentID: "root" }),
    sibling: goSession("sibling", { parentID: "root" }),
  }
  const family = { root: ["root", "child", "sibling"] }
  const data = createData({ sessions, family })

  let calls = 0
  const counting = (session, models) => {
    calls += 1
    return estimateSessionCost(session, models)
  }

  installCostOverride(data, counting)
  assertClose(data.session.cost("child"), DEEPSEEK_AMOUNT)
  assert.equal(calls, 1, "only the subagent itself must be estimated")
  console.log("ok: subagent estimates only itself")
}

// 4. A non-Go session with zero cost stays at zero.
{
  const sessions = {
    root: goSession("root", { model: { providerID: "deepseek", id: "deepseek-v4.1-flash" } }),
  }
  const data = createData({ sessions })

  const restore = installCostOverride(data, estimateSessionCost)
  assert.equal(typeof restore, "function")
  assert.equal(data.session.cost("root"), 0)
  assert.equal(estimateSessionCost(sessions.root, CATALOG), undefined)
  console.log("ok: non-Go session stays at zero")
}

// 5. The restore function puts the original method back.
{
  const sessions = {
    root: goSession("root"),
    child: goSession("child", { parentID: "root" }),
  }
  const family = { root: ["root", "child"], child: ["child"] }
  const data = createData({ sessions, family })
  const original = data.session.cost

  const restore = installCostOverride(data, estimateSessionCost)
  assert.notEqual(data.session.cost, original)
  assertClose(data.session.cost("root"), DEEPSEEK_AMOUNT * 2)

  restore()
  assert.equal(data.session.cost, original, "original method must be restored")
  assert.equal(data.session.cost("root"), 0, "patched behaviour must be gone")
  restore() // idempotent

  // If someone replaced the method after us, restore must not clobber it.
  const again = installCostOverride(data, estimateSessionCost)
  const foreign = () => 7
  data.session.cost = foreign
  again()
  assert.equal(data.session.cost, foreign)
  console.log("ok: restore brings the original method back")
}

// 6. Frozen and non-writable data layers are rejected instead of crashing.
{
  const frozen = createData({ sessions: { root: goSession("root") } })
  Object.freeze(frozen.session)
  assert.equal(installCostOverride(frozen, estimateSessionCost), undefined)

  const sealed = createData({ sessions: { root: goSession("root") } })
  Object.defineProperty(sealed.session, "cost", { writable: false })
  assert.equal(installCostOverride(sealed, estimateSessionCost), undefined)

  // Invalid arguments at any level.
  assert.equal(installCostOverride(undefined, estimateSessionCost), undefined)
  assert.equal(installCostOverride({}, estimateSessionCost), undefined)
  assert.equal(installCostOverride({ session: {} }, estimateSessionCost), undefined)
  assert.equal(
    installCostOverride({ session: { cost: () => 0, get: () => undefined } }, undefined),
    undefined,
  )
  console.log("ok: frozen and non-writable session objects are rejected")
}

// 7. Failures inside the override never escape: a broken `get`, a missing
//    catalog or a throwing estimator just yield the native value.
{
  const sessions = { root: goSession("root"), child: goSession("child", { parentID: "root" }) }
  // "ghost" has no entry in `sessions`, so session.get returns undefined.
  const family = { root: ["root", "ghost"], child: ["child"] }
  const data = createData({ sessions, family })

  // Missing session.get at install time.
  const broken = createData({ sessions })
  delete broken.session.get
  assert.equal(installCostOverride(broken, estimateSessionCost), undefined)

  // session.get throws when the patched method is called.
  const restore = installCostOverride(data, estimateSessionCost)
  const get = data.session.get
  data.session.get = () => {
    throw new Error("store exploded")
  }
  assert.equal(data.session.cost("root"), 0)
  data.session.get = get

  // Missing catalog: nothing to estimate, but no throw either.
  const location = data.location
  data.location = undefined
  assert.equal(data.session.cost("root"), 0)
  data.location = location

  // A throwing estimator must be ignored.
  restore()
  const throwing = installCostOverride(data, () => {
    throw new Error("estimator exploded")
  })
  assert.equal(typeof throwing, "function")
  assert.equal(data.session.cost("root"), 0)
  throwing()

  // A ghost family member (session.get returns undefined) is skipped.
  const clean = installCostOverride(data, estimateSessionCost)
  assertClose(data.session.cost("root"), DEEPSEEK_AMOUNT)
  clean()

  // A throwing original method falls back to the estimate instead of crashing.
  const throwingOriginal = createData({
    sessions: { root: goSession("root") },
    cost: () => {
      throw new Error("native exploded")
    },
  })
  const fallback = installCostOverride(throwingOriginal, estimateSessionCost)
  assert.equal(typeof fallback, "function")
  assertClose(throwingOriginal.session.cost("root"), DEEPSEEK_AMOUNT)
  fallback()

  console.log("ok: failures inside the override never throw")
}

console.log("\nall tests passed")
