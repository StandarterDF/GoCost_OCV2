// GoCost — server-side companion.
//
// All the work happens in the TUI plugin (`tui.tsx`): it appends the estimated
// session cost to the prompt footer and opens the breakdown dialog on click.
// This server entry exists only so the plugin directory is a well-formed
// package and shows up in `opencode plugin list`. It changes nothing and uses
// no network.

export default {
  id: "opencode.go-cost",

  setup() {
    // Intentionally empty.
  },
}
