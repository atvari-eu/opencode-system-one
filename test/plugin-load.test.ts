// Harness bug-class test: 3176904 shipped helper calls in the permission
// evaluate hook without importing them (and with isShellAction unexported in
// logic), so the plugin threw ReferenceError on every permission evaluation
// and every permissioned tool call in any session died. test files here
// never import src/index.ts, so nothing noticed. Loading the host file fails
// loudly on missing/misnamed imports (bun can't resolve a name that isn't
// exported), closing that gap.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const KNOWN_BAD: Array<[string, string]> = [
  // [identifier used in src/, must exist in logic exports or index scope]
  ["chainPermissionEffect", "src/logic.ts exports it"],
  ["shellChainSegments", "src/logic.ts exports it"],
  ["isShellAction", "src/logic.ts exports it"],
  ["approvalStatsBucket", "src/logic.ts exports it"],
  ["mergeApprovalStats", "src/logic.ts exports it"],
]

// bun's transpiler binds missing ESM named imports to undefined instead of
// failing the import (verified against the 3176904 snapshot), so a broken
// hook only detonates at call time in the service. This test is therefore
// STATIC: every value-level export of logic.ts that index.ts references in
// code must appear in index.ts's ./logic import lists, and every name in
// those lists must really be exported (or a type) by logic.ts. Comments and
// strings are stripped first so mentions don't confound the usage check.
function stripNoise(source: string): string {
  return source
    .replace(/`(?:[^`\\]|\\.)*`/g, "`STR`")
    .replace(/"(?:[^"\\]|\\.)*"/g, '"STR"')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'STR'")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
}

describe("plugin host file integrity", () => {
  const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  const logicSrc = readFileSync(new URL("../src/logic.ts", import.meta.url), "utf8")

  const importTexts = [...indexSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*"[^"]*logic[^"]*"/g)]
  const importedNames = new Set(
    importTexts.flatMap(([, block]) =>
      block
        .split(",")
        .map((part) => part.trim().replace(/^type\s+/, ""))
        .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)),
    ),
  )
  const logicValueExports = [...logicSrc.matchAll(/^export\s+(?:async\s+function|function|const|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  const logicTypeExports = [...logicSrc.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])

  test("src/index.ts loads with every import resolvable", async () => {
    const mod = await import("../src/index.ts")
    expect(mod.default).toBeTruthy()
    expect(typeof mod.default.setup).toBe("function")
  })

  test("every logic.ts value export used in index.ts is imported", () => {
    const indexCode = stripNoise(indexSrc)
    for (const name of logicValueExports) {
      const used = new RegExp(`\\b${name}\\b`).test(indexCode)
      if (used) expect({ name, used, imported: importedNames.has(name) }).toMatchObject({ imported: true })
      expect(typeof used).toBe("boolean")
    }
  })

  test("every name imported from logic.ts really is exported by it", () => {
    for (const name of importedNames) {
      const exists = logicValueExports.includes(name) || logicTypeExports.includes(name)
      expect({ name, exists }).toMatchObject({ exists: true })
    }
  })

  test("logic helpers the hooks call are really exported", async () => {
    const logic: Record<string, unknown> = await import("../src/logic.ts")
    for (const [name, why] of KNOWN_BAD) {
      expect({ name, why, exported: typeof logic[name] !== "undefined" }).toMatchObject({
        exported: true,
      })
    }
  })
})
