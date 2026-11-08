// Usage-window helpers for the OpenCode Go sidebar panel.
//
// The runtime exposes the OpenCode Console allowance as
// `context.data.location.usage.limits(location)`:
//
//   {
//     workspace: { id, name?, usageURL },
//     go: {
//       rolling: { percent, limited, resetsAt },
//       weekly:  { percent, limited, resetsAt },
//       monthly: { percent, limited, resetsAt },
//     },
//     budgets: [...],
//   }
//
// `percent` is already 0..100, `resetsAt` is a Unix timestamp in milliseconds.
// Everything here is pure and has no OpenCode imports, so it can be tested with
// plain Node.

export const USAGE_WINDOWS = Object.freeze([
  { key: "rolling", label: "5-hour window" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
])

// The session sidebar is 42 columns wide and has 2-column padding on both
// sides, so 36 cells leave a small breathing room on the right.
export const BAR_WIDTH = 36

export function meterPercent(meter) {
  const value = Number(meter?.percent)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

export function meterTone(meter) {
  if (meter?.limited === true) return "error"
  const percent = meterPercent(meter)
  if (percent >= 90) return "error"
  if (percent >= 75) return "warning"
  return "success"
}

// Number of filled cells. A non-zero usage always shows at least one cell so a
// small percentage does not look like an empty track.
export function barFill(meter, width = BAR_WIDTH) {
  const size = Math.max(1, Math.round(Number(width) || 0))
  const percent = meterPercent(meter)
  if (percent <= 0) return 0
  return Math.min(size, Math.max(1, Math.round((size * percent) / 100)))
}

// Compact "3h 14m" style countdown used next to "Resets in". Flooring minutes
// matches the Console wording; the "<1m" bucket covers the last minute.
export function formatReset(resetsAt, now = Date.now()) {
  const left = Number(resetsAt) - Number(now)
  if (!Number.isFinite(left)) return "—"
  if (left <= 0) return "now"

  const minutes = Math.floor(left / 60_000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`

  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`
}

// Stable rendering order; missing windows are skipped so a partial payload does
// not produce empty rows.
export function usageRows(info) {
  const go = info?.go
  if (!go || typeof go !== "object") return []

  return USAGE_WINDOWS.flatMap((entry) => {
    const meter = go[entry.key]
    return meter && typeof meter === "object" ? [{ ...entry, meter }] : []
  })
}

// Full label for the row, so an expired or missing timestamp does not read as
// "Resets in now" / "Resets in —".
export function resetLabel(resetsAt, now = Date.now()) {
  const value = formatReset(resetsAt, now)
  if (value === "now") return "Resets now"
  if (value === "—") return "Reset unknown"
  return `Resets in ${value}`
}
