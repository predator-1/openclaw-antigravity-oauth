// Issue #37: Gemini 4 Hydrogen (low|medium|high|xhigh) and gemini-pro-orchestrator-g1-pro.
// Hermetic only: fetch is mocked, no live calls. Fixture slugs and display names come from
// `agy models` (agy 1.5.7 in the issue; re-checked with agy 1.5.9 on 2026-11-14). Proto ids and
// the 65536 max output come from the agy 1.5.9 built-in table (docs/protocol.md#model-ids-2026-11-02).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CatalogService,
  createAntigravityProvider,
  DEFAULT_ENDPOINTS,
  InMemoryAuthProfileStore,
  KNOWN_CATALOG_MODELS,
  parseEffortVariant,
  PROTO_MODEL_ID_MAP,
  toOpenClawCatalogModelDefinition,
  type FetchLike
} from "../dist/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function sseResponse(events: unknown[]): Response {
  const chunks = events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(chunks, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

type CapturedBody = {
  model?: string;
  project?: string;
  reasoning_effort?: unknown;
  request?: { generationConfig?: { thinkingConfig?: Record<string, unknown> } };
  [key: string]: unknown;
};

// Existing families as fetchAvailableModels lists them (shape as in test/acceptance.test.ts).
const EXISTING_FAMILY_MODELS: Record<string, Record<string, unknown>> = {
  "gemini-4-argon-low": { model: "MODEL_PLACEHOLDER_M317", displayName: "Gemini 4 Argon (Low)", modality: "chat", maxTokens: 65536 },
  "gemini-4-argon-medium": { model: "MODEL_PLACEHOLDER_M318", displayName: "Gemini 4 Argon (Medium)", modality: "chat", maxTokens: 65536 },
  "gemini-4-argon-high": { model: "MODEL_PLACEHOLDER_M319", displayName: "Gemini 4 Argon (High)", modality: "chat", maxTokens: 65536 },
  "gemini-3.8-flash-tiered": { model: "MODEL_PLACEHOLDER_M322", displayName: "Gemini 3.8 Flash", modality: "chat", maxTokens: 65536 },
  "claude-opus-5-5-low": { model: "MODEL_PLACEHOLDER_M400", displayName: "Claude Opus 5.5 (Low)", modality: "chat", maxOutputTokens: 128000 },
  "claude-opus-5-5-high": { model: "MODEL_PLACEHOLDER_M402", displayName: "Claude Opus 5.5 (High)", modality: "chat", maxOutputTokens: 128000 },
  "claude-sonnet-5-5-low": { model: "MODEL_PLACEHOLDER_M403", displayName: "Claude Sonnet 5.5 (Low)", modality: "chat", maxOutputTokens: 128000 },
  "claude-sonnet-5-5-medium": { model: "MODEL_PLACEHOLDER_M404", displayName: "Claude Sonnet 5.5 (Medium)", modality: "chat", maxOutputTokens: 128000 },
  "claude-sonnet-5-5-high": { model: "MODEL_PLACEHOLDER_M405", displayName: "Claude Sonnet 5.5 (High)", modality: "chat", maxOutputTokens: 128000 },
  "gpt-oss-120b-medium": { model: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM", displayName: "GPT-OSS 120B (Medium)", modality: "chat", maxOutputTokens: 32768 }
};

// The five slugs agy 1.5.7 added (issue #37 "Known"). Only what upstream shows: slug and display name.
const NEW_SLUGS: Record<string, Record<string, unknown>> = {
  "gemini-4-hydrogen-low": { displayName: "Gemini 4 Hydrogen (Low)" },
  "gemini-4-hydrogen-medium": { displayName: "Gemini 4 Hydrogen (Medium)" },
  "gemini-4-hydrogen-high": { displayName: "Gemini 4 Hydrogen (High)" },
  "gemini-4-hydrogen-xhigh": { displayName: "Gemini 4 Hydrogen (XHigh)" },
  "gemini-pro-orchestrator-g1-pro": { displayName: "Orchestrator (Argon)" }
};

const FULL_FIXTURE = { ...EXISTING_FAMILY_MODELS, ...NEW_SLUGS };

async function harness(models: Record<string, Record<string, unknown>>) {
  const authStore = new InMemoryAuthProfileStore();
  await authStore.setSecret("antigravity", {
    accessToken: "ya29.hydrogen_token",
    refreshToken: "1//hydrogen_refresh",
    expiresAt: Date.now() + 3600_000,
    projectId: "test-project-redacted"
  });
  const bodies: CapturedBody[] = [];
  const mockFetch: FetchLike = async (input, init) => {
    const url = String(input);
    if (url === DEFAULT_ENDPOINTS.modelsUrl) {
      return jsonResponse({ models });
    }
    if (url === DEFAULT_ENDPOINTS.chatCompletionsUrl) {
      bodies.push(JSON.parse(String(init?.body)) as CapturedBody);
      return sseResponse([
        { response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] } }
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const { provider } = createAntigravityProvider({ fetchImpl: mockFetch, authStore });
  const rows = await provider.catalog.listModels({ refresh: true });
  return { provider, bodies, rows };
}

const EFFORTS = [undefined, "off", "low", "medium", "high", "xhigh", "max"] as const;

async function routingTable(
  provider: Awaited<ReturnType<typeof harness>>["provider"],
  bodies: CapturedBody[],
  modelIds: readonly string[]
): Promise<Record<string, Record<string, string>>> {
  const table: Record<string, Record<string, string>> = {};
  for (const id of modelIds) {
    table[id] = {};
    for (const effort of EFFORTS) {
      const before = bodies.length;
      try {
        await provider.completeTurn({
          model: `antigravity/${id}`,
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
          messages: [{ role: "user", content: "ping" }]
        });
        const body = bodies[bodies.length - 1]!;
        assert.equal(bodies.length, before + 1, `${id}/${effort}: exactly one request`);
        const thinking = body.request?.generationConfig?.thinkingConfig;
        table[id]![effort ?? "none"] = `${body.model}${thinking ? ` ${JSON.stringify(thinking)}` : ""}`;
      } catch (err) {
        assert.equal(bodies.length, before, `${id}/${effort}: rejected before any call`);
        table[id]![effort ?? "none"] = `error: ${(err as Error).message}`;
      }
    }
  }
  return table;
}

describe("Gemini 4 Hydrogen (issue #37)", () => {
  it("parseEffortVariant folds -xhigh / (XHigh) and leaves existing families unchanged", () => {
    assert.deepEqual(parseEffortVariant("gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"), {
      canonicalId: "gemini-4-hydrogen",
      canonicalDisplayName: "Gemini 4 Hydrogen",
      effortTier: "xhigh"
    });
    for (const tier of ["low", "medium", "high"] as const) {
      const parsed = parseEffortVariant(`gemini-4-hydrogen-${tier}`, `Gemini 4 Hydrogen (${tier})`);
      assert.equal(parsed.canonicalId, "gemini-4-hydrogen");
      assert.equal(parsed.canonicalDisplayName, "Gemini 4 Hydrogen");
      assert.equal(parsed.effortTier, tier);
    }
    // Regression: existing families parse exactly as before.
    assert.deepEqual(parseEffortVariant("gemini-4-argon-high", "Gemini 4 Argon (High)"), {
      canonicalId: "gemini-4-argon",
      canonicalDisplayName: "Gemini 4 Argon",
      effortTier: "high"
    });
    assert.deepEqual(parseEffortVariant("gemini-3.8-flash-tiered", "Gemini 3.8 Flash"), {
      canonicalId: "gemini-3.8-flash",
      canonicalDisplayName: "Gemini 3.8 Flash",
      effortTier: "tiered"
    });
    assert.deepEqual(parseEffortVariant("claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"), {
      canonicalId: "claude-sonnet-5-5",
      canonicalDisplayName: "Claude Sonnet 5.5",
      effortTier: "low"
    });
    assert.deepEqual(parseEffortVariant("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"), {
      canonicalId: "gpt-oss-120b",
      canonicalDisplayName: "GPT-OSS 120B",
      effortTier: "medium"
    });
  });

  it("publishes one gemini-4-hydrogen row with low|medium|high|xhigh and no orchestrator row", async () => {
    const { rows, provider } = await harness(FULL_FIXTURE);
    const hydrogenRows = rows.filter((m) => m.id.includes("hydrogen"));
    assert.deepEqual(hydrogenRows.map((m) => m.id), ["gemini-4-hydrogen"]);
    const hydrogen = hydrogenRows[0]!;
    assert.equal(hydrogen.displayName, "Gemini 4 Hydrogen");
    assert.deepEqual(hydrogen.reasoningLevels, ["low", "medium", "high", "xhigh"]);
    assert.equal(hydrogen.canDisableReasoning, false);
    assert.equal(hydrogen.contextWindow, 1_000_000);
    assert.equal(hydrogen.maxOutputTokens, 65_536, "agy 1.5.9 default when upstream omits max output");

    const published = toOpenClawCatalogModelDefinition(hydrogen, DEFAULT_ENDPOINTS.chatCompletionsUrl);
    assert.equal(published.id, "gemini-4-hydrogen");
    assert.equal(published.name, "Gemini 4 Hydrogen");
    assert.deepEqual(published.compat?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(published.thinkingLevelMap, { off: null });

    const run = await provider.catalog.run({});
    const runRow = run?.provider.models.find((m) => m.id === "gemini-4-hydrogen");
    assert.deepEqual(runRow?.compat?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);

    assert.ok(!rows.some((m) => /orchestrator/i.test(m.id) || /orchestrator/i.test(m.displayName)));
    assert.ok(KNOWN_CATALOG_MODELS.includes("gemini-4-hydrogen"));
    assert.ok(!KNOWN_CATALOG_MODELS.some((id) => /orchestrator/i.test(id)));
  });

  it("resolveThinkingProfile advertises xhigh (default medium) for Hydrogen, cached or not", async () => {
    const { provider } = await harness(FULL_FIXTURE);
    const profile = provider.resolveThinkingProfile?.({ modelId: "antigravity/gemini-4-hydrogen" });
    assert.deepEqual(profile?.levels.map((l) => l.id), ["low", "medium", "high", "xhigh"]);
    assert.equal(profile?.defaultLevel, "medium");

    const cold = createAntigravityProvider({ authStore: new InMemoryAuthProfileStore() }).provider;
    const coldProfile = cold.resolveThinkingProfile?.({ modelId: "gemini-4-hydrogen" });
    assert.deepEqual(coldProfile?.levels.map((l) => l.id), ["low", "medium", "high", "xhigh"]);
    assert.equal(coldProfile?.defaultLevel, "medium");
    // Regression: Argon cold profile unchanged.
    const coldArgon = cold.resolveThinkingProfile?.({ modelId: "gemini-4-argon" });
    assert.deepEqual(coldArgon?.levels.map((l) => l.id), ["low", "medium", "high"]);
  });

  it("routes each effort to its real -<level> slug with no thinkingConfig; max is rejected before any call", async () => {
    const { provider, bodies } = await harness(FULL_FIXTURE);
    const table = await routingTable(provider, bodies, ["gemini-4-hydrogen"]);
    assert.deepEqual(table["gemini-4-hydrogen"], {
      none: "gemini-4-hydrogen-medium",
      off: "gemini-4-hydrogen-medium",
      low: "gemini-4-hydrogen-low",
      medium: "gemini-4-hydrogen-medium",
      high: "gemini-4-hydrogen-high",
      xhigh: "gemini-4-hydrogen-xhigh",
      max: 'error: unsupported reasoning effort "max" for model gemini-4-hydrogen (valid: low, medium, high, xhigh)'
    });
    for (const body of bodies) {
      assert.equal(body.request?.generationConfig, undefined, `${body.model}: no generationConfig`);
      assert.equal("reasoning_effort" in body, false);
    }
  });

  it("suffixed Hydrogen ids are pre-tiered: -xhigh goes to -xhigh with no thinkingConfig", async () => {
    const { provider, bodies } = await harness(FULL_FIXTURE);
    for (const tier of ["low", "medium", "high", "xhigh"]) {
      await provider.completeTurn({
        model: `antigravity/gemini-4-hydrogen-${tier}`,
        messages: [{ role: "user", content: "ping" }]
      });
      const body = bodies.at(-1)!;
      assert.equal(body.model, `gemini-4-hydrogen-${tier}`);
      assert.equal(body.request?.generationConfig, undefined);
    }
    // Explicit xhigh on the -xhigh id must not add thinkingConfig either.
    await provider.completeTurn({
      model: "antigravity/gemini-4-hydrogen-xhigh",
      reasoningEffort: "xhigh",
      messages: [{ role: "user", content: "ping" }]
    });
    assert.equal(bodies.at(-1)?.model, "gemini-4-hydrogen-xhigh");
    assert.equal(bodies.at(-1)?.request?.generationConfig, undefined);
  });

  it("xhigh is advertised only when a real -xhigh slug is listed and is never routed to -high", async () => {
    const { ["gemini-4-hydrogen-xhigh"]: _dropped, ...withoutXhigh } = FULL_FIXTURE;
    const { provider, bodies, rows } = await harness(withoutXhigh);
    const hydrogen = rows.find((m) => m.id === "gemini-4-hydrogen")!;
    assert.deepEqual(hydrogen.reasoningLevels, ["low", "medium", "high"]);
    await assert.rejects(
      provider.completeTurn({
        model: "antigravity/gemini-4-hydrogen",
        reasoningEffort: "xhigh",
        messages: [{ role: "user", content: "ping" }]
      }),
      /unsupported reasoning effort "xhigh" for model gemini-4-hydrogen \(valid: low, medium, high\)/
    );
    assert.equal(bodies.length, 0);
  });

  it("agy 1.5.9 proto ids M463/M462/M461/M464 are incoming aliases for the low/medium/high/xhigh slugs", async () => {
    assert.deepEqual(
      ["MODEL_PLACEHOLDER_M463", "MODEL_PLACEHOLDER_M462", "MODEL_PLACEHOLDER_M461", "MODEL_PLACEHOLDER_M464"].map(
        (id) => PROTO_MODEL_ID_MAP[id]
      ),
      [
        { canonicalId: "gemini-4-hydrogen", effortTier: "low" },
        { canonicalId: "gemini-4-hydrogen", effortTier: "medium" },
        { canonicalId: "gemini-4-hydrogen", effortTier: "high" },
        { canonicalId: "gemini-4-hydrogen", effortTier: "xhigh" }
      ]
    );
    const { provider, bodies } = await harness(FULL_FIXTURE);
    const expected: Record<string, string> = {
      MODEL_PLACEHOLDER_M463: "gemini-4-hydrogen-low",
      MODEL_PLACEHOLDER_M462: "gemini-4-hydrogen-medium",
      MODEL_PLACEHOLDER_M461: "gemini-4-hydrogen-high",
      MODEL_PLACEHOLDER_M464: "gemini-4-hydrogen-xhigh"
    };
    for (const [alias, slug] of Object.entries(expected)) {
      await provider.completeTurn({ model: `antigravity/${alias}`, messages: [{ role: "user", content: "ping" }] });
      assert.equal(bodies.at(-1)?.model, slug, `${alias} is sent as its slug, never as the placeholder`);
      assert.equal(bodies.at(-1)?.request?.generationConfig, undefined);
    }
    // Regression: existing proto aliases are unchanged.
    const existing = ["M317", "M318", "M319", "M320", "M322", "M124", "M400", "M401", "M402", "M403", "M404", "M405"];
    assert.deepEqual(
      Object.fromEntries(existing.map((m) => [m, PROTO_MODEL_ID_MAP[`MODEL_PLACEHOLDER_${m}`]])),
      {
        M317: { canonicalId: "gemini-4-argon", effortTier: "low" },
        M318: { canonicalId: "gemini-4-argon", effortTier: "medium" },
        M319: { canonicalId: "gemini-4-argon", effortTier: "high" },
        M320: { canonicalId: "gemini-4-argon" },
        M322: { canonicalId: "gemini-3.8-flash", effortTier: "tiered" },
        M124: { canonicalId: "gemini-4-argon" },
        M400: { canonicalId: "claude-opus-5-5", effortTier: "low" },
        M401: { canonicalId: "claude-opus-5-5", effortTier: "medium" },
        M402: { canonicalId: "claude-opus-5-5", effortTier: "high" },
        M403: { canonicalId: "claude-sonnet-5-5", effortTier: "low" },
        M404: { canonicalId: "claude-sonnet-5-5", effortTier: "medium" },
        M405: { canonicalId: "claude-sonnet-5-5", effortTier: "high" }
      }
    );
  });

  it("orchestrator verdict: gemini-pro-orchestrator-g1-pro is not published and fails as an unknown model", async () => {
    const { provider, bodies, rows } = await harness(FULL_FIXTURE);
    assert.ok(!rows.some((m) => m.id === "gemini-pro-orchestrator-g1-pro"));
    await assert.rejects(
      provider.completeTurn({
        model: "antigravity/gemini-pro-orchestrator-g1-pro",
        messages: [{ role: "user", content: "ping" }]
      }),
      /unknown model: gemini-pro-orchestrator-g1-pro/
    );
    // Even if a future payload marks it as an ordinary chat row, it stays unpublished until the
    // fetchAvailableModels fields are recorded and the decision is revisited (issue #37).
    const ordinary = await harness({
      ...EXISTING_FAMILY_MODELS,
      "gemini-pro-orchestrator-g1-pro": { displayName: "Orchestrator (Argon)", modality: "chat", disabled: false }
    });
    assert.ok(!ordinary.rows.some((m) => /orchestrator/i.test(m.id)));
    assert.equal(bodies.length, 0);
  });

  it("regression: Argon, 3.8 Flash, Claude and GPT-OSS rows and routing are identical with and without the new slugs", async () => {
    const before = await harness(EXISTING_FAMILY_MODELS);
    const after = await harness(FULL_FIXTURE);
    const families = ["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b"];
    const pick = (rows: typeof before.rows) =>
      families.map((id) => {
        const row = rows.find((m) => m.id === id);
        assert.ok(row, `${id} published`);
        return row;
      });
    assert.deepEqual(pick(after.rows), pick(before.rows));

    const snapshot = pick(after.rows).map((r) => ({
      id: r!.id,
      displayName: r!.displayName,
      reasoningLevels: r!.reasoningLevels,
      canDisableReasoning: r!.canDisableReasoning,
      contextWindow: r!.contextWindow,
      maxOutputTokens: r!.maxOutputTokens
    }));
    assert.deepEqual(snapshot, [
      { id: "gemini-4-argon", displayName: "Gemini 4 Argon", reasoningLevels: ["low", "medium", "high"], canDisableReasoning: false, contextWindow: 1_000_000, maxOutputTokens: 65536 },
      { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], canDisableReasoning: false, contextWindow: 1_000_000, maxOutputTokens: 65536 },
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", reasoningLevels: ["low", "medium", "high"], canDisableReasoning: false, contextWindow: 1_000_000, maxOutputTokens: 128000 },
      { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", reasoningLevels: ["low", "medium", "high"], canDisableReasoning: false, contextWindow: 1_000_000, maxOutputTokens: 128000 },
      { id: "gpt-oss-120b", displayName: "GPT-OSS 120B", reasoningLevels: ["medium"], canDisableReasoning: false, contextWindow: 128_000, maxOutputTokens: 32768 }
    ]);

    const beforeRouting = await routingTable(before.provider, before.bodies, families);
    const afterRouting = await routingTable(after.provider, after.bodies, families);
    assert.deepEqual(afterRouting, beforeRouting);
    const lmh = "valid: low, medium, high";
    assert.deepEqual(afterRouting, {
      "gemini-4-argon": {
        none: "gemini-4-argon-medium",
        off: "gemini-4-argon-medium",
        low: "gemini-4-argon-low",
        medium: "gemini-4-argon-medium",
        high: "gemini-4-argon-high",
        xhigh: `error: unsupported reasoning effort "xhigh" for model gemini-4-argon (${lmh})`,
        max: `error: unsupported reasoning effort "max" for model gemini-4-argon (${lmh})`
      },
      "gemini-3.8-flash": {
        none: "gemini-3.8-flash-tiered",
        off: "gemini-3.8-flash-tiered",
        low: 'gemini-3.8-flash-tiered {"includeThoughts":true,"thinkingLevel":"LOW"}',
        medium: 'gemini-3.8-flash-tiered {"includeThoughts":true,"thinkingLevel":"MEDIUM"}',
        high: 'gemini-3.8-flash-tiered {"includeThoughts":true,"thinkingLevel":"HIGH"}',
        xhigh: 'gemini-3.8-flash-tiered {"includeThoughts":true,"thinkingLevel":"EXTRA_HIGH"}',
        max: 'gemini-3.8-flash-tiered {"includeThoughts":true,"thinkingLevel":"MAX"}'
      },
      "claude-opus-5-5": {
        none: "claude-opus-5-5-high",
        off: "claude-opus-5-5-high",
        low: "claude-opus-5-5-low",
        medium: "claude-opus-5-5-high",
        high: "claude-opus-5-5-high",
        xhigh: `error: unsupported reasoning effort "xhigh" for model claude-opus-5-5 (${lmh})`,
        max: `error: unsupported reasoning effort "max" for model claude-opus-5-5 (${lmh})`
      },
      "claude-sonnet-5-5": {
        none: "claude-sonnet-5-5-medium",
        off: "claude-sonnet-5-5-medium",
        low: "claude-sonnet-5-5-low",
        medium: "claude-sonnet-5-5-medium",
        high: "claude-sonnet-5-5-high",
        xhigh: `error: unsupported reasoning effort "xhigh" for model claude-sonnet-5-5 (${lmh})`,
        max: `error: unsupported reasoning effort "max" for model claude-sonnet-5-5 (${lmh})`
      },
      "gpt-oss-120b": {
        none: "gpt-oss-120b-medium",
        off: "gpt-oss-120b-medium",
        low: 'error: unsupported reasoning effort "low" for model gpt-oss-120b (valid: medium)',
        medium: "gpt-oss-120b-medium",
        high: 'error: unsupported reasoning effort "high" for model gpt-oss-120b (valid: medium)',
        xhigh: 'error: unsupported reasoning effort "xhigh" for model gpt-oss-120b (valid: medium)',
        max: 'error: unsupported reasoning effort "max" for model gpt-oss-120b (valid: medium)'
      }
    });
  });

  it("quota: Hydrogen buckets get their own group; Argon and Gemini groups do not swallow them", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T06:00:00Z") });
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes(":retrieveUserQuotaSummary")) {
        return jsonResponse({ groups: [] });
      }
      if (url.includes(":retrieveUserQuota")) {
        return jsonResponse({
          buckets: [
            { modelId: "gemini-3.8-flash-tiered", window: "5h", remainingFraction: 0.86, resetTime: "2026-11-14T09:00:00Z" },
            { modelId: "gemini-3-flash", window: "5h", remainingFraction: 0.86, resetTime: "2026-11-14T09:00:00Z" },
            { modelId: "gemini-4-argon-medium", window: "weekly", remainingFraction: 0.4, resetTime: "2026-11-18T09:00:00Z" },
            { modelId: "gemini-4-hydrogen-low", window: "weekly", remainingFraction: 0.7, resetTime: "2026-11-19T09:00:00Z" },
            { modelId: "gemini-4-hydrogen-medium", window: "weekly", remainingFraction: 0.7, resetTime: "2026-11-19T09:00:00Z" },
            { modelId: "gemini-4-hydrogen-high", window: "weekly", remainingFraction: 0.7, resetTime: "2026-11-19T09:00:00Z" },
            { modelId: "gemini-4-hydrogen-xhigh", window: "weekly", remainingFraction: 0.7, resetTime: "2026-11-19T09:00:00Z" }
          ]
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const service = new CatalogService(DEFAULT_ENDPOINTS, fetchImpl);
    const report = await service.getUsageWithToken("ya29.quota_token", "test-project-redacted");
    const buckets = report.buckets ?? [];
    const argon = buckets.filter((b) => b.groupDisplayName === "Gemini 4 Argon");
    const hydrogen = buckets.filter((b) => b.groupDisplayName === "Gemini 4 Hydrogen");
    const gemini = buckets.filter((b) => b.groupDisplayName === "Gemini");
    assert.ok(argon.length > 0 && argon.every((b) => !/hydrogen/i.test(b.modelId ?? "")), "Argon group has no Hydrogen bucket");
    assert.deepEqual(
      hydrogen.map((b) => ({ window: b.window, remainingFraction: b.remainingFraction, resetTime: b.resetTime })),
      [{ window: "weekly", remainingFraction: 0.7, resetTime: "2026-11-19T09:00:00Z" }]
    );
    // Regression: the shared Gemini 5h pool still collapses into one "Gemini" row.
    assert.deepEqual(
      gemini.map((b) => ({ window: b.window, remainingFraction: b.remainingFraction, displayName: b.displayName })),
      [{ window: "5h", remainingFraction: 0.86, displayName: "Gemini" }]
    );
  });

  it("quota: a summary group named for Hydrogen does not suppress per-model Gemini buckets", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-14T06:00:00Z") });
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes(":retrieveUserQuotaSummary")) {
        return jsonResponse({
          groups: [
            {
              displayName: "Gemini 4 Hydrogen",
              buckets: [{ bucketId: "hydrogen-weekly", window: "WEEKLY", remainingFraction: 0.5, resetTime: "2026-11-19T09:00:00Z" }]
            }
          ]
        });
      }
      if (url.includes(":retrieveUserQuota")) {
        return jsonResponse({
          buckets: [
            { modelId: "gemini-3.8-flash-tiered", window: "5h", remainingFraction: 0.86, resetTime: "2026-11-14T09:00:00Z" },
            { modelId: "gemini-4-hydrogen-medium", window: "weekly", remainingFraction: 0.5, resetTime: "2026-11-19T09:00:00Z" }
          ]
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const service = new CatalogService(DEFAULT_ENDPOINTS, fetchImpl);
    const report = await service.getUsageWithToken("ya29.quota_token", "test-project-redacted");
    const buckets = report.buckets ?? [];
    assert.ok(buckets.some((b) => b.groupDisplayName === "Gemini" && b.window === "5h"), "Gemini 5h bucket kept");
    assert.equal(
      buckets.filter((b) => b.groupDisplayName === "Gemini 4 Hydrogen").length,
      1,
      "Hydrogen shown once (summary group wins, per-model Hydrogen rows not duplicated)"
    );
  });
});
