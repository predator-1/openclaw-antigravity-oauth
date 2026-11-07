import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ANTIGRAVITY_FETCH_AUTO_DETECT_ORDER,
  ANTIGRAVITY_FETCH_DEFAULT_TIMEOUT_MS,
  ANTIGRAVITY_FETCH_OPAQUE_ERROR,
  ANTIGRAVITY_FETCH_PROVIDER_ID,
  ANTIGRAVITY_FETCH_TOOL_PARAMETERS,
  forbiddenFetchUrlReason,
  htmlToReadable,
  ANTIGRAVITY_SEARCH_AUTO_DETECT_ORDER,
  ANTIGRAVITY_SEARCH_PROVIDER_ID,
  ANTIGRAVITY_SEARCH_TOOL_PARAMETERS,
  ANTIGRAVITY_SEARCH_UPSTREAM_MODEL,
  antigravityPlugin,
  ANTIGRAVITY_CLI_USER_AGENT,
  assertInlineAudioWithinLimit,
  buildAntigravityMediaUnderstandingProvider,
  buildAntigravityQuotaHeaders,
  buildAntigravityWebSearchProvider,
  buildAntigravityWebFetchProvider,
  fetchFromTrawlerCacheUrl,
  buildAntigravityImageGenerationProvider,
  calculateBucketUsedPercent,
  classifyGoogleRpc429,
  createAntigravityProvider,
  CLI_VERSION,
  buildAgyUserAgent,
  mapAgyOsArch,
  buildAntigravityHeaders,
  cleanJsonSchema,
  ToolNameMapper,
  DEFAULT_ENDPOINTS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_PROJECT_ID,
  extractErrorSummary,
  formatResetTime,
  INLINE_AUDIO_MAX_BYTES,
  INLINE_AUDIO_REQUEST_MAX_BYTES,
  inferQuotaWindow,
  InMemoryAuthProfileStore,
  isEligibleChatModel,
  normalizeModelRow,
  parseFormattedApiKey,
  PLUGIN_ID,
  PROVIDER_ID,
  toOpenClawCatalogModelDefinition,
  type AntigravityImageGenerationProvider,
  type AntigravityMediaUnderstandingProvider,
  type AntigravityWebSearchProvider,
  type AntigravityWebFetchProvider,
  type FetchLike,
  type ModelAuthRuntime,
  type OpenClawProviderRegistration
} from "../dist/index.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function sseResponse(events: unknown[], status = 200, headers: Record<string, string> = {}): Response {
  const chunks = events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(chunks, {
    status,
    headers: {
      "Content-Type": "text/event-stream",
      ...headers
    }
  });
}

describe("@openclaw/antigravity-provider acceptance suite (docs/architecture.md, Contract §6)", () => {
  it("registers provider 'antigravity' via definePluginEntry and api.registerProvider (synchronous register & auth array)", () => {
    let registered: OpenClawProviderRegistration | undefined;
    antigravityPlugin.register({
      registerProvider(p) {
        registered = p;
      }
    });

    assert.ok(registered, "Provider should be registered via register(api)");
    assert.equal(registered.id, "antigravity");
    assert.equal(registered.api, "openai-completions");
    assert.equal(Array.isArray(registered.auth), true, "provider.auth must be an array for OpenClaw 2026.10.8");
    assert.equal(registered.auth.length, 1);
    assert.equal(registered.auth[0]?.id, "oauth");
    assert.equal(registered.auth[0]?.kind, "oauth");
    assert.deepEqual(registered.auth.methods, ["oauth"]);
  });

  it("1. Login: device-code login with an eligible account stores a profile without leaking tokens", async () => {
    const printedLines: string[] = [];
    const authStore = new InMemoryAuthProfileStore();
    const secretAccess = "ya29.SECRET_ACCESS_TOKEN_DO_NOT_PRINT";
    const secretRefresh = "1//SECRET_REFRESH_TOKEN_DO_NOT_PRINT";

    let pollCount = 0;
    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.deviceCodeUrl) {
        return jsonResponse({
          device_code: "dev_code_123",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 300,
          interval: 1
        });
      }
      if (url === DEFAULT_ENDPOINTS.tokenUrl) {
        pollCount += 1;
        if (pollCount === 1) {
          return jsonResponse({ error: "authorization_pending" }, 400);
        }
        return jsonResponse({
          access_token: secretAccess,
          refresh_token: secretRefresh,
          expires_in: 3600
        });
      }
      if (url === DEFAULT_ENDPOINTS.verifySubscriptionUrl) {
        return jsonResponse({
          eligible: true,
          accountId: "acct_eligible_01"
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore,
      pollIntervalMs: 5
    });

    const result = await provider.auth.login({
      method: "oauth",
      authStore,
      print: (msg) => printedLines.push(msg)
    });

    assert.equal(result.profile.provider, "antigravity");
    assert.equal(result.profile.method, "oauth");
    assert.equal(result.accountId, "acct_eligible_01");

    // Verify stored secret in OpenClaw auth profile store
    const stored = await authStore.getSecret("antigravity");
    assert.ok(stored, "Auth profile secret should be saved");
    assert.equal(stored.accessToken, secretAccess);
    assert.equal(stored.refreshToken, secretRefresh);

    // Verify stdout/stderr output contains device URL & user code, and NEVER contains tokens
    const combinedOutput = printedLines.join("\n");
    assert.match(combinedOutput, /https:\/\/www\.google\.com\/device/);
    assert.match(combinedOutput, /ABCD-EFGH/);
    assert.equal(combinedOutput.includes(secretAccess), false, "Access token must not be printed");
    assert.equal(combinedOutput.includes(secretRefresh), false, "Refresh token must not be printed");
    assert.equal(combinedOutput.toLowerCase().includes("bearer"), false, "Auth header must not be printed");
  });

  it("2. Ineligible account: login exits non-zero with 'subscription not eligible' and leaves no profile", async () => {
    const authStore = new InMemoryAuthProfileStore();

    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.deviceCodeUrl) {
        return jsonResponse({
          device_code: "dev_code_ineligible",
          user_code: "WXYZ-1234",
          verification_url: "https://www.google.com/device",
          expires_in: 300,
          interval: 1
        });
      }
      if (url === DEFAULT_ENDPOINTS.tokenUrl) {
        return jsonResponse({
          access_token: "ya29.ineligible_token",
          refresh_token: "1//ineligible_refresh",
          expires_in: 3600
        });
      }
      if (url === DEFAULT_ENDPOINTS.verifySubscriptionUrl) {
        return jsonResponse({
          eligible: false,
          subscriptionStatus: "NONE"
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore,
      pollIntervalMs: 5
    });

    await assert.rejects(
      async () => {
        await provider.auth.login({
          method: "oauth",
          authStore,
          print: () => {}
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "subscription not eligible");
        return true;
      }
    );

    const stored = await authStore.getSecret("antigravity");
    assert.equal(stored, null, "No half-saved profile may remain after ineligible login");
  });

  it("3. Catalog: lists subscription chat models only (no image, video, audio, embedding, speech, or 'off' when reasoning cannot be disabled)", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.valid",
      refreshToken: "1//valid",
      expiresAt: Date.now() + 3600_000
    });

    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: [
            {
              id: "gemini-3-pro",
              displayName: "Gemini 3 Pro",
              modality: "chat",
              contextWindow: 1000000,
              maxOutputTokens: 65536,
              canDisableReasoning: false,
              reasoningLevels: ["off", "low", "medium", "high"]
            },
            {
              id: "gemini-3-flash",
              displayName: "Gemini 3 Flash",
              modality: "chat",
              contextWindow: 1000000,
              maxOutputTokens: 32768,
              canDisableReasoning: true,
              reasoningLevels: ["off", "low", "medium", "high"]
            },
            {
              id: "imagen-4-ultra",
              displayName: "Imagen 4 Ultra",
              modality: "image"
            },
            {
              id: "veo-3-video",
              displayName: "Veo 3",
              modality: "video"
            },
            {
              id: "chirp-3-audio",
              displayName: "Chirp 3",
              modality: "audio"
            },
            {
              id: "text-embedding-005",
              displayName: "Text Embedding 005",
              modality: "embedding"
            },
            {
              id: "gemini-speech-tts",
              displayName: "Gemini Speech TTS",
              modality: "speech"
            }
          ]
        });
      }
      if (url === DEFAULT_ENDPOINTS.usageUrl) {
        return jsonResponse({
          inputTokens: 1200,
          outputTokens: 350,
          thinkingTokens: 400,
          cacheReadTokens: 800,
          quotaWindow: "5h",
          resetAt: "2026-10-30T02:00:00Z"
          // usedPercentage intentionally omitted to verify omission reporting
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const models = await provider.catalog.listModels({ refresh: true });
    assert.equal(models.length, 2);
    assert.deepEqual(
      models.map((m) => m.id),
      ["gemini-3-pro", "gemini-3-flash"]
    );
    assert.deepEqual(
      models.map((m) => m.ref),
      ["antigravity/gemini-3-pro", "antigravity/gemini-3-flash"]
    );

    // gemini-3-pro has canDisableReasoning: false -> must NOT advertise 'off'
    const proModel = models[0]!;
    assert.equal(proModel.canDisableReasoning, false);
    assert.equal(proModel.reasoningLevels.includes("off"), false);
    assert.deepEqual(proModel.reasoningLevels, ["low", "medium", "high"]);

    // gemini-3-flash has canDisableReasoning: true -> advertises 'off'
    const flashModel = models[1]!;
    assert.equal(flashModel.canDisableReasoning, true);
    assert.equal(flashModel.reasoningLevels.includes("off"), true);

    // Usage check: omitted percentage must be reported as omitted, not invented
    const usage = await provider.catalog.getUsage();
    assert.equal(usage.inputTokens, 1200);
    assert.equal(usage.thinkingTokens, 400);
    assert.equal(usage.usedPercentage, null);
    assert.equal(usage.percentageOmitted, true);
  });

  it("Catalog: drops disabled and deprecated models and honors media flags", async () => {
    assert.equal(
      isEligibleChatModel({ id: "gemini-3-flash", modality: "chat", disabled: true }),
      false
    );
    assert.equal(
      isEligibleChatModel({ id: "gemini-3-flash", modality: "chat", enabled: false }),
      false
    );
    assert.equal(
      isEligibleChatModel({ id: "gemini-3-flash", modality: "chat", disabled: false }),
      true
    );
    assert.equal(
      isEligibleChatModel(
        { id: "gemini-3-flash", modality: "chat" },
        { deprecatedModelIds: ["gemini-3-flash"] }
      ),
      false
    );
    assert.equal(
      isEligibleChatModel(
        { id: "claude-sonnet-5-5-low", modality: "chat" },
        { deprecatedModelIds: ["claude-sonnet-5-5"] }
      ),
      false
    );
    assert.equal(
      isEligibleChatModel(
        { id: "gemini-3-flash", model: "MODEL_PLACEHOLDER_M18", modality: "chat" },
        { deprecatedModelIds: ["MODEL_PLACEHOLDER_M18"] }
      ),
      false
    );
    assert.equal(isEligibleChatModel({ id: "gemini-3-flash", modality: "chat" }), true);
    assert.equal(isEligibleChatModel({ id: "gemini-3.5-flash-lite", modality: "chat" }), true);
    assert.equal(isEligibleChatModel({ id: "gemini-3.5-flash-lite-low", modality: "chat" }), true);
    assert.equal(isEligibleChatModel({ id: "gemini-3.5-flash", modality: "chat" }), false);
    assert.equal(isEligibleChatModel({ id: "gemini-3.5-pro", modality: "chat" }), false);
    assert.equal(isEligibleChatModel({ id: "gemini-2.5-flash", modality: "chat" }), false);
    assert.equal(isEligibleChatModel({ id: "gemini-2.5-flash-lite", modality: "chat" }), false);
    assert.equal(isEligibleChatModel({ id: "gemini-3.1-flash-lite", modality: "chat" }), false);

    const mimeInferred = normalizeModelRow({
      id: "gemini-3-pro",
      modality: "chat",
      supportedMimeTypes: ["image/png", "video/mp4", "application/pdf"]
    });
    assert.ok(mimeInferred);
    assert.equal(mimeInferred.supportsImages, true);
    assert.equal(mimeInferred.supportsVideo, true);
    assert.equal(mimeInferred.supportsPdf, true);
    assert.deepEqual(toOpenClawCatalogModelDefinition(mimeInferred, DEFAULT_ENDPOINTS.chatCompletionsUrl).input, [
      "text",
      "image"
    ]);

    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.valid",
      refreshToken: "1//valid",
      expiresAt: Date.now() + 3600_000
    });

    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          deprecatedModelIds: ["gemini-3-flash", "legacy-chat-model"],
          models: [
            {
              id: "gemini-3-pro",
              displayName: "Gemini 3 Pro",
              modality: "chat",
              supportsImages: true,
              supportsVideo: true,
              supportsPdf: true,
              supportedMimeTypes: ["image/jpeg", "video/mp4", "application/pdf"]
            },
            {
              id: "gemini-3-flash",
              displayName: "Gemini 3 Flash",
              modality: "chat"
            },
            {
              id: "claude-sonnet-5-5",
              displayName: "Claude Sonnet 5.5",
              modality: "chat",
              disabled: true
            },
            {
              id: "legacy-chat-model",
              displayName: "Legacy Chat",
              modality: "chat"
            }
          ]
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const models = await provider.catalog.listModels({ refresh: true });
    assert.deepEqual(
      models.map((m) => m.id),
      ["gemini-3-pro"]
    );
    const pro = models[0]!;
    assert.equal(pro.supportsImages, true);
    assert.equal(pro.supportsVideo, true);
    assert.equal(pro.supportsPdf, true);
    assert.deepEqual(pro.supportedMimeTypes, ["image/jpeg", "video/mp4", "application/pdf"]);
    assert.deepEqual(toOpenClawCatalogModelDefinition(pro, DEFAULT_ENDPOINTS.chatCompletionsUrl).input, [
      "text",
      "image"
    ]);
  });

  it("4. Text: a turn whose prompt is 'Reply with exactly the single word pong' streams deltas and returns 'pong' with zero tool calls", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.valid_turn_token",
      refreshToken: "1//valid_turn_refresh",
      expiresAt: Date.now() + 3600_000
    });

    let turnNetworkCalls = 0;
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      turnNetworkCalls += 1;
      assert.equal(url, DEFAULT_ENDPOINTS.chatCompletionsUrl);

      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), "Bearer ya29.valid_turn_token");

      const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(sentBody.model, "gemini-3-pro");
      assert.equal(sentBody.stream, true);

      return sseResponse([
        { choices: [{ delta: { content: "po" } }] },
        {
          choices: [{ delta: { content: "ng" } }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 1,
            thinking_tokens: 5,
            cache_read_tokens: 0
          }
        }
      ]);
    };

    const { provider, catalogService } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    catalogService.setCachedModels([
      {
        id: "gemini-3-pro",
        ref: "antigravity/gemini-3-pro",
        displayName: "Gemini 3 Pro",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);

    const deltas: string[] = [];
    const response = await provider.completeTurn({
      model: "antigravity/gemini-3-pro",
      messages: [{ role: "user", content: "Reply with exactly the single word pong" }],
      onTextDelta: (d) => deltas.push(d)
    });

    assert.equal(turnNetworkCalls, 1, "Must make exactly one HTTPS request during the turn");
    assert.deepEqual(deltas, ["po", "ng"]);
    assert.equal(response.text, "pong");
    assert.deepEqual(response.toolCalls, []);
    assert.deepEqual(response.usage, {
      inputTokens: 12,
      outputTokens: 1,
      thinkingTokens: 5,
      cacheReadTokens: 0
    });
  });

  it("5. Tool: a turn with a host-supplied 'lookup_weather' tool calls that tool with arguments untouched", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.valid_tool_token",
      refreshToken: "1//valid_tool_refresh",
      expiresAt: Date.now() + 3600_000
    });

    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      assert.equal(url, DEFAULT_ENDPOINTS.chatCompletionsUrl);

      const sentBody = JSON.parse(String(init?.body)) as {
        tools?: Array<{ function: { name: string } }>;
      };
      assert.equal(sentBody.tools?.length, 1);
      assert.equal(sentBody.tools?.[0]?.function.name, "lookup_weather");

      return sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_weather_1",
                    type: "function",
                    function: {
                      name: "lookup_weather",
                      arguments: JSON.stringify({ city: "Paris", unit: "celsius" })
                    }
                  }
                ]
              }
            }
          ]
        }
      ]);
    };

    const { provider, catalogService } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    catalogService.setCachedModels([
      {
        id: "gemini-3-pro",
        ref: "antigravity/gemini-3-pro",
        displayName: "Gemini 3 Pro",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);

    const response = await provider.completeTurn({
      model: "antigravity/gemini-3-pro",
      messages: [{ role: "user", content: "What is the weather in Paris?" }],
      tools: [
        {
          name: "lookup_weather",
          description: "Look up current weather for a city",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string" },
              unit: { type: "string" }
            },
            required: ["city"]
          }
        }
      ]
    });

    assert.equal(response.text, "");
    assert.equal(response.toolCalls.length, 1);
    assert.deepEqual(response.toolCalls[0], {
      id: "call_weather_1",
      name: "lookup_weather",
      arguments: { city: "Paris", unit: "celsius" }
    });
  });

  it("6. Native tool refusal: fails immediately with 'native tool refused' or 'native tools offered' if endpoint emits or offers native CLI tools", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.valid_token",
      refreshToken: "1//valid_refresh",
      expiresAt: Date.now() + 3600_000
    });

    let scenario: "emitted_manage_task" | "emitted_unrequested_tool" | "offered_native_tools" =
      "emitted_manage_task";

    const mockFetch: FetchLike = async () => {
      if (scenario === "emitted_manage_task") {
        return sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: "call_native_1",
                      type: "function",
                      function: {
                        name: "manage_task",
                        arguments: JSON.stringify({ Action: "list" })
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]);
      }
      if (scenario === "emitted_unrequested_tool") {
        return sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: "call_native_2",
                      type: "function",
                      function: {
                        name: "run_command",
                        arguments: JSON.stringify({ CommandLine: "uname -a" })
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]);
      }
      return jsonResponse({
        offered_tools: ["manage_task", "run_command"],
        choices: [{ message: { content: "hello" } }]
      });
    };

    const { provider, catalogService } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    catalogService.setCachedModels([
      {
        id: "gemini-3-pro",
        ref: "antigravity/gemini-3-pro",
        displayName: "Gemini 3 Pro",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);

    // Case A: Endpoint attempts to emit `manage_task`
    await assert.rejects(
      async () => {
        await provider.completeTurn({
          model: "antigravity/gemini-3-pro",
          messages: [{ role: "user", content: "Check tasks" }]
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /native tool refused: manage_task/);
        return true;
      }
    );

    // Case B: Endpoint attempts to emit `run_command`
    scenario = "emitted_unrequested_tool";
    await assert.rejects(
      async () => {
        await provider.completeTurn({
          model: "antigravity/gemini-3-pro",
          messages: [{ role: "user", content: "Run a shell command" }]
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /native tool refused: run_command/);
        return true;
      }
    );

    // Case C: Endpoint offers native tools in payload metadata
    scenario = "offered_native_tools";
    await assert.rejects(
      async () => {
        await provider.completeTurn({
          model: "antigravity/gemini-3-pro",
          messages: [{ role: "user", content: "Hello" }]
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "native tools offered");
        return true;
      }
    );

    // Case D: Endpoint emits an OpenClaw host tool (e.g. session_status) -> must NOT refuse, pass to OpenClaw
    const mockHostFetch: FetchLike = async () => {
      return sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "call_status_1",
                    type: "function",
                    function: {
                      name: "session_status",
                      arguments: JSON.stringify({})
                    }
                  }
                ]
              }
            }
          ]
        }
      ]);
    };
    const { provider: hostProvider, catalogService: hostCatalog } = createAntigravityProvider({
      fetchImpl: mockHostFetch,
      authStore
    });
    hostCatalog.setCachedModels([
      {
        id: "claude-sonnet-5-5",
        ref: "antigravity/claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);
    const hostTurn = await hostProvider.completeTurn({
      model: "antigravity/claude-sonnet-5-5",
      messages: [{ role: "user", content: "how many context here?" }]
    });
    assert.equal(hostTurn.toolCalls.length, 1);
    assert.equal(hostTurn.toolCalls[0]?.name, "session_status");
  });

  it("Additional guardrails: rejects unknown model before network call, rejects unsupported reasoning effort, and fails on empty 200 reply", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.valid_token",
      refreshToken: "1//valid_refresh",
      expiresAt: Date.now() + 3600_000
    });

    let networkCalls = 0;
    const mockFetch: FetchLike = async () => {
      networkCalls += 1;
      return jsonResponse({
        choices: [{ message: { content: "" } }]
      });
    };

    const { provider, catalogService } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    catalogService.setCachedModels([
      {
        id: "gemini-3-pro",
        ref: "antigravity/gemini-3-pro",
        displayName: "Gemini 3 Pro",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);

    // Unknown model must fail before making any billable network call
    await assert.rejects(
      async () => {
        await provider.completeTurn({
          model: "antigravity/invented-model-99",
          messages: [{ role: "user", content: "Hi" }]
        });
      },
      /unknown model: invented-model-99/
    );
    assert.equal(networkCalls, 0, "Unknown model must not trigger a network call");

    // Unsupported reasoning effort 'off' when canDisableReasoning is false
    await assert.rejects(
      async () => {
        await provider.completeTurn({
          model: "antigravity/gemini-3-pro",
          reasoningEffort: "off",
          messages: [{ role: "user", content: "Hi" }]
        });
      },
      /unsupported reasoning effort "off"/
    );
    assert.equal(networkCalls, 0, "Unsupported reasoning effort must not trigger a network call");

    // Empty reply with 200 status must fail
    await assert.rejects(
      async () => {
        await provider.completeTurn({
          model: "antigravity/gemini-3-pro",
          messages: [{ role: "user", content: "Hi" }]
        });
      },
      /Empty reply from subscription endpoint/
    );
    assert.equal(networkCalls, 1);
  });

  it("Catalog: publishes gemini-3.5-flash-lite as the cheap chat model and keeps 2.5/3.1 filtered", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.flash_lite_token",
      refreshToken: "1//flash_lite_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    let sentUpstreamModel: string | undefined;
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.5-flash-lite": {
              id: "gemini-3.5-flash-lite",
              modality: "chat"
            },
            "gemini-2.5-flash": {
              model: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
              displayName: "Gemini 3.5 Flash Lite",
              modality: "chat"
            },
            "gemini-2.5-flash-lite": {
              id: "gemini-2.5-flash-lite",
              modality: "chat"
            },
            "gemini-3.1-flash-lite": {
              id: "gemini-3.1-flash-lite",
              modality: "chat"
            },
            "gemini-3.5-pro": {
              id: "gemini-3.5-pro",
              modality: "chat"
            },
            "gemini-3-flash": {
              id: "gemini-3-flash",
              modality: "chat"
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        sentUpstreamModel = (JSON.parse(String(init?.body)) as { model?: string }).model;
        return sseResponse([
          { response: { candidates: [{ content: { parts: [{ text: "pong" }] } }] } }
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const models = await provider.catalog.listModels({ refresh: true });
    assert.deepEqual(
      models.map((m) => m.id),
      ["gemini-3.5-flash-lite", "gemini-3-flash"]
    );

    const lite = models.find((m) => m.id === "gemini-3.5-flash-lite")!;
    assert.equal(lite.displayName, "Gemini 3.5 Flash Lite");
    assert.equal(lite.contextWindow, 1_000_000);
    assert.equal(lite.maxOutputTokens, 8192);
    assert.equal(lite.canDisableReasoning, true);
    assert.deepEqual(lite.reasoningLevels, ["off", "low", "medium", "high"]);

    const definition = toOpenClawCatalogModelDefinition(lite, DEFAULT_ENDPOINTS.chatCompletionsUrl);
    assert.equal(definition.id, "gemini-3.5-flash-lite");
    assert.equal(definition.name, "Gemini 3.5 Flash Lite");
    assert.equal("tags" in definition, false, "provider model settings reject authored-catalog tags");
    assert.deepEqual(definition.input, ["text", "image"]);
    assert.deepEqual(definition.compat?.supportedReasoningEfforts, ["off", "low", "medium", "high"]);
    assert.equal(definition.cost.input, 0);
    assert.equal(definition.cost.output, 0);

    assert.equal(
      models.some((m) => m.id.startsWith("gemini-2.5") || m.id.startsWith("gemini-3.1") || m.id === "gemini-3.5-pro"),
      false
    );

    const turn = await provider.completeTurn({
      model: "antigravity/gemini-3.5-flash-lite",
      messages: [{ role: "user", content: "Reply with exactly the single word pong" }]
    });
    assert.equal(turn.text, "pong");
    assert.equal(sentUpstreamModel, "gemini-3.5-flash-lite");
  });

  it("7. Real v1internal:fetchAvailableModels map payload: deduplicates effort variants, filters internal/image/tab models, assigns 1M context window, and routes turns to upstream effort slug", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.valid_token",
      refreshToken: "1//valid_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    const sentUpstreamModels: string[] = [];
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "claude-sonnet-5-5-low": {
              model: "MODEL_PLACEHOLDER_M403",
              displayName: "Claude Sonnet 5.5 (Low)",
              maxTokens: 128000
            },
            "claude-sonnet-5-5-medium": {
              model: "MODEL_PLACEHOLDER_M404",
              displayName: "Claude Sonnet 5.5 (Medium)",
              maxTokens: 128000
            },
            "claude-sonnet-5-5-high": {
              model: "MODEL_PLACEHOLDER_M405",
              displayName: "Claude Sonnet 5.5 (High)",
              maxTokens: 128000
            },
            "gpt-oss-120b-medium": {
              model: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
              displayName: "GPT-OSS 120B (Medium)",
              maxTokens: 32768
            },
            "gemini-3-flash": {
              model: "MODEL_PLACEHOLDER_M18",
              displayName: "Gemini 3 Flash",
              maxTokens: 65536
            },
            "gemini-2.5-flash": {
              model: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
              displayName: "Gemini 3.5 Flash Lite",
              maxTokens: 65535
            },
            "gemini-3.1-flash-image": {
              model: "MODEL_PLACEHOLDER_M21",
              displayName: "Gemini 3.1 Flash Image",
              maxTokens: 65536
            },
            chat_20706: {
              model: "MODEL_CHAT_20706",
              maxTokens: 8192
            },
            tab_flash_lite_preview: {
              model: "MODEL_PLACEHOLDER_M19",
              maxTokens: 4096
            },
            "gemini-3.8-flash-tiered": {
              model: "MODEL_PLACEHOLDER_M322",
              maxTokens: 65536
            },
            "gemini-4-argon-medium": {
              model: "MODEL_PLACEHOLDER_M318",
              displayName: "Gemini 4 Argon (Medium)",
              maxTokens: 65536
            }
          }
        });
      }
      if (url === DEFAULT_ENDPOINTS.chatCompletionsUrl) {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          project: string;
          request: { generationConfig?: unknown };
        };
        sentUpstreamModels.push(body.model);
        assert.equal(body.project, "default-cli-project");
        assert.equal(body.request.generationConfig, undefined);
        return sseResponse([
          {
            response: {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: "pong" }]
                  }
                }
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 1
              }
            }
          }
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const models = await provider.catalog.listModels({ refresh: true });
    assert.deepEqual(
      models.map((m) => m.id),
      ["claude-sonnet-5-5", "gpt-oss-120b", "gemini-3-flash", "gemini-3.8-flash", "gemini-4-argon"]
    );
    assert.deepEqual(
      models.map((m) => m.displayName),
      ["Claude Sonnet 5.5", "GPT-OSS 120B", "Gemini 3 Flash", "Gemini 3.8 Flash", "Gemini 4 Argon"]
    );

    const claude = models.find((m) => m.id === "claude-sonnet-5-5")!;
    assert.equal(claude.contextWindow, 1_000_000);
    assert.equal(claude.maxOutputTokens, 128_000);
    assert.equal(claude.canDisableReasoning, false);
    assert.deepEqual(claude.reasoningLevels, ["low", "medium", "high"]);

    const gptOss = models.find((m) => m.id === "gpt-oss-120b")!;
    assert.equal(gptOss.contextWindow, 128_000);
    assert.equal(gptOss.maxOutputTokens, 32_768);
    assert.deepEqual(gptOss.reasoningLevels, ["medium"]);

    const geminiFlash = models.find((m) => m.id === "gemini-3-flash")!;
    assert.equal(geminiFlash.contextWindow, 1_000_000);

    const flash38 = models.find((m) => m.id === "gemini-3.8-flash")!;
    assert.equal(flash38.contextWindow, 1_000_000);

    const argon = models.find((m) => m.id === "gemini-4-argon")!;
    assert.equal(argon.contextWindow, 1_000_000);
    assert.equal(argon.displayName, "Gemini 4 Argon");

    // Turn with canonical model + reasoningEffort 'high' routes to 'claude-sonnet-5-5-high'
    const turn1 = await provider.completeTurn({
      model: "antigravity/claude-sonnet-5-5",
      reasoningEffort: "high",
      messages: [{ role: "user", content: "ping" }]
    });
    assert.equal(turn1.text, "pong");

    // Turn with legacy effort-suffixed model ID 'claude-sonnet-5-5-low' also routes cleanly
    const turn2 = await provider.completeTurn({
      model: "antigravity/claude-sonnet-5-5-low",
      messages: [{ role: "user", content: "ping" }]
    });
    assert.equal(turn2.text, "pong");

    // Turn with gemini-4-argon routes to gemini-4-argon-medium
    const turn3 = await provider.completeTurn({
      model: "antigravity/gemini-4-argon",
      messages: [{ role: "user", content: "ping" }]
    });
    assert.equal(turn3.text, "pong");

    assert.deepEqual(sentUpstreamModels, [
      "claude-sonnet-5-5-high",
      "claude-sonnet-5-5-low",
      "gemini-4-argon-medium"
    ]);
  });

  it("8. Diagnostic visibility & schema cleanup: sanitizes tool parameters and includes HTTP error response bodies", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.VALID_TOKEN",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    let sentRequestBody: any;
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "claude-opus-5-5-medium": {
              model: "MODEL_PLACEHOLDER_M401",
              displayName: "Claude Opus 5.5 (Medium)",
              enabled: true
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        sentRequestBody = JSON.parse(String(init?.body));
        return jsonResponse(
          {
            error: {
              code: 400,
              message: "Invalid field 'bad_param': not supported",
              status: "INVALID_ARGUMENT"
            }
          },
          400
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider, catalogService } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    await provider.catalog.listModels({ refresh: true });

    // Test proto enum ID resolution: MODEL_PLACEHOLDER_M401 -> claude-opus-5-5-medium
    const resolved = catalogService.resolveModelForTurn("MODEL_PLACEHOLDER_M401");
    assert.ok(resolved, "Should resolve MODEL_PLACEHOLDER_M401");
    assert.equal(resolved.matchedModel.id, "claude-opus-5-5");
    assert.equal(resolved.upstreamModelId, "claude-opus-5-5-medium");

    // Turn with complex schema that has $schema and additionalProperties
    await assert.rejects(
      async () => {
        await provider.completeTurn({
          model: "antigravity/MODEL_PLACEHOLDER_M401",
          messages: [{ role: "user", content: "hello" }],
          tools: [
            {
              name: "test_tool",
              description: "test description",
              parameters: {
                $schema: "http://json-schema.org/draft-07/schema#",
                type: "object",
                additionalProperties: false,
                properties: {
                  target: {
                    type: "string",
                    description: "target file",
                    default: "foo"
                  }
                },
                required: ["target"]
              }
            }
          ]
        });
      },
      (err: Error) => {
        assert.ok(
          err.message.includes("400") && err.message.includes("Invalid field 'bad_param'"),
          `Expected error message to contain HTTP 400 and upstream body text, got: ${err.message}`
        );
        return true;
      }
    );

    // Verify sent tool schema was cleaned
    const funcDecl = sentRequestBody.request.tools[0].functionDeclarations[0];
    assert.equal(funcDecl.name, "test_tool");
    assert.equal(funcDecl.parameters.$schema, undefined, "$schema must be stripped");
    assert.equal(funcDecl.parameters.additionalProperties, undefined, "additionalProperties must be stripped");
    assert.equal(funcDecl.parameters.properties.target.type, "string");
  });

  it("9. Antigravity application alignment: publishes canonical flagship models with 1M context windows and routes Opus medium to high tier", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.FLAGSHIP_TOKEN",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    let lastSentModel = "";
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        // Upstream returns claude-opus-5-5-high, claude-sonnet-5-5-high, gemini-3.8-flash-tiered,
        // gpt-oss-120b-medium, plus junk/internal models (chat_20706, tab_jump, gemini-2.5, MODEL_*)
        // Note: gemini-4-argon is omitted upstream here to verify automatic Antigravity canonical inclusion.
        return jsonResponse({
          models: {
            "claude-opus-5-5-high": {
              model: "MODEL_PLACEHOLDER_M402",
              displayName: "Claude Opus 5.5 (High)",
              contextWindow: 128000 // upstream placeholder must be overridden to 1M
            },
            "claude-opus-5-5-low": {
              model: "MODEL_PLACEHOLDER_M400",
              displayName: "Claude Opus 5.5 (Low)",
              contextWindow: 128000
            },
            "claude-sonnet-5-5-high": {
              model: "MODEL_PLACEHOLDER_M405",
              displayName: "Claude Sonnet 5.5 (High)",
              contextWindow: 128000
            },
            "gemini-3.8-flash-tiered": {
              model: "MODEL_PLACEHOLDER_M322",
              displayName: "gemini-3.8-flash-tiered",
              contextWindow: 128000
            },
            "gpt-oss-120b-medium": {
              model: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
              displayName: "GPT-OSS 120B (Medium)",
              contextWindow: 128000
            },
            chat_20706: {
              model: "MODEL_CHAT_20706"
            },
            tab_jump_flash_lite_preview: {
              model: "MODEL_PLACEHOLDER_M19"
            },
            "gemini-2.5-pro": {
              model: "MODEL_GOOGLE_GEMINI_2_5_PRO"
            },
            MODEL_PLACEHOLDER_M28: {
              model: "MODEL_PLACEHOLDER_M28"
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        const body = JSON.parse(String(init?.body)) as { model: string };
        lastSentModel = body.model;
        return sseResponse([
          {
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 }
            }
          }
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider, catalogService } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const models = await provider.catalog.listModels({ refresh: true });
    // Exactly the 5 Antigravity models (no junk, no tab, no chat, no MODEL_, no gemini-2.5)
    assert.deepEqual(
      models.map((m) => m.id),
      ["claude-opus-5-5", "claude-sonnet-5-5", "gemini-3.8-flash", "gpt-oss-120b", "gemini-4-argon"]
    );

    // Verify context windows
    const opus = models.find((m) => m.id === "claude-opus-5-5")!;
    assert.equal(opus.contextWindow, 1_000_000);
    assert.equal(opus.displayName, "Claude Opus 5.5");

    const sonnet = models.find((m) => m.id === "claude-sonnet-5-5")!;
    assert.equal(sonnet.contextWindow, 1_000_000);

    const flash = models.find((m) => m.id === "gemini-3.8-flash")!;
    assert.equal(flash.contextWindow, 1_000_000);
    assert.equal(flash.displayName, "Gemini 3.8 Flash");

    const argon = models.find((m) => m.id === "gemini-4-argon")!;
    assert.equal(argon.contextWindow, 1_000_000);
    assert.equal(argon.displayName, "Gemini 4 Argon");

    const gpt = models.find((m) => m.id === "gpt-oss-120b")!;
    assert.equal(gpt.contextWindow, 128_000);

    // Verify turn resolution: claude-opus-5-5 with medium effort routes to claude-opus-5-5-high
    await provider.completeTurn({
      model: "antigravity/claude-opus-5-5",
      reasoningEffort: "medium",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(lastSentModel, "claude-opus-5-5-high");

    // Verify gemini-4-argon turn routes to gemini-4-argon-medium (default tier)
    await provider.completeTurn({
      model: "antigravity/gemini-4-argon",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(lastSentModel, "gemini-4-argon-medium");

    // Verify gemini-4-argon with high effort routes to gemini-4-argon-high
    await provider.completeTurn({
      model: "antigravity/gemini-4-argon",
      reasoningEffort: "high",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(lastSentModel, "gemini-4-argon-high");

    // Stale proto alias still resolves; the dead id is never sent upstream
    await provider.completeTurn({
      model: "antigravity/MODEL_PLACEHOLDER_M124",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(lastSentModel, "gemini-4-argon-medium");

    // Verify gemini-3.8-flash turn routes to gemini-3.8-flash-tiered
    await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(lastSentModel, "gemini-3.8-flash-tiered");
  });

  it("10. Quota formatting: formatResetTime accurately computes human-readable local time and countdown durations", () => {
    const fixedNow = Date.parse("2026-10-30T10:00:00Z");

    // 45 minutes in the future
    const in45m = new Date(fixedNow + 45 * 60_000).toISOString();
    const res45m = formatResetTime(in45m, fixedNow);
    assert.ok(res45m);
    assert.equal(res45m.relative, "in 45m");

    // 2 hours 15 minutes in the future
    const in2h15m = new Date(fixedNow + (2 * 3600_000 + 15 * 60_000)).toISOString();
    const res2h = formatResetTime(in2h15m, fixedNow);
    assert.ok(res2h);
    assert.equal(res2h.relative, "in 2h 15m");

    // Already passed or 0 seconds
    const passed = new Date(fixedNow - 5000).toISOString();
    const resPassed = formatResetTime(passed, fixedNow);
    assert.ok(resPassed);
    assert.equal(resPassed.relative, "momentarily");

    // Invalid / empty strings return null safely
    assert.equal(formatResetTime(""), null);
    assert.equal(formatResetTime(undefined), null);
    assert.equal(formatResetTime("not-a-date"), null);
  });

  it("11. Quota error streaming: when a model hits HTTP 429 quota exhaustion, streams user-facing notice with reset time and countdown into chat", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.quota_test_token",
      refreshToken: "1//quota_test_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    const resetIso = new Date(Date.now() + 90 * 60_000).toISOString(); // 1h 30m in future

    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              id: "gemini-3.8-flash-tiered",
              displayName: "Gemini 3.8 Flash",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 8192
            }
          }
        });
      }
      if (url === DEFAULT_ENDPOINTS.usageUrl) {
        return jsonResponse({
          inputTokens: 1000,
          outputTokens: 500,
          quotaWindow: "5h",
          resetAt: resetIso,
          buckets: [
            {
              bucketId: "gemini-3.8-flash",
              window: "5h",
              remainingFraction: 0,
              resetTime: resetIso
            }
          ]
        });
      }
      if (url.includes(":streamGenerateContent")) {
        // Return HTTP 429 Quota Exceeded
        return new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: "Resource has been exhausted (e.g. check quota).",
              status: "RESOURCE_EXHAUSTED"
            }
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "retry-after": "5400"
            }
          }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const streamFn = provider.createStreamFn();
    const stream = streamFn(
      {
        id: "gemini-3.8-flash",
        api: "openai-completions",
        provider: "antigravity"
      },
      {
        messages: [{ role: "user", content: "hello" }]
      },
      {
        apiKey: JSON.stringify({ token: "ya29.quota_test_token", projectId: "default-cli-project" })
      }
    );

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    // Verify text deltas were streamed to the chat
    const textDeltaEvents = events.filter((e) => e.type === "text_delta");
    assert.ok(textDeltaEvents.length > 0, "Should stream text delta notice for quota exhaustion");

    const fullStreamedText = textDeltaEvents.map((e) => e.delta as string).join("");
    assert.match(fullStreamedText, /quota exhausted/i);
    assert.match(fullStreamedText, /Resets at:/);
    assert.match(fullStreamedText, /in 1h 30m/);

    // Verify final message contains the notice content
    const errorEvent = events.find((e) => e.type === "error");
    assert.ok(errorEvent, "Stream should end with error event");
    const errMsg = errorEvent.error as Record<string, unknown>;
    const content = errMsg.content as Array<{ type: string; text: string }>;
    assert.ok(content.length > 0, "Error message should include user-facing content blocks");
    assert.match(content[0]!.text, /quota exhausted/i);
  });

  it("12. Thought signatures: falls back to skip_thought_signature_validator when history has no stored signature", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.thought_test_token",
      refreshToken: "1//thought_test_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    let sentBody: Record<string, unknown> | null = null;
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              id: "gemini-3.8-flash-tiered",
              displayName: "Gemini 3.8 Flash",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 8192
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        sentBody = JSON.parse(String(init?.body));
        return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    await provider.catalog.listModels();

    await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [
        { role: "user", content: "what is the weather?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_123",
              name: "get_weather",
              arguments: { location: "Kyiv" }
            }
          ]
        },
        { role: "tool", content: "sunny", toolCallId: "call_123", name: "get_weather" }
      ]
    });

    assert.ok(sentBody);
    const req = (sentBody as { request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> } }).request;
    const modelTurn = req.contents.find((c) => c.role === "model");
    assert.ok(modelTurn, "Should have model turn in contents");
    const funcPart = modelTurn.parts.find((p) => p.functionCall);
    assert.ok(funcPart, "Should have functionCall in part");
    assert.equal(funcPart.thoughtSignature, "skip_thought_signature_validator");
    assert.equal(funcPart.thought_signature, "skip_thought_signature_validator");
  });

  it("13. Real Antigravity HTTP 429 quota body parsing: extracts quotaResetTimeStamp and quotaResetDelay directly from errorBody details", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.quota_real_token",
      refreshToken: "1//quota_real_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "claude-opus-5-5-high": {
              id: "claude-opus-5-5-high",
              displayName: "Claude Opus 5.5",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 8192
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        // Return real Google Cloud Code 429 payload
        return new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h56m54s.",
              status: "RESOURCE_EXHAUSTED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "QUOTA_EXHAUSTED",
                  domain: "cloudcode-pa.googleapis.com",
                  metadata: {
                    uiMessage: "true",
                    model: "claude-opus-5-5-medium",
                    quotaResetDelay: "2h56m54.112698854s",
                    quotaResetTimeStamp: new Date(Date.now() + 10614 * 1000).toISOString()
                  }
                },
                {
                  "@type": "type.googleapis.com/google.rpc.RetryInfo",
                  retryDelay: "10614.112698854s"
                }
              ]
            }
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const streamFn = provider.createStreamFn();
    const stream = streamFn(
      {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        api: "openai-completions",
        provider: "antigravity"
      },
      {
        messages: [{ role: "user", content: "hello" }]
      },
      {
        apiKey: JSON.stringify({ token: "ya29.quota_real_token", projectId: "default-cli-project" })
      }
    );

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    const textDeltaEvents = events.filter((e) => e.type === "text_delta");
    assert.ok(textDeltaEvents.length > 0, "Should stream quota text delta");
    const streamedText = textDeltaEvents.map((e) => e.delta as string).join("");
    assert.match(streamedText, /Claude Opus 5\.5/);
    assert.match(streamedText, /Resets at:/);
    assert.match(streamedText, /in 2h 5[67]m/);
    // Since model was Claude Opus, suggestion should suggest Gemini models
    assert.match(streamedText, /Gemini 3\.8 Flash/);
  });

  it("14. Reasoning effort: thinkingConfig uses canonical camelCase thinkingLevel without duplicate snake_case keys (avoids proto3 oneof violation)", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.effort_test_token",
      refreshToken: "1//effort_test_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    let sentBody: Record<string, unknown> | null = null;
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              id: "gemini-3.8-flash-tiered",
              displayName: "Gemini 3.8 Flash",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 8192
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        sentBody = JSON.parse(String(init?.body));
        return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: "reasoning test response" }] } }] } }]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    await provider.catalog.listModels();

    await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      reasoningEffort: "high",
      messages: [{ role: "user", content: "think hard" }]
    });

    assert.ok(sentBody);
    const innerReq = (sentBody as { request: { generationConfig?: { thinkingConfig?: Record<string, unknown> } } }).request;
    assert.ok(innerReq.generationConfig?.thinkingConfig, "thinkingConfig must be present");
    const thinkingConfig = innerReq.generationConfig.thinkingConfig;
    assert.equal(thinkingConfig.thinkingLevel, "HIGH");
    assert.equal(thinkingConfig.includeThoughts, true);
    // Must NOT have snake_case duplicate keys that violate protobuf oneof _thinking_level constraint
    assert.equal(thinkingConfig.thinking_level, undefined);
    assert.equal(thinkingConfig.thinking_budget, undefined);
  });

  it("14b. Reasoning effort: /think max and xhigh map to MAX and EXTRA_HIGH on supported models and are rejected with valid options elsewhere", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.effort_xhigh_token",
      refreshToken: "1//effort_xhigh_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    let streamCalls = 0;
    let sentBody: Record<string, unknown> | null = null;
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              id: "gemini-3.8-flash-tiered",
              displayName: "Gemini 3.8 Flash",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 8192
            },
            "gemini-4-argon-medium": {
              id: "gemini-4-argon-medium",
              displayName: "Gemini 4 Argon",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 65536
            },
            "claude-sonnet-5-5-high": {
              id: "claude-sonnet-5-5-high",
              displayName: "Claude Sonnet 5.5",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 128000
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        streamCalls += 1;
        sentBody = JSON.parse(String(init?.body));
        return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const models = await provider.catalog.listModels({ refresh: true });
    const flash38 = models.find((m) => m.id === "gemini-3.8-flash")!;
    const argon = models.find((m) => m.id === "gemini-4-argon")!;
    const sonnet = models.find((m) => m.id === "claude-sonnet-5-5")!;
    assert.deepEqual(flash38.reasoningLevels, ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(argon.reasoningLevels, ["low", "medium", "high"]);
    assert.deepEqual(sonnet.reasoningLevels, ["low", "medium", "high"]);

    const catalogRun = await provider.catalog.run({});
    const publishedFlash = catalogRun?.provider.models.find((m) => m.id === "gemini-3.8-flash");
    const publishedSonnet = catalogRun?.provider.models.find((m) => m.id === "claude-sonnet-5-5");
    assert.deepEqual(publishedFlash?.compat?.supportedReasoningEfforts, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
    assert.deepEqual(publishedSonnet?.compat?.supportedReasoningEfforts, ["low", "medium", "high"]);

    const flashProfile = provider.resolveThinkingProfile?.({ modelId: "antigravity/gemini-3.8-flash" });
    const argonProfile = provider.resolveThinkingProfile?.({ modelId: "gemini-4-argon" });
    const sonnetProfile = provider.resolveThinkingProfile?.({ modelId: "antigravity/claude-sonnet-5-5" });
    assert.deepEqual(
      flashProfile?.levels.map((level) => level.id),
      ["low", "medium", "high", "xhigh", "max"]
    );
    assert.deepEqual(
      argonProfile?.levels.map((level) => level.id),
      ["low", "medium", "high"]
    );
    assert.deepEqual(
      sonnetProfile?.levels.map((level) => level.id),
      ["low", "medium", "high"]
    );
    assert.equal(flashProfile?.defaultLevel, "medium");
    assert.equal(sonnetProfile?.defaultLevel, "medium");

    await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      reasoningEffort: "max",
      messages: [{ role: "user", content: "think" }]
    });
    let innerReq = sentBody as {
      model?: string;
      request: { generationConfig?: { thinkingConfig?: Record<string, unknown> } };
    };
    assert.equal(innerReq.model, "gemini-3.8-flash-tiered");
    assert.equal(innerReq.request.generationConfig?.thinkingConfig?.thinkingLevel, "MAX");

    await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      reasoningEffort: "xhigh",
      messages: [{ role: "user", content: "think" }]
    });
    innerReq = sentBody as typeof innerReq;
    assert.equal(innerReq.request.generationConfig?.thinkingConfig?.thinkingLevel, "EXTRA_HIGH");

    const streamCallsBeforeArgonReject = streamCalls;
    await assert.rejects(
      async () => {
        await provider.completeTurn({
          model: "antigravity/gemini-4-argon",
          reasoningEffort: "max",
          messages: [{ role: "user", content: "think" }]
        });
      },
      /unsupported reasoning effort "max" for model gemini-4-argon \(valid: low, medium, high\)/
    );
    assert.equal(streamCalls, streamCallsBeforeArgonReject, "argon max must not call the chat endpoint");

    const streamCallsBeforeReject = streamCalls;
    await assert.rejects(
      async () => {
        await provider.completeTurn({
          model: "antigravity/claude-sonnet-5-5",
          reasoningEffort: "max",
          messages: [{ role: "user", content: "think" }]
        });
      },
      /unsupported reasoning effort "max" for model claude-sonnet-5-5 \(valid: low, medium, high\)/
    );
    assert.equal(streamCalls, streamCallsBeforeReject, "rejected effort must not call the chat endpoint");

    const streamFn = provider.createStreamFn({ model: { id: "gemini-3.8-flash" } });
    const drain = async (thinking: string): Promise<void> => {
      const stream = streamFn(
        { id: "gemini-3.8-flash" },
        { messages: [{ role: "user", content: "think" }] },
        {
          thinking,
          apiKey: JSON.stringify({ token: "ya29.effort_xhigh_token", projectId: "default-cli-project" })
        }
      ) as AsyncIterable<Record<string, unknown>>;
      for await (const _event of stream) {
        void _event;
      }
    };

    await drain("max");
    innerReq = sentBody as typeof innerReq;
    assert.equal(innerReq.request.generationConfig?.thinkingConfig?.thinkingLevel, "MAX");

    await drain("extra-high");
    innerReq = sentBody as typeof innerReq;
    assert.equal(innerReq.request.generationConfig?.thinkingConfig?.thinkingLevel, "EXTRA_HIGH");

    await drain("maximum");
    innerReq = sentBody as typeof innerReq;
    assert.equal(innerReq.request.generationConfig?.thinkingConfig?.thinkingLevel, "MAX");
  });

  it("Structured output: host responseFormat maps onto Gemini generationConfig and is ignored for Claude", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.structured_output_token",
      refreshToken: "1//structured_output_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    let sentBody: Record<string, unknown> | null = null;
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash": {
              id: "gemini-3.8-flash",
              displayName: "Gemini 3.8 Flash",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 8192
            },
            "claude-sonnet-5-5-high": {
              id: "claude-sonnet-5-5-high",
              displayName: "Claude Sonnet 5.5",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 128000
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        sentBody = JSON.parse(String(init?.body));
        return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }] } }]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });
    await provider.catalog.listModels();

    const streamFn = provider.createStreamFn();
    const drain = async (
      modelId: string,
      options: Record<string, unknown>
    ): Promise<typeof sentBody> => {
      sentBody = null;
      const stream = streamFn(
        { id: modelId },
        { messages: [{ role: "user", content: "reply in json" }] },
        {
          apiKey: JSON.stringify({ token: "ya29.structured_output_token", projectId: "default-cli-project" }),
          ...options
        }
      ) as AsyncIterable<Record<string, unknown>>;
      for await (const _event of stream) {
        void _event;
      }
      return sentBody;
    };

    type Inner = {
      request?: {
        generationConfig?: {
          responseMimeType?: string;
          responseSchema?: Record<string, unknown>;
          thinkingConfig?: Record<string, unknown>;
        };
      };
    };

    const dirtySchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", const: "fixed" },
        count: { type: "integer" }
      },
      required: ["title"]
    };

    const rawBody = (await drain("gemini-3.8-flash", { responseFormat: dirtySchema })) as Inner;
    assert.equal(rawBody.request?.generationConfig?.responseMimeType, "application/json");
    const rawSchema = rawBody.request?.generationConfig?.responseSchema;
    assert.ok(rawSchema);
    assert.equal(rawSchema.type, "object");
    assert.equal(rawSchema.$schema, undefined);
    assert.equal(rawSchema.additionalProperties, undefined);
    assert.deepEqual(rawSchema.required, ["title"]);
    assert.equal((rawSchema.properties as Record<string, Record<string, unknown>>).title.type, "string");
    assert.equal((rawSchema.properties as Record<string, Record<string, unknown>>).title.const, undefined);
    assert.equal((rawSchema.properties as Record<string, Record<string, unknown>>).count.type, "integer");

    const wrappedBody = (await drain("gemini-3.8-flash", {
      responseFormat: {
        type: "json_schema",
        json_schema: { name: "TitleCount", schema: dirtySchema }
      }
    })) as Inner;
    assert.equal(wrappedBody.request?.generationConfig?.responseMimeType, "application/json");
    assert.deepEqual(wrappedBody.request?.generationConfig?.responseSchema?.required, ["title"]);

    const snakeBody = (await drain("gemini-3.8-flash", {
      response_format: { type: "json_object" }
    })) as Inner;
    assert.equal(snakeBody.request?.generationConfig?.responseMimeType, "application/json");
    assert.equal(snakeBody.request?.generationConfig?.responseSchema, undefined);

    const thinkingBody = (await drain("gemini-3.8-flash", {
      thinking: "low",
      responseFormat: { type: "object", properties: { ok: { type: "boolean" } } }
    })) as Inner;
    assert.equal(thinkingBody.request?.generationConfig?.responseMimeType, "application/json");
    assert.equal(thinkingBody.request?.generationConfig?.thinkingConfig?.thinkingLevel, "LOW");

    const absentBody = (await drain("gemini-3.8-flash", {})) as Inner;
    assert.equal(absentBody.request?.generationConfig?.responseMimeType, undefined);
    assert.equal(absentBody.request?.generationConfig?.responseSchema, undefined);

    const textOffBody = (await drain("gemini-3.8-flash", { responseFormat: { type: "text" } })) as Inner;
    assert.equal(textOffBody.request?.generationConfig?.responseMimeType, undefined);

    const arrayBody = (await drain("gemini-3.8-flash", {
      responseFormat: { type: "array", items: { type: "string" } }
    })) as Inner;
    assert.equal(arrayBody.request?.generationConfig?.responseMimeType, "application/json");
    assert.equal(arrayBody.request?.generationConfig?.responseSchema?.type, "array");
    assert.equal(
      (arrayBody.request?.generationConfig?.responseSchema?.items as { type?: string } | undefined)?.type,
      "string"
    );
    assert.equal(arrayBody.request?.generationConfig?.responseSchema?.properties, undefined);

    const missingSchemaBody = (await drain("gemini-3.8-flash", {
      responseFormat: { type: "json_schema", json_schema: { name: "TitleCount", strict: true } }
    })) as Inner;
    assert.equal(missingSchemaBody.request?.generationConfig?.responseMimeType, "application/json");
    assert.equal(missingSchemaBody.request?.generationConfig?.responseSchema, undefined);

    sentBody = null;
    await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [{ role: "user", content: "reply in json" }],
      tools: [
        {
          name: "lookup_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      ],
      responseMimeType: "application/json",
      responseSchema: dirtySchema
    });
    const toolsBody = sentBody as Inner & { request?: { tools?: unknown[] } };
    assert.ok(toolsBody.request?.tools && toolsBody.request.tools.length > 0);
    assert.equal(toolsBody.request?.generationConfig?.responseMimeType, undefined);
    assert.equal(toolsBody.request?.generationConfig?.responseSchema, undefined);

    sentBody = null;
    await provider.completeTurn({
      model: "antigravity/claude-sonnet-5-5",
      messages: [{ role: "user", content: "reply in json" }],
      responseMimeType: "application/json",
      responseSchema: dirtySchema
    });
    const claudeBody = sentBody as Inner;
    assert.ok(claudeBody);
    assert.equal(claudeBody.request?.generationConfig?.responseMimeType, undefined);
    assert.equal(claudeBody.request?.generationConfig?.responseSchema, undefined);
  });

  it("15. Argon quota exhaustion: streams user-facing notice with reset time when Gemini 4 Argon hits HTTP 429", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.argon_quota_token",
      refreshToken: "1//argon_quota_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-4-argon-medium": {
              id: "gemini-4-argon-medium",
              displayName: "Gemini 4 Argon (Medium)",
              modality: "chat",
              contextWindow: 1000000,
              maxOutputTokens: 65536
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        return new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h45m00s.",
              status: "RESOURCE_EXHAUSTED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "QUOTA_EXHAUSTED",
                  domain: "cloudcode-pa.googleapis.com",
                  metadata: {
                    uiMessage: "true",
                    model: "gemini-4-argon-medium",
                    quotaResetDelay: "1h45m00s"
                  }
                }
              ]
            }
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const streamFn = provider.createStreamFn();
    const stream = streamFn(
      {
        id: "gemini-4-argon",
        name: "Gemini 4 Argon",
        api: "openai-completions",
        provider: "antigravity"
      },
      {
        messages: [{ role: "user", content: "hello" }]
      },
      {
        apiKey: JSON.stringify({ token: "ya29.argon_quota_token", projectId: "default-cli-project" })
      }
    );

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    const textDeltaEvents = events.filter((e) => e.type === "text_delta");
    assert.ok(textDeltaEvents.length > 0, "Should stream quota text delta for Argon");
    const streamedText = textDeltaEvents.map((e) => e.delta as string).join("");
    assert.match(streamedText, /Gemini 4 Argon/);
    assert.match(streamedText, /Resets at:/);
    assert.match(streamedText, /in 1h 45m/);
    // Since model was Argon, suggestion should suggest Claude models
    assert.match(streamedText, /Claude Opus 5\.5/);
  });

  it("16. Argon HTTP 404 is an unknown-model failure, not a quota notice", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.argon_404_token",
      refreshToken: "1//valid_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    let lastSentModel = "";
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "claude-opus-5-5-high": {
              id: "claude-opus-5-5-high",
              displayName: "Claude Opus 5.5",
              modality: "chat"
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        const body = JSON.parse(String(init?.body)) as { model: string };
        lastSentModel = body.model;
        return new Response(
          JSON.stringify({
            error: {
              code: 404,
              message: "Requested entity was not found.",
              status: "NOT_FOUND"
            }
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" }
          }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const streamFn = provider.createStreamFn();
    const stream = streamFn(
      {
        id: "gemini-4-argon",
        name: "Gemini 4 Argon",
        api: "openai-completions",
        provider: "antigravity"
      },
      {
        messages: [{ role: "user", content: "what is model?" }]
      },
      {
        apiKey: JSON.stringify({ token: "ya29.argon_404_token", projectId: "default-cli-project" })
      }
    );

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    assert.equal(lastSentModel, "gemini-4-argon-medium");
    const textDeltaEvents = events.filter((e) => e.type === "text_delta");
    const streamedText = textDeltaEvents.map((e) => e.delta as string).join("");
    assert.equal(streamedText.includes("quota exhausted"), false, "Argon 404 must not emit a quota notice");
    const errorEvents = events.filter((e) => e.type === "error");
    assert.ok(errorEvents.length > 0, "Should surface an error event for unknown model");
    const errorText = JSON.stringify(errorEvents);
    assert.match(errorText, /unknown model|NOT_FOUND|not found/i);
  });

  it("17. Media Understanding: registers media understanding provider via registerMediaUnderstandingProvider", () => {
    let registeredMedia: AntigravityMediaUnderstandingProvider | undefined;
    antigravityPlugin.register({
      registerProvider() {},
      registerMediaUnderstandingProvider(p) {
        registeredMedia = p;
      }
    });

    assert.ok(registeredMedia, "Media understanding provider should be registered");
    assert.equal(registeredMedia.id, "antigravity");
    assert.deepEqual(registeredMedia.capabilities, ["image", "audio", "video"]);
    assert.equal(registeredMedia.defaultModels.image, "gemini-3.8-flash");
    assert.equal(registeredMedia.defaultModels.audio, "gemini-3.8-flash");
    assert.equal(registeredMedia.defaultModels.video, "gemini-3.8-flash");
    assert.deepEqual(registeredMedia.autoPriority, { image: 90, audio: 90, video: 90 });
    assert.deepEqual(registeredMedia.nativeDocumentInputs, ["pdf"]);
  });

  it("18. Media Understanding: describeImage and describeImages delegate through SDK with cfg/agentDir auth", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.includes("oauth2.googleapis.com") || urlStr.includes("/token")) {
        return jsonResponse({
          access_token: "ya29.mock_refreshed_media_token",
          expires_in: 3600,
          token_type: "Bearer"
        });
      }
      if (urlStr.includes(":fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              displayName: "Gemini 3.8 Flash",
              supportsImages: true,
              supportsThinking: true,
              maxTokens: 65536
            }
          }
        });
      }
      if (init?.headers) {
        capturedHeaders = init.headers as Record<string, string>;
      }
      if (init?.body) {
        capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      }
      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [{ text: "This image shows a beautiful mountain landscape with snow peaks." }]
                }
              }
            ]
          }
        }
      ]);
    }) as any;

    try {
      const mediaProvider = buildAntigravityMediaUnderstandingProvider();

      // OpenClaw passes cfg & agentDir without token; SDK resolves auth and streamFn executes
      const dummyPng = Buffer.from("fake-png-data");
      const resultSingle = await mediaProvider.describeImage({
        buffer: dummyPng,
        fileName: "mountain.png",
        mime: "image/png",
        model: "antigravity/gemini-3.8-flash",
        provider: "antigravity",
        agentDir: "/tmp",
        cfg: {
          models: {
            providers: {
              antigravity: {
                apiKey: JSON.stringify({ token: "ya29.bare_delegated_token", projectId: "custom-proj-123" }),
                models: [{ id: "gemini-3.8-flash", input: ["text", "image"] }]
              }
            }
          }
        }
      } as any);

      assert.equal(resultSingle.model, "gemini-3.8-flash");
      assert.match(resultSingle.text, /mountain landscape/);
      assert.ok(capturedBody, "Request body should be sent");
      assert.ok(
        capturedBody.project === "custom-proj-123" || capturedBody.project === "aicode-consumers",
        `Expected project to be resolved from cfg or active profile, got ${capturedBody.project}`
      );
      assert.ok(
        typeof capturedHeaders.Authorization === "string" &&
          capturedHeaders.Authorization.startsWith("Bearer ya29.") &&
          !capturedHeaders.Authorization.includes("{"),
        "Authorization header must be bare access token, not JSON"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("19. Media Understanding: transcribeAudio and describeVideo decode formatApiKey JSON, assert bare token header and stored project", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBodies: Array<Record<string, unknown>> = [];
    const mockFetch: FetchLike = async (input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedBodies.push(body);
      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [{ text: "Transcribed speech or video scene summary." }]
                }
              }
            ]
          }
        }
      ]);
    };

    const mediaProvider = buildAntigravityMediaUnderstandingProvider({
      fetchFn: mockFetch
    });

    // 1. transcribeAudio receives formatApiKey-produced JSON string in req.apiKey
    const dummyAudio = Buffer.from("fake-wav-bytes");
    const audioRes = await mediaProvider.transcribeAudio({
      buffer: dummyAudio,
      fileName: "interview.wav",
      language: "en",
      apiKey: JSON.stringify({
        token: "ya29.bare_audio_access_token",
        projectId: "audio-project-777"
      })
    });
    assert.equal(audioRes.model, "gemini-3.8-flash");
    assert.match(audioRes.text, /Transcribed speech/);
    assert.equal(capturedHeaders.Authorization, "Bearer ya29.bare_audio_access_token");
    assert.equal(capturedBodies[0].project, "audio-project-777");
    const audioReq = capturedBodies[0].request as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    const audioParts = audioReq.contents[0].parts;
    assert.match(String(audioParts[0].text), /en/);
    const audioInline = audioParts.find((p) => p.inlineData !== undefined) as { inlineData: { mimeType: string; data: string } };
    assert.equal(audioInline.inlineData.mimeType, "audio/wav");
    assert.equal(audioInline.inlineData.data, dummyAudio.toString("base64"));

    // 2. describeVideo receives formatApiKey-produced JSON string in req.auth.apiKey
    const dummyVideo = Buffer.from("fake-mp4-bytes");
    const videoRes = await mediaProvider.describeVideo({
      buffer: dummyVideo,
      fileName: "clip.mp4",
      auth: {
        apiKey: JSON.stringify({
          token: "ya29.bare_video_access_token",
          projectId: "video-project-888"
        })
      }
    });
    assert.equal(videoRes.model, "gemini-3.8-flash");
    assert.equal(capturedHeaders.Authorization, "Bearer ya29.bare_video_access_token");
    assert.equal(capturedBodies[1].project, "video-project-888");
    const videoReq = capturedBodies[1].request as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    const videoInline = videoReq.contents[0].parts.find((p) => p.inlineData !== undefined) as { inlineData: { mimeType: string; data: string } };
    assert.equal(videoInline.inlineData.mimeType, "video/mp4");
  });

  it("19b. Media Understanding: transcribeAudio fails early above the documented Gemini inline limit and never fetches", async () => {
    // Raw cap keeps base64(audio) + 256 KiB overhead ≤ 20 MiB request budget.
    assert.equal(INLINE_AUDIO_REQUEST_MAX_BYTES, 20 * 1024 * 1024);
    assert.equal(INLINE_AUDIO_MAX_BYTES, 15_532_032);
    assert.ok(INLINE_AUDIO_MAX_BYTES < 15 * 1024 * 1024);
    assert.ok(Math.ceil(INLINE_AUDIO_MAX_BYTES / 3) * 4 + 256 * 1024 <= INLINE_AUDIO_REQUEST_MAX_BYTES);

    assertInlineAudioWithinLimit(Buffer.alloc(5 * 1024 * 1024));
    assertInlineAudioWithinLimit(Buffer.alloc(14 * 1024 * 1024));
    assertInlineAudioWithinLimit(Buffer.alloc(INLINE_AUDIO_MAX_BYTES));
    assert.throws(
      () => assertInlineAudioWithinLimit(Buffer.alloc(INLINE_AUDIO_MAX_BYTES + 1)),
      /15532032 bytes after base64 expansion/
    );
    assert.throws(
      () => assertInlineAudioWithinLimit(Buffer.alloc(15 * 1024 * 1024)),
      /20 MiB/
    );
    assert.throws(
      () => assertInlineAudioWithinLimit(Buffer.alloc(25 * 1024 * 1024)),
      /no media upload path/
    );

    let fetchCalls = 0;
    const mockFetch: FetchLike = async () => {
      fetchCalls += 1;
      return sseResponse([
        {
          response: {
            candidates: [{ content: { parts: [{ text: "ok" }] } }]
          }
        }
      ]);
    };
    const mediaProvider = buildAntigravityMediaUnderstandingProvider({ fetchFn: mockFetch });
    const apiKey = JSON.stringify({ token: "ya29.inline_limit_token", projectId: "inline-limit-project" });

    const underLimit = await mediaProvider.transcribeAudio({
      buffer: Buffer.alloc(5 * 1024 * 1024),
      fileName: "five-mebibyte.wav",
      apiKey
    });
    assert.equal(underLimit.text, "ok");
    assert.equal(fetchCalls, 1);

    await assert.rejects(
      () =>
        mediaProvider.transcribeAudio({
          buffer: Buffer.alloc(25 * 1024 * 1024),
          fileName: "twenty-five-mebibyte.wav",
          apiKey
        }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /26214400-byte clip/);
        assert.match(message, /20971520 bytes \(20 MiB\)/);
        assert.match(message, /15532032 bytes after base64 expansion/);
        assert.match(message, /Gemini inline data limit/);
        assert.match(message, /v1internal has no media upload path/);
        return true;
      }
    );
    assert.equal(fetchCalls, 1, "oversized audio must not call fetch");
  });

  it("20. In-turn multimodal messages: maps OpenClaw {type: 'image', data, mimeType}, image_url, Anthropic image, and audio parts to inlineData", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.turn_multimodal_token",
      refreshToken: "1//refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    let capturedBody: Record<string, unknown> | undefined;
    const mockFetch: FetchLike = async (input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [{ text: "I can see the screenshot, the logo image, and the audio input." }]
                }
              }
            ]
          }
        }
      ]);
    };

    const { provider, catalogService } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    catalogService.setCachedModels([
      {
        id: "gemini-3.8-flash",
        ref: "antigravity/gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: true,
        reasoningLevels: ["off", "low", "medium", "high"],
        supportsImages: true
      }
    ]);

    const fakeOpenClawPng = Buffer.from("openclaw-png").toString("base64");
    const fakeUrlPngBase64 = Buffer.from("url-png").toString("base64");
    const fakeAnthropicJpgBase64 = Buffer.from("anthropic-jpg").toString("base64");
    const fakeWavBase64 = Buffer.from("openai-wav").toString("base64");

    const response = await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this:" },
            {
              type: "image",
              data: fakeOpenClawPng,
              mimeType: "image/png"
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${fakeUrlPngBase64}` }
            },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: fakeAnthropicJpgBase64 }
            },
            {
              type: "input_audio",
              input_audio: { data: fakeWavBase64, format: "wav" }
            }
          ]
        }
      ]
    });

    assert.equal(response.text, "I can see the screenshot, the logo image, and the audio input.");
    assert.ok(capturedBody, "Request body should be sent");
    const envelope = capturedBody.request as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    const userParts = envelope.contents[0].parts;
    assert.equal(userParts.length, 5);
    assert.equal(userParts[0].text, "Look at this:");
    assert.deepEqual(userParts[1].inlineData, { mimeType: "image/png", data: fakeOpenClawPng });
    assert.deepEqual(userParts[2].inlineData, { mimeType: "image/png", data: fakeUrlPngBase64 });
    assert.deepEqual(userParts[3].inlineData, { mimeType: "image/jpeg", data: fakeAnthropicJpgBase64 });
    assert.deepEqual(userParts[4].inlineData, { mimeType: "audio/wav", data: fakeWavBase64 });
  });

  it("21. Tool results: image parts map to inlineData alongside functionResponse and never stringify raw base64 as text", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const mockFetch: FetchLike = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes(":fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              displayName: "Gemini 3.8 Flash",
              supportsImages: true,
              supportsThinking: true,
              maxTokens: 65536
            }
          }
        });
      }
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [{ text: "The image shows a diagram." }]
                }
              }
            ]
          }
        }
      ]);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch
    });

    const streamFn = provider.createStreamFn({ model: { id: "gemini-3.8-flash" } });
    const fakeImageBase64 = Buffer.from("raw-image-bytes-not-in-text").toString("base64");

    const stream = streamFn(
      { id: "gemini-3.8-flash" },
      {
        messages: [
          { role: "user", content: "Please read image.png" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_read_1", name: "read", arguments: { path: "image.png" } }]
          },
          {
            role: "toolResult",
            toolName: "read",
            toolCallId: "call_read_1",
            content: [
              { type: "text", text: "Read image file [image/png]" },
              { type: "image", data: fakeImageBase64, mimeType: "image/png" }
            ]
          }
        ]
      },
      {
        apiKey: JSON.stringify({ token: "test-token", projectId: "test-proj" })
      }
    ) as AsyncIterable<unknown>;

    for await (const _ of stream) {
      // consume stream
    }

    assert.ok(capturedBody, "Request body should be sent");
    const contents = (capturedBody.request as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }).contents;
    assert.equal(contents.length, 2);

    const toolTurn = contents[1];
    assert.equal(toolTurn.role, "user");
    assert.equal(toolTurn.parts.length, 1);

    // Assert functionResponse contains only text, never base64
    const fnResp = toolTurn.parts[0].functionResponse as {
      name: string;
      response: { output: string };
      parts?: Array<{ inlineData: { mimeType: string; data: string } }>;
    };
    assert.equal(fnResp.name, "read");
    assert.equal(fnResp.response.output, "Read image file [image/png]");
    assert.equal(fnResp.response.output.includes(fakeImageBase64), false, "Function response text must not contain base64");

    // Assert image was nested inside functionResponse.parts
    assert.ok(fnResp.parts && fnResp.parts.length === 1);
    assert.deepEqual(fnResp.parts[0].inlineData, {
      mimeType: "image/png",
      data: fakeImageBase64
    });
  });

  it("22. Simple completions: provider exports wrapSimpleCompletionStreamFn delegating to createStreamFn", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const mockFetch: FetchLike = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes(":fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              displayName: "Gemini 3.8 Flash",
              supportsImages: true,
              supportsThinking: true,
              maxTokens: 65536
            }
          }
        });
      }
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [{ text: "This is a single-page PDF containing a quarterly financial report." }]
                }
              }
            ]
          }
        }
      ]);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch
    });

    assert.equal(typeof provider.wrapSimpleCompletionStreamFn, "function", "Provider must export wrapSimpleCompletionStreamFn");

    const simpleStreamFn = provider.wrapSimpleCompletionStreamFn({
      model: { id: "gemini-3.8-flash", provider: "antigravity" }
    });
    assert.equal(typeof simpleStreamFn, "function");

    const stream = simpleStreamFn(
      { id: "gemini-3.8-flash" },
      {
        messages: [
          { role: "user", content: "Describe this extracted PDF document: [PDF Extracted Content: Page 1]" }
        ]
      },
      {
        apiKey: JSON.stringify({ token: "test-pdf-token", projectId: "test-pdf-proj" })
      }
    ) as AsyncIterable<Record<string, unknown>>;

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    const textDeltas = events.filter((e) => e.type === "text_delta");
    assert.ok(textDeltas.length > 0, "Simple completion must stream text deltas");
    const combinedText = textDeltas.map((e) => e.delta as string).join("");
    assert.match(combinedText, /quarterly financial report/);
    assert.ok(capturedBody, "Request body should be sent via Antigravity transport");
  });

  it("23. Host tool collision safety & native tool refusal: allows host-offered tools named exec and browser, refuses unoffered native tools", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.host_tool_token",
      refreshToken: "1//host_tool_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    let scenario: "host_exec_and_browser" | "unoffered_manage_task" = "host_exec_and_browser";

    const mockFetch: FetchLike = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes(":fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              displayName: "Gemini 3.8 Flash",
              supportsThinking: true,
              maxTokens: 65536
            }
          }
        });
      }

      if (scenario === "host_exec_and_browser") {
        return sseResponse([
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: "exec",
                          args: { command: "ls /tmp" }
                        }
                      },
                      {
                        functionCall: {
                          name: "browser",
                          args: { action: "open", url: "https://example.com" }
                        }
                      }
                    ]
                  }
                }
              ]
            }
          }
        ]);
      }

      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: "manage_task",
                        args: { Action: "list" }
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      ]);
    };

    const { provider, catalogService } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    catalogService.setCachedModels([
      {
        id: "gemini-3.8-flash",
        ref: "antigravity/gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: true,
        reasoningLevels: ["off", "low", "medium", "high"],
        supportsImages: true
      }
    ]);

    // 1. Regression test: host offers tools named `exec` and `browser`.
    // The model calls them; they must come back as normal tool calls with arguments untouched.
    const res = await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [{ role: "user", content: "list files and open browser" }],
      tools: [
        {
          name: "exec",
          description: "Execute a command on the host",
          parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
        },
        {
          name: "browser",
          description: "Interact with a web browser",
          parameters: { type: "object", properties: { action: { type: "string" }, url: { type: "string" } }, required: ["action"] }
        }
      ]
    });

    assert.equal(res.toolCalls.length, 2);
    assert.equal(res.toolCalls[0].name, "exec");
    assert.deepEqual(res.toolCalls[0].arguments, { command: "ls /tmp" });
    assert.equal(res.toolCalls[1].name, "browser");
    assert.deepEqual(res.toolCalls[1].arguments, { action: "open", url: "https://example.com" });

    // 2. Keep the refusal test: model calls `manage_task` with no host tool of that name.
    // It must be strictly refused with 'native tool refused'.
    scenario = "unoffered_manage_task";
    await assert.rejects(
      () =>
        provider.completeTurn({
          model: "antigravity/gemini-3.8-flash",
          messages: [{ role: "user", content: "list tasks" }],
          tools: [
            {
              name: "exec",
              description: "Execute a command on the host",
              parameters: { type: "object", properties: { command: { type: "string" } } }
            }
          ]
        }),
      /native tool refused: manage_task/
    );
  });

  it("24. Error sanitization: extractErrorSummary parses status and message without dumping raw JSON envelopes", async () => {
    // 1. Google RPC error envelope
    const rpcError = JSON.stringify({
      error: {
        code: 400,
        message: "Invalid field 'bad_param': not supported",
        status: "INVALID_ARGUMENT"
      }
    });
    assert.equal(extractErrorSummary(rpcError), "INVALID_ARGUMENT: Invalid field 'bad_param': not supported");

    // 2. Error object without status
    const simpleError = JSON.stringify({
      error: {
        message: "Quota exceeded for project"
      }
    });
    assert.equal(extractErrorSummary(simpleError), "ERROR: Quota exceeded for project");

    // 3. Plain text error
    const plainError = "Service Unavailable: backend failure";
    assert.equal(extractErrorSummary(plainError), "Service Unavailable: backend failure");

    // 4. Excessive raw payload truncated to 200 chars
    const massiveError = "x".repeat(500);
    assert.equal(extractErrorSummary(massiveError).length, 200);

    // 5. In executeTurn, HTTP error throws sanitized summary instead of raw JSON
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.error_test_token",
      refreshToken: "1//error_test_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    const mockFetch: FetchLike = async (input) => {
      const urlStr = String(input);
      if (urlStr.includes(":fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": { displayName: "Gemini 3.8 Flash", maxTokens: 65536 }
          }
        });
      }
      return new Response(rpcError, {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    };

    const { provider, catalogService } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    catalogService.setCachedModels([
      {
        id: "gemini-3.8-flash",
        ref: "antigravity/gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: true,
        reasoningLevels: ["off", "low", "medium", "high"],
        supportsImages: true
      }
    ]);

    await assert.rejects(
      () =>
        provider.completeTurn({
          model: "antigravity/gemini-3.8-flash",
          messages: [{ role: "user", content: "hello" }]
        }),
      (err: Error) => {
        assert.match(err.message, /Subscription turn failed with HTTP 400: INVALID_ARGUMENT: Invalid field 'bad_param'/);
        assert.doesNotMatch(err.message, /"code":400/);
        return true;
      }
    );
  });

  it("25. Google Search web-search provider: registers antigravity-search, executes grounding search, and formats citations", async () => {
    // 1. Verify openclaw.plugin.json contract registration
    const pluginJson = JSON.parse(
      await import("node:fs").then((fs) =>
        fs.promises.readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf-8")
      )
    ) as { contracts?: { webSearchProviders?: string[] } };
    assert.ok(pluginJson.contracts?.webSearchProviders?.includes("antigravity-search"));

    // 2. Verify register(api) registers antigravity-search
    let registeredSearchProvider: AntigravityWebSearchProvider | undefined;
    antigravityPlugin.register({
      registerProvider: () => {},
      registerWebSearchProvider: (p: AntigravityWebSearchProvider) => {
        registeredSearchProvider = p;
      }
    });
    assert.ok(registeredSearchProvider);
    assert.equal(registeredSearchProvider.id, ANTIGRAVITY_SEARCH_PROVIDER_ID);
    assert.equal(registeredSearchProvider.providerId, "antigravity");
    assert.equal(registeredSearchProvider.authProviderId, "antigravity");
    assert.equal(registeredSearchProvider.requiresCredential, true);
    assert.equal(registeredSearchProvider.autoDetectOrder, 35);
    assert.deepEqual(registeredSearchProvider.envVars, []);
    assert.equal(registeredSearchProvider.parameters, ANTIGRAVITY_SEARCH_TOOL_PARAMETERS);

    // 3. Verify execution via mock fetch
    let capturedSearchHeaders: Record<string, string> = {};
    let capturedSearchBody: Record<string, unknown> | undefined;

    const mockFetch: FetchLike = async (input, init) => {
      capturedSearchHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      capturedSearchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: "OpenClaw 2026.10 was officially released with native provider plugin contracts."
                    }
                  ]
                },
                groundingMetadata: {
                  webSearchQueries: ["OpenClaw release notes 2026.10"],
                  groundingChunks: [
                    {
                      web: {
                        uri: "https://docs.openclaw.dev/releases/2026.10",
                        title: "OpenClaw 2026.10 Release Notes"
                      }
                    },
                    {
                      web: {
                        uri: "https://github.com/openclaw/openclaw",
                        title: "OpenClaw Repository"
                      }
                    }
                  ],
                  groundingSupports: [
                    {
                      segment: { startIndex: 0, endIndex: 35, text: "OpenClaw 2026.10 was released" },
                      groundingChunkIndices: [0],
                      confidenceScores: [0.98]
                    }
                  ]
                }
              }
            ]
          }
        }
      ]);
    };

    const searchProvider = buildAntigravityWebSearchProvider({
      fetchFn: mockFetch
    });

    const searchResult = await searchProvider.search({
      query: "OpenClaw release notes 2026.10",
      count: 3,
      apiKey: JSON.stringify({
        token: "ya29.bare_search_access_token",
        projectId: "search-project-999"
      })
    });

    assert.equal(searchResult.provider, "antigravity-search");
    assert.equal(searchResult.query, "OpenClaw release notes 2026.10");
    assert.match(searchResult.content, /OpenClaw 2026\.10 was officially released/);
    assert.match(searchResult.text ?? "", /OpenClaw 2026\.10 was officially released/);

    assert.equal(searchResult.citations.length, 2);
    assert.equal(searchResult.citations[0].url, "https://docs.openclaw.dev/releases/2026.10");
    assert.equal(searchResult.citations[0].title, "OpenClaw 2026.10 Release Notes");
    assert.equal(searchResult.citations[1].url, "https://github.com/openclaw/openclaw");

    // Verify request headers and body
    assert.equal(capturedSearchHeaders.authorization, "Bearer ya29.bare_search_access_token");
    assert.equal(capturedSearchBody?.project, "search-project-999");
    const innerReq = (capturedSearchBody?.request as { tools?: Array<{ googleSearch?: Record<string, unknown> }> });
    assert.ok(innerReq?.tools, "Must send tools in search request");
    assert.ok(innerReq.tools.some((t) => t.googleSearch !== undefined), "Must include googleSearch tool in search request");
    assert.equal(capturedSearchBody?.model, ANTIGRAVITY_SEARCH_UPSTREAM_MODEL);
    assert.equal(ANTIGRAVITY_SEARCH_UPSTREAM_MODEL, "gemini-3.8-flash-tiered");
  });


  it("25b. antigravity-fetch web-fetch provider: registers, posts to fetchFromTrawlerCache, retries 500, and refuses private URLs", async () => {
    const pluginJson = JSON.parse(
      await import("node:fs").then((fs) =>
        fs.promises.readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf-8")
      )
    ) as { contracts?: { webFetchProviders?: string[] } };
    assert.ok(pluginJson.contracts?.webFetchProviders?.includes("antigravity-fetch"));

    let registeredFetchProvider: AntigravityWebFetchProvider | undefined;
    antigravityPlugin.register({
      registerProvider: () => {},
      registerWebFetchProvider: (p: AntigravityWebFetchProvider) => {
        registeredFetchProvider = p;
      }
    });
    assert.ok(registeredFetchProvider);
    assert.equal(registeredFetchProvider.id, ANTIGRAVITY_FETCH_PROVIDER_ID);
    assert.equal(registeredFetchProvider.providerId, "antigravity");
    assert.equal(registeredFetchProvider.authProviderId, "antigravity");
    assert.equal(registeredFetchProvider.requiresCredential, true);
    assert.equal(registeredFetchProvider.autoDetectOrder, ANTIGRAVITY_FETCH_AUTO_DETECT_ORDER);
    assert.deepEqual(registeredFetchProvider.envVars, []);
    assert.equal(registeredFetchProvider.parameters, ANTIGRAVITY_FETCH_TOOL_PARAMETERS);

    const expectedTrawler = fetchFromTrawlerCacheUrl(DEFAULT_ENDPOINTS);
    assert.equal(expectedTrawler, "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchFromTrawlerCache");

    const apiKey = JSON.stringify({
      token: "ya29.bare_fetch_access_token",
      projectId: "fetch-project-1"
    });

    const html = "<!doctype html><html><head><title>Echo</title></head><body><h1>Hello</h1><p>nonce-abc</p></body></html>";
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push({ url, body });
      if (url.endsWith(":checkUrlDenylist")) {
        return jsonResponse({ isDenied: false });
      }
      if (url === expectedTrawler) {
        return jsonResponse({ content: html });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const fetchProvider = buildAntigravityWebFetchProvider({ fetchFn: mockFetch });
    const result = await fetchProvider.fetch!({
      url: "https://example.com/page",
      extractMode: "text",
      apiKey
    });

    assert.equal(result.url, "https://example.com/page");
    assert.equal(result.finalUrl, "https://example.com/page");
    assert.equal(result.extractMode, "text");
    assert.equal(result.extractor, "antigravity-trawler-live");
    assert.equal(result.contentType, "text/html");
    assert.equal(result.title, "Echo");
    assert.match(result.text, /Hello/);
    assert.match(result.text, /nonce-abc/);
    assert.equal("status" in result, false, "must not invent an HTTP status");
    const trawlerPosts = posts.filter((p) => p.url === expectedTrawler);
    assert.equal(trawlerPosts.length, 1);
    assert.deepEqual(trawlerPosts[0].body, { url: "https://example.com/page", liveFetch: true });

    // 500 then cached retry
    let liveCalls = 0;
    const retryFetch: FetchLike = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith(":checkUrlDenylist")) {
        return jsonResponse({ isDenied: false });
      }
      if (url !== expectedTrawler) {
        throw new Error(`unexpected fetch ${url}`);
      }
      liveCalls += 1;
      if (body.liveFetch === true) {
        return jsonResponse({ error: { status: "INTERNAL", message: "failed" } }, 500);
      }
      return jsonResponse({ content: '{"ok":true,"n":"cached-nonce"}' });
    };
    const retried = await buildAntigravityWebFetchProvider({ fetchFn: retryFetch }).fetch!({
      url: "https://example.com/cached",
      apiKey
    });
    assert.equal(liveCalls, 2);
    assert.equal(retried.extractor, "antigravity-trawler-cache");
    assert.equal(retried.contentType, "application/json");
    assert.match(retried.text, /cached-nonce/);
    assert.equal("status" in retried, false);
    assert.match(retried.warning ?? "", /cached copy/);

    // Double 500 maps to the opaque error
    const failFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith(":checkUrlDenylist")) {
        return jsonResponse({ isDenied: false });
      }
      return jsonResponse({ error: { status: "INTERNAL" } }, 500);
    };
    await assert.rejects(
      () =>
        buildAntigravityWebFetchProvider({ fetchFn: failFetch }).fetch!({
          url: "https://example.com/pdf",
          apiKey
        }),
      (err: Error) => {
        assert.equal(err.message, ANTIGRAVITY_FETCH_OPAQUE_ERROR);
        return true;
      }
    );

    // Private / loopback / link-local refused before any upstream call
    let called = 0;
    const guardFetch: FetchLike = async () => {
      called += 1;
      return jsonResponse({});
    };
    const guarded = buildAntigravityWebFetchProvider({ fetchFn: guardFetch });
    for (const bad of [
      "http://127.0.0.1/",
      "http://localhost/secret",
      "http://192.168.1.10/admin",
      "http://10.0.0.2/",
      "http://172.16.5.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:a9fe:a9fe]/"
    ]) {
      called = 0;
      await assert.rejects(
        () => guarded.fetch!({ url: bad, apiKey }),
        (err: Error) => {
          assert.match(err.message, /loopback|private|link-local/i);
          return true;
        }
      );
      assert.equal(called, 0, `must not call upstream for ${bad}`);
    }

    // Denylist blocks before trawler
    let trawlerHits = 0;
    const denyFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith(":checkUrlDenylist")) {
        return jsonResponse({ isDenied: true });
      }
      trawlerHits += 1;
      return jsonResponse({ content: "should not run" });
    };
    await assert.rejects(
      () =>
        buildAntigravityWebFetchProvider({ fetchFn: denyFetch }).fetch!({
          url: "https://example.com/blocked",
          apiKey
        }),
      /denied/
    );
    assert.equal(trawlerHits, 0);

    // maxChars truncation + createTool
    const long = "x".repeat(500);
    const toolFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith(":checkUrlDenylist")) {
        return jsonResponse({ isDenied: false });
      }
      return jsonResponse({ content: long });
    };
    const toolStore = new InMemoryAuthProfileStore();
    await toolStore.setSecret("antigravity", {
      accessToken: "ya29.bare_fetch_access_token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      projectId: "fetch-project-1"
    });
    const tool = buildAntigravityWebFetchProvider({
      fetchFn: toolFetch,
      defaultAuthStore: toolStore
    }).createTool({});
    const trimmed = (await tool.execute(
      { url: "https://example.com/long", maxChars: 120, extractMode: "text" },
      {}
    )) as { text: string; truncated: boolean; rawLength: number; length: number };
    assert.equal(trimmed.truncated, true);
    assert.equal(trimmed.text.length, 120);
    assert.equal(trimmed.rawLength, 500);
    assert.equal(trimmed.length, 120);

    // Bold/italic tags must not match <body>/<br>/<img>/etc.
    const doc = `<!doctype html><html><head><title>Doc</title></head><body><p>plain <b>bold</b> and <strong>strong</strong> plus <i>italic</i> and <em>emph</em> with <br> break and <img src="x"> tip</p></body></html>`;
    const md = htmlToReadable(doc, "markdown");
    assert.equal(md.title, "Doc");
    assert.match(md.text, /\*\*bold\*\*/);
    assert.match(md.text, /\*\*strong\*\*/);
    assert.match(md.text, /\*italic\*/);
    assert.match(md.text, /\*emph\*/);
    assert.doesNotMatch(md.text, /\*\*plain/);
    assert.doesNotMatch(md.text, /\*\*.*break/);
    assert.match(md.text, /plain/);
    assert.match(md.text, /break/);
    assert.equal(forbiddenFetchUrlReason("http://[::ffff:7f00:1]/"), "Refusing private, loopback or link-local URL");
    assert.equal(forbiddenFetchUrlReason("http://[::ffff:a9fe:a9fe]/"), "Refusing private, loopback or link-local URL");
    assert.equal(ANTIGRAVITY_FETCH_DEFAULT_TIMEOUT_MS, 15_000);
  });

  it("26. Secret handling: parseFormattedApiKey correctly decodes host-delivered credential shapes without internal sentinel decryption", () => {
    // 1. Plain formatApiKey JSON with token & projectId
    const shape1 = parseFormattedApiKey(
      JSON.stringify({ token: "ya29.host_resolved_token_1", projectId: "proj-1" })
    );
    assert.deepEqual(shape1, {
      token: "ya29.host_resolved_token_1",
      projectId: "proj-1"
    });

    // 2. FormatApiKey JSON with access & projectId & accountId
    const shape2 = parseFormattedApiKey(
      JSON.stringify({
        access: "ya29.host_resolved_token_2",
        projectId: "proj-2",
        accountId: "user@example.com"
      })
    );
    assert.deepEqual(shape2, {
      token: "ya29.host_resolved_token_2",
      projectId: "proj-2",
      accountId: "user@example.com"
    });

    // 3. Raw bare token string (fallback)
    const shape3 = parseFormattedApiKey("ya29.direct_token_string");
    assert.deepEqual(shape3, {
      token: "ya29.direct_token_string",
      projectId: DEFAULT_PROJECT_ID
    });

    // 4. Invalid or empty values return null
    assert.equal(parseFormattedApiKey(""), null);
    assert.equal(parseFormattedApiKey("   "), null);
    assert.equal(parseFormattedApiKey(undefined), null);
    assert.equal(parseFormattedApiKey(null), null);
    assert.equal(parseFormattedApiKey({}), null);

    // 5. Ensure parseFormattedApiKey works even if globalThis secretSentinel keys do not exist
    const sentinelKey = Symbol.for("openclaw.secretSentinel.keys");
    const globalStore = globalThis as Record<symbol, unknown>;
    const savedKeys = globalStore[sentinelKey];
    try {
      delete globalStore[sentinelKey];
      const parsedWithoutKeys = parseFormattedApiKey(
        JSON.stringify({ token: "ya29.no_keys_needed", projectId: "proj-no-sentinel" })
      );
      assert.deepEqual(parsedWithoutKeys, {
        token: "ya29.no_keys_needed",
        projectId: "proj-no-sentinel"
      });
    } finally {
      if (savedKeys !== undefined) {
        globalStore[sentinelKey] = savedKeys;
      }
    }
  });

  it("27. Config Sync: sync-models script respects dry-run, sets owned fields, preserves manual fields, and handles static catalog pruning", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const os = await import("node:os");
    const fs = await import("node:fs");
    const execFileAsync = promisify(execFile);

    const scriptPath = path.resolve("scripts/sync-models.js");
    const nodeBin = process.execPath;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sync-test-"));
    const fixtureConfigPath = path.join(tmpDir, "openclaw.json");
    const stubBinPath = path.join(tmpDir, "openclaw-stub.sh");

    const initialConfig = {
      models: {
        providers: {
          antigravity: {
            models: [
              { id: "gemini-4-argon" },
              { id: "gemini-3.8-flash" },
              { id: "claude-opus-5-5" },
              { id: "claude-sonnet-5-5" },
              { id: "gpt-oss-120b" }
            ]
          }
        }
      },
      agents: {
        defaults: {
          models: {
            "antigravity/gemini-4-argon": {
              customField: "keepMeManual",
              temperature: 0.7
            }
          }
        }
      }
    };

    fs.writeFileSync(fixtureConfigPath, JSON.stringify(initialConfig, null, 2));

    // Stub binary that handles 'models list', 'config set', and 'config unset'
    const stubScript = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const cfgPath = process.env.OPENCLAW_CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

function parsePath(p) {
  const segments = [];
  const re = /\\["([^"]+)"\\]|\\[([0-9]+)\\]|([^.\\[\\]]+)/g;
  let match;
  while ((match = re.exec(p)) !== null) {
    segments.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]);
  }
  return segments;
}

if (args[0] === "models" && args[1] === "list") {
  if (process.env.STUB_MODELS_FAIL === "true") {
    process.stderr.write("CLI gateway offline");
    process.exit(1);
  }
  if (process.env.STUB_DROP_ARGON === "true" && !cfg.models?.providers?.antigravity?.models) {
    const droppedList = [
      { id: "antigravity/gemini-3.8-flash" },
      { id: "antigravity/claude-opus-5-5" },
      { id: "antigravity/claude-sonnet-5-5" },
      { id: "antigravity/gpt-oss-120b" },
      { id: "antigravity/gemini-3-flash" }
    ];
    process.stdout.write(JSON.stringify(droppedList));
    process.exit(0);
  }
  const dynamicList = [
    { id: "antigravity/gemini-4-argon" },
    { id: "antigravity/gemini-3.8-flash" },
    { id: "antigravity/claude-opus-5-5" },
    { id: "antigravity/claude-sonnet-5-5" },
    { id: "antigravity/gpt-oss-120b" },
    { id: "antigravity/gemini-3-flash" }
  ];
  process.stdout.write(JSON.stringify(dynamicList));
  process.exit(0);
} else if (args[0] === "config" && args[1] === "set") {
  const targetPath = args[2];
  const value = JSON.parse(args[3]);
  const parts = parsePath(targetPath);
  let curr = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    curr[parts[i]] = curr[parts[i]] || {};
    curr = curr[parts[i]];
  }
  curr[parts[parts.length - 1]] = value;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
} else if (args[0] === "config" && args[1] === "unset") {
  const targetPath = args[2];
  const parts = parsePath(targetPath);
  let curr = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    curr = curr?.[parts[i]];
  }
  if (curr) {
    delete curr[parts[parts.length - 1]];
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}
`;
    const stubJsPath = path.join(tmpDir, "stub.js");
    fs.writeFileSync(stubJsPath, stubScript);
    fs.writeFileSync(stubBinPath, `#!/bin/sh\nexec "${nodeBin}" "${stubJsPath}" "$@"\n`);
    fs.chmodSync(stubBinPath, 0o755);

    const testEnv = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: fixtureConfigPath,
      OPENCLAW_BIN: stubBinPath
    };

    try {
      // 1. Dry run makes NO writes to the fixture
      const dryRunRes = await execFileAsync(nodeBin, [scriptPath, "--dry-run"], { env: testEnv });
      assert.ok(dryRunRes.stdout.includes("[dry-run] Found"));
      const configAfterDryRun = JSON.parse(fs.readFileSync(fixtureConfigPath, "utf8"));
      assert.deepEqual(configAfterDryRun, initialConfig, "Dry run must make no changes to file");

      // 2. --apply sets owned fields and preserves customField & temperature
      const applyRes = await execFileAsync(nodeBin, [scriptPath, "--apply"], { env: testEnv });
      assert.ok(applyRes.stdout.includes("Successfully applied"));

      const configAfterApply = JSON.parse(fs.readFileSync(fixtureConfigPath, "utf8"));
      const argon = configAfterApply.agents.defaults.models["antigravity/gemini-4-argon"];
      assert.equal(argon.alias, "argon");
      assert.equal(argon.agentRuntime?.id, "openclaw");
      assert.equal(argon.customField, "keepMeManual", "Manual extra field must be preserved");
      assert.equal(argon.temperature, 0.7, "Manual extra field must be preserved");

      // Verify gemini-3-flash alias
      const flash3 = configAfterApply.agents.defaults.models["antigravity/gemini-3-flash"];
      assert.equal(flash3.alias, "gemini3-flash");
      assert.equal(flash3.agentRuntime?.id, "openclaw");

      // 3. Second --apply reports no changes
      const secondApplyRes = await execFileAsync(nodeBin, [scriptPath, "--apply"], { env: testEnv });
      assert.ok(
        secondApplyRes.stdout.includes("All Antigravity model configurations are already up to date")
      );

      // 4. Dry-run with --prune-static-catalog describes the verification and rollback steps
      const dryRunPruneRes = await execFileAsync(
        nodeBin,
        [scriptPath, "--dry-run", "--prune-static-catalog"],
        { env: testEnv }
      );
      assert.ok(dryRunPruneRes.stdout.includes("[verify & rollback]"));
      assert.ok(dryRunPruneRes.stdout.includes("Step 1: Save backup"));
      assert.ok(dryRunPruneRes.stdout.includes("Step 2:"));
      assert.ok(dryRunPruneRes.stdout.includes("Step 3:"));
      assert.ok(dryRunPruneRes.stdout.includes("Step 4:"));

      // 5. Successful prune: saves backup to .tmp, unsets static models, verifies all models remain
      const testTmpBackupDir = path.join(tmpDir, ".tmp");
      const pruneEnv = {
        ...testEnv,
        SYNC_MODELS_TMP_DIR: testTmpBackupDir
      };
      const pruneRes = await execFileAsync(
        nodeBin,
        [scriptPath, "--apply", "--prune-static-catalog"],
        { env: pruneEnv }
      );
      assert.ok(pruneRes.stdout.includes("Saved static models backup"));
      assert.ok(pruneRes.stdout.includes("Verification succeeded"));
      const configAfterPrune = JSON.parse(fs.readFileSync(fixtureConfigPath, "utf8"));
      assert.equal(
        configAfterPrune.models.providers.antigravity.models,
        undefined,
        "Static catalog models must be pruned"
      );
      const backupFiles = fs.readdirSync(testTmpBackupDir);
      assert.ok(backupFiles.length > 0, "Backup file must be written to tmp directory");
      assert.ok(backupFiles[0]!.startsWith("static-models-backup-"));

      // 6. Prune that loses a model: rolls back and restores static models
      configAfterPrune.models.providers.antigravity.models = [
        { id: "gemini-4-argon" },
        { id: "gemini-3.8-flash" }
      ];
      fs.writeFileSync(fixtureConfigPath, JSON.stringify(configAfterPrune, null, 2));

      const dropArgonEnv = {
        ...pruneEnv,
        STUB_DROP_ARGON: "true"
      };
      await assert.rejects(
        async () => {
          await execFileAsync(nodeBin, [scriptPath, "--apply", "--prune-static-catalog"], {
            env: dropArgonEnv
          });
        },
        (err: Error) => {
          assert.match(err.message, /dynamic catalog is missing models: gemini-4-argon/);
          assert.match(err.message, /Rolled back static models/);
          return true;
        }
      );
      // Verify rollback restored the static models
      const configAfterRollback = JSON.parse(fs.readFileSync(fixtureConfigPath, "utf8"));
      assert.deepEqual(
        configAfterRollback.models.providers.antigravity.models,
        [{ id: "gemini-4-argon" }, { id: "gemini-3.8-flash" }],
        "Rollback must restore original static models in configuration"
      );

      // 7. Normal sync with unserved static model warns and exits 0 (does not fail)
      configAfterPrune.models.providers.antigravity.models = [{ id: "unserved-custom-model" }];
      fs.writeFileSync(fixtureConfigPath, JSON.stringify(configAfterPrune, null, 2));

      const normalSyncWithWarning = await execFileAsync(nodeBin, [scriptPath, "--dry-run"], {
        env: testEnv
      });
      assert.match(
        (normalSyncWithWarning.stdout || "") + (normalSyncWithWarning.stderr || ""),
        /Warning: The following static models.*unserved-custom-model/
      );

      // 6. If static catalog has an unserved model, refuses to prune and exits non-zero
      await assert.rejects(
        async () => {
          await execFileAsync(nodeBin, [scriptPath, "--apply", "--prune-static-catalog"], {
            env: testEnv
          });
        },
        (err: Error) => {
          assert.match(err.message, /unserved-custom-model/);
          return true;
        }
      );

      // 7. When OpenClaw CLI fails to query dynamic models:
      // a. --prune-static-catalog refuses with exit 1
      const failCliEnv = {
        ...testEnv,
        STUB_MODELS_FAIL: "true"
      };
      await assert.rejects(
        async () => {
          await execFileAsync(nodeBin, [scriptPath, "--apply", "--prune-static-catalog"], {
            env: failCliEnv
          });
        },
        (err: Error) => {
          assert.match(err.message, /unable to read dynamic catalog from OpenClaw/);
          return true;
        }
      );

      // b. normal sync without prune warns and exits 0
      const normalSyncWithCliFail = await execFileAsync(nodeBin, [scriptPath, "--dry-run"], {
        env: failCliEnv
      });
      assert.match(
        (normalSyncWithCliFail.stdout || "") + (normalSyncWithCliFail.stderr || ""),
        /Warning: Could not read dynamic model catalog from OpenClaw/
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("28. Image Generation: registers image generation provider via registerImageGenerationProvider", () => {
    let registeredImageProvider: AntigravityImageGenerationProvider | undefined;
    antigravityPlugin.register({
      registerProvider() {},
      registerImageGenerationProvider(p) {
        registeredImageProvider = p;
      }
    });

    assert.ok(registeredImageProvider, "Image generation provider should be registered");
    assert.equal(registeredImageProvider.id, "antigravity");
    assert.equal(registeredImageProvider.label, "Antigravity");
    assert.equal(registeredImageProvider.defaultModel, DEFAULT_IMAGE_MODEL);
    assert.deepEqual(registeredImageProvider.models, [DEFAULT_IMAGE_MODEL]);
    assert.equal(registeredImageProvider.capabilities.generate.maxCount, 1);
    assert.equal(registeredImageProvider.capabilities.edit.enabled, true);
    assert.equal(registeredImageProvider.capabilities.edit.maxInputImages, 5);
    assert.deepEqual(registeredImageProvider.capabilities.output?.formats, ["jpeg"]);
    assert.ok(registeredImageProvider.capabilities.geometry?.aspectRatios?.includes("1:1"));
    assert.ok(registeredImageProvider.capabilities.geometry?.resolutions?.includes("2K"));
    assert.ok(registeredImageProvider.capabilities.geometry?.sizes?.includes("1024x1024"));
  });

  it("Image Generation: rejects unsupported models before auth or fetch", async () => {
    let fetchCalls = 0;
    const provider = buildAntigravityImageGenerationProvider({
      fetchFn: async () => {
        fetchCalls++;
        throw new Error("Unexpected upstream request");
      }
    });
    for (const model of ["gemini-3.8-flash", "antigravity/gemini-3.8-flash", "imagen-4", "antigravity/"]) {
      await assert.rejects(provider.generateImage({ prompt: "draw a star", model }), (err: Error) => {
        assert.equal(
          err.message,
          `Unsupported Antigravity image model "${model}". Supported model: gemini-3.1-flash-image. Set agents.defaults.mediaModels.image or pass a per-call model override.`
        );
        return true;
      });
    }
    assert.equal(fetchCalls, 0);
  });

  it("29. Image Generation: executes generation and editing with bare token, stored project, and generationConfig", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> | undefined;

    const dummyBase64 = Buffer.from("fake-jpeg-data").toString("base64");
    const mockFetch: FetchLike = async (url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse((init?.body as string) ?? "{}");

      const sseBody = `data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/jpeg","data":"${dummyBase64}"}}]}}]}}\n\ndata: [DONE]\n\n`;
      return new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    };

    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.image_test_token_bare",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600000,
      projectId: "image-test-project"
    });

    const provider = buildAntigravityImageGenerationProvider({
      fetchFn: mockFetch,
      defaultAuthStore: authStore
    });

    const inputBuffer = Buffer.from("input-image-bytes");
    const result = await provider.generateImage({
      prompt: "a red cube on a white table",
      model: "antigravity/gemini-3.1-flash-image",
      size: "1024x1024",
      inputImages: [
        {
          buffer: inputBuffer,
          mimeType: "image/png"
        }
      ]
    });

    // 1. Output verification
    assert.equal(result.model, "gemini-3.1-flash-image");
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, "image/jpeg");
    assert.equal(result.images[0].buffer.toString(), "fake-jpeg-data");

    // 2. Auth headers verification (bare token)
    assert.equal(capturedHeaders.Authorization, "Bearer ya29.image_test_token_bare");

    // 3. Body verification (project & request parts)
    assert.equal(capturedBody?.project, "image-test-project");
    assert.equal(capturedBody?.model, "gemini-3.1-flash-image");

    const reqObj = capturedBody?.request as {
      contents?: Array<{ parts?: Array<Record<string, unknown>> }>;
      generationConfig?: { responseModalities?: string[]; imageConfig?: { aspectRatio?: string } };
    };
    assert.ok(reqObj?.contents?.[0]?.parts, "Parts must be defined");
    const parts = reqObj.contents[0].parts;
    assert.equal(parts.length, 2);
    // Part 0 is inputImage
    assert.deepEqual(parts[0], {
      inlineData: {
        mimeType: "image/png",
        data: inputBuffer.toString("base64")
      }
    });
    // Part 1 is text prompt
    assert.deepEqual(parts[1], { text: "a red cube on a white table" });

    // 4. GenerationConfig verification
    assert.deepEqual(reqObj.generationConfig?.responseModalities, ["TEXT", "IMAGE"]);
    assert.equal(reqObj.generationConfig?.imageConfig?.aspectRatio, "1:1");

    // Accepted spellings all send the one supported upstream image model.
    for (const model of [undefined, "", " \t\n ", "gemini-3.1-flash-image", "antigravity/gemini-3.1-flash-image", "flash-image", "antigravity/flash-image"]) {
      capturedBody = undefined;
      const generated = await provider.generateImage({ prompt: "draw a star", ...(model !== undefined ? { model } : {}) });
      assert.equal(generated.model, DEFAULT_IMAGE_MODEL);
      assert.equal((capturedBody as Record<string, unknown> | undefined)?.model, DEFAULT_IMAGE_MODEL);
    }
  });

  it("30. Image Generation: maps HTTP 429 quota exhaustion and HTTP errors cleanly", async () => {
    const quotaTimestamp = new Date(Date.now() + 3600000).toISOString();
    const quotaErrorBody = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            metadata: {
              quotaResetTimeStamp: quotaTimestamp
            }
          }
        ]
      }
    });

    const mockFetch429: FetchLike = async () =>
      new Response(quotaErrorBody, { status: 429, headers: { "Content-Type": "application/json" } });

    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.test_token",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600000,
      projectId: "proj"
    });

    const provider = buildAntigravityImageGenerationProvider({
      fetchFn: mockFetch429,
      defaultAuthStore: authStore
    });

    await assert.rejects(
      async () => {
        await provider.generateImage({ prompt: "test prompt" });
      },
      (err: Error) => {
        assert.match(err.message, /Quota exceeded HTTP 429/);
        assert.ok(err.message.includes(DEFAULT_IMAGE_MODEL));
        assert.match(err.message, /RESOURCE_EXHAUSTED/);
        assert.match(err.message, /Resets in/);
        return true;
      }
    );
    let fetchCalls = 0;
    const notFoundProvider = buildAntigravityImageGenerationProvider({
      defaultAuthStore: authStore,
      fetchFn: async () => {
        fetchCalls++;
        return new Response(JSON.stringify({ error: { status: "NOT_FOUND", message: "Requested entity was not found." } }), { status: 404 });
      }
    });
    await assert.rejects(
      notFoundProvider.generateImage({ prompt: "draw a star", model: DEFAULT_IMAGE_MODEL }),
      (err: Error) => {
        assert.match(err.message, /Image generation failed with HTTP 404/);
        assert.ok(err.message.includes(DEFAULT_IMAGE_MODEL));
        assert.match(err.message, /NOT_FOUND/);
        return true;
      }
    );
    assert.equal(fetchCalls, 1, "A valid-model 404 must not retry or substitute a model");
  });

  it("31. Image Generation: respects timeout and abort signals", async () => {
    const mockFetchHanging: FetchLike = async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("Aborted"));
        });
      });
    };

    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.test_token",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600000,
      projectId: "proj"
    });

    const provider = buildAntigravityImageGenerationProvider({
      fetchFn: mockFetchHanging,
      defaultAuthStore: authStore
    });

    const controller = new AbortController();
    controller.abort(new Error("User cancelled generation"));

    await assert.rejects(
      async () => {
        await provider.generateImage({
          prompt: "test prompt",
          signal: controller.signal
        });
      },
      (err: Error) => {
        assert.match(err.message, /User cancelled generation/);
        return true;
      }
    );
  });

  it("32. Image Generation diagnostics & retry: retries text-only response once, reports finishReason & snippet on repeated failure, and does not retry blocked responses", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.test_token",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600000,
      projectId: "proj"
    });

    const dummyBase64 = Buffer.from("fake-jpeg").toString("base64");
    const imageSse = `data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/jpeg","data":"${dummyBase64}"}}]}}]}}\n\ndata: [DONE]\n\n`;
    const textOnlySse = `data: {"response":{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"I cannot generate that image directly."}]}}]}}\n\ndata: [DONE]\n\n`;
    const blockedSse = `data: {"response":{"promptFeedback":{"blockReason":"SAFETY"},"candidates":[{"finishReason":"SAFETY"}]}}\n\ndata: [DONE]\n\n`;

    // 1. Text-only then success on retry
    let callCount1 = 0;
    const mockFetchRetrySuccess: FetchLike = async () => {
      callCount1++;
      if (callCount1 === 1) {
        return new Response(textOnlySse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(imageSse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const provider1 = buildAntigravityImageGenerationProvider({
      fetchFn: mockFetchRetrySuccess,
      defaultAuthStore: authStore
    });

    const result1 = await provider1.generateImage({ prompt: "draw a star" });
    assert.equal(callCount1, 2, "Must retry exactly once when first response is text-only");
    assert.equal(result1.images.length, 1);

    // 2. Text-only twice gives an error containing finishReason and text snippet
    let callCount2 = 0;
    const mockFetchDoubleText: FetchLike = async () => {
      callCount2++;
      return new Response(textOnlySse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const provider2 = buildAntigravityImageGenerationProvider({
      fetchFn: mockFetchDoubleText,
      defaultAuthStore: authStore
    });

    await assert.rejects(
      async () => {
        await provider2.generateImage({ prompt: "draw a star" });
      },
      (err: Error) => {
        assert.equal(callCount2, 2, "Must retry once before failing on double text-only response");
        assert.match(err.message, /finishReason: STOP/);
        assert.match(err.message, /I cannot generate that image directly/);
        return true;
      }
    );

    // 3. Blocked response is NOT retried, includes safety details, and error names the block reason
    let callCount3 = 0;
    const blockedWithSafetySse = `data: ${JSON.stringify({
      response: {
        promptFeedback: {
          blockReason: "SAFETY",
          safetyRatings: [
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", probability: "HIGH", blocked: true },
            { category: "HARM_CATEGORY_HATE_SPEECH", probability: "LOW", blocked: false }
          ]
        },
        candidates: [{ finishReason: "SAFETY" }]
      }
    })}\n\ndata: [DONE]\n\n`;

    const mockFetchBlocked: FetchLike = async () => {
      callCount3++;
      return new Response(blockedWithSafetySse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const provider3 = buildAntigravityImageGenerationProvider({
      fetchFn: mockFetchBlocked,
      defaultAuthStore: authStore
    });

    await assert.rejects(
      async () => {
        await provider3.generateImage({ prompt: "unsafe prompt" });
      },
      (err: Error) => {
        assert.equal(callCount3, 1, "Must NOT retry blocked response");
        assert.match(err.message, /Antigravity image generation blocked \(SAFETY\)/);
        assert.match(err.message, /HARM_CATEGORY_SEXUALLY_EXPLICIT=HIGH/);
        assert.equal(err.message.includes("HARM_CATEGORY_HATE_SPEECH"), false, "LOW probability must be omitted");
        return true;
      }
    );

    // 4. Blocked finish reason without blockReason (e.g. IMAGE_SAFETY or PROHIBITED_CONTENT) is NOT retried
    let callCount4 = 0;
    const blockedFinishSse = `data: ${JSON.stringify({
      response: {
        candidates: [{ finishReason: "IMAGE_SAFETY" }]
      }
    })}\n\ndata: [DONE]\n\n`;

    const mockFetchBlockedFinish: FetchLike = async () => {
      callCount4++;
      return new Response(blockedFinishSse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };

    const provider4 = buildAntigravityImageGenerationProvider({
      fetchFn: mockFetchBlockedFinish,
      defaultAuthStore: authStore
    });

    await assert.rejects(
      async () => {
        await provider4.generateImage({ prompt: "blocked image content" });
      },
      (err: Error) => {
        assert.equal(callCount4, 1, "Must NOT retry on BLOCKED_FINISH_REASONS");
        assert.match(err.message, /IMAGE_SAFETY/);
        return true;
      }
    );
  });

  it("33. Honest isConfigured: returns true when auth is resolvable and false when not signed in", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");

    // 1. Signed-in via authStore
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.active_token",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600000,
      projectId: "proj"
    });

    const providerWithStore = buildAntigravityImageGenerationProvider({
      defaultAuthStore: authStore
    });
    assert.equal(providerWithStore.isConfigured?.({}), true, "Must be configured when authStore has secret");

    // 2. Not signed-in (empty store, no modelAuth)
    const emptyStore = new InMemoryAuthProfileStore();
    const providerEmpty = buildAntigravityImageGenerationProvider({
      defaultAuthStore: emptyStore
    });
    assert.equal(providerEmpty.isConfigured?.({}), false, "Must NOT be configured when store is empty and no modelAuth");

    // 3. Host runtime modelAuth: profile present
    let capturedAgentDir = "";
    let capturedOptions: Record<string, unknown> | undefined;
    const mockModelAuthWithProfile: ModelAuthRuntime = {
      ensureAuthProfileStore: (agentDir, opts) => {
        capturedAgentDir = agentDir ?? "";
        capturedOptions = opts;
        return { fakeStore: true };
      },
      listProfilesForProvider: (_store, providerId) => {
        return providerId === "antigravity" ? [{ id: "antigravity:user", provider: "antigravity" }] : [];
      },
      isProviderApiKeyConfigured: () => false
    };

    const providerWithHostProfile = buildAntigravityImageGenerationProvider({
      defaultAuthStore: emptyStore,
      modelAuth: mockModelAuthWithProfile
    });
    assert.equal(
      providerWithHostProfile.isConfigured?.({ agentDir: "/test/agent/dir" }),
      true,
      "Must be configured when host modelAuth lists an antigravity profile"
    );
    assert.equal(capturedAgentDir, "/test/agent/dir");
    assert.equal(capturedOptions?.readOnly, true);
    assert.equal(capturedOptions?.allowKeychainPrompt, false);

    // 4. Host runtime modelAuth: API key configured
    const mockModelAuthWithApiKey: ModelAuthRuntime = {
      ensureAuthProfileStore: () => ({ fakeStore: true }),
      listProfilesForProvider: () => [],
      isProviderApiKeyConfigured: (params) => {
        return params.provider === "antigravity" && params.readOnly === true && params.allowKeychainPrompt === false;
      }
    };
    const providerWithHostKey = buildAntigravityImageGenerationProvider({
      defaultAuthStore: emptyStore,
      modelAuth: mockModelAuthWithApiKey
    });
    assert.equal(
      providerWithHostKey.isConfigured?.({ agentDir: "/test/agent/dir" }),
      true,
      "Must be configured when host modelAuth reports isProviderApiKeyConfigured"
    );

    // 5. Host runtime modelAuth: profile and API key absent
    const mockModelAuthAbsent: ModelAuthRuntime = {
      ensureAuthProfileStore: () => ({ fakeStore: true }),
      listProfilesForProvider: () => [],
      isProviderApiKeyConfigured: () => false
    };
    const providerAbsent = buildAntigravityImageGenerationProvider({
      defaultAuthStore: emptyStore,
      modelAuth: mockModelAuthAbsent
    });
    assert.equal(
      providerAbsent.isConfigured?.({ agentDir: "/test/agent/dir" }),
      false,
      "Must NOT be configured when host modelAuth has no profiles and no key"
    );

    // 6. Runtime API throws/unavailable
    const mockModelAuthThrowing: ModelAuthRuntime = {
      ensureAuthProfileStore: () => {
        throw new Error("Store access error");
      },
      isProviderApiKeyConfigured: () => {
        throw new Error("Lookup error");
      }
    };
    const providerThrowing = buildAntigravityImageGenerationProvider({
      defaultAuthStore: emptyStore,
      modelAuth: mockModelAuthThrowing
    });
    assert.equal(
      providerThrowing.isConfigured?.({ agentDir: "/test/agent/dir" }),
      false,
      "Must fail closed to false when host modelAuth throws"
    );
    assert.equal(await providerWithStore.isConfiguredAsync?.({ agentDir: "/test/agent/dir" }), true);
    assert.equal(await providerEmpty.isConfiguredAsync?.({ agentDir: "/test/agent/dir" }), false);
    assert.equal(await providerWithHostProfile.isConfiguredAsync?.({ agentDir: "/test/agent/dir" }), true);
    assert.equal(await providerWithHostKey.isConfiguredAsync?.({ agentDir: "/test/agent/dir" }), true);
    assert.equal(await providerAbsent.isConfiguredAsync?.({ agentDir: "/test/agent/dir" }), false);
    assert.equal(await providerThrowing.isConfiguredAsync?.({ agentDir: "/test/agent/dir" }), false);
  });

  it("Async image readiness: prefers host async APIs, passes prompt-free options, and fails closed", async () => {
    const cfg = {};
    const agentDir = "test-agent";
    for (const scenario of ["profile", "key", "absent", "store-error", "key-error"] as const) {
      const store = {};
      let syncCalls = 0;
      let keyCalls = 0;
      const deprecated = () => {
        syncCalls++;
        throw new Error("Deprecated sync method must not run");
      };
      const provider = buildAntigravityImageGenerationProvider({
        modelAuth: {
          ensureAuthProfileStore: deprecated,
          isProviderApiKeyConfigured: deprecated,
          ensureAuthProfileStoreAsync: async (directory, options) => {
            await Promise.resolve();
            assert.equal(directory, agentDir);
            assert.deepEqual(options, { readOnly: true, allowKeychainPrompt: false });
            if (scenario === "store-error") throw new Error("Store unavailable");
            return store;
          },
          listProfilesForProvider: (actualStore, providerId) => {
            assert.equal(actualStore, store);
            assert.equal(providerId, PROVIDER_ID);
            return scenario === "profile" ? [{}] : [];
          },
          isProviderApiKeyConfiguredAsync: async (params) => {
            await Promise.resolve();
            keyCalls++;
            assert.deepEqual(params, {
              provider: PROVIDER_ID, cfg, agentDir, store,
              readOnly: true, allowKeychainPrompt: false
            });
            if (scenario === "key-error") throw new Error("Key lookup unavailable");
            return scenario === "key";
          }
        }
      });
      assert.equal(await provider.isConfiguredAsync?.({ cfg, agentDir }), scenario === "profile" || scenario === "key");
      assert.equal(syncCalls, 0, "Async APIs take precedence, even when they reject");
      assert.equal(keyCalls, scenario === "profile" || scenario === "store-error" ? 0 : 1);
    }
  });

  it("34. OAuth refresh: an expired stored credential with successful mocked token endpoint yields a request-ready credential and preserves refresh token and identity", async () => {
    const expiredTimestamp = Date.now() - 3600_000;
    const expiredCredential = {
      type: "oauth" as const,
      provider: "antigravity",
      profileId: "profile-test-identifier",
      access: "ya29.expired_access_token_12345",
      refresh: "1//mock_refresh_token_abc_keep_me",
      expires: expiredTimestamp,
      email: "engineer@company.example",
      accountId: "acct-unique-789",
      projectId: "cloud-project-alpha"
    };

    const originalConsoleInfo = console.info;
    const originalConsoleWarn = console.warn;
    const loggedLines: string[] = [];
    console.info = (...args: unknown[]) => {
      loggedLines.push(args.map(String).join(" "));
      originalConsoleInfo(...args);
    };
    console.warn = (...args: unknown[]) => {
      loggedLines.push(args.map(String).join(" "));
      originalConsoleWarn(...args);
    };

    let capturedRequestBody: string | undefined;
    let capturedContentType: string | undefined;

    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              id: "gemini-3.8-flash-tiered",
              displayName: "Gemini 3.8 Flash",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 8192
            }
          }
        });
      }
      if (url === DEFAULT_ENDPOINTS.tokenUrl) {
        capturedRequestBody = String(init?.body);
        capturedContentType = (init?.headers as Record<string, string>)?.["Content-Type"];
        return jsonResponse({
          access_token: "ya29.brand_new_fresh_token_999",
          expires_in: 3600,
          token_type: "Bearer"
          // Note: Google's token refresh endpoint omits refresh_token when not rotating
        });
      }
      throw new Error(`Unexpected URL called during refresh: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch
    });

    assert.equal(typeof provider.refreshOAuth, "function", "Provider must export refreshOAuth hook");

    const refreshed = await provider.refreshOAuth(expiredCredential);

    // 1. Refresh token preserved
    assert.equal(
      refreshed.refresh,
      "1//mock_refresh_token_abc_keep_me",
      "Refresh token must be preserved when upstream omits it"
    );

    // 2. New access token assigned
    assert.equal(
      refreshed.access,
      "ya29.brand_new_fresh_token_999",
      "Fresh access token must be returned"
    );

    // 3. Provider & type match
    assert.equal(refreshed.type, "oauth");
    assert.equal(refreshed.provider, "antigravity");

    // 4. Expires is future epoch milliseconds
    assert.equal(typeof refreshed.expires, "number");
    assert.ok(Number.isFinite(refreshed.expires));
    assert.ok(
      refreshed.expires > Date.now() + 3500_000,
      `Expires must be in future epoch ms, got ${refreshed.expires}`
    );

    // 5. Preserves identity attributes for isSafeOAuthOwnerRefreshResult
    assert.equal(refreshed.email, "engineer@company.example");
    assert.equal(refreshed.accountId, "acct-unique-789");
    assert.equal(refreshed.projectId, "cloud-project-alpha");

    // 6. Request body sent to tokenUrl includes client_id, refresh_token, grant_type
    assert.ok(capturedRequestBody?.includes("grant_type=refresh_token"));
    assert.ok(capturedRequestBody?.includes("refresh_token=1%2F%2Fmock_refresh_token_abc_keep_me"));
    assert.equal(capturedContentType, "application/x-www-form-urlencoded");

    // 7. Request-ready via formatApiKey
    assert.equal(typeof provider.formatApiKey, "function");
    const formatted = provider.formatApiKey(refreshed);
    assert.equal(typeof formatted, "string");
    const parsed = parseFormattedApiKey(formatted);
    assert.ok(parsed, "formatApiKey must return valid JSON key for refreshed credential");
    assert.equal(parsed?.token, "ya29.brand_new_fresh_token_999");
    assert.equal(parsed?.projectId, "cloud-project-alpha");
    assert.equal(parsed?.accountId, "acct-unique-789");

    // 8. Error handling: missing refresh token or placeholder rejects
    await assert.rejects(
      async () => {
        await provider.refreshOAuth({
          type: "oauth",
          provider: "antigravity",
          access: "ya29.expired",
          refresh: "",
          expires: 0
        });
      },
      /missing refresh token/
    );

    let networkCallMade = false;
    const sentinelCheckFetch: FetchLike = async () => {
      networkCallMade = true;
      return new Response("{}", { status: 200 });
    };
    const { provider: placeholderProvider } = createAntigravityProvider({ fetchImpl: sentinelCheckFetch });
    await assert.rejects(
      async () => {
        await placeholderProvider.refreshOAuth({
          type: "oauth",
          provider: "antigravity",
          access: "ya29.expired",
          refresh: "managed-by-openclaw",
          expires: 0
        });
      },
      /missing refresh token/
    );
    assert.equal(networkCallMade, false, "Placeholder managed-by-openclaw must not make network calls");

    // 9. Error handling: invalid_grant returns actionable re-login guidance
    const invalidGrantFetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 });
    const { provider: invalidGrantProvider } = createAntigravityProvider({ fetchImpl: invalidGrantFetch });
    await assert.rejects(
      async () => {
        await invalidGrantProvider.refreshOAuth(expiredCredential);
      },
      /Re-login required: openclaw models auth login --provider antigravity/
    );

    // 10. Error handling: 5xx server error is marked transient and retryable
    const serverErrorFetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: "internal_error", error_description: "backend temporarily unavailable" }), { status: 503 });
    const { provider: serverErrProvider } = createAntigravityProvider({ fetchImpl: serverErrorFetch });
    try {
      await serverErrProvider.refreshOAuth(expiredCredential);
      assert.fail("Should have rejected on 503");
    } catch (err: any) {
      assert.match(err.message, /transient upstream token refresh failure \(503\)/);
      assert.equal(err.transient, true, "5xx errors must have transient = true");
      assert.equal(err.retryable, true, "5xx errors must have retryable = true");
    } finally {
      console.info = originalConsoleInfo;
      console.warn = originalConsoleWarn;
    }

    // Assert that no identity (email or accountId) was printed in logs
    assert.ok(loggedLines.length > 0, "Should have logged refresh outcome");
    for (const line of loggedLines) {
      assert.equal(line.includes("engineer@company.example"), false, "Log output must never contain email");
      assert.equal(line.includes("acct-unique-789"), false, "Log output must never contain accountId");
    }
    const successLog = loggedLines.find((l) => l.includes("OAuth token refresh succeeded"));
    assert.ok(successLog, "Must log refresh success");
    assert.ok(successLog.includes("old expiry:"), "Must include old expiry ISO");
    assert.ok(successLog.includes("new expiry:"), "Must include new expiry ISO");
    assert.ok(successLog.includes("[profile:"), "Must include 8-char hex profile hint");

    // 11. Provider failover classification
    assert.equal(typeof provider.classifyFailoverReason, "function", "Provider must export classifyFailoverReason");
    const classify = provider.classifyFailoverReason!;
    // 401 returns "auth"
    assert.equal(classify({ errorMessage: "401 Unauthorized", status: 401 }), "auth");
    // Token-expired or invalid 403 returns "auth"
    assert.equal(classify({ errorMessage: "403 Forbidden: ACCESS_TOKEN_EXPIRED", status: 403 }), "auth");
    assert.equal(classify({ errorMessage: "403 Forbidden: invalid_token", status: 403 }), "auth");
    assert.equal(classify({ errorMessage: "UNAUTHENTICATED: invalid token", status: 403 }), "auth");
    // PERMISSION_DENIED 403 returns null (does not trigger auth failover)
    assert.equal(classify({ errorMessage: "403 Forbidden: PERMISSION_DENIED: User not entitled to model", status: 403 }), null);
    assert.equal(classify({ errorMessage: "The caller does not have permission", status: 403 }), null);
    // Rate limit & quota return "rate_limit"
    assert.equal(classify({ errorMessage: "Resource exhausted", status: 429 }), "rate_limit");
    assert.equal(classify({ errorMessage: "quota exceeded" }), "rate_limit");
    // Argon 404 is not quota; it is an unknown-model failure (no failover reason)
    assert.equal(classify({ errorMessage: "upstream not found for gemini-4-argon", status: 404 }), null);
    assert.equal(classify({ errorMessage: "unknown model: gemini-4-argon (HTTP 404 NOT_FOUND: Requested entity was not found.)", status: 404 }), null);
    // 5xx returns "server_error"
    assert.equal(classify({ errorMessage: "internal backend error", status: 500 }), "server_error");
    // Upstream code UNAUTHENTICATED returns "auth"
    assert.equal(classify({ errorMessage: "Request unauthenticated", code: "UNAUTHENTICATED" }), "auth");
    // Other errors return null
    assert.equal(classify({ errorMessage: "some unhandled parse error", status: 400 }), null);
  });

  it("35. In-turn 401 retry: turn encountering 401 UNAUTHENTICATED with direct authStore refreshes token and retries successfully", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.stale_turn_token",
      refreshToken: "1//valid_turn_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "turn-retry-project"
    });

    let tokenRefreshCalls = 0;
    let turnCalls = 0;

    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              id: "gemini-3.8-flash-tiered",
              displayName: "Gemini 3.8 Flash",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 8192
            }
          }
        });
      }
      if (url === DEFAULT_ENDPOINTS.tokenUrl) {
        tokenRefreshCalls++;
        return jsonResponse({
          access_token: "ya29.refreshed_turn_token",
          expires_in: 3600,
          token_type: "Bearer"
        });
      }
      if (url.includes(":streamGenerateContent")) {
        turnCalls++;
        const authHeader = (init?.headers as Record<string, string>)?.Authorization;
        if (turnCalls === 1) {
          assert.equal(authHeader, "Bearer ya29.stale_turn_token");
          return new Response(
            JSON.stringify({
              error: {
                code: 401,
                message: "Request had invalid authentication credentials. Expected OAuth 2 access token.",
                status: "UNAUTHENTICATED"
              }
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" }
            }
          );
        }
        // Second attempt with refreshed token
        assert.equal(authHeader, "Bearer ya29.refreshed_turn_token");
        return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: "retry-turn-success" }] } }] } }]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const streamFn = provider.createStreamFn();
    const stream = streamFn(
      {
        id: "gemini-3.8-flash",
        api: "openai-completions",
        provider: "antigravity"
      },
      {
        messages: [{ role: "user", content: "hello retry" }]
      }
    );

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    assert.equal(tokenRefreshCalls, 1, "Must call token refresh endpoint exactly once");
    assert.equal(turnCalls, 2, "Must retry turn after token refresh");
    const textDeltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    assert.equal(textDeltas, "retry-turn-success");

    // AuthStore must have been updated with refreshed token
    const updatedSecret = await authStore.getSecret("antigravity");
    assert.equal(updatedSecret?.accessToken, "ya29.refreshed_turn_token");
  });

  it("20. Real usage quotas: maps upstream quota groups and buckets to openclaw usage windows", async (t) => {
    // Window inference without an explicit `window` uses time-to-reset, so pin the clock
    // to a moment consistent with the fixture timestamps (keeps the test hermetic).
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-31T15:00:00Z") });
    let capturedUsageProject: string | undefined;
    let capturedSummaryHeaders: any;
    let capturedUserQuotaHeaders: any;

    // Test Case 1: Multi-source merge with summary (3p) + Gemini source (5h + weekly) + Argon (0%) + duplicates
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes(":retrieveUserQuotaSummary")) {
        capturedSummaryHeaders = init?.headers;
        const body = JSON.parse(String(init?.body || "{}"));
        capturedUsageProject = body.project;
        return jsonResponse({
          groups: [
            {
              displayName: "Claude and GPT models",
              description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
              buckets: [
                {
                  bucketId: "3p-weekly",
                  displayName: "Weekly Limit Remaining",
                  window: "WEEKLY", // Test uppercase window enum
                  resetTime: "2026-11-06T06:23:11Z",
                  remainingFraction: 0.1652656
                },
                {
                  bucketId: "3p-5h",
                  displayName: "Five Hour Limit Remaining",
                  window: "FIVE_HOUR", // Test uppercase window enum
                  resetTime: "2026-10-31T17:11:26Z",
                  remainingFraction: 0.9684096
                }
              ]
            }
          ]
        });
      }
      if (url.includes(":retrieveUserQuota")) {
        capturedUserQuotaHeaders = init?.headers;
        return jsonResponse({
          buckets: [
            // Gemini models sharing the same 5h window, fraction and resetTime (should collapse into Gemini · 5h)
            {
              modelId: "gemini-3-flash",
              remainingFraction: 0.86,
              resetTime: "2026-10-31T17:48:00Z"
            },
            {
              modelId: "gemini-2.5-flash",
              remainingFraction: 0.86,
              resetTime: "2026-10-31T17:48:00Z"
            },
            {
              modelId: "gemini-3.8-flash-tiered",
              remainingFraction: 0.86,
              resetTime: "2026-10-31T17:48:00Z"
            },
            // Gemini Weekly bucket
            {
              modelId: "gemini-weekly-bucket",
              groupDisplayName: "Gemini",
              displayName: "Gemini",
              window: "weekly",
              remainingFraction: 0.49,
              resetTime: "2026-11-04T19:23:11Z"
            },
            // Duplicate Claude model in retrieveUserQuota (should be deduplicated because summary has 3p group)
            {
              modelId: "claude-opus-5-5-high",
              remainingFraction: 0.1652656,
              resetTime: "2026-11-06T06:23:11Z"
            },
            // Argon bucket with 0% remaining
            {
              modelId: "gemini-4-argon",
              displayName: "Gemini 4 Argon",
              window: "weekly",
              remainingFraction: 0.0,
              resetTime: "2026-11-04T19:23:11Z"
            }
          ]
        });
      }
      if (url.includes(":fetchAvailableModels")) {
        return jsonResponse({
          models: {
            // Duplicate gemini-3-flash across userQuota and models
            "gemini-3-flash": {
              displayName: "Gemini 3 Flash",
              quotaInfo: {
                remainingFraction: 0.86,
                resetTime: "2026-10-31T17:48:00Z"
              }
            }
          }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch
    });

    const apiKey = JSON.stringify({
      token: "ya29.test_token",
      projectId: "aicode-consumers"
    });

    const snapshot = await provider.fetchUsageSnapshot!({
      token: apiKey
    } as any);

    assert.equal(capturedUsageProject, "aicode-consumers", "Must forward projectId to retrieveUserQuotaSummary");
    const summaryUA = capturedSummaryHeaders?.["User-Agent"] ?? capturedSummaryHeaders?.get?.("User-Agent");
    const summaryActivity = capturedSummaryHeaders?.["x-activity-request-id"] ?? capturedSummaryHeaders?.get?.("x-activity-request-id");
    assert.equal(summaryUA, ANTIGRAVITY_CLI_USER_AGENT, "retrieveUserQuotaSummary must use CLI User-Agent");
    assert.ok(summaryActivity && /^[0-9a-f-]{36}$/i.test(summaryActivity), "retrieveUserQuotaSummary must include x-activity-request-id UUID");

    const userQuotaUA = capturedUserQuotaHeaders?.["User-Agent"] ?? capturedUserQuotaHeaders?.get?.("User-Agent");
    const userQuotaActivity = capturedUserQuotaHeaders?.["x-activity-request-id"] ?? capturedUserQuotaHeaders?.get?.("x-activity-request-id");
    assert.equal(userQuotaUA, ANTIGRAVITY_CLI_USER_AGENT, "retrieveUserQuota must use CLI User-Agent");
    assert.ok(userQuotaActivity && /^[0-9a-f-]{36}$/i.test(userQuotaActivity), "retrieveUserQuota must include x-activity-request-id UUID");

    assert.equal(snapshot.provider, "antigravity");
    assert.equal(snapshot.displayName, "Antigravity");
    assert.equal(snapshot.windows.length, 5, "Must produce 5 usage windows without duplicates");

    // Order: Gemini (Weekly before 5h), Claude and GPT (Weekly before 5h), Gemini 4 Argon (Weekly)
    assert.deepEqual(
      snapshot.windows.map((w) => ({
        label: w.label,
        usedPercent: w.usedPercent,
        resetAt: w.resetAt
      })),
      [
        {
          label: "Gemini · Weekly",
          usedPercent: 51, // 100 - 49 = 51% used (49% left)
          resetAt: Date.parse("2026-11-04T19:23:11Z")
        },
        {
          label: "Gemini · 5h",
          usedPercent: 14, // 100 - 86 = 14% used (86% left)
          resetAt: Date.parse("2026-10-31T17:48:00Z")
        },
        {
          label: "Claude and GPT · Weekly",
          usedPercent: 83, // round((1 - 0.1652656)*100) = 83% used (17% left)
          resetAt: Date.parse("2026-11-06T06:23:11Z")
        },
        {
          label: "Claude and GPT · 5h",
          usedPercent: 3, // round((1 - 0.9684096)*100) = 3% used (97% left)
          resetAt: Date.parse("2026-10-31T17:11:26Z")
        },
        {
          label: "Gemini 4 Argon · Weekly",
          usedPercent: 100, // 0 remaining fraction = 100% used (0% left)
          resetAt: Date.parse("2026-11-04T19:23:11Z")
        }
      ]
    );

    // Test Case 2: Gemini source fails (HTTP 500 / timeout) -> 3p windows still returned, does not throw
    const partialFailureFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes(":retrieveUserQuotaSummary")) {
        return jsonResponse({
          groups: [
            {
              displayName: "Claude and GPT models",
              buckets: [
                {
                  bucketId: "3p-weekly",
                  window: "weekly",
                  resetTime: "2026-11-06T06:23:11Z",
                  remainingFraction: 0.2
                },
                {
                  bucketId: "3p-5h",
                  window: "5h",
                  resetTime: "2026-10-31T17:11:26Z",
                  remainingFraction: 0.95
                }
              ]
            }
          ]
        });
      }
      if (url.includes(":retrieveUserQuota")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      if (url.includes(":fetchAvailableModels")) {
        throw new Error("Connection timeout");
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider: resilientProvider } = createAntigravityProvider({
      fetchImpl: partialFailureFetch
    });

    const resilientSnapshot = await resilientProvider.fetchUsageSnapshot!({
      token: apiKey
    } as any);

    assert.equal(resilientSnapshot.windows.length, 2, "Must return 3p windows even if Gemini sources fail");
    assert.deepEqual(
      resilientSnapshot.windows.map((w) => w.label),
      ["Claude and GPT · Weekly", "Claude and GPT · 5h"]
    );

    // Test Case 3: Argon bucket with remainingFraction 0 or disabled gives usedPercent 100 and keeps resetAt
    const argonBucketPercent = calculateBucketUsedPercent({
      groupDisplayName: "Gemini 4 Argon",
      modelId: "gemini-4-argon",
      remainingFraction: 0.0,
      resetTime: "2026-11-04T19:23:11Z"
    });
    assert.equal(argonBucketPercent, 100, "Argon with 0% remaining fraction must report 100% used");

    const disabledBucketPercent = calculateBucketUsedPercent({
      bucketId: "test-disabled",
      disabled: true,
      remainingFraction: 0.9
    });
    assert.equal(disabledBucketPercent, 100, "Disabled bucket must report 100% used");

    // Test Case 4: Empty bucket list keeps omitted state
    const emptyMockFetch: FetchLike = async () => jsonResponse({});
    const { provider: emptyProvider } = createAntigravityProvider({
      fetchImpl: emptyMockFetch
    });
    const emptySnapshot = await emptyProvider.fetchUsageSnapshot!({
      token: "ya29.empty"
    } as any);
    assert.equal(emptySnapshot.windows.length, 1);
    assert.equal(emptySnapshot.windows[0]!.usedPercent, null, "Empty buckets must keep usedPercent: null");

    // Test Case 5: Rounding formula alignment with official Antigravity app
    // App rounds remaining fraction UP: Math.ceil(remainingFraction * 100), usedPercent = Math.floor((1 - remainingFraction) * 100)
    assert.equal(
      calculateBucketUsedPercent({ remainingFraction: 0.1543 }),
      84,
      "0.1543 remaining must yield 84% used (16% left)"
    );
    assert.equal(
      calculateBucketUsedPercent({ remainingFraction: 0.1610 }),
      83,
      "0.1610 remaining must yield 83% used (17% left)"
    );
    assert.equal(
      calculateBucketUsedPercent({ remainingFraction: 0.9780 }),
      2,
      "0.9780 remaining must yield 2% used (98% left)"
    );
    assert.equal(
      calculateBucketUsedPercent({ remainingFraction: 0.8770 }),
      12,
      "0.8770 remaining must yield 12% used (88% left)"
    );

    // Test Case 6: Window inference heuristic (resetTime <= 5h15m in future is 5h, anything longer is weekly)
    const now = Date.now();
    const in18Hours = new Date(now + 18 * 3600_000).toISOString();
    assert.equal(
      inferQuotaWindow({ resetTime: in18Hours }),
      "weekly",
      "Reset time 18 hours in future must NOT be inferred as 5h"
    );
    const in3Hours = new Date(now + 3 * 3600_000).toISOString();
    assert.equal(
      inferQuotaWindow({ resetTime: in3Hours }),
      "5h",
      "Reset time 3 hours in future must be inferred as 5h"
    );
    // Explicit window / bucketId overrides time
    assert.equal(
      inferQuotaWindow({ window: "5h", resetTime: in18Hours }),
      "5h",
      "Explicit window '5h' takes precedence"
    );

    // Test Case 7: Real combined capture test (summary 3p group + userQuota Gemini 5h + Claude/GPT weekly + chat/tab models at 1.0 + no Argon)
    const resetTime5h = new Date(now + 3 * 3600_000).toISOString();
    const resetTimeWeekly = new Date(now + 5 * 24 * 3600_000).toISOString();
    const realCaptureFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes(":retrieveUserQuotaSummary")) {
        return jsonResponse({
          groups: [
            {
              displayName: "Claude and GPT models",
              description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
              buckets: [
                {
                  bucketId: "3p-weekly",
                  displayName: "Weekly Limit Remaining",
                  window: "weekly",
                  resetTime: resetTimeWeekly,
                  description: "You have used some of your weekly limit.",
                  remainingFraction: 0.1543
                },
                {
                  bucketId: "3p-5h",
                  displayName: "Five Hour Limit Remaining",
                  window: "5h",
                  resetTime: resetTime5h,
                  description: "You have used some of your 5-hour limit.",
                  remainingFraction: 0.9780
                }
              ]
            }
          ],
          description: "Within each group, models share a weekly limit and a 5-hour limit."
        });
      }
      if (url.includes(":retrieveUserQuota")) {
        return jsonResponse({
          buckets: [
            { modelId: "chat_20706", tokenType: "WTUS", remainingFraction: 1 },
            { modelId: "chat_23310", tokenType: "WTUS", remainingFraction: 1 },
            { modelId: "tab_flash_lite_preview", tokenType: "WTUS", remainingFraction: 1 },
            {
              modelId: "gemini-2.5-flash",
              tokenType: "WTUS",
              remainingFraction: 0.8770,
              resetTime: resetTime5h
            },
            {
              modelId: "gemini-3-flash",
              tokenType: "WTUS",
              remainingFraction: 0.8770,
              resetTime: resetTime5h
            },
            {
              modelId: "gemini-3.8-flash-tiered",
              tokenType: "WTUS",
              remainingFraction: 0.8770,
              resetTime: resetTime5h
            },
            {
              modelId: "claude-opus-5-5-high",
              tokenType: "WTUS",
              remainingFraction: 0.1543,
              resetTime: resetTimeWeekly
            },
            {
              modelId: "claude-sonnet-5-5-medium",
              tokenType: "WTUS",
              remainingFraction: 0.1543,
              resetTime: resetTimeWeekly
            },
            {
              modelId: "gpt-oss-120b-medium",
              tokenType: "WTUS",
              remainingFraction: 0.1543,
              resetTime: resetTimeWeekly
            }
          ]
        });
      }
      if (url.includes(":fetchAvailableModels")) {
        throw new Error("fetchAvailableModels should NOT be called when retrieveUserQuota succeeds");
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider: realCaptureProvider } = createAntigravityProvider({
      fetchImpl: realCaptureFetch
    });

    const realSnapshot = await realCaptureProvider.fetchUsageSnapshot!({
      token: apiKey
    } as any);

    assert.equal(
      realSnapshot.windows.length,
      3,
      "Real capture must produce exactly 3 windows (Gemini 5h, Claude/GPT Weekly, Claude/GPT 5h)"
    );
    assert.deepEqual(
      realSnapshot.windows.map((w) => ({
        label: w.label,
        usedPercent: w.usedPercent
      })),
      [
        {
          label: "Gemini · 5h",
          usedPercent: 12 // floor((1 - 0.8770) * 100) = 12% used (88% left)
        },
        {
          label: "Claude and GPT · Weekly",
          usedPercent: 84 // floor((1 - 0.1543) * 100) = 84% used (16% left)
        },
        {
          label: "Claude and GPT · 5h",
          usedPercent: 2 // floor((1 - 0.9780) * 100) = 2% used (98% left)
        }
      ]
    );

    // Test Case 8: rawUsage size must be well under 10 KB
    const rawUsageStr = JSON.stringify(realSnapshot.rawUsage);
    assert.ok(
      rawUsageStr.length < 10000,
      `rawUsage size must be under 10 KB, got ${rawUsageStr.length} bytes`
    );
  });

  it("36. Auth resolution: forwards caller agent context (agentDir, cfg, signal) across media, search, and catalog", async () => {
    const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-context-test-"));
    fs.writeFileSync(path.join(testAgentDir, "auth-profiles.json"), "{}");

    try {
      const { catalogService, mediaUnderstandingProvider, webSearchProvider } = createAntigravityProvider({
        fetchImpl: async () => jsonResponse({})
      });

      // 1. mediaUnderstandingProvider.transcribeAudio forwards agentDir
      try {
        await mediaUnderstandingProvider.transcribeAudio({
          buffer: Buffer.from("test audio"),
          agentDir: testAgentDir
        } as any);
      } catch (err: any) {
        assert.ok(
          err?.ownerId?.includes(testAgentDir) || err?.message?.includes("access token"),
          "Media understanding must forward agentDir to auth resolution"
        );
      }

      // 2. webSearchProvider.search forwards agentDir
      try {
        await webSearchProvider.search({
          query: "test query",
          agentDir: testAgentDir
        } as any);
      } catch (err: any) {
        assert.ok(
          err?.ownerId?.includes(testAgentDir) || err?.message?.includes("active authentication"),
          "Web search must forward agentDir to auth resolution"
        );
      }

      // 3. catalogService.listModels forwards agentDir
      const emptyStore = new InMemoryAuthProfileStore();
      try {
        await catalogService.listModels(emptyStore, {
          refresh: true,
          agentDir: testAgentDir
        } as any);
        assert.fail("Should have thrown when agentDir has no credentials");
      } catch (err: any) {
        assert.ok(
          err?.ownerId?.includes(testAgentDir) ||
            err?.message?.includes("not signed in to Antigravity") ||
            err?.message?.includes("no stored Antigravity"),
          `Catalog listModels must forward agentDir to auth resolution, got error: ${err.message}`
        );
      }

      // 4. catalogService.getUsage forwards agentDir
      try {
        await catalogService.getUsage(emptyStore, {
          agentDir: testAgentDir
        } as any);
        assert.fail("Should have thrown when agentDir has no credentials");
      } catch (err: any) {
        assert.ok(
          err?.ownerId?.includes(testAgentDir) ||
            err?.message?.includes("not signed in to Antigravity") ||
            err?.message?.includes("no stored Antigravity"),
          `Catalog getUsage must forward agentDir to auth resolution, got error: ${err.message}`
        );
      }
    } finally {
      fs.rmSync(testAgentDir, { recursive: true, force: true });
    }
  });

  it("38. Quota headers & project resolution (Section A): resolves managed project from loadCodeAssist and accepts uppercase window enums", async () => {
    let loadCodeAssistCalls = 0;
    let capturedSummaryProject: string | undefined;

    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes(":loadCodeAssist")) {
        loadCodeAssistCalls++;
        return jsonResponse({
          eligible: true,
          cloudaicompanionProject: { id: "managed-proj-xyz" }
        });
      }
      if (url.includes(":retrieveUserQuotaSummary")) {
        const body = JSON.parse(String(init?.body || "{}"));
        capturedSummaryProject = body.project;
        return jsonResponse({
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                {
                  bucketId: "gemini-weekly",
                  window: "WEEKLY",
                  remainingFraction: 0.38,
                  resetTime: "2026-11-04T17:05:24Z"
                },
                {
                  bucketId: "gemini-5h",
                  window: "FIVE_HOUR",
                  remainingFraction: 0.91,
                  resetTime: "2026-11-01T01:38:09Z"
                }
              ]
            }
          ]
        });
      }
      if (url.includes(":retrieveUserQuota")) {
        return jsonResponse({
          buckets: [
            {
              modelId: "gemini-3-flash",
              remainingFraction: 0.91,
              resetTime: "2026-11-01T01:38:09Z"
            }
          ]
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { catalogService, defaultAuthStore } = createAntigravityProvider({
      fetchImpl: mockFetch
    });
    await defaultAuthStore.setSecret("antigravity", {
      accessToken: "ya29.test_token",
      refreshToken: "test_refresh",
      expiresAt: Date.now() + 3600_000
    });

    const usageReport = await catalogService.getUsageWithToken("ya29.test_token");
    assert.equal(loadCodeAssistCalls, 1, "Must query loadCodeAssist once to resolve managed project");
    assert.equal(capturedSummaryProject, "managed-proj-xyz", "Must forward resolved managed project to retrieveUserQuotaSummary");
    assert.equal(catalogService.getCachedManagedProjectId(), "managed-proj-xyz", "Must cache resolved managed project");

    // Second call must use cached managed project ID without calling loadCodeAssist again
    await catalogService.getUsageWithToken("ya29.test_token");
    assert.equal(loadCodeAssistCalls, 1, "Must not re-query loadCodeAssist when managed project is cached");

    // Calling getUsage with an isolated authStore updates stored projectId from cached managed project
    const isolatedStore = new InMemoryAuthProfileStore();
    await isolatedStore.setSecret("antigravity", {
      accessToken: "ya29.test_token",
      refreshToken: "test_refresh",
      expiresAt: Date.now() + 3600_000
    });
    await catalogService.getUsage(isolatedStore, { agentDir: "/tmp/non-existent-agent-dir" } as any);
    const storedSecret = await isolatedStore.getSecret("antigravity");
    assert.equal(storedSecret?.projectId, "managed-proj-xyz", "Must store resolved projectId into authStore");

    // Verify uppercase windows are properly mapped and formatted
    assert.ok(usageReport.buckets.some((b) => b.window === "weekly" && b.bucketId === "gemini-weekly"));
    assert.ok(usageReport.buckets.some((b) => b.window === "5h" && b.bucketId === "gemini-5h"));
  });

  it("37. Error classification (Section G): classifyGoogleRpc429 parses ErrorInfo and RetryInfo, filters domain, and handles transient vs terminal 429", async () => {
    // 1. QUOTA_EXHAUSTED with cloudcode domain -> terminal_quota, reset timestamp parsed
    const terminalJson = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Resource has been exhausted (e.g. check quota).",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "QUOTA_EXHAUSTED",
            domain: "cloudcode.googleapis.com",
            metadata: {
              quotaResetTimeStamp: "2026-11-04T17:05:24Z"
            }
          }
        ]
      }
    });
    const terminalClass = classifyGoogleRpc429(terminalJson);
    assert.equal(terminalClass.type, "terminal_quota");
    assert.equal(terminalClass.reason, "QUOTA_EXHAUSTED");
    assert.equal(terminalClass.domain, "cloudcode.googleapis.com");
    assert.equal(terminalClass.resetAt, "2026-11-04T17:05:24Z");

    // 2. RATE_LIMIT_EXCEEDED with cloudaicompanion domain + RetryInfo -> transient_rate_limit, retryDelay parsed
    const transientJson = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Rate limit exceeded. Please retry in 3.5s",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            domain: "cloudaicompanion.googleapis.com"
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "3.5s"
          }
        ]
      }
    });
    const transientClass = classifyGoogleRpc429(transientJson);
    assert.equal(transientClass.type, "transient_rate_limit");
    assert.equal(transientClass.reason, "RATE_LIMIT_EXCEEDED");
    assert.equal(transientClass.domain, "cloudaicompanion.googleapis.com");
    assert.equal(transientClass.retryDelayMs, 3500);

    // 3. MODEL_CAPACITY_EXHAUSTED with cloudcode domain -> transient_rate_limit
    const capacityJson = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Model capacity exhausted. Please retry in 2s",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "MODEL_CAPACITY_EXHAUSTED",
            domain: "daily-cloudcode-pa.googleapis.com"
          }
        ]
      }
    });
    const capacityClass = classifyGoogleRpc429(capacityJson);
    assert.equal(capacityClass.type, "transient_rate_limit");
    assert.equal(capacityClass.reason, "MODEL_CAPACITY_EXHAUSTED");
    assert.equal(capacityClass.retryDelayMs, 2000);

    // 4. Non-cloudcode domain (e.g. storage.googleapis.com) -> ignored, returns unclassified
    const thirdPartyJson = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Third party storage quota",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "QUOTA_EXHAUSTED",
            domain: "storage.googleapis.com"
          }
        ]
      }
    });
    const thirdPartyClass = classifyGoogleRpc429(thirdPartyJson);
    assert.equal(thirdPartyClass.type, "unclassified", "ErrorInfo with non-cloudcode domain must be ignored");

    // 5. In-turn streaming behavior:
    // A) Transient 429 retries boundedly and succeeds on retry -> no quota card emitted
    let transientCallCount = 0;
    const transientTurnFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes(":fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-3-flash": { displayName: "Gemini 3 Flash" }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        transientCallCount++;
        if (transientCallCount === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 429,
                status: "RESOURCE_EXHAUSTED",
                message: "Rate limit exceeded. Please retry in 0.1s",
                details: [
                  {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    reason: "RATE_LIMIT_EXCEEDED",
                    domain: "cloudcode.googleapis.com"
                  },
                  {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    retryDelay: "0.1s"
                  }
                ]
              }
            }),
            { status: 429, headers: { "Content-Type": "application/json" } }
          );
        }
        return sseResponse([
          {
            response: {
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "success after retry" }] },
                  finishReason: "STOP"
                }
              ]
            }
          }
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider: transientProvider, defaultAuthStore: tStore } = createAntigravityProvider({
      fetchImpl: transientTurnFetch
    });
    await tStore.setSecret("antigravity", {
      accessToken: "ya29.test_token",
      refreshToken: "test_refresh",
      expiresAt: Date.now() + 3600_000
    });

    const tStreamFn = transientProvider.createStreamFn();
    const tStream = tStreamFn(
      { id: "antigravity/gemini-3-flash" } as any,
      { messages: [{ role: "user", content: "hello" }] }
    );
    const tEvents: any[] = [];
    for await (const ev of tStream) {
      tEvents.push(ev);
    }
    assert.equal(transientCallCount, 2, "Transient 429 must retry upstream");
    const tText = tEvents.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    assert.equal(tText, "success after retry");
    assert.ok(!tText.includes("quota exhausted"), "Transient 429 must not emit quota exhausted card");

    // B) Terminal 429 emits quota notice card with reset countdown
    const terminalTurnFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes(":fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-3-flash": { displayName: "Gemini 3 Flash" }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        return new Response(terminalJson, { status: 429, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider: terminalProvider, defaultAuthStore: termStore } = createAntigravityProvider({
      fetchImpl: terminalTurnFetch
    });
    await termStore.setSecret("antigravity", {
      accessToken: "ya29.test_token",
      refreshToken: "test_refresh",
      expiresAt: Date.now() + 3600_000
    });

    const termStreamFn = terminalProvider.createStreamFn();
    const termStream = termStreamFn(
      { id: "antigravity/gemini-3-flash" } as any,
      { messages: [{ role: "user", content: "hello" }] }
    );
    const termEvents: any[] = [];
    for await (const ev of termStream) {
      termEvents.push(ev);
    }
    const termText = termEvents.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    assert.ok(termText.includes("quota exhausted"), "Terminal 429 must emit quota exhausted notice card");
    assert.ok(termText.includes("Resets at"), "Terminal 429 card must include reset time");
  });

  it("39. Refresh robustness & concurrency deduping (Section H): dedupes concurrent 401 token refreshes and never retries invalid_grant", async () => {
    let tokenRefreshCalls = 0;

    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes("/token")) {
        tokenRefreshCalls++;
        // Add slight delay to allow concurrent turns to race
        await new Promise((r) => setTimeout(r, 50));
        return jsonResponse({
          access_token: "ya29.refreshed_concurrent_token",
          refresh_token: "test_refresh_deduped",
          expires_in: 3600
        });
      }
      if (url.includes(":fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-3-flash": { displayName: "Gemini 3 Flash" }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        const authHeader = (init?.headers as Record<string, string>)?.["Authorization"] || "";
        if (authHeader.includes("ya29.initial_expired_token")) {
          return new Response(
            JSON.stringify({
              error: {
                code: 401,
                status: "UNAUTHENTICATED",
                message: "Request had invalid authentication credentials. Expected OAuth 2 access token."
              }
            }),
            { status: 401, headers: { "Content-Type": "application/json" } }
          );
        }
        return sseResponse([
          {
            response: {
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "concurrent turn success" }] },
                  finishReason: "STOP"
                }
              ]
            }
          }
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider, defaultAuthStore } = createAntigravityProvider({
      fetchImpl: mockFetch
    });
    await defaultAuthStore.setSecret("antigravity", {
      accessToken: "ya29.initial_expired_token",
      refreshToken: "test_refresh_deduped",
      expiresAt: Date.now() + 3600_000
    });

    // Launch two concurrent turns simultaneously
    const streamFn = provider.createStreamFn();
    const stream1 = streamFn(
      { id: "antigravity/gemini-3-flash" } as any,
      { messages: [{ role: "user", content: "turn 1" }] }
    );
    const stream2 = streamFn(
      { id: "antigravity/gemini-3-flash" } as any,
      { messages: [{ role: "user", content: "turn 2" }] }
    );

    const [events1, events2] = await Promise.all([
      (async () => {
        const evs: any[] = [];
        for await (const ev of stream1) evs.push(ev);
        return evs;
      })(),
      (async () => {
        const evs: any[] = [];
        for await (const ev of stream2) evs.push(ev);
        return evs;
      })()
    ]);

    assert.equal(tokenRefreshCalls, 1, "Concurrent 401 turns must deduplicate token refresh to exactly 1 network call");
    const text1 = events1.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    const text2 = events2.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
    assert.equal(text1, "concurrent turn success");
    assert.equal(text2, "concurrent turn success");

    // Auth store must have the refreshed token
    const finalSecret = await defaultAuthStore.getSecret("antigravity");
    assert.equal(finalSecret?.accessToken, "ya29.refreshed_concurrent_token");
  });

  it("40. Plugin rename & identity isolation: manifest plugin id = 'openclaw-antigravity-oauth' while provider & contract ids remain 'antigravity' / 'antigravity-search'", async () => {
    // 1. Read openclaw.plugin.json
    const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf-8"));
    assert.equal(manifest.id, "openclaw-antigravity-oauth", "Plugin id must be openclaw-antigravity-oauth");
    assert.equal(manifest.name, "Antigravity OAuth", "Plugin name must be Antigravity OAuth");

    // 2. Read package.json
    const pkgPath = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, "utf-8"));
    assert.equal(pkg.name, "openclaw-antigravity-oauth");
    // Plugin version = <agyMajor>.<agyMinor>.<agyPatch*100 + fix> (agy 1.4.12 -> 1.4.1200..1.4.1299).
    const [maj, min, patch] = CLI_VERSION.split(".").map(Number);
    const [pMaj, pMin, pPatch] = String(pkg.version).split(".").map(Number);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual([pMaj, pMin, Math.floor(pPatch / 100)], [maj, min, patch]);
    assert.equal(pkg.private, true);
    assert.equal(pkg.repository?.url, "https://github.com/predator-1/openclaw-antigravity-oauth.git");

    // 3. Plugin export definition
    assert.equal(PLUGIN_ID, "openclaw-antigravity-oauth");
    assert.equal(antigravityPlugin.id, "openclaw-antigravity-oauth");
    assert.equal(antigravityPlugin.name, "Antigravity OAuth");

    // 4. Provider and capability identities remain 'antigravity' and 'antigravity-search'
    assert.equal(PROVIDER_ID, "antigravity");
    assert.deepEqual(manifest.providers, ["antigravity"]);
    assert.equal(manifest.modelCatalog?.discovery?.antigravity, "refreshable");
    assert.deepEqual(manifest.contracts?.usageProviders, ["antigravity"]);
    assert.deepEqual(manifest.contracts?.mediaUnderstandingProviders, ["antigravity"]);
    assert.deepEqual(manifest.contracts?.imageGenerationProviders, ["antigravity"]);
    assert.deepEqual(manifest.contracts?.webSearchProviders, ["antigravity-search"]);
    assert.deepEqual(manifest.contracts?.webFetchProviders, ["antigravity-fetch"]);
    assert.deepEqual(manifest.activation?.onProviders, ["antigravity"]);
    assert.ok(manifest.mediaUnderstandingProviderMetadata?.antigravity);

    // 5. Registered providers retain their exact capability IDs
    let registeredProvider: OpenClawProviderRegistration | undefined;
    let registeredMedia: any;
    let registeredSearch: any;
    let registeredFetch: any;
    let registeredImage: any;

    antigravityPlugin.register({
      registerProvider: (p) => {
        registeredProvider = p;
      },
      registerMediaUnderstandingProvider: (p) => {
        registeredMedia = p;
      },
      registerWebSearchProvider: (p) => {
        registeredSearch = p;
      },
      registerWebFetchProvider: (p) => {
        registeredFetch = p;
      },
      registerImageGenerationProvider: (p) => {
        registeredImage = p;
      }
    });

    assert.equal(registeredProvider?.id, "antigravity");
    assert.equal(registeredMedia?.id, "antigravity");
    assert.equal(registeredSearch?.id, "antigravity-search");
    assert.equal(registeredSearch?.providerId, "antigravity");
    assert.equal(registeredSearch?.authProviderId, "antigravity");
    assert.equal(registeredFetch?.id, "antigravity-fetch");
    assert.equal(registeredFetch?.providerId, "antigravity");
    assert.equal(registeredFetch?.authProviderId, "antigravity");
    assert.equal(registeredImage?.id, "antigravity");
  });

  it("41. CLI client identity: UA built from CLI_VERSION with platform/arch mapping, no bare IDE UA, and x-activity-request-id", async () => {
    // 1. Version and user agent builder
    // CLI_VERSION is bumped by `npm run sync:upstream:apply`; only its shape is pinned here
    // so a safe agy update does not fail its own verification step.
    assert.match(CLI_VERSION, /^\d+\.\d+\.\d+$/);
    const cases: Array<[unknown, unknown, string, string]> = [
      ["win32", "x64", "windows", "amd64"],
      ["linux", "x64", "linux", "amd64"],
      ["linux", "arm64", "linux", "arm64"],
      ["darwin", "arm64", "darwin", "arm64"],
      ["darwin", "x64", "darwin", "amd64"],
      ["freebsd", "x64", "freebsd", "amd64"],
      ["linux", "ia32", "linux", "386"],
      ["sunos", "x64", "solaris", "amd64"],
      ["", "x64", "unknown", "amd64"],
      ["linux", "", "linux", "unknown"],
      [undefined, undefined, "unknown", "unknown"],
      [null, 64, "unknown", "unknown"],
      [123, "arm64", "unknown", "arm64"]
    ];
    for (const [platform, arch, osToken, archToken] of cases) {
      assert.doesNotThrow(() => buildAgyUserAgent(platform, arch));
      const mapped = mapAgyOsArch(platform, arch);
      assert.equal(mapped.os, osToken);
      assert.equal(mapped.arch, archToken);
      const built = buildAgyUserAgent(platform, arch);
      assert.equal(built, `antigravity/cli/${CLI_VERSION} ${osToken}/${archToken}`);
      assert.ok(built.length > 0);
    }
    const ua = buildAgyUserAgent();
    assert.equal(ua.split(" ")[0], `antigravity/cli/${CLI_VERSION}`);
    assert.match(ua, new RegExp(`^antigravity/cli/${CLI_VERSION.replaceAll(".", "\\.")} [^/\\s]+/[^/\\s]+$`));
    assert.equal(ANTIGRAVITY_CLI_USER_AGENT, ua);

    // 3. Header builders
    const headers = buildAntigravityHeaders("ya29.test_token");
    assert.equal(headers["User-Agent"], ua);
    assert.equal(headers["Authorization"], "Bearer ya29.test_token");
    assert.match(headers["x-activity-request-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal((headers as any)["X-Goog-Api-Client"], undefined);
    assert.equal((headers as any)["Client-Metadata"], undefined);

    const quotaHeaders = buildAntigravityQuotaHeaders("ya29.test_token");
    assert.equal(quotaHeaders["User-Agent"], ua);
    assert.equal(quotaHeaders["Authorization"], "Bearer ya29.test_token");
    assert.equal(quotaHeaders["Content-Type"], "application/json");
    assert.equal(quotaHeaders["Accept"], "application/json");
    assert.match(quotaHeaders["x-activity-request-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal((quotaHeaders as any)["X-Goog-Api-Client"], undefined);
    assert.equal((quotaHeaders as any)["Client-Metadata"], undefined);

    // 4. Verify no outbound request sends bare IDE UA "antigravity/1.15.8"
    let capturedHeaders: Record<string, string> | undefined;
    const mockFetch = (async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: "pong" }] } }] } }]);
    }) as any;

    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret(PROVIDER_ID, {
      accessToken: "ya29.live_token",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600000,
      projectId: "test-proj"
    });

    const { provider, catalogService } = createAntigravityProvider({
      authStore,
      fetchImpl: mockFetch
    });

    catalogService.setCachedModels([
      {
        id: "gemini-3.8-flash",
        ref: "antigravity/gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      },
      {
        id: "claude-sonnet-5-5",
        ref: "antigravity/claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);

    await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [{ role: "user", content: "pong" }]
    }, { authStore });

    assert.ok(capturedHeaders);
    assert.equal(capturedHeaders["User-Agent"], ua);
    assert.notEqual(capturedHeaders["User-Agent"], "antigravity/1.15.8 darwin/arm64");
    assert.ok(!capturedHeaders["User-Agent"].includes("1.15.8"));
    assert.equal(capturedHeaders["X-Goog-Api-Client"], undefined);
    assert.equal(capturedHeaders["Client-Metadata"], undefined);
    assert.ok(capturedHeaders["x-activity-request-id"]);
  });

  it("42. Request sanitization: cleanJsonSchema flattens unions, stringifies enums, and never drops types", () => {
    // 1. Type arrays: ["string", "null"] -> string + nullable
    const s1 = cleanJsonSchema({
      type: "object",
      properties: {
        nickname: { type: ["string", "null"], description: "Optional nickname" }
      }
    });
    assert.deepEqual(s1.properties, {
      nickname: { type: "string", nullable: true, description: "Optional nickname" }
    });

    // 2. anyOf with null branch -> non-null branch + nullable
    const s2 = cleanJsonSchema({
      type: "object",
      properties: {
        age: {
          description: "Age in years",
          anyOf: [{ type: "integer" }, { type: "null" }]
        }
      }
    });
    assert.deepEqual(s2.properties, {
      age: { type: "integer", nullable: true, description: "Age in years" }
    });

    // 3. oneOf with null branch -> non-null branch + nullable
    const s3 = cleanJsonSchema({
      type: "object",
      properties: {
        isActive: {
          oneOf: [{ type: "boolean" }, { type: "null" }]
        }
      }
    });
    assert.deepEqual(s3.properties, {
      isActive: { type: "boolean", nullable: true }
    });

    // 4. other anyOf without null -> first viable branch keeping description
    const s4 = cleanJsonSchema({
      type: "object",
      properties: {
        target: {
          description: "Target location",
          anyOf: [{ type: "string", description: "City" }, { type: "number" }]
        }
      }
    });
    assert.deepEqual(s4.properties, {
      target: { type: "string", description: "City" }
    });

    // 5. Stringify enum values & deduplicate
    const s5 = cleanJsonSchema({
      type: "object",
      properties: {
        status: {
          enum: [1, 2, "3", "3", true, null]
        }
      }
    });
    assert.deepEqual(s5.properties, {
      status: { type: "string", enum: ["1", "2", "3", "true"] }
    });

    // 6. Recurse into properties and items
    const s6 = cleanJsonSchema({
      type: "object",
      properties: {
        userList: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tags: { type: ["string", "null"] }
            }
          }
        }
      }
    });
    assert.deepEqual(s6.properties, {
      userList: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tags: { type: "string", nullable: true }
          }
        }
      }
    });

    // 7. Never drop type silently
    const s7 = cleanJsonSchema({
      type: "object",
      properties: {
        implicitObj: { properties: { a: { type: "string" } } },
        implicitArr: { items: { type: "string" } },
        implicitEnum: { enum: ["a", "b"] },
        untypedEmpty: {}
      }
    });
    const props = s7.properties as Record<string, any>;
    assert.equal(props.implicitObj.type, "object");
    assert.equal(props.implicitArr.type, "array");
    assert.equal(props.implicitEnum.type, "string");
    assert.equal(props.untypedEmpty.type, "string");
  });

  it("43. Tool name mapping & collision safety: bidirectional ToolNameMapper with original name validation", async () => {
    // 1. Valid names pass through unchanged
    const mapper = new ToolNameMapper();
    assert.equal(mapper.toSafeName("lookup_weather"), "lookup_weather");
    assert.equal(mapper.toOriginalName("lookup_weather"), "lookup_weather");

    // 2. Non-alphanumeric chars mapped to underscores
    assert.equal(mapper.toSafeName("atlassian:get-issue"), "atlassian_get_issue");
    assert.equal(mapper.toOriginalName("atlassian_get_issue"), "atlassian:get-issue");

    // 3. Leading digits prefixed with underscore
    assert.equal(mapper.toSafeName("123_data"), "_123_data");
    assert.equal(mapper.toOriginalName("_123_data"), "123_data");

    // 4. Collision detection order 1: "a:b" then literal "a_b"
    const m1 = new ToolNameMapper();
    const safeCol1 = m1.toSafeName("a:b");
    const safeLit1 = m1.toSafeName("a_b");
    assert.equal(safeCol1, "a_b");
    assert.equal(safeLit1, "a_b_1");
    assert.match(safeCol1, /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
    assert.match(safeLit1, /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
    assert.equal(m1.toOriginalName(safeCol1), "a:b");
    assert.equal(m1.toOriginalName(safeLit1), "a_b");
    assert.equal(m1.toSafeName("a:b"), "a_b");
    assert.equal(m1.toSafeName("a_b"), "a_b_1");

    // 5. Collision detection order 2: literal "a_b" then "a:b"
    const m2 = new ToolNameMapper();
    const safeLit2 = m2.toSafeName("a_b");
    const safeCol2 = m2.toSafeName("a:b");
    assert.equal(safeLit2, "a_b");
    assert.equal(safeCol2, "a_b_1");
    assert.match(safeLit2, /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
    assert.match(safeCol2, /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
    assert.equal(m2.toOriginalName(safeLit2), "a_b");
    assert.equal(m2.toOriginalName(safeCol2), "a:b");
    assert.equal(m2.toSafeName("a_b"), "a_b");
    assert.equal(m2.toSafeName("a:b"), "a_b_1");

    // 6. Max length boundary test (64 chars) with collision
    const m3 = new ToolNameMapper();
    const longBase = "a".repeat(64);
    const longAlt = "a".repeat(63) + ":";
    const safeLongBase = m3.toSafeName(longBase);
    const safeLongAlt = m3.toSafeName(longAlt);
    assert.equal(safeLongBase.length, 64);
    assert.equal(safeLongAlt.length, 64);
    assert.match(safeLongBase, /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
    assert.match(safeLongAlt, /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
    assert.notEqual(safeLongBase, safeLongAlt);
    assert.equal(m3.toOriginalName(safeLongBase), longBase);
    assert.equal(m3.toOriginalName(safeLongAlt), longAlt);

    // 7. End-to-end turn with colliding tools in Order 1: "a:b" then "a_b"
    let capturedBodyOrder1: Record<string, any> | undefined;
    const mockFetchOrder1 = (async (_url: unknown, init?: RequestInit) => {
      capturedBodyOrder1 = JSON.parse(String(init?.body));
      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    { functionCall: { name: "a_b", args: { x: 1 } } },
                    { functionCall: { name: "a_b_1", args: { y: 2 } } }
                  ]
                }
              }
            ]
          }
        }
      ]);
    }) as any;

    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret(PROVIDER_ID, {
      accessToken: "ya29.turn_token",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600000,
      projectId: "test-proj"
    });

    const { provider: prov1, catalogService: cat1 } = createAntigravityProvider({
      authStore,
      fetchImpl: mockFetchOrder1
    });

    cat1.setCachedModels([
      {
        id: "gemini-3.8-flash",
        ref: "antigravity/gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);

    const resOrder1 = await prov1.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [{ role: "user", content: "call tools" }],
      tools: [
        {
          name: "a:b",
          description: "Colon tool",
          parameters: { type: "object", properties: { x: { type: "number" } } }
        },
        {
          name: "a_b",
          description: "Literal underscore tool",
          parameters: { type: "object", properties: { y: { type: "number" } } }
        }
      ]
    }, { authStore });

    // Verify declarations are unique in the built request
    const declsOrder1 = capturedBodyOrder1?.request?.tools?.[0]?.functionDeclarations;
    assert.ok(declsOrder1);
    const namesOrder1 = declsOrder1.map((d: any) => d.name);
    assert.deepEqual(namesOrder1, ["a_b", "a_b_1"]);
    assert.equal(new Set(namesOrder1).size, 2);

    // Verify returned calls are restored to the correct original names and passed allowedHostToolNames
    assert.equal(resOrder1.toolCalls.length, 2);
    assert.equal(resOrder1.toolCalls[0].name, "a:b");
    assert.deepEqual(resOrder1.toolCalls[0].arguments, { x: 1 });
    assert.equal(resOrder1.toolCalls[1].name, "a_b");
    assert.deepEqual(resOrder1.toolCalls[1].arguments, { y: 2 });

    // 8. End-to-end turn with colliding tools in Order 2: "a_b" then "a:b"
    let capturedBodyOrder2: Record<string, any> | undefined;
    const mockFetchOrder2 = (async (_url: unknown, init?: RequestInit) => {
      capturedBodyOrder2 = JSON.parse(String(init?.body));
      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    { functionCall: { name: "a_b", args: { y: 2 } } },
                    { functionCall: { name: "a_b_1", args: { x: 1 } } }
                  ]
                }
              }
            ]
          }
        }
      ]);
    }) as any;

    const { provider: prov2, catalogService: cat2 } = createAntigravityProvider({
      authStore,
      fetchImpl: mockFetchOrder2
    });

    cat2.setCachedModels([
      {
        id: "gemini-3.8-flash",
        ref: "antigravity/gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);

    const resOrder2 = await prov2.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [{ role: "user", content: "call tools" }],
      tools: [
        {
          name: "a_b",
          description: "Literal underscore tool",
          parameters: { type: "object", properties: { y: { type: "number" } } }
        },
        {
          name: "a:b",
          description: "Colon tool",
          parameters: { type: "object", properties: { x: { type: "number" } } }
        }
      ]
    }, { authStore });

    const declsOrder2 = capturedBodyOrder2?.request?.tools?.[0]?.functionDeclarations;
    assert.ok(declsOrder2);
    const namesOrder2 = declsOrder2.map((d: any) => d.name);
    assert.deepEqual(namesOrder2, ["a_b", "a_b_1"]);
    assert.equal(new Set(namesOrder2).size, 2);

    assert.equal(resOrder2.toolCalls.length, 2);
    assert.equal(resOrder2.toolCalls[0].name, "a_b");
    assert.deepEqual(resOrder2.toolCalls[0].arguments, { y: 2 });
    assert.equal(resOrder2.toolCalls[1].name, "a:b");
    assert.deepEqual(resOrder2.toolCalls[1].arguments, { x: 1 });
  });

  it("44. Claude thought signatures & host replay policy: Gemini gets sentinel, Claude does not, replay policy repairs tool pairing", async () => {
    let capturedBodies: Record<string, any>[] = [];
    const mockFetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(String(init?.body)));
      return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: "done" }] } }] } }]);
    }) as any;

    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret(PROVIDER_ID, {
      accessToken: "ya29.sentinel_test",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600000,
      projectId: "test-proj"
    });

    const { provider, catalogService } = createAntigravityProvider({
      authStore,
      fetchImpl: mockFetch
    });

    catalogService.setCachedModels([
      {
        id: "gemini-3.8-flash",
        ref: "antigravity/gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      },
      {
        id: "claude-sonnet-5-5",
        ref: "antigravity/claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);

    const conversationWithToolCall = [
      { role: "user" as const, content: "Calculate 2+2" },
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: "call_1", name: "calc", arguments: { expr: "2+2" } }]
      },
      { role: "tool" as const, toolCallId: "call_1", name: "calc", content: "4" }
    ];

    // 1. Turn on Gemini model
    await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: conversationWithToolCall
    }, { authStore });

    const geminiPayload = capturedBodies[0];
    const geminiAssistantParts = geminiPayload.request.contents[1].parts;
    assert.equal(geminiAssistantParts[0].thoughtSignature, "skip_thought_signature_validator");
    assert.equal(geminiAssistantParts[0].thought_signature, "skip_thought_signature_validator");

    // 2. Turn on Claude model
    await provider.completeTurn({
      model: "antigravity/claude-sonnet-5-5",
      messages: conversationWithToolCall
    }, { authStore });

    const claudePayload = capturedBodies[1];
    const claudeAssistantParts = claudePayload.request.contents[1].parts;
    assert.equal(claudeAssistantParts[0].thoughtSignature, undefined);
    assert.equal(claudeAssistantParts[0].thought_signature, undefined);

    // 3. Provider buildReplayPolicy declaration
    assert.ok(provider.buildReplayPolicy);
    const geminiPolicy = provider.buildReplayPolicy({ modelId: "gemini-3.8-flash" });
    assert.equal(geminiPolicy.repairToolUseResultPairing, true);
    assert.equal(geminiPolicy.allowSyntheticToolResults, true);
    assert.ok((geminiPolicy as any).sanitizeThoughtSignatures);

    const claudePolicy = provider.buildReplayPolicy({ modelId: "claude-sonnet-5-5" });
    assert.equal(claudePolicy.repairToolUseResultPairing, true);
    assert.equal(claudePolicy.allowSyntheticToolResults, true);
    assert.equal((claudePolicy as any).sanitizeThoughtSignatures, undefined);
  });

  it("Thought signatures: stores real Gemini signatures, replays them, keeps sentinel fallback, leaves Claude unchanged", async () => {
    const storedSignature = "c2lnbmF0dXJlX3Rlc3RfYWJj";
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret(PROVIDER_ID, {
      accessToken: "ya29.thought_sig_store",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000,
      projectId: "test-proj"
    });

    let capturedBodies: Record<string, any>[] = [];
    let streamPhase: "emit" | "replay" = "emit";
    const mockFetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes(":fetchAvailableModels") || url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              id: "gemini-3.8-flash-tiered",
              displayName: "Gemini 3.8 Flash",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 8192
            },
            "claude-sonnet-5-5-medium": {
              id: "claude-sonnet-5-5-medium",
              displayName: "Claude Sonnet 5.5",
              modality: "chat",
              contextWindow: 128000,
              maxOutputTokens: 8192
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        capturedBodies.push(JSON.parse(String(init?.body)));
        if (streamPhase === "emit") {
          return sseResponse([
            {
              response: {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            id: "call_weather_1",
                            name: "lookup_weather",
                            args: { city: "Paris" }
                          },
                          thoughtSignature: storedSignature
                        }
                      ]
                    }
                  }
                ]
              }
            }
          ]);
        }
        return sseResponse([
          { response: { candidates: [{ content: { parts: [{ text: "done" }] } }] } }
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider, catalogService } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    catalogService.setCachedModels([
      {
        id: "gemini-3.8-flash",
        ref: "antigravity/gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      },
      {
        id: "claude-sonnet-5-5",
        ref: "antigravity/claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);

    const emitted = await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [
        {
          name: "lookup_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      ]
    });

    assert.equal(emitted.toolCalls.length, 1);
    assert.equal(emitted.toolCalls[0].id, "call_weather_1");
    assert.equal(emitted.toolCalls[0].name, "lookup_weather");
    assert.deepEqual(emitted.toolCalls[0].arguments, { city: "Paris" });
    assert.equal(emitted.toolCalls[0].thoughtSignature, storedSignature);
    assert.equal(emitted.toolCalls[0].thoughtSignatureModel, "gemini-3.8-flash");

    streamPhase = "replay";
    capturedBodies = [];

    await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [emitted.toolCalls[0]]
        },
        { role: "tool", content: "sunny", toolCallId: "call_weather_1", name: "lookup_weather" }
      ]
    });

    const replayedGemini = capturedBodies[0].request.contents.find(
      (c: { role: string }) => c.role === "model"
    );
    const replayedPart = replayedGemini.parts.find((part: Record<string, unknown>) => part.functionCall);
    assert.equal(replayedPart.thoughtSignature, storedSignature);
    assert.equal(replayedPart.thought_signature, storedSignature);
    assert.notEqual(replayedPart.thoughtSignature, "skip_thought_signature_validator");

    // Cross-model replay (flash signature on argon) must use the sentinel — signatures are model-bound.
    capturedBodies = [];
    catalogService.setCachedModels([
      {
        id: "gemini-3.8-flash",
        ref: "antigravity/gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      },
      {
        id: "gemini-4-argon",
        ref: "antigravity/gemini-4-argon",
        displayName: "Gemini 4 Argon",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      },
      {
        id: "claude-sonnet-5-5",
        ref: "antigravity/claude-sonnet-5-5",
        displayName: "Claude Sonnet 5.5",
        contextWindow: 1000000,
        maxOutputTokens: 65536,
        canDisableReasoning: false,
        reasoningLevels: ["low", "medium", "high"]
      }
    ]);
    await provider.completeTurn({
      model: "antigravity/gemini-4-argon",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [emitted.toolCalls[0]]
        },
        { role: "tool", content: "sunny", toolCallId: "call_weather_1", name: "lookup_weather" }
      ]
    });
    const crossGemini = capturedBodies[0].request.contents.find(
      (c: { role: string }) => c.role === "model"
    );
    const crossPart = crossGemini.parts.find((part: Record<string, unknown>) => part.functionCall);
    assert.equal(crossPart.thoughtSignature, "skip_thought_signature_validator");
    assert.equal(crossPart.thought_signature, "skip_thought_signature_validator");

    capturedBodies = [];
    await provider.completeTurn({
      model: "antigravity/gemini-3.8-flash",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_weather_1", name: "lookup_weather", arguments: { city: "Paris" } }]
        },
        { role: "tool", content: "sunny", toolCallId: "call_weather_1", name: "lookup_weather" }
      ]
    });

    const fallbackGemini = capturedBodies[0].request.contents.find(
      (c: { role: string }) => c.role === "model"
    );
    const fallbackPart = fallbackGemini.parts.find((part: Record<string, unknown>) => part.functionCall);
    assert.equal(fallbackPart.thoughtSignature, "skip_thought_signature_validator");
    assert.equal(fallbackPart.thought_signature, "skip_thought_signature_validator");

    capturedBodies = [];
    await provider.completeTurn({
      model: "antigravity/claude-sonnet-5-5",
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_weather_1",
              name: "lookup_weather",
              arguments: { city: "Paris" },
              thoughtSignature: storedSignature
            }
          ]
        },
        { role: "tool", content: "sunny", toolCallId: "call_weather_1", name: "lookup_weather" }
      ]
    });

    const claudeParts = capturedBodies[0].request.contents.find(
      (c: { role: string }) => c.role === "model"
    ).parts;
    assert.equal(claudeParts[0].thoughtSignature, undefined);
    assert.equal(claudeParts[0].thought_signature, undefined);

    streamPhase = "emit";
    capturedBodies = [];
    const streamFn = provider.createStreamFn();
    const emitStream = streamFn(
      { id: "gemini-3.8-flash", provider: "antigravity", api: "openai-completions" },
      {
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_weather",
              parameters: { type: "object", properties: { city: { type: "string" } } }
            }
          }
        ]
      },
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-proj" }) }
    ) as AsyncIterable<Record<string, unknown>>;

    const emitEvents: Array<Record<string, unknown>> = [];
    for await (const ev of emitStream) {
      emitEvents.push(ev);
    }
    const toolEnd = emitEvents.find((e) => e.type === "toolcall_end");
    assert.ok(toolEnd, "stream should emit toolcall_end");
    const toolCall = toolEnd.toolCall as Record<string, unknown>;
    assert.equal(toolCall.thoughtSignature, storedSignature);
    assert.equal(toolCall.thought_signature, storedSignature);

    streamPhase = "replay";
    capturedBodies = [];
    const replayStream = streamFn(
      { id: "gemini-3.8-flash", provider: "antigravity", api: "openai-completions" },
      {
        messages: [
          { role: "user", content: "weather in Paris?" },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_weather_1",
                name: "lookup_weather",
                arguments: { city: "Paris" },
                thoughtSignature: storedSignature
              }
            ]
          },
          {
            role: "tool",
            name: "lookup_weather",
            toolCallId: "call_weather_1",
            content: "sunny"
          }
        ]
      },
      { apiKey: JSON.stringify({ token: "test-token", projectId: "test-proj" }) }
    ) as AsyncIterable<Record<string, unknown>>;

    for await (const _ev of replayStream) {
      // consume
    }

    const streamedReplay = capturedBodies[0].request.contents.find(
      (c: { role: string }) => c.role === "model"
    );
    const streamedPart = streamedReplay.parts.find((part: Record<string, unknown>) => part.functionCall);
    assert.equal(streamedPart.thoughtSignature, storedSignature);
    assert.equal(streamedPart.thought_signature, storedSignature);
  });

  it("47. Web search auto-detection and fallback: order 35 (after Grok, before Kimi), requiresCredential, readiness via OAuth profile, and fallback chain participation", async () => {
    // 1. Verify autoDetectOrder and credential declarations
    const emptyAuthStore = new InMemoryAuthProfileStore();
    const searchProvider = buildAntigravityWebSearchProvider({
      defaultAuthStore: emptyAuthStore
    });

    assert.equal(searchProvider.id, ANTIGRAVITY_SEARCH_PROVIDER_ID);
    assert.equal(searchProvider.requiresCredential, true);
    assert.equal(searchProvider.autoDetectOrder, 35);
    assert.equal(searchProvider.authProviderId, "antigravity");
    assert.equal(ANTIGRAVITY_SEARCH_AUTO_DETECT_ORDER, 35);
    assert.ok(Array.isArray(searchProvider.inactiveSecretPaths));
    assert.ok(
      searchProvider.inactiveSecretPaths.includes(
        "plugins.entries.openclaw-antigravity-oauth.config.webSearch.apiKey"
      )
    );

    // 2. Auto-detect order sorting parity with OpenClaw's sortPluginEntriesForAutoDetect
    // OpenClaw's precedence: Brave (10), MiniMax (15), Gemini (20), Grok (30), Antigravity (35), Kimi (40), Perplexity (50)
    const simulatedRegistryProviders = [
      { id: "perplexity", autoDetectOrder: 50, pluginId: "perplexity" },
      { id: "kimi", autoDetectOrder: 40, pluginId: "moonshot" },
      {
        id: "antigravity-search",
        autoDetectOrder: searchProvider.autoDetectOrder,
        pluginId: "openclaw-antigravity-oauth"
      },
      { id: "grok", autoDetectOrder: 30, pluginId: "xai" },
      { id: "gemini", autoDetectOrder: 20, pluginId: "google" },
      { id: "brave", autoDetectOrder: 10, pluginId: "brave" }
    ];

    const sortedCandidates = simulatedRegistryProviders.toSorted((left, right) => {
      const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.id.localeCompare(right.id);
    });

    assert.deepEqual(
      sortedCandidates.map((p) => p.id),
      ["brave", "gemini", "grok", "antigravity-search", "kimi", "perplexity"],
      "antigravity-search must sort immediately after Grok and before Kimi in auto-detection"
    );

    // 3. Readiness / isConfigured verification
    // A. Not signed in (empty auth store, no profile) -> not ready / not eligible
    assert.equal(searchProvider.isConfigured?.(), false);

    // B. Signed in via authStore -> ready
    const signedInAuthStore = new InMemoryAuthProfileStore();
    await signedInAuthStore.setSecret("antigravity", {
      accessToken: "ya29.valid_test_token",
      refreshToken: "1//valid_refresh_token",
      expiresAt: Date.now() + 3600_000,
      projectId: "test-grounding-proj"
    });
    const readySearchProvider = buildAntigravityWebSearchProvider({
      defaultAuthStore: signedInAuthStore
    });
    assert.equal(readySearchProvider.isConfigured?.(), true);

    // C. ModelAuth host runtime integration (readOnly: true, allowKeychainPrompt: false)
    const mockModelAuth: ModelAuthRuntime = {
      ensureAuthProfileStore: () => ({}),
      listProfilesForProvider: (_store, providerId) => {
        if (providerId === "antigravity") {
          return [{ id: "antigravity:user@example.com", type: "oauth" }];
        }
        return [];
      },
      isProviderApiKeyConfigured: () => false
    };

    const searchProviderWithHostAuth = buildAntigravityWebSearchProvider({
      defaultAuthStore: emptyAuthStore,
      modelAuth: mockModelAuth
    });
    assert.equal(searchProviderWithHostAuth.isConfigured?.({ agentDir: "/test/agent/dir" }), true);

    // D. ModelAuth host runtime returning empty profiles -> not configured
    const mockEmptyModelAuth: ModelAuthRuntime = {
      ensureAuthProfileStore: () => ({}),
      listProfilesForProvider: () => [],
      isProviderApiKeyConfigured: () => false
    };
    const searchProviderUnconfigured = buildAntigravityWebSearchProvider({
      defaultAuthStore: emptyAuthStore,
      modelAuth: mockEmptyModelAuth
    });
    assert.equal(searchProviderUnconfigured.isConfigured?.({ agentDir: "/test/agent/dir" }), false);

    // 4. Configured credential getter & setter
    assert.equal(
      searchProvider.getConfiguredCredentialValue?.({
        plugins: {
          entries: {
            "openclaw-antigravity-oauth": {
              config: {
                webSearch: {
                  apiKey: "custom-configured-api-key"
                }
              }
            }
          }
        }
      }),
      "custom-configured-api-key"
    );
    assert.equal(searchProvider.getConfiguredCredentialValue?.({}), undefined);

    const configTarget: Record<string, unknown> = {};
    searchProvider.setConfiguredCredentialValue?.(configTarget, "persisted-key-999");
    assert.equal(
      (configTarget as any)?.plugins?.entries?.["openclaw-antigravity-oauth"]?.config?.webSearch?.apiKey,
      "persisted-key-999"
    );

    // Scoped credential getter & setter
    assert.equal(
      searchProvider.getCredentialValue({
        "antigravity-search": { apiKey: "scoped-key-1" }
      }),
      "scoped-key-1"
    );
    const searchConfigTarget: Record<string, unknown> = {};
    searchProvider.setCredentialValue(searchConfigTarget, "scoped-key-2");
    assert.equal((searchConfigTarget as any)?.["antigravity-search"]?.apiKey, "scoped-key-2");

    // 5. Fallback execution simulation matching OpenClaw runtime semantics
    // Simulate candidate chain [grok, antigravity-search] where Grok fails and search falls back
    let antigravityCalled = false;
    const mockFetch: FetchLike = async (_input, _init) => {
      antigravityCalled = true;
      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [{ text: "Antigravity search fallback successful answer." }]
                },
                groundingMetadata: {
                  webSearchQueries: ["fallback search test"],
                  groundingChunks: [
                    {
                      web: {
                        uri: "https://example.com/fallback-result",
                        title: "Fallback Result Page"
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      ]);
    };

    const fallbackAntigravityProvider = buildAntigravityWebSearchProvider({
      defaultAuthStore: signedInAuthStore,
      fetchFn: mockFetch
    });

    // Simulated Grok failure (e.g. rate limit HTTP 429 or missing API key)
    let grokAttempted = false;
    const mockGrokTool = {
      execute: async () => {
        grokAttempted = true;
        throw new Error("Grok search upstream HTTP 429: Rate limit exceeded");
      }
    };

    const candidateTools = [
      { id: "grok", tool: mockGrokTool },
      {
        id: "antigravity-search",
        tool: fallbackAntigravityProvider.createTool({ authStore: signedInAuthStore })
      }
    ];

    // OpenClaw's executeWebSearchCandidates loop:
    let searchResultPayload: unknown;
    for (const candidate of candidateTools) {
      try {
        const result = await candidate.tool.execute({ query: "fallback search test" });
        searchResultPayload = { provider: candidate.id, result };
        break;
      } catch {
        // Continue to fallback
      }
    }

    assert.equal(grokAttempted, true, "First candidate Grok must be attempted");
    assert.equal(
      antigravityCalled,
      true,
      "Fallback candidate antigravity-search must be invoked after Grok failure"
    );
    assert.ok(searchResultPayload);
    assert.equal((searchResultPayload as any).provider, "antigravity-search");
    const result = (searchResultPayload as any).result;
    assert.equal(result.provider, "antigravity-search");
    assert.match(result.content, /Antigravity search fallback successful answer/);
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].url, "https://example.com/fallback-result");
  });

  it("48. Upstream Variable Sync & Integration Smoke: hermetic verification of sync verdicts, fingerprint diffs, secret sanitization, and smoke result classification", async () => {
    const { pathToFileURL } = await import("node:url");
    const syncScriptUrl = pathToFileURL(path.resolve("scripts/sync-upstream-vars.js")).href;
    const smokeScriptUrl = pathToFileURL(path.resolve("scripts/integration-smoke.js")).href;

    const {
      VERDICT,
      analyzeBinary,
      applySafeUpdate,
      compareSemver,
      createMockMachOBinary,
      evaluateFingerprints,
      extractAgyFingerprint,
      extractCliVersion,
      extractModels,
      extractSubcommands,
      extractLatestChangelog,
      parseMachOSegments,
      parseSemver,
      readConstantsConfig,
      resolveAgyBinary,
      resolveNpmBinary
    } = await import(syncScriptUrl);

    const {
      classifySmokeResult,
      evaluateCatalog,
      evaluateImageDescribe,
      evaluateImageGeneration,
      evaluatePongTurn,
      evaluateSearch,
      evaluateToolRoundTrip,
      evaluateUsage,
      loadStoredAntigravityProfile,
      sanitizeError
    } = await import(smokeScriptUrl);

    // 1. Helper parsing functions
    assert.equal(extractCliVersion("1.4.12\n"), "1.4.12");
    assert.equal(extractCliVersion("v1.5.0-beta.1"), "1.5.0-beta.1");

    const sampleHelp = `
Usage of agy:
  --agent   Agent for session
Available subcommands:
  agent     Manage agents
  changelog Release notes
  models    List models
  update    Update CLI
`;
    const subcmds = extractSubcommands(sampleHelp);
    assert.deepEqual(subcmds, ["agent", "changelog", "models", "update"]);

    const sampleModels = `
Fetching available models...
gemini-4-argon-medium\tGemini 4 Argon
gemini-3.8-flash-high\tGemini 3.8 Flash
# commented model
claude-opus-5-5-high\tClaude Opus 5.5
`;
    const parsedModels = extractModels(sampleModels);
    assert.deepEqual(parsedModels, ["claude-opus-5-5-high", "gemini-3.8-flash-high", "gemini-4-argon-medium"]);

    const sampleChangelog = `
1.4.12:
· Added optional API key flag
· Fixed table formatting

1.4.11:
· Previous release notes
`;
    const latestEntry = extractLatestChangelog(sampleChangelog);
    assert.ok(latestEntry.startsWith("1.4.12:"));
    assert.ok(!latestEntry.includes("1.4.11:"));

    // 2. Hermetic fake agy fixture
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fixture-"));
    try {
      const fakeBinPath = path.join(tmpDir, "fake-agy");
      // Create a script that is also a valid binary text blob containing mock strings
      const fakeBinContent = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "1.4.12"
  exit 0
elif [ "$1" = "--help" ]; then
  echo "Available subcommands:\n  agent\n  changelog\n  models\n  update" >&2
  exit 0
elif [ "$1" = "changelog" ]; then
  echo "1.4.12:\n· Safe bump notes\n\n1.4.11:\n· Old notes"
  exit 0
elif [ "$1" = "models" ]; then
  echo "gemini-3.8-flash\ngemini-4-argon"
  exit 0
fi
exit 0
# MOCK_BINARY_DATA:
# v1internal:loadCodeAssist
# v1internal:fetchAvailableModels
# v1internal:streamGenerateContent
# https://daily-cloudcode-pa.googleapis.com
# https://oauth2.googleapis.com
# 1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com
# GOCSPX-MOCK-SECRET
# https://www.googleapis.com/auth/cloud-platform
# https://www.googleapis.com/auth/userinfo.email
# ideType platform pluginType ANTIGRAVITY VSCODE LINUX MACOS WINDOWS x-goog-user-project
`;
      fs.writeFileSync(fakeBinPath, fakeBinContent, { mode: 0o755 });

      // Test resolveAgyBinary with explicit path
      const resolved = resolveAgyBinary(fakeBinPath);
      assert.equal(resolved, fakeBinPath);

      // Non-Mach-O binary buffer fails loudly (exit 30 condition)
      assert.throws(() => {
        parseMachOSegments(Buffer.from("#!/bin/sh\necho 1.4.12"));
      }, /Unable to parse Mach-O header/i);

      assert.throws(() => {
        extractAgyFingerprint(fakeBinPath);
      }, /Unsupported agy binary format/i);

      // Extract fingerprint using valid mock Mach-O binary buffer
      const testConstants = readConstantsConfig();
      const mockMachOBinary = createMockMachOBinary({
        clientId: testConstants.clientId,
        clientSecret: testConstants.clientSecret
      });
      const fixtureFingerprint = extractAgyFingerprint(fakeBinPath, { binaryBuffer: mockMachOBinary });
      assert.equal(fixtureFingerprint.cliVersion, "1.4.12");

      // Stable fingerprint: extracting twice from the same binary produces identical output
      const fixtureFingerprint2 = extractAgyFingerprint(fakeBinPath, { binaryBuffer: mockMachOBinary });
      assert.deepEqual(fixtureFingerprint, fixtureFingerprint2, "Fingerprint extraction must be completely deterministic and stable");

      // Verify rpcNames and googleHosts are split into used and other
      assert.ok(Array.isArray(fixtureFingerprint.rpcNames.used));
      assert.ok(Array.isArray(fixtureFingerprint.rpcNames.other));
      assert.ok(fixtureFingerprint.rpcNames.used.includes("v1internal:loadCodeAssist"));
      assert.ok(Array.isArray(fixtureFingerprint.googleHosts.used));
      assert.ok(Array.isArray(fixtureFingerprint.googleHosts.other));
      assert.ok(fixtureFingerprint.googleHosts.used.includes("daily-cloudcode-pa.googleapis.com"));

      assert.ok(fixtureFingerprint.oauthClientPrefixes.includes("1071006060591"));
      assert.equal(fixtureFingerprint.consumerClientParity.matchesClientId, true);
      assert.equal(fixtureFingerprint.consumerClientParity.matchesClientSecret, true);
      assert.ok(fixtureFingerprint.oauthScopes.includes("https://www.googleapis.com/auth/cloud-platform"));

      // 3. Verdict 0: No change
      const res0 = evaluateFingerprints(fixtureFingerprint, fixtureFingerprint);
      assert.equal(res0.verdict, VERDICT.NO_CHANGE);
      assert.equal(res0.changedFields.length, 0);

      // 4. Verdict 10: Safe update (cliVersion, latestChangelog, or non-plugin rpc/hosts changed)
      const safeNewFingerprint = {
        ...fixtureFingerprint,
        cliVersion: "1.4.13",
        binarySha256: "deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd",
        latestChangelog: "1.4.13:\n· Bump minor fixes",
        rpcNames: {
          used: [...fixtureFingerprint.rpcNames.used],
          other: [...fixtureFingerprint.rpcNames.other, "v1internal:newUnusedMethod"].sort()
        },
        googleHosts: {
          used: [...fixtureFingerprint.googleHosts.used],
          other: [...fixtureFingerprint.googleHosts.other, "unused.googleapis.com"].sort()
        }
      };
      const res10 = evaluateFingerprints(fixtureFingerprint, safeNewFingerprint);
      assert.equal(res10.verdict, VERDICT.SAFE);
      assert.ok(res10.changedFields.includes("cliVersion"));
      assert.equal(res10.changedFields.includes("binarySha256"), false);
      assert.ok(res10.changedFields.includes("latestChangelog"));
      assert.ok(res10.changedFields.includes("rpcNames"));
      assert.ok(res10.changedFields.includes("googleHosts"));

      // 5. Verdict 20: Protocol method change in used-by-plugin RPC
      const rpcChangedFingerprint = {
        ...fixtureFingerprint,
        rpcNames: {
          ...fixtureFingerprint.rpcNames,
          used: fixtureFingerprint.rpcNames.used.filter((r: string) => r !== "v1internal:loadCodeAssist")
        }
      };
      const res20Rpc = evaluateFingerprints(fixtureFingerprint, rpcChangedFingerprint);
      assert.equal(res20Rpc.verdict, VERDICT.REVIEW_NEEDED);
      assert.ok(res20Rpc.changedFields.includes("rpcNames"));

      // 6. Verdict 20: Scope or OAuth client change
      const scopeChangedFingerprint = {
        ...fixtureFingerprint,
        oauthScopes: [...fixtureFingerprint.oauthScopes, "https://www.googleapis.com/auth/new_scope"].sort()
      };
      const res20Scope = evaluateFingerprints(fixtureFingerprint, scopeChangedFingerprint);
      assert.equal(res20Scope.verdict, VERDICT.REVIEW_NEEDED);
      assert.ok(res20Scope.changedFields.includes("oauthScopes"));

      // 7. Secret never appears in output or JSON (only sha256)
      const secret = testConstants.clientSecret;
      const jsonDump = JSON.stringify(fixtureFingerprint);
      assert.equal(jsonDump.includes(secret), false, "Raw client secret must never appear in fingerprint JSON");
      assert.ok(
        fixtureFingerprint.consumerClientParity.secretSha256.length === 64,
        "Secret must only be represented as sha256 hash"
      );

      // 8. Missing agy binary -> throws / error
      assert.throws(() => {
        resolveAgyBinary("/non/existent/agy/path");
      }, /not found/i);

      // 9. Missing constants fields -> throws with code/error (no silent fallback)
      const fakeConstantsEmpty = path.join(tmpDir, "constants-empty.ts");
      fs.writeFileSync(fakeConstantsEmpty, "// empty constants file");
      assert.throws(() => {
        readConstantsConfig(fakeConstantsEmpty);
      }, /CLI_VERSION constant missing/i);

      // 10. Semver comparison (behind / equal / ahead)
      assert.equal(compareSemver("1.4.12", "1.4.13"), -1);
      assert.equal(compareSemver("1.4.12", "1.4.12"), 0);
      assert.equal(compareSemver("1.4.13", "1.4.12"), 1);
      assert.equal(compareSemver("1.4.12-beta.1", "1.4.12"), -1);

      // 11. Apply failure propagation: fake npm that fails on 'check'
      const fakeConstantsPath = path.join(tmpDir, "constants.ts");
      fs.writeFileSync(
        fakeConstantsPath,
        `export const CLI_VERSION = "1.4.12" as const;\nexport const clientId = "1071006060591-test.apps.googleusercontent.com";\nexport const clientSecret = "GOCSPX-test";\n`
      );
      const fakeFingerprintPath = path.join(tmpDir, "agy-fingerprint.json");
      const fakeNpmPath = path.join(tmpDir, "fake-npm");
      const fakeNpmContent = `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "check" ]; then
  echo "Type error in src/catalog.ts line 42: invalid syntax" >&2
  exit 1
fi
exit 0
`;
      fs.writeFileSync(fakeNpmPath, fakeNpmContent, { mode: 0o755 });

      let applyError: any = null;
      try {
        applySafeUpdate("1.4.13", safeNewFingerprint, {
          customNpmPath: fakeNpmPath,
          customConstantsPath: fakeConstantsPath,
          customFingerprintPath: fakeFingerprintPath
        });
      } catch (err: any) {
        applyError = err;
      }
      assert.ok(applyError, "applySafeUpdate must throw on verification failure");
      assert.equal(applyError.failingStep, "check");
      assert.ok(applyError.tailOutput.includes("Type error in src/catalog.ts"));
      assert.ok(Array.isArray(applyError.stepResults));
      const failingRecord = applyError.stepResults.find((s: any) => s.step === "check");
      assert.ok(failingRecord);
      assert.equal(failingRecord.status, 1);
      assert.ok(failingRecord.tailOutput.includes("Type error"));

      // 12. SQLite auth store schema mismatch fails loudly
      const mockOpenclawDir = path.join(tmpDir, "mock-openclaw");
      const mockStateDir = path.join(mockOpenclawDir, "state");
      fs.mkdirSync(mockStateDir, { recursive: true });
      const badDbPath = path.join(mockStateDir, "openclaw.sqlite");

      // Create SQLite DB with wrong column name
      const { DatabaseSync } = await import("node:sqlite");
      const badDb = new DatabaseSync(badDbPath);
      badDb.exec("CREATE TABLE config_machine_state (wrong_key TEXT PRIMARY KEY, wrong_val TEXT);");
      badDb.close();

      await assert.rejects(async () => {
        await loadStoredAntigravityProfile("main", { openclawDir: mockOpenclawDir });
      }, /SQLite schema mismatch/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // 13. Smoke result classifier & checks
    assert.deepEqual(classifySmokeResult(null), { status: "pass" });

    // Quota exhausted (429 / resource exhausted) -> skipped with reset time
    const quota429 = new Error(
      "Subscription quota exceeded (429): RESOURCE_EXHAUSTED: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 113h44m36s."
    );
    const quotaClassified = classifySmokeResult(quota429);
    assert.equal(quotaClassified.status, "skipped");
    assert.equal(quotaClassified.reason, "quota_exhausted");
    assert.equal(quotaClassified.resetTime, "113h44m36s");

    // Model 404 / unknown model is a fail, not a quota skip
    const model404 = Object.assign(new Error("unknown model: gemini-4-argon (HTTP 404 NOT_FOUND: Requested entity was not found.)"), {
      status: 404
    });
    const model404Classified = classifySmokeResult(model404);
    assert.equal(model404Classified.status, "fail");
    assert.match(String(model404Classified.error), /unknown model/);

    // Other error -> fail with sanitized summary
    const internalErr = new Error("HTTP 500: Internal server error on connection");
    const failClassified = classifySmokeResult(internalErr);
    assert.equal(failClassified.status, "fail");
    assert.equal(failClassified.error, "HTTP 500: Internal server error on connection");

    // Smoke test behavior verification (exercising exported pure evaluation functions directly):
    // (a) If tool is not called by model, status is fail; if called, status is pass
    const toolNotCalledResult = evaluateToolRoundTrip(
      "gemini-3.8-flash",
      { text: "Here is your ticket info" },
      null
    );
    assert.equal(toolNotCalledResult.status, "fail");
    assert.ok(toolNotCalledResult.details.includes("without calling tool"));

    const toolCalledResult = evaluateToolRoundTrip(
      "gemini-3.8-flash",
      { toolCalls: [{ id: "call_1", name: "jira:get_ticket", args: { ticketId: "PROJ-99" } }] },
      { text: "Ticket is resolved" }
    );
    assert.equal(toolCalledResult.status, "pass");
    assert.ok(toolCalledResult.details.includes("Mapped call 'jira:get_ticket'"));

    // (b) If search returns 0 citations, status is fail; with citations, status is pass
    const searchNoCitationsResult = evaluateSearch({ citations: [] });
    assert.equal(searchNoCitationsResult.status, "fail");
    assert.ok(searchNoCitationsResult.details.includes("0 citations"));

    const searchWithCitationsResult = evaluateSearch({
      citations: [{ uri: "https://deepmind.google/news" }]
    });
    assert.equal(searchWithCitationsResult.status, "pass");
    assert.ok(searchWithCitationsResult.details.includes("1 citations"));

    // (c) Usage window evaluation: < 5 buckets fails, >= 5 passes
    const usageUnderResult = evaluateUsage({ buckets: [{ bucketId: "1" }, { bucketId: "2" }] });
    assert.equal(usageUnderResult.status, "fail");
    assert.ok(usageUnderResult.details.includes("Expected 5 quota windows, but found 2"));

    const usagePassResult = evaluateUsage({
      buckets: [
        { bucketId: "1" },
        { bucketId: "2" },
        { bucketId: "3" },
        { bucketId: "4" },
        { bucketId: "5" }
      ]
    });
    assert.equal(usagePassResult.status, "pass");
    assert.ok(usagePassResult.details.includes("Found 5 quota windows"));

    // Sanitization check
    const sensitiveErr = "Failed request for Bearer ya29.SECRET_TOKEN_HERE and user test@example.com on projects/123456789";
    const sanitized = sanitizeError(sensitiveErr);
    assert.ok(!sanitized.includes("SECRET_TOKEN_HERE"));
    assert.ok(!sanitized.includes("test@example.com"));
    assert.ok(!sanitized.includes("projects/123456789"));
    assert.ok(sanitized.includes("[REDACTED_TOKEN]"));
    assert.ok(sanitized.includes("[REDACTED_EMAIL]"));
  });
});


describe("plugin stream must own antigravity turns (host 2026.10.10)", () => {
  /**
   * Host-shaped fake of OpenClaw 2026.10.10 registerProviderStreamForModel /
   * resolveProviderStreamFn. Lookup uses a "loaded" registry only (activate:false);
   * missing createStreamFn falls back to the OpenAI client, whose URL builder
   * inserts /chat/completions before the query string.
   */
  function openaiSdkBuildURL(baseUrl: string, path: string): string {
    const url = new URL(baseUrl);
    const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    const suffix = path.startsWith("/") ? path : `/${path}`;
    url.pathname = `${basePath}${suffix}`;
    return url.toString();
  }

  type OpenAiCompletionsClient = {
    chat: { completions: { create: (args: { url: string }) => unknown } };
  };

  function registerProviderStreamForModel(params: {
    model: { id: string; provider: string; api?: string; baseUrl?: string };
    loadedProviders: Map<string, OpenClawProviderRegistration>;
    client?: OpenAiCompletionsClient;
  }): {
    streamFn: ((...args: any[]) => unknown) | undefined;
    transport: "plugin" | "openai-fallback";
    fallbackRequestUrl?: string;
  } {
    const plugin = params.loadedProviders.get(params.model.provider);
    const streamFn = plugin?.createStreamFn?.({ model: params.model }) as
      | ((...args: any[]) => unknown)
      | undefined;
    if (streamFn) {
      return { streamFn, transport: "plugin" };
    }
    const baseUrl = params.model.baseUrl ?? DEFAULT_ENDPOINTS.chatCompletionsUrl;
    const fallbackRequestUrl = openaiSdkBuildURL(baseUrl, "/chat/completions");
    const client = params.client;
    return {
      streamFn: client
        ? () => client.chat.completions.create({ url: fallbackRequestUrl })
        : undefined,
      transport: "openai-fallback",
      fallbackRequestUrl
    };
  }

  function createTrackingOpenAiClient(): {
    client: OpenAiCompletionsClient;
    wasCreateCalled: () => boolean;
  } {
    let called = false;
    return {
      client: {
        chat: {
          completions: {
            create: (args: { url: string }) => {
              called = true;
              return args;
            }
          }
        }
      },
      wasCreateCalled: () => called
    };
  }

  const CORE_BUILT_IN_MODEL_APIS = new Set([
    "anthropic-messages",
    "azure-openai-responses",
    "google-generative-ai",
    "google-interactions",
    "google-vertex",
    "mistral-conversations",
    "openai-chatgpt-responses",
    "openai-completions",
    "openai-responses"
  ]);

  // Host 2026.10.10: configuredModelProviderNeedsRuntimePlugin is false for core
  // built-in APIs, so config alone does not load the plugin. Startup selection
  // keys on activation.onStartup === true (shouldConsiderForGatewayStartup).
  function hostWouldLoadPluginAtStartup(params: {
    onStartup: boolean | undefined;
    catalogApi: string;
  }): boolean {
    const configForcesRuntimePlugin = !CORE_BUILT_IN_MODEL_APIS.has(params.catalogApi);
    return params.onStartup === true || configForcesRuntimePlugin;
  }

  it("reproduces host bypass: loaded registry without plugin → OpenAI fallback doubles the path and calls client.chat.completions.create", () => {
    const { client, wasCreateCalled } = createTrackingOpenAiClient();
    const emptyLoaded = new Map<string, OpenClawProviderRegistration>();
    const resolved = registerProviderStreamForModel({
      model: {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "openai-completions",
        baseUrl: DEFAULT_ENDPOINTS.chatCompletionsUrl
      },
      loadedProviders: emptyLoaded,
      client
    });
    assert.equal(resolved.transport, "openai-fallback");
    assert.equal(
      resolved.fallbackRequestUrl,
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent/chat/completions?alt=sse"
    );
    assert.equal(typeof resolved.streamFn, "function");
    resolved.streamFn!();
    assert.equal(wasCreateCalled(), true, "fallback must call client.chat.completions.create");
  });

  it("when register() has run, createStreamFn and wrapSimpleCompletionStreamFn are on the loaded provider", () => {
    let registered: OpenClawProviderRegistration | undefined;
    antigravityPlugin.register({
      registerProvider(p) {
        registered = p;
      }
    });
    assert.ok(registered);
    assert.equal(typeof registered.createStreamFn, "function");
    assert.equal(typeof registered.wrapSimpleCompletionStreamFn, "function");
    // activate is an alias of register (same function); definePluginEntry keeps both.
    assert.equal(antigravityPlugin.activate, antigravityPlugin.register);

    const loaded = new Map<string, OpenClawProviderRegistration>([["antigravity", registered]]);
    const resolved = registerProviderStreamForModel({
      model: {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: "openai-completions",
        baseUrl: DEFAULT_ENDPOINTS.chatCompletionsUrl
      },
      loadedProviders: loaded
    });
    assert.equal(resolved.transport, "plugin");
    assert.equal(typeof resolved.streamFn, "function");
  });

  it("chat turn and utility completion POST exactly chatCompletionsUrl and never client.chat.completions.create", async () => {
    const requestUrls: string[] = [];
    const { client, wasCreateCalled } = createTrackingOpenAiClient();

    const mockFetch: FetchLike = async (input) => {
      const urlStr = String(input);
      requestUrls.push(urlStr);
      if (urlStr.includes(":fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              displayName: "Gemini 3.8 Flash",
              supportsImages: true,
              supportsThinking: true,
              maxTokens: 65536
            },
            "gemini-3-flash": {
              displayName: "Gemini 3 Flash",
              supportsImages: true,
              supportsThinking: true,
              maxTokens: 65536
            }
          }
        });
      }
      if (urlStr.includes(":streamGenerateContent")) {
        return sseResponse([
          {
            response: {
              candidates: [{ content: { parts: [{ text: "pong" }] } }]
            }
          }
        ]);
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    };

    const { provider } = createAntigravityProvider({ fetchImpl: mockFetch });
    const loaded = new Map<string, OpenClawProviderRegistration>([["antigravity", provider]]);

    async function runThroughHostShapedStream(
      modelId: string,
      kind: "chat" | "utility"
    ): Promise<void> {
      const model = {
        id: modelId,
        provider: "antigravity" as const,
        api: "openai-completions" as const,
        baseUrl: DEFAULT_ENDPOINTS.chatCompletionsUrl
      };
      const resolved = registerProviderStreamForModel({
        model,
        loadedProviders: loaded,
        client
      });
      assert.equal(resolved.transport, "plugin", `${kind} must use plugin transport`);
      assert.ok(resolved.streamFn);

      // Utility completions go through wrapSimpleCompletionStreamFn → createStreamFn.
      const streamFactory =
        kind === "utility"
          ? (provider.wrapSimpleCompletionStreamFn?.({ model }) as typeof resolved.streamFn)
          : resolved.streamFn;
      assert.equal(typeof streamFactory, "function");

      const stream = streamFactory!(
        model,
        { messages: [{ role: "user", content: kind === "utility" ? "title this" : "ping" }] },
        { apiKey: JSON.stringify({ token: "test-stream-token", projectId: "test-proj" }) }
      ) as AsyncIterable<Record<string, unknown>>;

      const events: Array<Record<string, unknown>> = [];
      for await (const ev of stream) {
        events.push(ev);
      }
      assert.ok(
        events.some((e) => e.type === "text_delta" || e.type === "text_end" || e.type === "done"),
        `${kind} must produce stream events`
      );
      assert.equal(wasCreateCalled(), false, "plugin path must not call client.chat.completions.create");
    }

    await runThroughHostShapedStream("gemini-3.8-flash", "chat");
    await runThroughHostShapedStream("gemini-3-flash", "utility");

    const turnUrls = requestUrls.filter((u) => u.includes(":streamGenerateContent"));
    assert.ok(turnUrls.length >= 2, "expected chat + utility stream requests");
    for (const u of turnUrls) {
      assert.equal(u, DEFAULT_ENDPOINTS.chatCompletionsUrl, `request URL must be exact chatCompletionsUrl, got ${u}`);
      assert.equal(u.includes("/chat/completions"), false, "must not double the path");
    }
    assert.equal(wasCreateCalled(), false);
  });

  it("host startup selection from the real manifest puts the plugin in the stream lookup registry", async () => {
    const manifest = JSON.parse(
      await fs.promises.readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf-8")
    ) as {
      activation?: { onStartup?: boolean };
      autoEnableWhenConfiguredProviders?: string[];
    };
    const catalogApi = "openai-completions";

    assert.equal(
      hostWouldLoadPluginAtStartup({ onStartup: false, catalogApi }),
      false,
      "with onStartup false, a core built-in api does not enter the active registry"
    );
    assert.equal(
      hostWouldLoadPluginAtStartup({ onStartup: manifest.activation?.onStartup, catalogApi }),
      true,
      "real manifest must opt into startup so the plugin is in the active registry"
    );
    assert.deepEqual(manifest.autoEnableWhenConfiguredProviders, ["antigravity"]);

    const loadedProviders = new Map<string, OpenClawProviderRegistration>();
    if (
      hostWouldLoadPluginAtStartup({
        onStartup: manifest.activation?.onStartup,
        catalogApi
      })
    ) {
      antigravityPlugin.register({
        registerProvider(p) {
          loadedProviders.set(p.id, p);
        }
      });
    }

    const { client, wasCreateCalled } = createTrackingOpenAiClient();
    const resolved = registerProviderStreamForModel({
      model: {
        id: "gemini-3.8-flash",
        provider: "antigravity",
        api: catalogApi,
        baseUrl: DEFAULT_ENDPOINTS.chatCompletionsUrl
      },
      loadedProviders,
      client
    });
    assert.ok(loadedProviders.has("antigravity"), "startup-selected plugin must be in the stream lookup registry");
    assert.equal(resolved.transport, "plugin");
    assert.equal(typeof resolved.streamFn, "function");
    assert.equal(wasCreateCalled(), false);
  });
});

describe("show model reasoning", () => {
  it("thought: true parts stream as thinking events and never as answer text", async () => {
    const thoughtText = "I should add 40 and 2.";
    const answerText = "The answer is 42.";
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.reasoning_test_token",
      refreshToken: "1//reasoning_test_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              displayName: "Gemini 3.8 Flash",
              supportsImages: true,
              supportsThinking: true,
              maxTokens: 65536
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        return sseResponse([
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ thought: true, text: thoughtText }]
                  }
                }
              ]
            }
          },
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: answerText }]
                  }
                }
              ]
            }
          }
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const streamFn = provider.createStreamFn();
    const stream = streamFn(
      {
        id: "gemini-3.8-flash",
        api: "openai-completions",
        provider: "antigravity"
      },
      {
        messages: [{ role: "user", content: "What is 40+2?" }]
      },
      {
        apiKey: JSON.stringify({
          token: "ya29.reasoning_test_token",
          projectId: "default-cli-project"
        })
      }
    ) as AsyncIterable<Record<string, unknown>>;

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    const thinkingDeltas = events
      .filter((e) => e.type === "thinking_delta")
      .map((e) => e.delta as string);
    const textDeltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.delta as string);
    assert.deepEqual(thinkingDeltas, [thoughtText]);
    assert.deepEqual(textDeltas, [answerText]);
    assert.equal(
      textDeltas.join("").includes(thoughtText),
      false,
      "thought text must not appear in text_delta events"
    );
    assert.ok(events.some((e) => e.type === "thinking_start"));
    assert.ok(events.some((e) => e.type === "thinking_end"));
    const thinkingEnd = events.find((e) => e.type === "thinking_end");
    assert.equal(thinkingEnd?.content, thoughtText);

    const done = events.find((e) => e.type === "done") as
      | { message?: { content?: Array<Record<string, unknown>> } }
      | undefined;
    const blocks = done?.message?.content ?? [];
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["thinking", "text"]
    );
    assert.equal(blocks[0]?.thinking, thoughtText);
    assert.equal(blocks[1]?.text, answerText);

    const reasoningChunks: string[] = [];
    const complete = await provider.completeTurn({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "What is 40+2?" }],
      onReasoningDelta: (delta) => {
        reasoningChunks.push(delta);
      }
    });
    assert.equal(complete.text, answerText);
    assert.equal(complete.text.includes(thoughtText), false);
    assert.deepEqual(reasoningChunks, [thoughtText]);
  });

  it("interleaved thought/text parts close and reopen blocks in order", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.reasoning_interleave_token",
      refreshToken: "1//reasoning_interleave_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              displayName: "Gemini 3.8 Flash",
              supportsImages: true,
              supportsThinking: true,
              maxTokens: 65536
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        return sseResponse([
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ thought: true, text: "think-1" }]
                  }
                }
              ]
            }
          },
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "say-1" }]
                  }
                }
              ]
            }
          },
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ thought: true, text: "think-2" }]
                  }
                }
              ]
            }
          },
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ text: "say-2" }]
                  }
                }
              ]
            }
          }
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const streamFn = provider.createStreamFn();
    const stream = streamFn(
      {
        id: "gemini-3.8-flash",
        api: "openai-completions",
        provider: "antigravity"
      },
      {
        messages: [{ role: "user", content: "interleave?" }]
      },
      {
        apiKey: JSON.stringify({
          token: "ya29.reasoning_interleave_token",
          projectId: "default-cli-project"
        })
      }
    ) as AsyncIterable<Record<string, unknown>>;

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    const blockEvents = events.filter((e) =>
      [
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "text_start",
        "text_delta",
        "text_end"
      ].includes(String(e.type))
    );

    assert.deepEqual(
      blockEvents.map((e) => ({
        type: e.type,
        contentIndex: e.contentIndex,
        ...(e.delta !== undefined ? { delta: e.delta } : {}),
        ...(e.content !== undefined ? { content: e.content } : {})
      })),
      [
        { type: "thinking_start", contentIndex: 0 },
        { type: "thinking_delta", contentIndex: 0, delta: "think-1" },
        { type: "thinking_end", contentIndex: 0, content: "think-1" },
        { type: "text_start", contentIndex: 1 },
        { type: "text_delta", contentIndex: 1, delta: "say-1" },
        { type: "text_end", contentIndex: 1, content: "say-1" },
        { type: "thinking_start", contentIndex: 2 },
        { type: "thinking_delta", contentIndex: 2, delta: "think-2" },
        { type: "thinking_end", contentIndex: 2, content: "think-2" },
        { type: "text_start", contentIndex: 3 },
        { type: "text_delta", contentIndex: 3, delta: "say-2" },
        { type: "text_end", contentIndex: 3, content: "say-2" }
      ]
    );

    const done = events.find((e) => e.type === "done") as
      | { message?: { content?: Array<Record<string, unknown>> } }
      | undefined;
    const blocks = done?.message?.content ?? [];
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["thinking", "text", "thinking", "text"]
    );
    assert.equal(blocks[0]?.thinking, "think-1");
    assert.equal(blocks[1]?.text, "say-1");
    assert.equal(blocks[2]?.thinking, "think-2");
    assert.equal(blocks[3]?.text, "say-2");
  });

  it("emits thinking_end when the stream errors mid-thought", async () => {
    const authStore = new InMemoryAuthProfileStore();
    await authStore.setSecret("antigravity", {
      accessToken: "ya29.reasoning_error_token",
      refreshToken: "1//reasoning_error_refresh",
      expiresAt: Date.now() + 3600_000,
      projectId: "default-cli-project"
    });

    const mockFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === DEFAULT_ENDPOINTS.modelsUrl) {
        return jsonResponse({
          models: {
            "gemini-3.8-flash-tiered": {
              displayName: "Gemini 3.8 Flash",
              supportsImages: true,
              supportsThinking: true,
              maxTokens: 65536
            }
          }
        });
      }
      if (url.includes(":streamGenerateContent")) {
        // Thought-only success stream leaves fullText empty, so executeTurn
        // throws after onReasoningDelta has already opened a thinking block.
        return sseResponse([
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [{ thought: true, text: "partial thought" }]
                  }
                }
              ]
            }
          }
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { provider } = createAntigravityProvider({
      fetchImpl: mockFetch,
      authStore
    });

    const streamFn = provider.createStreamFn();
    const stream = streamFn(
      {
        id: "gemini-3.8-flash",
        api: "openai-completions",
        provider: "antigravity"
      },
      {
        messages: [{ role: "user", content: "fail mid-thought" }]
      },
      {
        apiKey: JSON.stringify({
          token: "ya29.reasoning_error_token",
          projectId: "default-cli-project"
        })
      }
    ) as AsyncIterable<Record<string, unknown>>;

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of stream) {
      events.push(ev);
    }

    assert.ok(events.some((e) => e.type === "thinking_start"));
    assert.ok(events.some((e) => e.type === "thinking_delta"));
    const thinkingEnd = events.find((e) => e.type === "thinking_end");
    assert.ok(thinkingEnd, "thinking_end must be emitted on error mid-thought");
    assert.equal(thinkingEnd?.content, "partial thought");
    assert.ok(events.some((e) => e.type === "error"));
  });
});
