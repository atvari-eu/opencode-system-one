import { describe, expect, test } from "bun:test"
import {
  catalogModelFacts,
  cheapestModels,
  cheaperPoolModel,
  defaultPoolSplit,
  DEFAULT_POOL,
  DEFAULT_POOL_SPLITS,
  effectiveInputPrice,
  isFreePoolModel,
  isLargePoolModel,
  MODEL_FACTS_MAX_ROWS,
  modelCacheCost,
  modelCost,
  modelFactsBlock,
  modelOutputPrice,
  modelPrice,
  modelNameKey,
  GO_PLAN_USD,
  goAllowanceFactor,
  parseGoMonthlyLimits,
  needsTrainingOptIn,
  parseCacheRatio,
  parseLeaderboard,
  parseLeaderboardPages,
  parseModelBenchmarks,
  parsePoolSplit,
  parseSessionCost,
  parseTokenCost,
  parseTrainingConsent,
  percentileRanks,
  poolCut,
  poolRunCost,
  poolShapeText,
  rankDefaultPool,
  strongestModels,
  strengthDetails,
  strengthScores,
  usageRanks,
} from "../src/logic"

const poolModel = (modelID: string, inputCost: number | undefined, outputCost: number | undefined) => ({
  providerID: "opencode",
  modelID,
  ...(inputCost === undefined ? {} : { inputCost }),
  ...(outputCost === undefined ? {} : { outputCost }),
})

const sizedModel = (
  modelID: string,
  inputCost: number,
  outputCost: number,
  contextTokens: number,
  sessionCost?: number,
) => ({
  providerID: "opencode",
  modelID,
  inputCost,
  outputCost,
  contextTokens,
  ...(sessionCost === undefined ? {} : { sessionCost }),
})

describe("parseLeaderboard", () => {
  test("reads leaderboard.pastWeek into rank order, deduped", () => {
    const json = {
      leaderboard: {
        pastWeek: [
          { rank: 2, model: "b" },
          { rank: 1, model: "a" },
          { rank: 3, model: "a" },
          { rank: 4, model: "  " },
          { rank: 5 },
        ],
      },
    }
    expect(parseLeaderboard(json)).toEqual(["a", "b"])
  })

  test("absent or malformed data yields an empty ranking", () => {
    expect(parseLeaderboard(undefined)).toEqual([])
    expect(parseLeaderboard({})).toEqual([])
    expect(parseLeaderboard({ leaderboard: { pastWeek: {} } })).toEqual([])
    expect(parseLeaderboard("nope")).toEqual([])
  })
})

describe("parseLeaderboardPages", () => {
  test("keeps only opencode.ai data pages, keyed by model id", () => {
    const json = {
      leaderboard: {
        pastWeek: [
          { model: "a", page: "https://opencode.ai/data/lab/a" },
          { model: "a", page: "https://opencode.ai/data/lab/a-again" },
          { model: "b", page: "https://evil.example/a" },
          { model: "c" },
          { model: "", page: "https://opencode.ai/data/lab/c" },
        ],
      },
    }
    expect(parseLeaderboardPages(json)).toEqual({ a: "https://opencode.ai/data/lab/a" })
  })

  test("absent or malformed data yields no pages", () => {
    expect(parseLeaderboardPages(undefined)).toEqual({})
    expect(parseLeaderboardPages({})).toEqual({})
    expect(parseLeaderboardPages({ leaderboard: { pastWeek: {} } })).toEqual({})
  })
})

describe("parseModelBenchmarks", () => {
  test("reads model.benchmarks, dropping nameless and non-numeric rows", () => {
    const json = {
      model: {
        benchmarks: [
          { name: "DeepSWE", version: "1.1", score: 74.2, harness: "OpenCode" },
          { name: "Terminal-Bench", score: 90.6 },
          { name: " ", score: 1 },
          { name: "broken", score: "high" },
          { name: "Codeforces", version: 2026, score: 3471 },
          null,
        ],
      },
    }
    expect(parseModelBenchmarks(json)).toEqual([
      { name: "DeepSWE", version: "1.1", score: 74.2 },
      { name: "Terminal-Bench", score: 90.6 },
      { name: "Codeforces", version: "2026", score: 3471 },
    ])
  })

  test("a bare array and malformed bodies are accepted safely", () => {
    expect(parseModelBenchmarks([{ name: "a", score: 1 }])).toEqual([{ name: "a", score: 1 }])
    expect(parseModelBenchmarks(undefined)).toEqual([])
    expect(parseModelBenchmarks({ model: {} })).toEqual([])
    expect(parseModelBenchmarks("nope")).toEqual([])
  })
})

describe("parseSessionCost", () => {
  test("reads sessionCost into model id -> USD per session", () => {
    const json = {
      sessionCost: [
        { model: "a", costPerSessionUsd: 0.01 },
        { model: " b ", costPerSessionUsd: 0.02 },
        { model: "", costPerSessionUsd: 1 },
        { model: "c", costPerSessionUsd: -1 },
        { model: "d", costPerSessionUsd: "x" },
        { model: "e" },
      ],
    }
    expect(parseSessionCost(json)).toEqual({ a: 0.01, b: 0.02 })
  })

  test("absent or malformed data yields no costs", () => {
    expect(parseSessionCost(undefined)).toEqual({})
    expect(parseSessionCost({})).toEqual({})
    expect(parseSessionCost({ sessionCost: {} })).toEqual({})
    expect(parseSessionCost("nope")).toEqual({})
  })
})

describe("parseTokenCost", () => {
  test("reads actual per-Mtok prices, dropping unusable sides", () => {
    const json = {
      tokenPricesUsdPer1M: [
        { model: "a", input: 0.1, output: 0.2, cachedInput: 0.01 },
        { model: " b ", input: 0.2 },
        { model: "", input: 1 },
        { model: "c", input: -1, output: "x" },
      ],
    }
    expect(parseTokenCost(json)).toEqual({ a: { input: 0.1, output: 0.2, cachedInput: 0.01 }, b: { input: 0.2 } })
  })

  test("absent or malformed data yields no prices", () => {
    expect(parseTokenCost(undefined)).toEqual({})
    expect(parseTokenCost({})).toEqual({})
    expect(parseTokenCost({ tokenPricesUsdPer1M: {} })).toEqual({})
    expect(parseTokenCost("nope")).toEqual({})
  })
})

describe("parseCacheRatio", () => {
  test("reads the percent, falling back to token counts", () => {
    const json = {
      cacheRatio: [
        { model: "a", cachedInputPercent: 99.9 },
        { model: "b", cachedInputTokens: 3, uncachedInputTokens: 1 },
        { model: "c", cachedInputPercent: 150 },
        { model: "d", cachedInputPercent: -1 },
        { model: "" },
      ],
    }
    const ratios = parseCacheRatio(json)
    expect(ratios.a).toBeCloseTo(0.999)
    expect(ratios.b).toBe(0.75)
  })

  test("absent or malformed data yields no ratios", () => {
    expect(parseCacheRatio(undefined)).toEqual({})
    expect(parseCacheRatio({})).toEqual({})
    expect(parseCacheRatio({ cacheRatio: {} })).toEqual({})
    expect(parseCacheRatio("nope")).toEqual({})
  })
})

describe("usageRanks", () => {
  test("keeps the first position per aliased model id", () => {
    expect([...usageRanks(["a", "b", "a", "glm-5.3-flash", "glm-5.3-flash-free"]).entries()]).toEqual([
      ["a", 1],
      ["b", 2],
      ["glm-5.3-flash", 4],
    ])
  })
})

describe("rankDefaultPool", () => {
  const models = [poolModel("a", 10, 40), poolModel("b", 1, 2), poolModel("c", 5, 11), poolModel("d", 7, 30)]

  test("the window is the leaderboard models, in leaderboard order, unranked excluded", () => {
    expect(rankDefaultPool(models, ["c", "a"]).map((m) => m.modelID)).toEqual(["c", "a"])
  })

  test("with no usable ranking it falls back to blended price order", () => {
    const withMissing = [...models, poolModel("e", undefined, undefined)]
    expect(rankDefaultPool(withMissing, []).map((m) => m.modelID)).toEqual(["b", "c", "d", "a", "e"])
    // A leaderboard that names only models outside this catalog degrades too.
    expect(rankDefaultPool(models, ["nope"]).map((m) => m.modelID)).toEqual(["b", "c", "d", "a"])
  })

  test("truncates the ranked window to top-K", () => {
    expect(rankDefaultPool(models, ["c", "a"], 1).map((m) => m.modelID)).toEqual(["c"])
  })

  test("the default window is the top 18 ranked models", () => {
    const many = Array.from({ length: 20 }, (_, index) => poolModel(`m${index}`, 1, 1))
    const board = many.map((model) => model.modelID)
    expect(rankDefaultPool(many, board)).toHaveLength(DEFAULT_POOL.topK)
    expect(DEFAULT_POOL.topK).toBe(18)
  })

  test("a Console free tier matches the upstream id the leaderboard reports", () => {
    const free = {
      providerID: "opencode",
      modelID: "beam-free",
      canonicalID: "reflection/beam-1.0-501b-a23b",
      inputCost: 0,
      outputCost: 0,
    }
    expect(rankDefaultPool([free], ["beam-1.0-501b-a23b"]).map((m) => m.modelID)).toEqual(["beam-free"])
    // Without the canonical id only the `-free` strip applies.
    const blind = { providerID: "opencode", modelID: "iceman-contributor-free", inputCost: 0, outputCost: 0 }
    expect(rankDefaultPool([blind], ["iceman-contributor"]).map((m) => m.modelID)).toEqual([
      "iceman-contributor-free",
    ])
  })

  test("dated build rows fold into the model they were built from", () => {
    const flash = poolModel("deepseek-v4.1-flash", 0.3, 1.2)
    const board = ["deepseek-v4.1-flash-1017-op", "deepseek-v4.1-flash-1017", "deepseek-v4.1-flash"]
    expect(rankDefaultPool([flash], board).map((m) => m.modelID)).toEqual(["deepseek-v4.1-flash"])
    // Once taken, a model does not occupy another slot from a later row.
    const other = poolModel("glm-5.3-flash", 0.15, 0.5)
    expect(
      rankDefaultPool([flash, other], [...board, "glm-5.3-flash"]).map((m) => m.modelID),
    ).toEqual(["deepseek-v4.1-flash", "glm-5.3-flash"])
  })

  test("a spelling neither id nor canonical id agrees on stays unmatched", () => {
    // Fireworks reports DeepSeek V4.1 as `deepseek-v4p1-flash`; guessing that
    // relationship would be a hard-coded alias, so the row is simply skipped.
    const flash = poolModel("deepseek-v4.1-flash", 0.3, 1.2)
    const other = poolModel("glm-5.3-flash", 0.15, 0.5)
    expect(
      rankDefaultPool([flash, other], ["deepseek-v4p1-flash", "glm-5.3-flash"]).map((m) => m.modelID),
    ).toEqual(["glm-5.3-flash"])
  })
})

describe("cheapestModels / strongestModels", () => {
  const pool = [poolModel("a", 10, 40), poolModel("b", 1, 2), poolModel("c", 5, 11)]

  test("cheapest picks the lowest blended prices", () => {
    expect(cheapestModels(pool, 2).map((m) => m.modelID)).toEqual(["b", "c"])
  })

  test("blended price is input plus output, so a cheap-to-read model is not 'cheapest'", () => {
    const readOnlyCheap = [poolModel("read-cheap", 0.1, 9), poolModel("balanced", 0.5, 1)]
    expect(modelPrice(readOnlyCheap[0]!)).toBeCloseTo(9.1)
    expect(cheapestModels(readOnlyCheap, 1).map((m) => m.modelID)).toEqual(["balanced"])
  })

  test("strongest picks the highest output prices", () => {
    expect(strongestModels(pool, 2).map((m) => m.modelID)).toEqual(["a", "c"])
  })

  test("strongest uses measured output prices and breaks ties by usage", () => {
    const models = [
      { providerID: "opencode", modelID: "listed-strong", outputCost: 2 },
      { providerID: "opencode", modelID: "measured-cheap", outputCost: 9, tokenOutputCost: 1 },
      { providerID: "opencode", modelID: "b-tie", outputCost: 1, usageRank: 5 },
      { providerID: "opencode", modelID: "a-tie", outputCost: 1, usageRank: 2 },
    ]
    expect(strongestModels(models, 3).map((m) => m.modelID)).toEqual(["listed-strong", "a-tie", "b-tie"])
  })

  test("unknown prices sort last in both directions", () => {
    const withMissing = [...pool, poolModel("d", undefined, undefined)]
    expect(cheapestModels(withMissing, 4).map((m) => m.modelID)).toEqual(["b", "c", "a", "d"])
    expect(strongestModels(withMissing, 4).map((m) => m.modelID)).toEqual(["a", "c", "b", "d"])
  })
})

describe("percentileRanks / strengthScores", () => {
  test("percentiles are 1 for the highest value and ties share their rank", () => {
    const models = [poolModel("a", 0, 10), poolModel("b", 0, 5), poolModel("c", 0, 5), poolModel("d", 0, 1)]
    const ranks = percentileRanks(models, modelOutputPrice)
    expect(ranks.get("opencode/a")).toBe(1)
    expect(ranks.get("opencode/b")).toBe(0.5)
    expect(ranks.get("opencode/c")).toBe(0.5)
    expect(ranks.get("opencode/d")).toBe(0)
  })

  test("fewer than the minimum qualifying models yields no ranks", () => {
    expect(percentileRanks([poolModel("a", 0, 1)], modelOutputPrice).size).toBe(0)
    const two = [poolModel("a", 0, 1), poolModel("b", 0, 2)]
    expect(percentileRanks(two, modelOutputPrice, 3).size).toBe(0)
  })

  test("benchmark scores outrank output price", () => {
    const bench = (modelID: string, outputCost: number, score: number) => ({
      ...poolModel(modelID, 0.1, outputCost),
      benchmarks: [{ name: "DeepSWE", version: "1.1", score }],
    })
    const models = [bench("priciest", 10, 40), bench("winner", 1, 80), bench("middle", 5, 60)]
    const scores = strengthScores(models)
    expect(scores.get("opencode/winner")!).toBeGreaterThan(scores.get("opencode/middle")!)
    expect(scores.get("opencode/middle")!).toBeGreaterThan(scores.get("opencode/priciest")!)
  })

  test("an unmeasured model sits at the neutral 0.5, not at its price", () => {
    const bench = (modelID: string, outputCost: number, score: number) => ({
      ...poolModel(modelID, 0.1, outputCost),
      benchmarks: [{ name: "DeepSWE", version: "1.1", score }],
    })
    const models = [...[bench("a", 1, 80), bench("b", 2, 60), bench("c", 3, 40)], poolModel("unscored", 0.1, 100)]
    expect(strengthScores(models).get("opencode/unscored")).toBe(0.5)
  })

  test("only 0-100 pass-rate scores count, so Elo and rating scales are ignored", () => {
    const models = [
      { ...poolModel("elo", 0.1, 1), benchmarks: [{ name: "Codeforces", score: 3471 }] },
      { ...poolModel("ga", 0.1, 1), benchmarks: [{ name: "DeepSWE", version: "1.1", score: 80 }] },
      { ...poolModel("gb", 0.1, 1), benchmarks: [{ name: "DeepSWE", version: "1.1", score: 60 }] },
      { ...poolModel("gc", 0.1, 1), benchmarks: [{ name: "DeepSWE", version: "1.1", score: 40 }] },
    ]
    expect(strengthScores(models).get("opencode/elo")).toBe(0.5)
  })

  test("a group fewer than three models report is ignored and price decides", () => {
    const models = [
      { ...poolModel("a", 0.1, 1), benchmarks: [{ name: "DeepSWE", version: "1.1", score: 90 }] },
      { ...poolModel("b", 0.1, 2), benchmarks: [{ name: "DeepSWE", version: "1.1", score: 10 }] },
    ]
    const scores = strengthScores(models)
    expect(scores.get("opencode/b")).toBe(1)
    expect(scores.get("opencode/a")).toBe(0)
  })

  test("a model scores its best harness run within a benchmark version", () => {
    const models = [
      {
        ...poolModel("multi", 0.1, 1),
        benchmarks: [
          { name: "Terminal-Bench", version: "2.1", score: 60 },
          { name: "Terminal-Bench", version: "2.1", score: 90 },
        ],
      },
      { ...poolModel("low", 0.1, 2), benchmarks: [{ name: "Terminal-Bench", version: "2.1", score: 30 }] },
      { ...poolModel("mid", 0.1, 3), benchmarks: [{ name: "Terminal-Bench", version: "2.1", score: 50 }] },
    ]
    const scores = strengthScores(models)
    expect(scores.get("opencode/multi")!).toBeGreaterThan(scores.get("opencode/mid")!)
    expect(scores.get("opencode/mid")!).toBeGreaterThan(scores.get("opencode/low")!)
  })

  test("with no usable benchmark, the output-price percentile decides", () => {
    const models = [poolModel("cheap", 0.1, 1), poolModel("pricey", 0.1, 9)]
    const scores = strengthScores(models)
    expect(scores.get("opencode/pricey")).toBe(1)
    expect(scores.get("opencode/cheap")).toBe(0)
  })
})

describe("strengthDetails", () => {
  test("reports the number of usable benchmark groups behind each score", () => {
    const bench = (modelID: string, score: number) => ({
      ...poolModel(modelID, 0.1, 1),
      benchmarks: [{ name: "DeepSWE", version: "1.1", score }],
    })
    const detail = strengthDetails([bench("a", 90), bench("b", 60), bench("c", 30)])
    expect(detail.groups.get("opencode/a")).toBe(1)
    expect(detail.groups.get("opencode/c")).toBe(1)
    expect(detail.scores.get("opencode/a")!).toBeGreaterThan(detail.scores.get("opencode/b")!)
  })

  test("the price fallback reports no benchmark groups", () => {
    const detail = strengthDetails([poolModel("cheap", 0.1, 1), poolModel("pricey", 0.1, 9)])
    expect(detail.groups.size).toBe(0)
    expect(detail.scores.get("opencode/pricey")).toBe(1)
  })
})

describe("catalogModelFacts", () => {
  const info = {
    limit: { context: 1_048_576, output: 131_072 },
    cost: [{ input: 0.3, output: 1.2, cache: { read: 0.03, write: 0 } }],
    capabilities: { tools: true, input: ["text", "image"] },
    time: { released: Date.UTC(2026, 4, 1) },
    headers: { authorization: "secret" },
    body: { key: "secret" },
    settings: { token: "secret" },
  }

  test("whitelists catalog fields and never carries host overlays", () => {
    const facts = catalogModelFacts("opencode", "model-x", info)!
    expect(facts).toEqual({
      providerID: "opencode",
      modelID: "model-x",
      contextTokens: 1_048_576,
      outputTokens: 131_072,
      inputCost: 0.3,
      outputCost: 1.2,
      cacheReadCost: 0.03,
      releasedAt: Date.UTC(2026, 4, 1),
      tools: true,
      imageInput: true,
    })
    expect(Object.keys(facts)).not.toContain("headers")
    expect(Object.keys(facts)).not.toContain("body")
    expect(Object.keys(facts)).not.toContain("settings")
  })

  test("a partial entry keeps what it has, and garbage yields nothing", () => {
    expect(catalogModelFacts("acme", "bare", { limit: { context: 200_000 } })).toEqual({
      providerID: "acme",
      modelID: "bare",
      contextTokens: 200_000,
    })
    expect(catalogModelFacts("acme", "none", {})).toBeUndefined()
    expect(catalogModelFacts("acme", "none", undefined)).toBeUndefined()
    expect(catalogModelFacts("acme", "none", "nope")).toBeUndefined()
  })
})

describe("modelFactsBlock", () => {
  const facts = (modelID: string, extra: Record<string, unknown> = {}) => ({
    providerID: "acme",
    modelID,
    contextTokens: 1_000_000,
    ...extra,
  })
  const modelsFor = (keys: string[]) =>
    keys.map((key) => {
      const [providerID, modelID] = key.split("/") as [string, string]
      return { providerID, modelID }
    })

  test("renders one row per model, deduped by model key", () => {
    const table = new Map([
      ["acme/base", facts("base")],
      ["acme/fast", facts("fast")],
    ])
    const block = modelFactsBlock(
      modelsFor(["acme/base", "acme/base", "acme/fast"]),
      (p, m) => table.get(`${p}/${m}`),
    )
    expect(block).toContain("<candidate-models>")
    expect(block).toContain("- acme/base: ctx 1M")
    expect(block).toContain("- acme/fast: ctx 1M")
    expect(block.match(/- acme\/base:/g)?.length).toBe(1)
  })

  test("strength is emitted only when the model reports benchmark groups", () => {
    const bench = (modelID: string, score: number) =>
      facts(modelID, { benchmarks: [{ name: "DeepSWE", version: "1.1", score }] })
    const table = new Map([
      ["acme/a", bench("a", 90)],
      ["acme/b", bench("b", 60)],
      ["acme/c", bench("c", 30)],
      ["acme/d", facts("d", { outputCost: 10 })],
    ])
    const block = modelFactsBlock(modelsFor([...table.keys()]), (p, m) => table.get(`${p}/${m}`))
    expect(block).toContain("- acme/a: ctx 1M; strength")
    expect(block).toContain("over 1 benchmarks")
    expect(block).not.toContain("- acme/d: ctx 1M; strength")
  })

  test("an empty or throwing facts callback renders nothing", () => {
    const models = [{ providerID: "acme", modelID: "base" }]
    expect(modelFactsBlock(models, () => undefined)).toBe("")
    expect(
      modelFactsBlock(models, () => {
        throw new Error("boom")
      }),
    ).toBe("")
  })

  test("every offered model keeps its row; long rows are trimmed", () => {
    const table = new Map(Array.from({ length: 20 }, (_, i) => [`acme/m${i}`, facts(`m${i}`)]))
    const models = modelsFor(Array.from({ length: 20 }, (_, i) => `acme/m${i}`))
    const rows = (block: string) => block.split("\n").filter((line) => line.startsWith("- ")).length
    expect(rows(modelFactsBlock(models, (p, m) => table.get(`${p}/${m}`)))).toBe(MODEL_FACTS_MAX_ROWS)
    const tight = modelFactsBlock(models, (p, m) => table.get(`${p}/${m}`), 12)
    expect(rows(tight)).toBe(MODEL_FACTS_MAX_ROWS)
    expect(tight).toContain("- acme/m0...")
  })
})

const cut = (
  overrides: Partial<typeof DEFAULT_POOL_SPLITS.default> = {},
  kind: "default" | "review" = "default",
) => ({ ...DEFAULT_POOL_SPLITS[kind], ...overrides })

describe("parsePoolSplit", () => {
  test("missing and malformed values keep the kind's built-in cut", () => {
    for (const raw of [undefined, true, "no", 42, []]) {
      expect(parsePoolSplit(raw)).toEqual(DEFAULT_POOL_SPLITS.default)
      expect(parsePoolSplit(raw, "review")).toEqual(DEFAULT_POOL_SPLITS.review)
    }
  })

  test("counts floor, clamp to the window, and 0 is valid", () => {
    const parsed = parsePoolSplit({ topK: 3, cheap: 9, popular: 0, strong: 1.9 })
    expect(parsed).toEqual({
      cheap: 3,
      popular: 0,
      strong: 1,
      topK: 3,
      minContext: DEFAULT_POOL.defaultMinContext,
    })
  })

  test("topK clamps 1-40 and minContext 0 disables the floor", () => {
    expect(parsePoolSplit({ topK: 0 }).topK).toBe(1)
    expect(parsePoolSplit({ topK: 99 }).topK).toBe(40)
    expect(parsePoolSplit({ minContext: 0 }).minContext).toBe(0)
    expect(parsePoolSplit({ minContext: 1_000 }, "review").minContext).toBe(1_000)
  })

  test("fields merge independently over the kind's defaults", () => {
    const parsed = parsePoolSplit({ cheap: 2 }, "review")
    expect(parsed.cheap).toBe(2)
    expect(parsed.popular).toBe(DEFAULT_POOL.reviewPopular)
    expect(parsed.strong).toBe(DEFAULT_POOL.reviewStrong)
    expect(parsed.minContext).toBe(DEFAULT_POOL.reviewMinContext)
  })
})

describe("poolShapeText", () => {
  test("omits zero slots and keeps the familiar wording", () => {
    expect(poolShapeText(DEFAULT_POOL_SPLITS.default)).toBe("1 cheap + 1 popular + 1 strong")
    expect(poolShapeText(DEFAULT_POOL_SPLITS.review)).toBe("1 popular + 2 strong")
  })

  test("an empty cut says so", () => {
    expect(poolShapeText(cut({ cheap: 0, popular: 0, strong: 0 }))).toBe("no picks")
  })
})

describe("defaultPoolSplit with inlined cuts", () => {
  const models = [poolModel("cheap", 0.1, 0.2), poolModel("popular", 1, 2), poolModel("strong", 2, 5), poolModel("strong2", 3, 6)]
  const board = ["cheap", "popular", "strong", "strong2"]

  test("configured counts shape each split and keep them disjoint", () => {
    const split = defaultPoolSplit(models, board, {
      default: cut({ cheap: 1, popular: 1, strong: 0, topK: 4, minContext: 0 }),
      review: cut({ cheap: 0, popular: 0, strong: 1, topK: 4, minContext: 0 }, "review"),
    })
    expect(split.review.map((m) => m.modelID)).toEqual(["strong2"])
    expect(split.default.map((m) => m.modelID)).toEqual(["cheap", "popular"])
    const keys = new Set(split.default.map((m) => m.modelID))
    expect(split.review.every((m) => !keys.has(m.modelID))).toBe(true)
  })

  test("each split picks from its own topK window", () => {
    const split = defaultPoolSplit(models, board, {
      default: cut({ topK: 4, cheap: 0, popular: 0, strong: 1, minContext: 0 }),
      review: cut({ topK: 2, cheap: 0, popular: 0, strong: 1, minContext: 0 }, "review"),
    })
    expect(split.review.map((m) => m.modelID)).toEqual(["popular"])
    expect(split.default.map((m) => m.modelID)).toEqual(["strong2"])
  })

  test("an inlined cut outside the built-in pair is independent", () => {
    const own = cut({ cheap: 1, popular: 2, strong: 1, topK: 4, minContext: 0 })
    expect(poolCut(models, board, own).map((m) => m.modelID)).toEqual([
      "cheap",
      "popular",
      "strong",
      "strong2",
    ])
    const strongOnly = cut({ cheap: 0, popular: 0, strong: 2, topK: 4, minContext: 0 })
    expect(poolCut(models, board, strongOnly).map((m) => m.modelID)).toEqual(["strong2", "strong"])
  })
})

describe("defaultPoolSplit", () => {
  // The shape observed on 2026-11-03: seven Console models on the public
  // leaderboard, plus an unranked free model that must not enter.
  const catalog = [
    poolModel("deepseek-v4.1-flash", 0.3, 1.2),
    poolModel("muse-spark-1.3-contributor", 0.1, 0.2),
    poolModel("glm-5.3-flash", 0.15, 0.5),
    poolModel("mimo-v2.6-flash", 0.14, 0.28),
    poolModel("gpt-6-luna", 0.1, 0.5),
    poolModel("deepseek-v4-pro", 1.74, 3.84),
    poolModel("mimo-v2.6-pro", 0.435, 0.87),
    poolModel("big-pickle", 0, 0),
  ]
  const leaderboard = [
    "deepseek-v4.1-flash",
    "muse-spark-1.3-contributor",
    "glm-5.3-flash",
    "mimo-v2.6-flash",
    "gpt-6-luna",
    "deepseek-v4-pro",
    "mimo-v2.6-pro",
  ]

  test("review takes one popular and two strong, the default kind takes cheap, popular and strong", () => {
    const split = defaultPoolSplit(catalog, leaderboard)
    // The top model by usage, then the two strongest remaining by output.
    expect(split.review.map((m) => m.modelID)).toEqual([
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "mimo-v2.6-pro",
    ])
    // Cheapest by list price, then the next-highest usage, then the strongest
    // of what is left. Muse Spark is a `-contributor` model and stays out.
    expect(split.default.map((m) => m.modelID)).toEqual([
      "mimo-v2.6-flash",
      "glm-5.3-flash",
      "gpt-6-luna",
    ])
  })

  test("benchmark scores decide the strong slots, not output price", () => {
    const bench = (modelID: string, outputCost: number, score: number) => ({
      ...sizedModel(modelID, 0.1, outputCost, 1_000_000),
      benchmarks: [{ name: "DeepSWE", version: "1.1", score }],
    })
    const models = [bench("priciest", 10, 40), bench("winner", 1, 80), bench("middle", 5, 60)]
    const split = defaultPoolSplit(
      models,
      ["priciest", "winner", "middle"],
      {
        review: cut({ popular: 0, strong: 1 }, "review"),
        default: cut({ cheap: 0, popular: 0, strong: 0 }),
      },
    )
    expect(split.review.map((m) => m.modelID)).toEqual(["winner"])
  })

  test("no benchmark on any model keeps the output-price ranking", () => {
    const split = defaultPoolSplit(catalog, leaderboard)
    expect(split.review.map((m) => m.modelID)).toEqual(["deepseek-v4.1-flash", "deepseek-v4-pro", "mimo-v2.6-pro"])
  })

  test("the pools are disjoint and an unranked free model stays out", () => {
    const split = defaultPoolSplit(catalog, leaderboard)
    const keys = [...split.default, ...split.review].map((m) => `${m.providerID}/${m.modelID}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.some((key) => key.endsWith("/big-pickle"))).toBe(false)
  })

  test("a tiny window shrinks both pools without sharing a model", () => {
    const split = defaultPoolSplit(
      [poolModel("only", 1, 2), poolModel("other", 3, 4)],
      ["only", "other"],
    )
    expect(split.review.map((m) => m.modelID)).toEqual(["only", "other"])
    expect(split.default).toEqual([])
  })

  test("no leaderboard at all still yields disjoint pools from cost ranking", () => {
    const split = defaultPoolSplit(catalog, [])
    const keys = [...split.default, ...split.review].map((m) => `${m.providerID}/${m.modelID}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(split.review).toHaveLength(3)
    expect(split.default).toHaveLength(3)
  })

  test("the default kind skips small and free models when a large paid model exists", () => {
    const models = [
      sizedModel("small-free", 0, 0, 262_144),
      sizedModel("large-free", 0, 0, 1_048_576),
      sizedModel("large-paid", 0.1, 0.3, 1_000_000),
      sizedModel("large-paid-2", 0.2, 0.4, 1_000_000),
    ]
    const split = defaultPoolSplit(
      models,
      models.map((model) => model.modelID),
      { review: cut({ strong: 1, popular: 0 }, "review"), default: cut({ cheap: 2 }) },
    )
    // Review keeps the strongest by output; the default kind then refuses the small free
    // tier, the large free tier and anything else that is not paid.
    expect(split.review.map((m) => m.modelID)).toEqual(["large-paid-2"])
    expect(split.default.map((m) => m.modelID)).toEqual(["large-paid"])
  })

  test("a catalog of only gated models leaves the default pools empty", () => {
    const models = [sizedModel("small-free", 0, 0, 262_144), sizedModel("large-free", 0, 0, 1_048_576)]
    const split = defaultPoolSplit(
      models,
      models.map((model) => model.modelID),
      { review: cut({ strong: 0, popular: 0 }, "review") },
    )
    expect(split.default).toEqual([])
    expect(split.review).toEqual([])
  })

  test("the switches let gated models back into the pools", () => {
    const models = [
      sizedModel("large-free", 0, 0, 1_048_576),
      sizedModel("large-paid", 0.1, 0.3, 1_000_000),
    ]
    const board = models.map((model) => model.modelID)
    const shapes = {
      review: cut({ strong: 0, popular: 0 }, "review"),
      default: cut({ cheap: 2, popular: 0, strong: 0 }),
    }
    const off = defaultPoolSplit(models, board, shapes)
    expect(off.default.map((m) => m.modelID)).toEqual(["large-paid"])
    const on = defaultPoolSplit(models, board, {
      ...shapes,
      consent: { paid: true, free: true },
    })
    expect(on.default.map((m) => m.modelID)).toEqual(["large-free", "large-paid"])
  })

  test("observed session cost outranks list price for the default kind's cheap picks", () => {
    const models = [
      sizedModel("list-cheap", 0.01, 0.01, 1_000_000, 0.5),
      sizedModel("session-cheap", 0.5, 0.5, 1_000_000, 0.01),
    ]
    const split = defaultPoolSplit(
      models,
      models.map((model) => model.modelID),
      { review: cut({ strong: 0, popular: 0 }, "review"), default: cut({ cheap: 1, popular: 0, strong: 0 }) },
    )
    expect(split.default.map((m) => m.modelID)).toEqual(["session-cheap"])
  })

  test("a popular slot keeps the models people actually drive", () => {
    const models = [
      sizedModel("deepseek-v4.1-flash", 0.3, 1.2, 1_000_000, 0.0487),
      sizedModel("glm-5.3-flash", 0.15, 0.5, 1_000_000, 0.0367),
      sizedModel("mimo-v2.6-flash", 0.14, 0.28, 1_048_576, 0.0116),
      sizedModel("gpt-6-luna", 0.1, 0.5, 1_050_000, 0.0124),
      sizedModel("deepseek-v4-pro", 0.66, 1.98, 1_000_000, 0.2319),
      sizedModel("mimo-v2.6-pro", 0.435, 0.87, 1_048_576),
      sizedModel("minimax-m3.1-flash", 0.15, 0.6, 1_000_000),
    ]
    const board = [
      "deepseek-v4.1-flash",
      "glm-5.3-flash",
      "mimo-v2.6-flash",
      "gpt-6-luna",
      "deepseek-v4-pro",
      "mimo-v2.6-pro",
      "minimax-m3.1-flash",
    ]
    const split = defaultPoolSplit(models, board)
    // GLM-5.3-Flash is third by usage but neither the cheapest (MiMo Flash) nor
    // the strongest (MiniMax), so only the popular slot admits it. GPT-6-Luna
    // is cheaper and stays out.
    expect(split.default.map((m) => m.modelID)).toEqual([
      "mimo-v2.6-flash",
      "glm-5.3-flash",
      "minimax-m3.1-flash",
    ])
    expect(split.review.map((m) => m.modelID)).toEqual([
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "mimo-v2.6-pro",
    ])
  })
})

describe("pool size and cost helpers", () => {
  test("a missing context window fails open, a small one does not", () => {
    expect(isLargePoolModel(poolModel("unknown", 1, 1))).toBe(true)
    expect(isLargePoolModel(sizedModel("small", 1, 1, 262_144))).toBe(false)
    expect(isLargePoolModel(sizedModel("large", 1, 1, 1_000_000))).toBe(true)
  })

  test("only a genuinely zero price counts as free", () => {
    expect(isFreePoolModel(poolModel("free", 0, 0))).toBe(true)
    expect(isFreePoolModel(poolModel("cheap", 0, 0.5))).toBe(false)
    expect(isFreePoolModel(poolModel("unknown", undefined, undefined))).toBe(false)
  })

  test("gated models follow the workspace training switches", () => {
    const free = poolModel("glm-5.3-flash-free", 0, 0)
    const paid = poolModel("muse-spark-1.3-contributor", 0.1, 0.2)
    const open = poolModel("glm-5.3-flash", 0.15, 0.5)
    // Unknown policy (settings unreadable, non-Console deployment): fail closed.
    expect(needsTrainingOptIn(free)).toBe(true)
    expect(needsTrainingOptIn(paid)).toBe(true)
    // Both switches off.
    expect(needsTrainingOptIn(free, { paid: false, free: false })).toBe(true)
    expect(needsTrainingOptIn(paid, { paid: false, free: false })).toBe(true)
    // Free allowed, paid consent still off.
    expect(needsTrainingOptIn(free, { paid: false, free: true })).toBe(false)
    expect(needsTrainingOptIn(paid, { paid: false, free: true })).toBe(true)
    // Paid consent on, free models still off.
    expect(needsTrainingOptIn(free, { paid: true, free: false })).toBe(true)
    expect(needsTrainingOptIn(paid, { paid: true, free: false })).toBe(false)
    // Ungated models pass either way.
    expect(needsTrainingOptIn(open, { paid: false, free: false })).toBe(false)
  })

  test("reads the training switches from the console org payload", () => {
    expect(
      parseTrainingConsent({ org: { privacy: { training: { paid: false, free: true } } } }),
    ).toEqual({ paid: false, free: true })
    expect(parseTrainingConsent({ org: { privacy: {} } })).toBeUndefined()
    expect(parseTrainingConsent({ org: { privacy: { training: { paid: "no", free: true } } } })).toBeUndefined()
    expect(parseTrainingConsent(null)).toBeUndefined()
    expect(parseTrainingConsent("nope")).toBeUndefined()
  })

  test("run cost prefers the observed session cost, then cache-adjusted token cost", () => {
    expect(poolRunCost(sizedModel("observed", 1, 2, 1_000_000, 0.01))).toBe(0.01)
    expect(poolRunCost(sizedModel("listed", 1, 2, 1_000_000))).toBe(3)
    const cached = { providerID: "opencode", modelID: "cached", inputCost: 1, outputCost: 2, cacheReadCost: 0.1, cacheRatio: 0.9 }
    expect(effectiveInputPrice(cached)).toBeCloseTo(0.19)
    expect(modelOutputPrice(cached)).toBe(2)
    expect(poolRunCost(cached)).toBeCloseTo(2.19)
  })

  test("measured token prices outrank the catalog list on both sides", () => {
    const measured = {
      providerID: "opencode",
      modelID: "measured",
      inputCost: 1,
      outputCost: 5,
      tokenInputCost: 0.2,
      tokenOutputCost: 0.4,
      tokenCachedInputCost: 0.02,
      cacheRatio: 0.5,
    }
    expect(effectiveInputPrice(measured)).toBeCloseTo(0.11)
    expect(modelOutputPrice(measured)).toBe(0.4)
    expect(poolRunCost(measured)).toBeCloseTo(0.51)
  })

  test("a known Go allowance scales the run cost by the flat plan price", () => {
    // $60 included for a $10 plan: the same token costs a sixth of its list price.
    const flash = { ...poolModel("glm-5.3-flash", 0.15, 0.5), monthlyLimitUsd: 60 }
    expect(GO_PLAN_USD).toBe(10)
    expect(goAllowanceFactor(60)).toBeCloseTo(1 / 6)
    expect(poolRunCost(flash)).toBeCloseTo(0.65 / 6)
    // A smaller allowance makes an identically priced model look dearer.
    const haiku = { ...poolModel("claude-haiku-5-5", 0.15, 0.5), monthlyLimitUsd: 15 }
    expect(poolRunCost(haiku)).toBeCloseTo(0.65 * (10 / 15))
    expect(poolRunCost(flash)!).toBeLessThan(poolRunCost(haiku)!)
    // Unknown allowance leaves the price untouched; so does a nonsensical one.
    expect(poolRunCost(poolModel("plain", 0.15, 0.5))).toBeCloseTo(0.65)
    expect(goAllowanceFactor(undefined)).toBe(1)
    expect(goAllowanceFactor(0)).toBe(1)
  })

  test("the Go docs table parses into model-name keys", () => {
    const html = `
      <div data-plan-panel="go"><div>
        <table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr></thead>
        <tbody>
          <tr><td>GLM-5.3-Flash</td><td>$0.15</td><td>$0.50</td><td>$0.03</td><td>-</td><td><strong>$60</strong></td></tr>
          <tr><td>Claude Haiku 5.5 (≤ 100K tokens)</td><td>$0.10</td><td>$0.50</td><td>$0.01</td><td>$0.125</td><td><strong>$15</strong></td></tr>
          <tr><td>DeepSeek V4.1 Flash (Off-Peak)</td><td>$0.15</td><td>$0.60</td><td>$0.003</td><td>-</td><td><strong>$100</strong></td></tr>
          <tr><td>Beam Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td><td><strong>Unlimited</strong></td></tr>
        </tbody></table>
      </div></div>
      <div data-plan-panel="go-plus"><div><table><tbody>
        <tr><td>GLM-5.3-Flash</td><td>$0.15</td><td>$0.50</td><td>$0.03</td><td>-</td><td><strong>$180</strong></td></tr>
      </tbody></table></div></div>`
    const limits = parseGoMonthlyLimits(html)
    // Catalog ids normalize to the same keys as the docs labels.
    expect(limits.get(modelNameKey("glm-5.3-flash"))).toBe(60)
    expect(limits.get(modelNameKey("claude-haiku-5-5"))).toBe(15)
    expect(limits.get(modelNameKey("deepseek-v4.1-flash"))).toBe(100)
    // Unlimited rows carry no dollar allowance, and only the base plan is read.
    expect(limits.get(modelNameKey("beam-free"))).toBeUndefined()
    expect(limits.size).toBe(3)
  })

  test("an unreadable Go docs page yields no allowances", () => {
    expect(parseGoMonthlyLimits("")).toEqual(new Map())
    expect(parseGoMonthlyLimits("<html><body>nope</body></html>")).toEqual(new Map())
    expect(parseGoMonthlyLimits('<div data-plan-panel="go"><table></table></div>')).toEqual(new Map())
  })

  test("modelNameKey bridges catalog ids and docs labels", () => {
    expect(modelNameKey("Claude Haiku 5.5")).toBe("claude-haiku-5-5")
    expect(modelNameKey("claude-haiku-5-5")).toBe("claude-haiku-5-5")
    expect(modelNameKey("GPT 6 Luna (≤ 272K tokens)")).toBe("gpt-6-luna")
    expect(modelNameKey("Qwen3.8 Max")).toBe("qwen3-8-max")
    expect(modelNameKey("  ")).toBe("")
  })

  test("modelCacheCost reads every catalog shape", () => {
    expect(modelCacheCost({ cost: [{ input: 1, cache: { read: 0.1 } }, { input: 2, cache: { read: 0.05 } }] })).toBe(0.05)
    expect(modelCacheCost({ price: { perMillion: { cacheRead: 0.2 } } })).toBe(0.2)
    expect(modelCacheCost({ cost: { text: { input: { cache: { read: 0.03 } } } } })).toBe(0.03)
    expect(modelCacheCost({})).toBeUndefined()
    expect(modelCacheCost(null)).toBeUndefined()
  })

  test("duplicate provider entries keep the cheaper one, ties keep the first", () => {
    const expensive = { providerID: "opencode", modelID: "x", inputCost: 1, outputCost: 2 }
    const cheap = { providerID: "opencode-go", modelID: "x", inputCost: 0.5, outputCost: 1 }
    expect(cheaperPoolModel(expensive, cheap).providerID).toBe("opencode-go")
    expect(cheaperPoolModel(cheap, expensive).providerID).toBe("opencode-go")
    const tie = { ...expensive, providerID: "opencode-go" }
    expect(cheaperPoolModel(expensive, tie).providerID).toBe("opencode")
  })
})

describe("modelCost", () => {
  test("reads OpenCode 2's tier array and takes the cheapest tier", () => {
    const info = { cost: [{ input: 3, output: 9 }, { input: 1, output: 15 }] }
    expect(modelCost(info, "input")).toBe(1)
    expect(modelCost(info, "output")).toBe(9)
  })

  test("keeps the legacy object and numeric shapes working", () => {
    expect(modelCost({ cost: { input: 2.5, output: 5 } }, "input")).toBe(2.5)
    expect(modelCost({ price: { perMillion: { input: 4 } } }, "input")).toBe(4)
    expect(modelCost({ cost: 6 }, "output")).toBe(6)
  })

  test("reads OpenCode 2's per-modality prices", () => {
    const info = { cost: { text: { input: { price: 0.3, cache: { read: 0.006 } }, output: { price: 1.2 } } } }
    expect(modelCost(info, "input")).toBe(0.3)
    expect(modelCost(info, "output")).toBe(1.2)
  })

  test("missing or malformed prices yield undefined", () => {
    expect(modelCost({}, "input")).toBeUndefined()
    expect(modelCost(null, "input")).toBeUndefined()
    expect(modelCost({ cost: [{ input: "3" }] }, "input")).toBeUndefined()
  })
})
