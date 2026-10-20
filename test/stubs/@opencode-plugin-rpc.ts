// Stub of the host-only "@opencode/plugin/rpc" binding so editors and tsc can
// type-check src/rpc.ts and its importers (see test/stubs/@opencode-plugin.ts
// for the same pattern): Rpc.define passes the jev-config definition through,
// exactly what src/index.ts (register side) and src/tui.ts (client side)
// consume. Tests that need other host shapes rebind it with mock.module.
export const Rpc = {
  define: (definition: unknown): unknown => definition,
}
