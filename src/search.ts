import { randomUUID } from "node:crypto";
import { isAntigravityConfigured, parseFormattedApiKey } from "./auth.js";
import {
  DEFAULT_ENDPOINTS,
  DEFAULT_PROJECT_ID,
  PLUGIN_ID,
  PROVIDER_ID,
  buildAntigravityHeaders
} from "./constants.js";
import { unwrapCandidates } from "./utils.js";
import type {
  AntigravityEndpoints,
  AntigravityWebSearchProvider,
  AuthProfileStore,
  BuildWebSearchProviderOptions,
  FetchLike,
  ModelAuthRuntime,
  WebSearchResultCitation,
  WebSearchResultPayload
} from "./types.js";

export const ANTIGRAVITY_SEARCH_PROVIDER_ID = "antigravity-search" as const;
export const ANTIGRAVITY_SEARCH_DEFAULT_MODEL = "gemini-3.8-flash";
export const ANTIGRAVITY_SEARCH_UPSTREAM_MODEL = "gemini-3.8-flash-tiered";
export const ANTIGRAVITY_SEARCH_AUTO_DETECT_ORDER = 35;
export const ANTIGRAVITY_SEARCH_CREDENTIAL_PATH =
  `plugins.entries.${PLUGIN_ID}.config.webSearch.apiKey`;

export const ANTIGRAVITY_SEARCH_TOOL_PARAMETERS = Object.freeze({
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query string."
    },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10
    },
    freshness: {
      type: "string",
      description: "Filter search freshness: day, week, month, year."
    },
    date_after: {
      type: "string",
      description: "Only ground with results published after this date (YYYY-MM-DD)."
    },
    date_before: {
      type: "string",
      description: "Only ground with results published before this date (YYYY-MM-DD)."
    },
    country: {
      type: "string",
      description: "Not supported by Google Search grounding."
    },
    language: {
      type: "string",
      description: "Not supported by Google Search grounding."
    }
  },
  required: ["query"]
});

export interface ExecuteSearchOptions {
  model?: string | undefined;
  apiKey?: string | undefined;
  auth?: { kind?: string | undefined; apiKey?: string | undefined } | undefined;
  authStore?: AuthProfileStore | undefined;
  endpoints?: Partial<AntigravityEndpoints> | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchLike | undefined;
  count?: number | undefined;
  freshness?: string | undefined;
  dateAfter?: string | undefined;
  dateBefore?: string | undefined;
  agentDir?: string | undefined;
  cfg?: unknown | undefined;
}

export async function executeAntigravitySearch(
  query: string,
  options: ExecuteSearchOptions = {}
): Promise<WebSearchResultPayload> {
  const endpoints: AntigravityEndpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
  const fetchImpl: FetchLike = options.fetchFn ?? fetch;

  let rawKey = options.auth?.apiKey ?? options.apiKey;
  if (!rawKey) {
    try {
      const { resolveApiKeyForProvider } = await import(
        "openclaw/plugin-sdk/provider-auth-runtime"
      );
      const resolved = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        agentDir: options.agentDir,
        cfg: options.cfg as any,
        signal: options.signal
      });
      if (resolved?.apiKey) {
        rawKey = resolved.apiKey;
      }
    } catch {
      // Ignore if host helper not resolvable
    }
  }

  if (!rawKey && options.authStore) {
    try {
      const secret = await options.authStore.getSecret(PROVIDER_ID);
      if (secret?.accessToken) {
        rawKey = JSON.stringify({
          token: secret.accessToken,
          projectId: secret.projectId || DEFAULT_PROJECT_ID
        });
      }
    } catch {
      // Ignore store read error; fall through to validation
    }
  }

  const parsedKey = parseFormattedApiKey(rawKey);
  if (!parsedKey || !parsedKey.token) {
    throw new Error(
      "Antigravity search requires active authentication. Please sign in with your Antigravity subscription."
    );
  }

  const accessToken = parsedKey.token;
  const projectId = parsedKey.projectId ?? DEFAULT_PROJECT_ID;

  let queryText = query.trim();
  if (!queryText) {
    throw new Error("Search query must not be empty");
  }

  const freshness = options.freshness?.toLowerCase();
  if (freshness === "day") {
    queryText +=
      "\n\nSearch recency instruction: Prioritize web sources published in the last 24 hours. If no matching recent sources are available, state that limitation and use the most relevant available sources.";
  } else if (freshness === "week") {
    queryText +=
      "\n\nSearch recency instruction: Prioritize web sources published in the past week.";
  } else if (freshness === "month") {
    queryText +=
      "\n\nSearch recency instruction: Prioritize web sources published in the past month.";
  } else if (freshness === "year") {
    queryText +=
      "\n\nSearch recency instruction: Prioritize web sources published in the past year.";
  }

  if (options.dateAfter) {
    queryText += `\n\nOnly ground with sources published after ${options.dateAfter}.`;
  }
  if (options.dateBefore) {
    queryText += `\n\nOnly ground with sources published before ${options.dateBefore}.`;
  }

  const start = Date.now();
  const requestBody = {
    project: projectId,
    model: ANTIGRAVITY_SEARCH_UPSTREAM_MODEL,
    request: {
      contents: [
        {
          role: "user",
          parts: [{ text: queryText }]
        }
      ],
      tools: [{ googleSearch: {} }]
    },
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `search-${randomUUID()}`
  };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(
        new Error(`Antigravity search request timed out after ${options.timeoutMs}ms`)
      );
    }, options.timeoutMs);
  }

  const onAbort = () => {
    controller.abort(options.signal?.reason);
  };
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    const response = await fetchImpl(endpoints.chatCompletionsUrl, {
      method: "POST",
      headers: {
        ...buildAntigravityHeaders(accessToken),
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      let errorDetail = "";
      try {
        const errJson = (await response.json()) as {
          error?: { code?: number; message?: string; status?: string };
        };
        if (errJson?.error?.message) {
          errorDetail = `${errJson.error.status ?? "ERROR"}: ${errJson.error.message}`;
        }
      } catch {
        // Fallback for non-JSON error
      }
      if (!errorDetail) {
        errorDetail = response.statusText || `status ${response.status}`;
      }
      throw new Error(`Antigravity search failed with HTTP ${response.status} (${errorDetail})`);
    }

    let fullText = "";
    let groundingChunks: Array<{ web?: { uri?: string; title?: string } }> = [];
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

    if (contentType.includes("text/event-stream") && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) {
            continue;
          }
          const dataStr = trimmed.slice("data:".length).trim();
          if (!dataStr || dataStr === "[DONE]") {
            continue;
          }

          try {
            const chunk = JSON.parse(dataStr);
            const candidate = unwrapCandidates<{
              content?: { parts?: Array<{ text?: string }> };
              groundingMetadata?: {
                groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
              };
            }>(chunk)[0];
            if (candidate?.groundingMetadata?.groundingChunks) {
              groundingChunks = candidate.groundingMetadata.groundingChunks;
            }
            const candParts = candidate?.content?.parts;
            if (Array.isArray(candParts)) {
              for (const p of candParts) {
                if (typeof p.text === "string") {
                  fullText += p.text;
                }
              }
            }
          } catch {
            // Ignore SSE chunk parse errors
          }
        }
      }
    } else {
      const rawJson = await response.json();
      const candidate = unwrapCandidates<{
        content?: { parts?: Array<{ text?: string }> };
        groundingMetadata?: {
          groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        };
      }>(rawJson)[0];
      if (candidate?.groundingMetadata?.groundingChunks) {
        groundingChunks = candidate.groundingMetadata.groundingChunks;
      }
      const candParts = candidate?.content?.parts;
      if (Array.isArray(candParts)) {
        for (const p of candParts) {
          if (typeof p.text === "string") {
            fullText += p.text;
          }
        }
      }
    }

    const answer = fullText.trim();
    if (!answer) {
      throw new Error("Antigravity search returned no final answer.");
    }

    const rawCitations = (groundingChunks ?? []).flatMap((chunk) => {
      if (!chunk?.web?.uri) {
        return [];
      }
      return [
        {
          url: chunk.web.uri,
          title: chunk.web.title || undefined
        }
      ];
    });

    const maxCount =
      typeof options.count === "number" && options.count > 0 ? Math.min(options.count, 10) : 10;
    const slicedCitations = rawCitations.slice(0, maxCount);

    const citations: WebSearchResultCitation[] = [];
    try {
      const { resolveCitationRedirectUrl } = await import("openclaw/plugin-sdk/provider-web-search");
      for (let i = 0; i < slicedCitations.length; i += 5) {
        const batch = slicedCitations.slice(i, i + 5);
        const resolved = await Promise.all(
          batch.map(async (c) => ({
            url: await resolveCitationRedirectUrl(c.url),
            title: c.title
          }))
        );
        citations.push(...resolved);
      }
    } catch {
      citations.push(...slicedCitations.map((c) => ({ url: c.url, title: c.title })));
    }

    let formattedContent = answer;
    try {
      const { wrapWebContent } = await import("openclaw/plugin-sdk/provider-web-search");
      formattedContent = wrapWebContent(answer);
    } catch {
      // Fallback if SDK helper not imported
    }

    return {
      query,
      provider: ANTIGRAVITY_SEARCH_PROVIDER_ID,
      model: ANTIGRAVITY_SEARCH_DEFAULT_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: ANTIGRAVITY_SEARCH_PROVIDER_ID,
        wrapped: true
      },
      content: formattedContent,
      text: formattedContent,
      citations
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (options.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}

export function buildAntigravityWebSearchProvider(
  options: BuildWebSearchProviderOptions = {}
): AntigravityWebSearchProvider {
  return {
    id: ANTIGRAVITY_SEARCH_PROVIDER_ID,
    providerId: PROVIDER_ID,
    label: "Google Search (Antigravity)",
    hint: "Uses Antigravity subscription OAuth · Google Search grounding",
    authProviderId: PROVIDER_ID,
    requiresCredential: true,
    autoDetectOrder: ANTIGRAVITY_SEARCH_AUTO_DETECT_ORDER,
    envVars: [],
    placeholder: "No API key required (uses Antigravity subscription OAuth)",
    signupUrl: "https://cloud.google.com",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    credentialPath: ANTIGRAVITY_SEARCH_CREDENTIAL_PATH,
    inactiveSecretPaths: [ANTIGRAVITY_SEARCH_CREDENTIAL_PATH],
    credentialNote:
      "Uses your existing Antigravity OAuth sign-in. No separate API key is required.",
    parameters: ANTIGRAVITY_SEARCH_TOOL_PARAMETERS,
    getCredentialValue: (searchConfig?: Record<string, unknown>) => {
      const scoped =
        searchConfig?.[ANTIGRAVITY_SEARCH_PROVIDER_ID] ?? searchConfig?.[PROVIDER_ID];
      if (scoped && typeof scoped === "object") {
        return (scoped as Record<string, unknown>).apiKey;
      }
      return undefined;
    },
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) => {
      let scoped = searchConfigTarget[ANTIGRAVITY_SEARCH_PROVIDER_ID];
      if (!scoped || typeof scoped !== "object") {
        scoped = {};
        searchConfigTarget[ANTIGRAVITY_SEARCH_PROVIDER_ID] = scoped;
      }
      (scoped as Record<string, unknown>).apiKey = value;
    },
    getConfiguredCredentialValue: (config?: Record<string, unknown>) => {
      const pluginConfig = (config?.plugins as any)?.entries?.[PLUGIN_ID]?.config;
      if (pluginConfig && typeof pluginConfig === "object" && "webSearch" in pluginConfig) {
        const webSearch = pluginConfig.webSearch;
        if (webSearch && typeof webSearch === "object") {
          return webSearch.apiKey;
        }
      }
      return undefined;
    },
    setConfiguredCredentialValue: (configTarget: Record<string, unknown>, value: unknown) => {
      const plugins = ((configTarget.plugins as Record<string, unknown>) ??= {});
      const entries = ((plugins.entries as Record<string, unknown>) ??= {});
      const entry = ((entries[PLUGIN_ID] as Record<string, unknown>) ??= { enabled: true });
      const config = ((entry.config as Record<string, unknown>) ??= {});
      const webSearch = ((config.webSearch as Record<string, unknown>) ??= {});
      webSearch.apiKey = value;
    },
    isConfigured: (ctx?: { cfg?: unknown; agentDir?: string }) =>
      isAntigravityConfigured(ctx, options.defaultAuthStore, options.modelAuth),
    search: async (req) => {
      const apiKey = req.apiKey ?? req.auth?.apiKey;
      return await executeAntigravitySearch(req.query, {
        apiKey,
        agentDir: (req as any).agentDir ?? (req as any).ctx?.agentDir,
        cfg: (req as any).cfg ?? (req as any).ctx?.cfg,
        authStore: (req as any).authStore ?? options.defaultAuthStore,
        endpoints: options.endpoints,
        fetchFn: options.fetchFn,
        signal: req.signal,
        count: req.count,
        freshness: req.freshness,
        dateAfter: req.date_after,
        dateBefore: req.date_before
      });
    },

    createTool: (ctx) => ({
      description:
        "Search the web using Google Search grounding through your Antigravity subscription. Returns AI-synthesized answers with web source citations.",
      parameters: ANTIGRAVITY_SEARCH_TOOL_PARAMETERS,
      execute: async (args, executionContext) => {
        executionContext?.signal?.throwIfAborted();
        executionContext?.assertCurrent?.();

        if (args.country || args.language) {
          try {
            const { buildUnsupportedSearchFilterResponse } = await import(
              "openclaw/plugin-sdk/provider-web-search"
            );
            const unsupported = buildUnsupportedSearchFilterResponse(
              {
                country: typeof args.country === "string" ? args.country : undefined,
                language: typeof args.language === "string" ? args.language : undefined
              },
              ANTIGRAVITY_SEARCH_PROVIDER_ID
            );
            if (unsupported) {
              return unsupported;
            }
          } catch {
            // Ignore if helper is not present
          }
        }

        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) {
          throw new Error("Search query string is required");
        }

        const count = typeof args.count === "number" ? args.count : undefined;
        const freshness =
          typeof args.freshness === "string" ? args.freshness.trim().toLowerCase() : undefined;
        const dateAfter = typeof args.date_after === "string" ? args.date_after.trim() : undefined;
        const dateBefore =
          typeof args.date_before === "string" ? args.date_before.trim() : undefined;

        let cacheKey = "";
        let cacheTtlMs = 0;
        try {
          const { buildSearchCacheKey, readCachedSearchPayload, resolveSearchCacheTtlMs } =
            await import("openclaw/plugin-sdk/provider-web-search");
          cacheTtlMs = resolveSearchCacheTtlMs(ctx?.searchConfig);
          cacheKey = buildSearchCacheKey([
            ANTIGRAVITY_SEARCH_PROVIDER_ID,
            query,
            freshness,
            dateAfter,
            dateBefore
          ]);
          const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
          if (cached) {
            return cached as WebSearchResultPayload;
          }
        } catch {
          // Ignore cache read errors
        }

        let apiKey: string | undefined;
        try {
          const { resolveApiKeyForProvider } = await import(
            "openclaw/plugin-sdk/provider-auth-runtime"
          );
          const resolvedAuth = await resolveApiKeyForProvider({
            provider: PROVIDER_ID,
            agentDir: ctx?.agentDir,
            cfg: ctx?.config as any,
            signal: executionContext?.signal
          });
          apiKey = resolvedAuth?.apiKey;
        } catch {
          // Ignore if SDK runtime helper is unavailable
        }

        if (!apiKey && ((ctx as any)?.authStore ?? options.defaultAuthStore)) {
          const store = (ctx as any)?.authStore ?? options.defaultAuthStore;
          const secret = await store?.getSecret(PROVIDER_ID);
          if (secret?.accessToken) {
            apiKey = JSON.stringify({
              token: secret.accessToken,
              projectId: secret.projectId || DEFAULT_PROJECT_ID
            });
          }
        }

        const payload = await executeAntigravitySearch(query, {
          apiKey,
          agentDir: ctx?.agentDir,
          cfg: ctx?.config,
          authStore: (ctx as any)?.authStore ?? options.defaultAuthStore,
          endpoints: options?.endpoints,
          fetchFn: options?.fetchFn,
          signal: executionContext?.signal,
          count,
          freshness,
          dateAfter,
          dateBefore
        });

        if (cacheKey && cacheTtlMs > 0) {
          try {
            const { writeCachedSearchPayload } = await import(
              "openclaw/plugin-sdk/provider-web-search"
            );
            writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
          } catch {
            // Ignore cache write errors
          }
        }

        return payload;
      }
    })
  };
}
