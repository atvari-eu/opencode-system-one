// Compaction pure helpers: host-injected system blocks never reach the
// rendered summary or the judged state; user/assistant replay is untouched.

import { describe, expect, test } from "bun:test"
import { renderSummary, collectCalls, renderCallReport, runCompaction, DEFAULTS } from "../src/compaction"

const message = (role: "user" | "assistant" | "system", text: string): any => ({
  role,
  content: [{ type: "text", text }],
})

const SYSTEM_CATALOG =
  "The Code Mode tool catalog has changed. This catalog supersedes the previous one.\n\n# Code Mode\n\n## Available tools\n- execute"

describe("renderSummary", () => {
  test("host system blocks are excluded from the hook-supplied summary", () => {
    const summary = renderSummary(
      [
        message("user", "Hi, what's my best task?"),
        message("assistant", "Ranked your tasks."),
        message("system", SYSTEM_CATALOG),
        message("system", "The Code Mode tool catalog has changed again."),
        message("user", "How does compaction work?"),
        message("assistant", "Jev decides which calls stay verbatim."),
      ],
      collectCalls([], 6),
      new Map(),
      300,
    )
    expect(summary).toContain("[user]\nHi, what's my best task?")
    expect(summary).toContain("Jev decides which calls stay verbatim.")
    expect(summary).not.toContain("Code Mode")
    expect(summary).not.toContain("Available tools")
    expect(summary).not.toContain("hanged again")
  })

  test("system rows sit inline without shifting the replay around them", () => {
    const summary = renderSummary(
      [
        message("user", "first question"),
        message("system", SYSTEM_CATALOG),
        message("assistant", "first answer"),
      ],
      collectCalls([], 6),
      new Map(),
      300,
    )
    expect(summary.startsWith("Prior conversation, kept verbatim")).toBe(true)
    expect(summary).toContain("[user]\nfirst question")
    expect(summary).toContain("[assistant]\nfirst answer")
    expect(summary).toMatch(/\[user\]|\[assistant\]/)
    expect(summary.endsWith("first answer")).toBe(true)
  })
})

describe("collectCalls", () => {
  test("tool calls inside system messages are not picked up as compaction candidates", () => {
    const messages: any[] = [
      message("user", "please summarize"),
      {
        role: "system",
        content: [
          { type: "text", text: SYSTEM_CATALOG },
          { type: "tool-call", id: "call_1", name: "execute", input: {} },
          { type: "tool-result", id: "call_1", result: { type: "text", value: "catalog" } },
        ],
      },
      message("assistant", "done"),
    ]
    const calls = collectCalls(messages, 6)
    expect(calls.map((call) => call.callMsg)).not.toContain(1)
    expect(calls).toHaveLength(0)
  })
})

describe("renderCallReport", () => {
  const mkCall = (key: string, name: string, input: unknown, result: string, pinned = false): any => ({
    key,
    name,
    input,
    resultText: result,
    resultChars: result.length,
    isError: false,
    callMsg: 10,
    callIndex: 0,
    resultMsg: 10,
    resultIndex: 1,
    pinned,
  })
  const decision = (call: any, action: "keep" | "drop_result" | "drop_call"): any => ({
    call,
    keepCall: 0.9,
    keepResult: 0.9,
    action,
    reason: action === "keep" ? "kept" : action === "drop_result" ? "result_dropped" : "call_dropped",
  })

  test("report lists judged calls and excludes pinned ones", () => {
    const dropped = mkCall("a", "bash", { command: "rm -rf /tmp/x" }, "removed everything".repeat(40))
    const kept = mkCall("b", "read", { path: "src/main.ts" }, "const x = 1;".repeat(200))
    const pinned = mkCall("c", "grep", { pattern: "todo" }, "results", true)
    const report = renderCallReport(
      [pinned, dropped, kept],
      new Map([
        [dropped.key, decision(dropped, "drop_call")],
        [kept.key, decision(kept, "keep")],
      ]),
      300,
    )
    expect(report).toContain("Dropped calls:")
    expect(report).toContain("bash")
    expect(report).toContain("dropped call+result")
    expect(report).toContain("head kept")
    expect(report).not.toContain("grep")
    expect(report).not.toContain("todo")
    // bounded: kept result head is clamped
    expect(report.length).toBeLessThan(2400)
    // no transcript replay
    expect(report).not.toContain("[user]")
    expect(report).not.toContain("[assistant]")
  })

  test("report mode ignores calls without decisions", () => {
    const undecided = mkCall("d", "execute", { path: "x" }, "result")
    const report = renderCallReport([undecided], new Map(), 300)
    expect(report).toContain("0 judged tool calls dropped")
  })

  test("runCompaction report mode appends the built-in summarizer hint", async () => {
    const dropped = mkCall("r1", "bash", { command: "ls -la" }, "files listed".repeat(60))
    const messages: any[] = [
      message("user", "list the files"),
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: dropped.key, name: "bash", input: dropped.input, result: undefined },
          { type: "tool-result", id: dropped.key, result: { type: "text", value: dropped.resultText } },
        ],
      },
    ]
    const turnJudge = async (
      questions: Array<{ id: string }>,
    ): Promise<{ answers?: Record<string, any>; usage?: Record<string, unknown> }> => ({
      answers: Object.fromEntries(
        questions.map((question) => [question.id, { noul: 0.1 }]),
      ),
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const plan = await runCompaction(
      messages,
      turnJudge as never,
      [],
      { ...DEFAULTS, preserveRecentMessages: 0, summary: "report" },
      () => 200_000,
    )
    expect(plan.replaceSummary).toContain("Older history was removed")
    expect(plan.replaceSummary).toContain("Run /compact again within one minute")
    expect((plan.summaryTokens ?? 0) < 500).toBe(true)
  })
})

