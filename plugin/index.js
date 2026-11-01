// GoCost — server-side companion.
//
// All the work happens in the TUI plugin (`tui.tsx`): it overrides the shared
// `context.data.session.cost` method so the built-in footer and sidebar show
// the estimated session cost in their original place, with a small fallback
// badge if the data layer is not writable.
// This server entry exists only so the plugin directory is a well-formed
// package and shows up in `opencode plugin list`. It changes nothing and uses
// no network.

export default {
  id: "opencode.go-cost",

  setup() {
    // Intentionally empty.
  },
}
