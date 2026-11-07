import assert from "node:assert/strict";

/**
 * Published OpenClaw strict ModelDefinitionSchema snapshots (npm packages, not installed state).
 * Hashes cover the exact `const ModelDefinitionSchema = strictObject({ ... });` source block.
 * ProviderCatalogResult.provider is ModelProviderConfig, NOT authored ModelCatalogModel (which has tags).
 * This is a faithful projection for fields this plugin emits, not a general host config validator:
 * every present field is validated; unused host fields deliberately require extending the fixture.
 * Nested constraints come from ModelProviderSchema, ModelCompatSchema and ThinkingLevelMapSchema
 * in the same source files. No host code, config, auth resolver or external dependency is executed.
 */
export const HOST_MODEL_CONFIG_FIXTURES = [
  {
    "version": "2026.10.8",
    "source": "zod-schema.core-BAwh66MV.mjs",
    "modelSchemaSha256": "9752539b9879ba5d9384ac47986e53af3fe3cefc03c124916f23472a6a050985",
    "modelKeys": [
      "id",
      "name",
      "api",
      "baseUrl",
      "reasoning",
      "input",
      "cost",
      "contextWindow",
      "contextTokens",
      "maxTokens",
      "thinkingLevelMap",
      "params",
      "agentRuntime",
      "headers",
      "compat",
      "mediaInput",
      "metadataSource"
    ]
  },
  {
    "version": "2026.10.10",
    "source": "zod-schema.core-BohYkI3l.mjs",
    "modelSchemaSha256": "99bffdad3b7b9866b3838a12a926f51b2cf405b70bd948e04e159746a76bb0f4",
    "modelKeys": [
      "id",
      "name",
      "api",
      "baseUrl",
      "reasoning",
      "input",
      "cost",
      "contextWindow",
      "contextTokens",
      "maxTokens",
      "thinkingLevelMap",
      "params",
      "agentRuntime",
      "headers",
      "compat",
      "mediaInput",
      "responseModelEquivalent",
      "metadataSource"
    ]
  }
] as const;

type HostFixture = (typeof HOST_MODEL_CONFIG_FIXTURES)[number];

function object(value: unknown, path: string): Record<string, any> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${path}: expected object`);
  return value as Record<string, any>;
}
function strictKeys(value: Record<string, any>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) assert.ok(keys.includes(key), `${path}: Unrecognized key: "${key}"`);
}
function nonempty(value: unknown, path: string): void {
  assert.ok(typeof value === "string" && value.length >= 1, `${path}: expected nonempty string`);
}
function positive(value: unknown, path: string): void {
  assert.ok(typeof value === "number" && Number.isFinite(value) && value > 0, `${path}: expected positive number`);
}

export function assertHostModelConfig(value: unknown, fixture: HostFixture, path: string): void {
  const row = object(value, path);
  strictKeys(row, fixture.modelKeys, path);
  nonempty(row.id, `${path}.id`); nonempty(row.name, `${path}.name`);
  for (const [key, item] of Object.entries(row)) {
    const at = `${path}.${key}`;
    switch (key) {
      case "id": case "name": case "baseUrl": nonempty(item, at); break;
      // This is the plugin's emitted adapter, an accepted ModelApiSchema enum member in both versions.
      case "api": assert.equal(item, "openai-completions", at); break;
      case "reasoning": assert.equal(typeof item, "boolean", at); break;
      case "input":
        assert.ok(Array.isArray(item), at);
        for (const modality of item) assert.ok(["text", "image", "video", "audio"].includes(modality), at);
        break;
      case "contextWindow": case "maxTokens": positive(item, at); break;
      case "cost": {
        const cost = object(item, at); strictKeys(cost, ["input", "output", "cacheRead", "cacheWrite"], at);
        for (const number of Object.values(cost)) assert.ok(typeof number === "number" && Number.isFinite(number), at);
        break;
      }
      case "thinkingLevelMap": {
        const map = object(item, at); strictKeys(map, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], at);
        for (const mapped of Object.values(map)) assert.ok(mapped === null || typeof mapped === "string", at);
        break;
      }
      case "compat": {
        const compat = object(item, at); strictKeys(compat, ["supportsReasoningEffort", "supportedReasoningEfforts"], at);
        if ("supportsReasoningEffort" in compat) assert.equal(typeof compat.supportsReasoningEffort, "boolean", at);
        if ("supportedReasoningEfforts" in compat) {
          assert.ok(Array.isArray(compat.supportedReasoningEfforts), at);
          for (const effort of compat.supportedReasoningEfforts) nonempty(effort, at);
        }
        break;
      }
      default: assert.fail(`${at}: host field not emitted by plugin; extend fixture validation before using`);
    }
  }
}

export function assertHostProviderConfig(value: unknown, fixture: HostFixture): void {
  const path = "models.providers.antigravity";
  const provider = object(value, path);
  // Projection of the four ModelProviderSchema properties emitted by this plugin.
  strictKeys(provider, ["baseUrl", "api", "auth", "models"], path);
  if ("baseUrl" in provider) assert.equal(typeof provider.baseUrl, "string");
  if ("api" in provider) assert.equal(provider.api, "openai-completions");
  if ("auth" in provider) assert.ok(["api-key", "aws-sdk", "oauth", "token"].includes(provider.auth));
  if ("models" in provider) {
    assert.ok(Array.isArray(provider.models));
    provider.models.forEach((row: unknown, i: number) => assertHostModelConfig(row, fixture, `${path}.models.${i}`));
  }
}
