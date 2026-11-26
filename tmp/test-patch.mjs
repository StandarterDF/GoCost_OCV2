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
function createData({ sessions, family = {}, list = catalogFor, cost, messages, onMessageSync } = {}) {
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

  const data = { session, location: { model: { list } } }
  if (messages !== undefined) {
    session.message = {
      list: (sessionID) => messages[sessionID],
      sync: (sessionID) => {
        onMessageSync?.(sessionID)
        return Promise.resolve()
      },
    }
  }
  return data
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

// 8. Switching the selected model does not reprice earlier messages. Each new
//    assistant message adds only its own model's cost.
{
  const cheap = {
    id: "cheap",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const expensive = {
    id: "expensive",
    providerID: "opencode-go",
    cost: [{ input: 10, output: 0, cache: { read: 0, write: 0 } }],
  }
  const catalog = [cheap, expensive]
  const assistant = (id, model, input) => ({
    id,
    type: "assistant",
    model: { providerID: "opencode-go", id: model.id },
    cost: 0,
    tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const messages = {
    root: [assistant("msg_cheap", cheap, 1_000_000), assistant("msg_expensive", expensive, 1_000_000)],
  }
  const sessions = {
    root: goSession("root", {
      model: { providerID: "opencode-go", id: "expensive" },
      tokens: { input: 2_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  }
  let syncCalls = 0
  const data = createData({
    sessions,
    messages,
    list: () => catalog,
    onMessageSync: () => {
      syncCalls += 1
    },
  })
  const restore = installCostOverride(data, estimateSessionCost)
  assert.equal(typeof restore, "function")

  assertClose(data.session.cost("root"), 11)
  assert.equal(syncCalls, 0, "a non-empty cache must not be replaced by a latest-page sync")
  sessions.root.model = { providerID: "opencode-go", id: "cheap" }
  assertClose(data.session.cost("root"), 11)
  sessions.root.model = { providerID: "other", id: "native" }
  assertClose(data.session.cost("root"), 11)

  messages.root.push(assistant("msg_new", expensive, 1_000_000))
  assertClose(data.session.cost("root"), 21)
  restore()
  console.log("ok: model switching preserves per-message historical costs")
}

// 9. A positive native family total must not hide zero-cost Go messages. Real
//    non-Go message costs are included once alongside the Go estimate.
{
  const cheap = {
    id: "cheap",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = {
    root: goSession("root", { model: { providerID: "other", id: "native" }, cost: 0 }),
    child: goSession("child", {
      parentID: "root",
      model: { providerID: "other", id: "native" },
      cost: 0.42,
    }),
  }
  const messages = {
    root: [
      {
        id: "go",
        type: "assistant",
        model: { providerID: "opencode-go", id: "cheap" },
        cost: 0,
        tokens: { input: 1_000_000 },
      },
    ],
    child: [
      {
        id: "native",
        type: "assistant",
        model: { providerID: "other", id: "native" },
        cost: 0.42,
        tokens: { input: 1_000_000 },
      },
    ],
  }
  const family = { root: ["root", "child"], child: ["child"] }
  const data = createData({ sessions, messages, family, list: () => [cheap] })
  installCostOverride(data, estimateSessionCost)

  assertClose(data.session.cost("root"), 1.42)
  assertClose(data.session.cost("child"), 0.42)
  console.log("ok: positive native costs do not hide Go estimates")
}

// 10. A loaded empty message history is authoritative; cumulative counters are
//     not repriced with the current model while the cache is empty.
{
  const expensive = {
    id: "expensive",
    providerID: "opencode-go",
    cost: [{ input: 10, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = {
    root: goSession("root", {
      model: { providerID: "opencode-go", id: "expensive" },
      tokens: { input: 1_000_000 },
    }),
  }
  let syncCalls = 0
  const data = createData({
    sessions,
    messages: { root: [] },
    list: () => [expensive],
    onMessageSync: () => {
      syncCalls += 1
    },
  })
  installCostOverride(data, estimateSessionCost)
  assert.equal(data.session.cost("root"), 0)
  assert.equal(syncCalls, 1, "an empty initial cache must still be synced")
  console.log("ok: empty loaded history does not use the legacy estimate")
}

// 11. Missing message cache entries are synced once, then the reactive list is
//     used on the next cost read.
{
  const expensive = {
    id: "expensive",
    providerID: "opencode-go",
    cost: [{ input: 10, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = {
    root: goSession("root", {
      model: { providerID: "opencode-go", id: "expensive" },
      tokens: { input: 2_000_000 },
    }),
  }
  const messages = {}
  let syncCalls = 0
  const data = createData({
    sessions,
    messages,
    list: () => [expensive],
    onMessageSync: (sessionID) => {
      syncCalls += 1
      messages[sessionID] = [
        {
          id: "actual",
          type: "assistant",
          model: { providerID: "opencode-go", id: "expensive" },
          cost: 0,
          tokens: { input: 1_000_000 },
        },
      ]
    },
  })
  installCostOverride(data, estimateSessionCost)
  assertClose(data.session.cost("root"), 20)
  assertClose(data.session.cost("root"), 10)
  assert.equal(syncCalls, 1, "message sync is requested once per session")
  console.log("ok: message cache is synced and then priced from history")
}

// 12. Native family members are retained when their own message history is
//     empty or unavailable, without double counting loaded reported costs.
{
  const cheap = {
    id: "cheap",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const goMessage = {
    id: "go",
    type: "assistant",
    model: { providerID: "opencode-go", id: "cheap" },
    cost: 0,
    tokens: { input: 1_000_000 },
  }
  const sessions = {
    root: goSession("root", { cost: 0 }),
    child: goSession("child", {
      parentID: "root",
      model: { providerID: "other", id: "native" },
      cost: 0.42,
    }),
  }
  const data = createData({
    sessions,
    family: { root: ["root", "child"], child: ["child"] },
    messages: { root: [goMessage], child: [] },
    list: () => [cheap],
  })
  installCostOverride(data, estimateSessionCost)
  assertClose(data.session.cost("root"), 1.42)
  console.log("ok: partial family history retains native member costs")
}

// 13. The root's native aggregate is split correctly when a child supplies the
//     Go estimate and the root has no loaded message records.
{
  const cheap = {
    id: "cheap",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = {
    root: goSession("root", { model: { providerID: "other", id: "native" }, cost: 1 }),
    child: goSession("child", { parentID: "root", cost: 0 }),
  }
  const messages = {
    root: [],
    child: [
      {
        id: "child-go",
        type: "assistant",
        model: { providerID: "opencode-go", id: "cheap" },
        cost: 0,
        tokens: { input: 1_000_000 },
      },
    ],
  }
  const data = createData({
    sessions,
    family: { root: ["root", "child"], child: ["child"] },
    messages,
    list: () => [cheap],
  })
  installCostOverride(data, estimateSessionCost)
  assertClose(data.session.cost("root"), 2)
  console.log("ok: root native cost is separated from child estimates")
}

// 14. A rejected empty-cache sync is retried on the next cost read.
{
  const expensive = {
    id: "expensive",
    providerID: "opencode-go",
    cost: [{ input: 10, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = { root: goSession("root", { tokens: { input: 1_000_000 } }) }
  const messages = { root: [] }
  let attempts = 0
  const data = createData({
    sessions,
    messages,
    list: () => [expensive],
    onMessageSync: () => {
      attempts += 1
      if (attempts === 1) throw new Error("temporary sync failure")
      messages.root = [
        {
          id: "loaded",
          type: "assistant",
          model: { providerID: "opencode-go", id: "expensive" },
          cost: 0,
          tokens: { input: 1_000_000 },
        },
      ]
    },
  })
  installCostOverride(data, estimateSessionCost)
  assert.equal(data.session.cost("root"), 0)
  assert.equal(data.session.cost("root"), 0)
  assertClose(data.session.cost("root"), 10)
  assert.equal(attempts, 2)
  console.log("ok: rejected message syncs are retried")
}

// 15. In a partially loaded mixed-provider member, native reported costs and
//     the Go estimate are additive; `max(total, native)` would lose part of one.
{
  const cheap = {
    id: "cheap",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = {
    root: goSession("root", { model: { providerID: "other", id: "native" }, cost: 1 }),
  }
  const messages = {
    root: [
      {
        id: "native-part",
        type: "assistant",
        model: { providerID: "other", id: "native" },
        cost: 0.2,
      },
      {
        id: "go-part",
        type: "assistant",
        model: { providerID: "opencode-go", id: "cheap" },
        cost: 0,
        tokens: { input: 800_000 },
      },
    ],
  }
  const data = createData({ sessions, messages, list: () => [cheap] })
  installCostOverride(data, estimateSessionCost)
  assertClose(data.session.cost("root"), 1.8)
  console.log("ok: partial native and estimated costs are additive")
}

// 16. Full-history loading still runs when the TUI message API is absent, even
//     if the session already has a positive native cost.
{
  const cheap = {
    id: "cheap",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = {
    root: goSession("root", { model: { providerID: "other", id: "native" }, cost: 0.42 }),
  }
  const data = createData({ sessions, list: () => [cheap] })
  let loaded = false
  const estimator = (item, models) => {
    if (!loaded) return { amount: 0, hasGo: false, reported: 0, estimated: 0, ready: false }
    return {
      ...estimateSessionCost(item, models, [
        {
          id: "go",
          type: "assistant",
          model: { providerID: "opencode-go", id: "cheap" },
          cost: 0,
          tokens: { input: 1_000_000 },
        },
      ]),
      ready: true,
    }
  }
  installCostOverride(data, estimator, { canLoadFullHistory: true })
  assertClose(data.session.cost("root"), 0.42)
  loaded = true
  assertClose(data.session.cost("root"), 1.42)
  console.log("ok: full history is not bypassed by a positive native cost")
}

// 17. A native child survives a catalog error without hiding another member's
//     Go estimate.
{
  const cheap = {
    id: "cheap",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = {
    root: goSession("root", { cost: 0, location: { directory: "root" } }),
    child: goSession("child", {
      parentID: "root",
      model: { providerID: "other", id: "native" },
      cost: 0.42,
      location: { directory: "child" },
    }),
  }
  const messages = {
    root: [
      {
        id: "go",
        type: "assistant",
        model: { providerID: "opencode-go", id: "cheap" },
        cost: 0,
        tokens: { input: 1_000_000 },
      },
    ],
    child: [],
  }
  const data = createData({
    sessions,
    family: { root: ["root", "child"], child: ["child"] },
    messages,
    list: (location) => {
      if (location.directory === "child") throw new Error("child catalog failed")
      return [cheap]
    },
  })
  installCostOverride(data, estimateSessionCost)
  assertClose(data.session.cost("root"), 1.42)
  console.log("ok: native family cost survives a member catalog error")
}

// 18. Do not present a family total until every full history is ready.
{
  const cheap = {
    id: "cheap",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = {
    root: goSession("root", { cost: 0 }),
    child: goSession("child", { parentID: "root", cost: 0.42, model: { providerID: "other" } }),
  }
  const data = createData({
    sessions,
    family: { root: ["root", "child"], child: ["child"] },
    list: () => [cheap],
  })
  let childReady = false
  const estimator = (item, models) => {
    if (item.id === "child") {
      return { amount: 0, hasGo: false, reported: 0, estimated: 0, ready: childReady }
    }
    return {
      ...estimateSessionCost(item, models, [
        {
          id: "go",
          type: "assistant",
          model: { providerID: "opencode-go", id: "cheap" },
          cost: 0,
          tokens: { input: 1_000_000 },
        },
      ]),
      ready: true,
    }
  }
  installCostOverride(data, estimator, { canLoadFullHistory: true })
  assertClose(data.session.cost("root"), 0.42)
  childReady = true
  assertClose(data.session.cost("root"), 1.42)
  console.log("ok: incomplete family histories keep the native total")
}

// 19. In full-history mode, a switched-away Go member's estimation failure
//     makes the family incomplete instead of silently dropping its old cost.
{
  const cheap = {
    id: "cheap",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = {
    root: goSession("root", { cost: 0 }),
    child: goSession("child", { parentID: "root", cost: 0.42, model: { providerID: "other" } }),
  }
  const data = createData({
    sessions,
    family: { root: ["root", "child"], child: ["child"] },
    list: () => [cheap],
  })
  let failChild = true
  const estimator = (item, models) => {
    if (item.id === "child") {
      if (failChild) throw new Error("historical Go catalog failed")
      return { amount: 0, hasGo: false, reported: 0, estimated: 0, ready: true }
    }
    return {
      ...estimateSessionCost(item, models, [
        {
          id: "go",
          type: "assistant",
          model: { providerID: "opencode-go", id: "cheap" },
          cost: 0,
          tokens: { input: 1_000_000 },
        },
      ]),
      ready: true,
    }
  }
  installCostOverride(data, estimator, { canLoadFullHistory: true })
  assertClose(data.session.cost("root"), 0.42)
  failChild = false
  assertClose(data.session.cost("root"), 1.42)
  console.log("ok: switched-away member failures block partial family totals")
}

// 20. An unresolved family member blocks a full-history total until its session
//     info arrives; legacy mode retains its previous best-effort behaviour.
{
  const cheap = {
    id: "cheap",
    providerID: "opencode-go",
    cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
  }
  const sessions = { root: goSession("root", { cost: 0 }) }
  const data = createData({
    sessions,
    family: { root: ["root", "ghost"], ghost: ["ghost"] },
    list: () => [cheap],
  })
  const estimator = (item, models) => {
    if (item.id === "ghost") return { amount: 0, hasGo: false, reported: 0, estimated: 0, ready: true }
    return {
      ...estimateSessionCost(item, models, [
        {
          id: "go",
          type: "assistant",
          model: { providerID: "opencode-go", id: "cheap" },
          cost: 0,
          tokens: { input: 1_000_000 },
        },
      ]),
      ready: true,
    }
  }
  installCostOverride(data, estimator, { canLoadFullHistory: true })
  assert.equal(data.session.cost("root"), 0)
  sessions.ghost = goSession("ghost", { parentID: "root", cost: 0 })
  assertClose(data.session.cost("root"), 1)
  console.log("ok: unresolved family members block full-history totals")
}

console.log("\nall tests passed")
