import assert from "node:assert/strict"
import { estimateMessagesCost } from "../plugin/cost.js"
import { loadAllMessages, mergeMessages } from "../plugin/history.js"

const message = (id, cost = 0, extra = {}) => ({ id, type: "assistant", cost, ...extra })

// Cursor pagination: newest-first first page, no `order` on later pages.
{
  const calls = []
  const pages = [
    { data: [message("m4"), message("m3")], cursor: { next: "cursor-1" } },
    { data: [message("m2"), message("m1")], cursor: {} },
  ]
  const client = {
    message: {
      list: async (input) => {
        calls.push(input)
        return pages.shift()
      },
    },
  }

  const result = await loadAllMessages(client, "ses_test")
  assert.deepEqual(result.map((item) => item.id), ["m1", "m2", "m3", "m4"])
  assert.deepEqual(calls, [
    { sessionID: "ses_test", limit: 200, order: "desc" },
    { sessionID: "ses_test", limit: 200, cursor: "cursor-1" },
  ])
  console.log("ok: all message pages are fetched and reversed")
}

// Duplicate IDs across pages are counted once.
{
  const client = {
    message: {
      list: async (input) =>
        input.cursor
          ? { data: [message("m1")], cursor: {} }
          : { data: [message("m2"), message("m1")], cursor: { next: "older" } },
    },
  }
  const result = await loadAllMessages(client, "ses_test")
  assert.deepEqual(result.map((item) => item.id), ["m1", "m2"])
  console.log("ok: duplicate message IDs are deduplicated")
}

// Live cache records replace stale full-history records and append new ones.
{
  const full = [message("m1", 0.1), message("m2", 0.2)]
  const live = [message("m2", 0.25), message("m3", 0.3)]
  const result = mergeMessages(full, live)
  assert.deepEqual(result.map((item) => item.id), ["m1", "m2", "m3"])
  assert.equal(result[1].cost, 0.25)
  console.log("ok: live message updates merge without duplication")
}

// More than one 200-record page: all models in the history contribute, not just
// the newest TUI window.
{
  const models = [
    { id: "cheap", providerID: "opencode-go", cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }] },
    { id: "expensive", providerID: "opencode-go", cost: [{ input: 10, output: 0, cache: { read: 0, write: 0 } }] },
  ]
  const all = Array.from({ length: 205 }, (_, index) =>
    message(`m${index}`, 0, {
      type: "assistant",
      model: models[index % 2],
      tokens: { input: 1_000_000 },
    }),
  )
  const client = {
    message: {
      list: async (input) => {
        if (!input.cursor) {
          return {
            data: all.toReversed().slice(0, 200),
            cursor: { next: "older" },
          }
        }
        return { data: all.toReversed().slice(200), cursor: {} }
      },
    },
  }
  const history = await loadAllMessages(client, "ses_long")
  const result = estimateMessagesCost(history, models)
  assert.equal(history.length, 205)
  assert.equal(result.amount, 1123)
  console.log("ok: long mixed-model histories include every page")
}

// A broken cursor fails instead of caching an infinite/partial history.
{
  const client = {
    message: {
      list: async () => ({ data: [message("m1")], cursor: { next: "same" } }),
    },
  }
  await assert.rejects(() => loadAllMessages(client, "ses_test"), /cursor did not advance/)
  console.log("ok: a stuck message cursor is rejected")
}

// Malformed pages are not cached as if they were complete history.
{
  const client = { message: { list: async () => ({ cursor: {} }) } }
  await assert.rejects(() => loadAllMessages(client, "ses_test"), /invalid message history page/)
  console.log("ok: malformed message pages are rejected")
}

console.log("\nall tests passed")
