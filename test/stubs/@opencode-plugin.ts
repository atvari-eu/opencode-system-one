// Stub of the host-only @opencode/plugin module so test/plugin-load.test.ts
// can import src/index.ts outside a live OpenCode service: the point is load
// integrity (all imports resolvable, default shape present), not behavior.
// Index only touches Plugin.define at module scope; Provider/Model are used
// inside setup, so identity stubs are enough.

/** Identity wrapper that keeps the definition's type (the real host does the
 * same) so `import plugin from "../src/index"` is not `unknown` in tests.
 * `ctx` is deliberately `any`: this stub is load-integrity only, and the real
 * host surface is versioned upstream, not available here. */
export interface PluginDefinition {
  id: string
  setup: (ctx: any) => unknown
}

export const Plugin = { define: <T extends PluginDefinition>(definition: T): T => definition }

export const Provider = {
  ID: { make: (id: string): { id: string } => ({ id }) },
  Info: { empty: (id: unknown): unknown => ({ id }) },
}

export const Model = {
  ID: { make: (id: string): { id: string } => ({ id }) },
  Info: { default: (providerID: unknown, id: unknown): unknown => ({ providerID, id }) },
}
