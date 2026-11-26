// GoCost — override the shared TUI cost method.
//
// OpenCode V2 builds the built-in prompt footer (id `opencode.prompt.footer`)
// with `context.data.session.cost(sessionID)` and formats the result through
// `Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })`.
// The built-in sidebar Context component calls the same method. Every TUI
// plugin receives the same `context.data` object, so replacing `session.cost`
// makes the estimate appear exactly where OpenCode would show its own cost:
//
//   470.3K (48%) · $0.17
//
// No slot, no second badge, no "≈" prefix.
//
// This module deliberately has no OpenCode imports: it only needs the plain
// data layer object and the estimator from `cost.js`, so it is unit-tested with
// plain Node (`node tmp/test-patch.mjs`).

function unique(values) {
  return [...new Set(values)]
}

function positiveCost(value) {
  try {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number : 0
  } catch {
    return 0
  }
}

function readMessages(api, sessionID) {
  if (typeof api?.list !== "function") return undefined
  try {
    const messages = api.list(sessionID)
    return Array.isArray(messages) ? messages : undefined
  } catch {
    return undefined
  }
}

// Installs the override on `data.session.cost` and returns a restore function,
// or `undefined` when the data layer cannot be patched (missing methods, frozen
// or non-writable object).
//
// Native cost remains authoritative for sessions that never used Go. When the
// message cache is available, the override sums each cost-bearing record using
// that record's own model and reported cost. This also fills in Go's missing
// costs in mixed-provider sessions without discarding costs OpenCode knows.
export function installCostOverride(data, estimateSessionCost, options = {}) {
  if (typeof estimateSessionCost !== "function") return undefined
  const syncMessages = options.syncMessages !== false
  const canLoadFullHistory = options.canLoadFullHistory === true

  const session = data?.session
  if (!session || typeof session !== "object") return undefined
  if (typeof session.cost !== "function") return undefined
  if (typeof session.get !== "function") return undefined

  const original = session.cost
  const messageAPI = session.message
  const canReadMessages = typeof messageAPI?.list === "function"
  const requested = new Set()

  const requestMessages = (sessionID) => {
    if (!syncMessages || !canReadMessages || typeof messageAPI?.sync !== "function") return
    if (requested.has(sessionID)) return
    requested.add(sessionID)
    try {
      const pending = messageAPI.sync(sessionID)
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => requested.delete(sessionID))
      }
    } catch {
      requested.delete(sessionID)
      // The footer can still use the cached session counters until a later load.
    }
  }

  const patched = (sessionID) => {
    // Native cost first. It is returned unchanged unless message history shows
    // that part of the session used Go and still needs an estimate.
    let base = 0
    try {
      const reported = Number(original.call(session, sessionID))
      base = Number.isFinite(reported) && reported > 0 ? reported : 0
    } catch {
      base = 0
    }
    if (base > 0 && !canReadMessages && !canLoadFullHistory) return base

    try {
      const info = session.get(sessionID)
      if (!info) return base

      // Root sessions sum their subagent family (the native method does the
      // same); a subagent only pays for itself.
      let family = []
      if (!info.parentID && typeof session.family === "function") {
        try {
          const listed = session.family(sessionID)
          if (Array.isArray(listed)) family = listed
        } catch {
          family = []
        }
      }
      const ids = info.parentID ? [sessionID] : unique([sessionID, ...family])

      // `item.cost` is native per-session cost for children, but the root's
      // value is the family total. Split off the root's own native amount so it
      // can be retained when that member's history is not loaded yet.
      let familyNative = 0
      if (!info.parentID) {
        for (const id of ids) {
          if (id === sessionID) continue
          try {
            familyNative += positiveCost(session.get(id)?.cost)
          } catch {
            // A malformed family member must not break the root estimate.
          }
        }
      }
      const rootNative = info.parentID ? base : Math.max(0, base - familyNative)

      let total = 0
      let hasGo = false
      let complete = true
      for (const id of ids) {
        let item
        let nativeAmount = 0
        try {
          item = session.get(id)
          if (!item) {
            if (canLoadFullHistory) complete = false
            continue
          }
          nativeAmount = id === sessionID ? rootNative : positiveCost(item.cost)
          const models = data.location?.model?.list?.(item.location) ?? []
          const messages = readMessages(messageAPI, id)
          // The runtime returns [] before its first sync. Never re-sync a
          // non-empty cache: sync replaces it with only the newest page.
          if (messages === undefined || messages.length === 0) requestMessages(id)

          let reportedAmount = 0
          let estimatedAmount = 0
          if (Array.isArray(messages)) {
            const estimate = estimateSessionCost(item, models, messages)
            if (estimate && typeof estimate === "object") {
              if (estimate.ready === false) complete = false
              if (estimate.hasGo === true) hasGo = true
              reportedAmount = positiveCost(estimate.reported)
              estimatedAmount = positiveCost(estimate.estimated)
            }
          } else {
            // Older data layers may not expose messages at all. For the legacy
            // session-total estimate, use this member's own native cost rather
            // than the root's family aggregate.
            const legacySession = { ...item, cost: nativeAmount }
            const estimate = estimateSessionCost(legacySession, models)
            if (estimate && typeof estimate === "object") {
              if (estimate.ready === false) complete = false
              if (estimate.hasGo === true) hasGo = true
              estimatedAmount = positiveCost(estimate.estimated ?? estimate.amount)
            }
          }

          // Native aggregates remain authoritative for reported costs missing
          // from a partial history. Add only the non-overlapping Go estimate.
          total += Math.max(nativeAmount, reportedAmount) + estimatedAmount
        } catch {
          // Preserve a member's known native cost even if its catalog/history
          // lookup fails. A missing or current-Go member may still hide an
          // estimate, so do not present the family as complete in that case.
          total += nativeAmount
          if (!item || canLoadFullHistory || item.model?.providerID === "opencode-go") {
            complete = false
          }
        }
      }

      if (!hasGo || !complete) return base
      return total > 0 ? total : base
    } catch {
      return base
    }
  }

  try {
    session.cost = patched
  } catch {
    return undefined
  }
  if (session.cost !== patched) return undefined

  return function restore() {
    if (session.cost !== patched) return
    try {
      session.cost = original
    } catch {
      // Cleanup must never throw.
    }
  }
}
