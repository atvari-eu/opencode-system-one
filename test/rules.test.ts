// Plugin approval rules: OpenCode 2-style permission rules ({ action, resource,
// effect }) resolved against approval requests. Ordered, glob resources,
// last match wins; unmatched requests fall through to jev.

import { describe, expect, test } from "bun:test"
import { lookupRule, globMatches, parseApprovalRules } from "../src/logic"

const shellGit = [
  {
    action: "shell",
    resource: "git push *",
    effect: "deny",
  },
] as const

describe("globMatches", () => {
  test("whole-value wildcard matches like OpenCode rules", () => {
    expect(globMatches("git push origin main", "git push *")).toBe(true)
    expect(globMatches("git status --short", "git push *")).toBe(false)
    expect(globMatches("git status", "git status *")).toBe(true)
    expect(globMatches("src/foo.md", "src/*.md")).toBe(true)
    expect(globMatches("src/foo.mdx", "src/*.md")).toBe(false)
    expect(globMatches("ab", "a?b")).toBe(false)
    expect(globMatches("ab", "a?")).toBe(true)
    expect(globMatches("sudo *", "sudo *")).toBe(true)
    expect(globMatches("sudo apt", "sudo *")).toBe(true)
    expect(globMatches("sudo", "sudo *")).toBe(true)
  })

  test("regex metacharacters in the glob are literal", () => {
    expect(globMatches("nix shell nixpkgs#uv", "nix shell *")).toBe(true)
    expect(globMatches("a.c", "a?")).toBe(false)
    expect(globMatches("abc", "a.c")).toBe(false)
    expect(globMatches("a.c", "a.c")).toBe(true)
  })
})

describe("parseApprovalRules", () => {
  test("keeps well-formed rules, drops malformed ones", () => {
    expect(
      parseApprovalRules([
        { action: "shell", resource: "git push *", effect: "deny" },
        { resource: "src/*.md", effect: "allow" },
        { resource: "", effect: "allow" },
        { resource: "x", effect: "maybe" },
        "git push *",
        null,
      ]),
    ).toEqual([
      { action: "shell", resource: "git push *", effect: "deny" },
      { action: "*", resource: "src/*.md", effect: "allow" },
    ])
  })

  test("system-one keeps a trimmed, capped context; other effects drop it", () => {
    expect(
      parseApprovalRules([
        { resource: "src/*", effect: "system-one", context: "  routine edits - trust  " },
        { resource: "docs/*", effect: "system-one", context: "x".repeat(500) },
        { resource: "bin/*", effect: "allow", context: "ignored" },
        { resource: "lib/*", effect: "deny", context: "ignored too" },
        { resource: "vault/*", effect: "ask", context: "also ignored" },
      ]),
    ).toEqual([
      { action: "*", resource: "src/*", effect: "system-one", context: "routine edits - trust" },
      { action: "*", resource: "docs/*", effect: "system-one", context: "x".repeat(400) },
      { action: "*", resource: "bin/*", effect: "allow" },
      { action: "*", resource: "lib/*", effect: "deny" },
      { action: "*", resource: "vault/*", effect: "ask" },
    ])
  })

  test("system-one without context is valid", () => {
    expect(parseApprovalRules([{ resource: "src/*", effect: "system-one" }])).toEqual([
      { action: "*", resource: "src/*", effect: "system-one" },
    ])
  })

  test("non-arrays yield no rules", () => {
    expect(parseApprovalRules(undefined)).toEqual([])
    expect(parseApprovalRules("git push *")).toEqual([])
  })
})

describe("lookupRule", () => {
  test("matching deny rule enacts deny only when configured", () => {
    expect(lookupRule("shell", ["git push origin main"], [...shellGit])?.effect).toBe("deny")
  })

  test("non-matching requests fall through to jev", () => {
    expect(lookupRule("shell", ["git status"], [...shellGit])).toBe(null)
    expect(lookupRule("edit", ["git push *"], [...shellGit])).toBe(null)
  })

  test("rules apply in order and the last match wins", () => {
    const rules = parseApprovalRules([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status *", effect: "ask" },
      { action: "shell", resource: "git diff *", effect: "ask" },
    ])
    expect(lookupRule("shell", ["git diff --stat"], rules)?.effect).toBe("ask")
    expect(lookupRule("shell", ["bun test"], rules)?.effect).toBe("ask")
  })

  test("bare * action matches every action", () => {
    const rules = parseApprovalRules([{ resource: "raises/are/welcome", effect: "allow" }])
    expect(lookupRule("shell", ["raises/are/welcome"], rules)?.effect).toBe("allow")
    expect(lookupRule("edit", ["raises/are/welcome"], rules)?.effect).toBe("allow")
  })

  test("system-one returns the whole rule so the context rides along", () => {
    const rules = parseApprovalRules([
      { action: "edit", resource: "*", effect: "system-one", context: "local repo edits are fine unless touching secrets" },
    ])
    expect(lookupRule("edit", ["src/logic.ts"], rules)).toEqual(rules[0])
  })
})
