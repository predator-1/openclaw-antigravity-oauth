import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAntigravityProvider, DEFAULT_ENDPOINTS, toOpenClawCatalogModelDefinition, normalizeModelRow } from "../dist/index.js";
import { HOST_MODEL_CONFIG_FIXTURES, assertHostModelConfig, assertHostProviderConfig } from "./support/host-model-config-fixture.ts";

const ids = ["claude-opus-5-5", "claude-sonnet-5-5", "gemini-3.8-flash", "gemini-4-argon", "gpt-oss-120b", "gemini-3-flash", "gemini-3.5-flash-lite"];
const liteId = ids[6];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

async function mockedLogin() {
  const messages: string[] = [];
  const { provider } = createAntigravityProvider({
    pollIntervalMs: 1,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.deviceCodeUrl) return json({
        device_code: "fixture-device-code", user_code: "fixture-user-code", verification_url: "fixture-verification", expires_in: 300, interval: 1
      });
      if (url === DEFAULT_ENDPOINTS.tokenUrl) return json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 });
      if (url === DEFAULT_ENDPOINTS.verifySubscriptionUrl) return json({ eligible: true });
      if (url === DEFAULT_ENDPOINTS.modelsUrl) return json({ models: [
        ...ids.map((id) => ({ id, modality: "chat", contextWindow: 1_000_000, maxOutputTokens: 8192,
          supportsImages: id !== "gpt-oss-120b", canDisableReasoning: id !== "gemini-4-argon",
          reasoningLevels: ["off", "low", "medium", "high"] })),
        { id: "gemini-2.5-flash", modality: "chat" },
        { id: "fixture-disabled", disabled: true, modality: "chat" },
        { id: "fixture-image", modality: "image" }
      ] });
      assert.fail("unmocked request in catalog/config regression");
    }
  });
  const auth = await provider.auth[0]!.run({ isRemote: true, runtime: { log: (message) => messages.push(message) } });
  for (const message of messages) {
    assert.ok(!message.includes("fixture-access")); assert.ok(!message.includes("fixture-refresh"));
  }
  return { provider, auth };
}

for (const fixture of HOST_MODEL_CONFIG_FIXTURES) {
  describe(`provider config contract: published OpenClaw ${fixture.version}`, () => {
    it("accepts the actual mocked OAuth provider-settings result including model slot six", async () => {
      const { auth } = await mockedLogin();
      const config = (auth.configPatch as any).models.providers.antigravity;
      assert.equal(config.models[6].id, liteId);
      assert.equal(auth.profiles.length, 1, "credential result remains present");
      assertHostProviderConfig(config, fixture);
      assert.deepEqual(config.models.map((row: any) => row.id), ids);
    });

    it("also accepts catalog.run output and preserves supported model metadata", async () => {
      const { provider } = await mockedLogin();
      const result = await provider.catalog.run({});
      assert.ok(result); assertHostProviderConfig(result.provider, fixture);
      const lite = result.provider.models.find((row) => row.id === liteId)!;
      assert.deepEqual(lite, {
        id: liteId, name: "Gemini 3.5 Flash Lite", api: "openai-completions", baseUrl: DEFAULT_ENDPOINTS.chatCompletionsUrl,
        reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000, maxTokens: 8192,
        compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ["off", "low", "medium", "high"] }
      });
      const argon = result.provider.models.find((row) => row.id === "gemini-4-argon")!;
      assert.deepEqual(argon.thinkingLevelMap, { off: null });
      assert.deepEqual(argon.compat?.supportedReasoningEfforts, ["low", "medium", "high"]);
      assert.deepEqual(result.provider.models.find((row) => row.id === "gpt-oss-120b")?.input, ["text"]);
    });

    it("rejects authored-catalog tags instead of silently stripping unknown settings", () => {
      const row = toOpenClawCatalogModelDefinition(normalizeModelRow({ id: liteId, modality: "chat" })!, DEFAULT_ENDPOINTS.chatCompletionsUrl);
      assert.throws(() => assertHostModelConfig({ ...row, tags: ["cheap"] }, fixture, "models.providers.antigravity.models.6"),
        /models\.providers\.antigravity\.models\.6: Unrecognized key: "tags"/);
    });

    it("checks nested types and constraints, not just an allowlist of top-level keys", () => {
      const row = toOpenClawCatalogModelDefinition(normalizeModelRow({ id: "gemini-3-flash", modality: "chat" })!, DEFAULT_ENDPOINTS.chatCompletionsUrl);
      for (const invalid of [
        { ...row, contextWindow: 0 }, { ...row, input: ["document"] },
        { ...row, cost: { input: "not-a-number" } },
        { ...row, compat: { supportsReasoningEffort: "not-a-boolean" } },
        { ...row, thinkingLevelMap: { off: false } }
      ]) assert.throws(() => assertHostModelConfig(invalid, fixture, "model"));
    });
  });
}
