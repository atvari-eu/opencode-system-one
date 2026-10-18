// Stub of the host-only @opencode/plugin module so test/plugin-load.test.ts
// can import src/index.ts outside a live OpenCode service: the point is load
// integrity (all imports resolvable, default shape present), not behavior.
// Index only touches Plugin.define at module scope; Provider/Model are used
// inside setup, so identity stubs are enough.

export const Plugin = { define: (definition: unknown): unknown => definition }

export const Provider = {
  ID: { make: (id: string): { id: string } => ({ id }) },
  Info: { empty: (id: unknown): unknown => ({ id }) },
}

export const Model = {
  ID: { make: (id: string): { id: string } => ({ id }) },
  Info: { default: (providerID: unknown, id: unknown): unknown => ({ providerID, id }) },
}
