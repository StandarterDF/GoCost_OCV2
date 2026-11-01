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

// Installs the override on `data.session.cost` and returns a restore function,
// or `undefined` when the data layer cannot be patched (missing methods, frozen
// or non-writable object).
//
// The native method is kept as-is for sessions/instances where it already
// returns a positive amount. Only zero-cost sessions (OpenCode Go reports 0)
// are estimated, so a provider that reports real costs is never altered.
export function installCostOverride(data, estimateSessionCost) {
  if (typeof estimateSessionCost !== "function") return undefined

  const session = data?.session
  if (!session || typeof session !== "object") return undefined
  if (typeof session.cost !== "function") return undefined
  if (typeof session.get !== "function") return undefined

  const original = session.cost

  const patched = (sessionID) => {
    // Native cost first: never alter an amount OpenCode already knows.
    let base = 0
    try {
      const reported = Number(original.call(session, sessionID))
      base = Number.isFinite(reported) && reported > 0 ? reported : 0
    } catch {
      base = 0
    }
    if (base > 0) return base

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

      let total = 0
      for (const id of ids) {
        try {
          const item = session.get(id)
          if (!item) continue
          const models = data.location?.model?.list?.(item.location) ?? []
          const estimate = estimateSessionCost(item, models)
          if (!estimate || typeof estimate !== "object") continue
          const amount = Number(estimate.amount)
          if (Number.isFinite(amount) && amount > 0) total += amount
        } catch {
          // One malformed session or catalog entry must not break the footer.
        }
      }

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
