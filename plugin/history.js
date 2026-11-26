// Full message-history loading for the OpenCode Go cost estimate.
//
// The reactive TUI cache (`data.session.message.list`) initially contains only
// the newest page and loads older pages on demand. Cost needs the whole history,
// so this module uses the public client cursor API and keeps no OpenCode imports.

const PAGE_LIMIT = 200

function messageKey(message) {
  return typeof message?.id === "string" && message.id ? `id:${message.id}` : message
}

// Merges chronological message lists. Later lists win for existing IDs (live
// token/cost updates), while new records are appended in their source order.
export function mergeMessages(...groups) {
  const messages = []
  const positions = new Map()

  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const message of group) {
      const key = messageKey(message)
      const position = positions.get(key)
      if (position === undefined) {
        positions.set(key, messages.length)
        messages.push(message)
      } else {
        messages[position] = message
      }
    }
  }

  return messages
}

// Fetches every message page through the generated public client. The first
// request is newest-first; subsequent cursor requests must not include `order`.
export async function loadAllMessages(client, sessionID) {
  const messages = []
  let cursor

  do {
    const page = await client.message.list({
      sessionID,
      limit: PAGE_LIMIT,
      ...(cursor ? { cursor } : { order: "desc" }),
    })
    if (!Array.isArray(page?.data)) throw new Error("invalid message history page")
    messages.push(...page.data)

    const next = page?.cursor?.next
    if (next && next === cursor) throw new Error("message history cursor did not advance")
    cursor = typeof next === "string" && next.length > 0 ? next : undefined
  } while (cursor)

  return mergeMessages(messages).reverse()
}
