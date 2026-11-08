import assert from "node:assert/strict"
import {
  BAR_WIDTH,
  USAGE_WINDOWS,
  barFill,
  formatReset,
  meterPercent,
  meterTone,
  resetLabel,
  usageRows,
  usageSummary,
} from "../plugin/usage.js"

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Labels and order match the OpenCode Console card.
assert.deepEqual(
  USAGE_WINDOWS.map((window) => window.label),
  ["5-hour window", "Weekly", "Monthly"],
)

// Percent is clamped and rounded.
assert.equal(meterPercent({ percent: 1 }), 1)
assert.equal(meterPercent({ percent: 49 }), 49)
assert.equal(meterPercent({ percent: 49.6 }), 50)
assert.equal(meterPercent({ percent: -5 }), 0)
assert.equal(meterPercent({ percent: 250 }), 100)
assert.equal(meterPercent({ percent: "32" }), 32)
assert.equal(meterPercent({}), 0)
assert.equal(meterPercent(undefined), 0)

// Green by default, amber near the limit, red when exhausted or limited.
assert.equal(meterTone({ percent: 1 }), "success")
assert.equal(meterTone({ percent: 74 }), "success")
assert.equal(meterTone({ percent: 75 }), "warning")
assert.equal(meterTone({ percent: 89 }), "warning")
assert.equal(meterTone({ percent: 90 }), "error")
assert.equal(meterTone({ percent: 10, limited: true }), "error")

// Bar fill: empty at 0, at least one cell for any non-zero usage, full at 100.
assert.equal(barFill({ percent: 0 }), 0)
assert.equal(barFill({ percent: 1 }), 1)
assert.equal(barFill({ percent: 49 }), Math.round((BAR_WIDTH * 49) / 100))
assert.equal(barFill({ percent: 100 }), BAR_WIDTH)
assert.equal(barFill({ percent: 150 }), BAR_WIDTH)
assert.equal(barFill({ percent: 49 }, 20), 10)

// Countdown formats match the Console card: 3h 14m, 4h 10m, 22d 16h.
assert.equal(formatReset(NOW + 3 * HOUR + 14 * MINUTE + 30_000, NOW), "3h 14m")
assert.equal(formatReset(NOW + 4 * HOUR + 10 * MINUTE, NOW), "4h 10m")
assert.equal(formatReset(NOW + 22 * DAY + 16 * HOUR, NOW), "22d 16h")
assert.equal(formatReset(NOW + 45 * MINUTE, NOW), "45m")
assert.equal(formatReset(NOW + 2 * HOUR, NOW), "2h")
assert.equal(formatReset(NOW + 3 * DAY, NOW), "3d")
assert.equal(formatReset(NOW - 1, NOW), "now")
assert.equal(formatReset(NOW + 30_000, NOW), "<1m")
assert.equal(formatReset(undefined, NOW), "—")
assert.equal(formatReset("not-a-date", NOW), "—")

assert.equal(resetLabel(NOW + 3 * HOUR + 14 * MINUTE, NOW), "Resets in 3h 14m")
assert.equal(resetLabel(NOW - 1, NOW), "Resets now")
assert.equal(resetLabel(undefined, NOW), "Reset unknown")

// Partial payloads keep the canonical order and skip missing windows.
assert.deepEqual(
  usageRows({
    go: {
      monthly: { percent: 32, resetsAt: NOW },
      rolling: { percent: 1, resetsAt: NOW },
    },
  }).map((row) => row.key),
  ["rolling", "monthly"],
)
assert.deepEqual(usageRows({}), [])
assert.deepEqual(usageRows(null), [])

// Collapsed heading summary.
assert.equal(usageSummary([]), "")
assert.equal(usageSummary(null), "")
assert.equal(
  usageSummary(usageRows({ go: { rolling: { percent: 1 }, weekly: { percent: 49 }, monthly: { percent: 32 } } })),
  "max 49%",
)
assert.equal(usageSummary(usageRows({ go: { rolling: { percent: 91 } } })), "max 91%")

console.log("usage.js: ok")
