import { isIP, BlockList } from "node:net";
import { isAntigravityConfigured, parseFormattedApiKey } from "./auth.js";
import {
  DEFAULT_ENDPOINTS,
  DEFAULT_PROJECT_ID,
  PLUGIN_ID,
  PROVIDER_ID,
  buildAntigravityQuotaHeaders
} from "./constants.js";
import type {
  AntigravityEndpoints,
  AntigravityWebFetchProvider,
  AuthProfileStore,
  BuildWebFetchProviderOptions,
  FetchLike,
  WebFetchResultPayload
} from "./types.js";

export const ANTIGRAVITY_FETCH_PROVIDER_ID = "antigravity-fetch" as const;
export const ANTIGRAVITY_FETCH_AUTO_DETECT_ORDER = 40;
export const ANTIGRAVITY_FETCH_CREDENTIAL_PATH =
  `plugins.entries.${PLUGIN_ID}.config.webFetch.apiKey`;
export const ANTIGRAVITY_FETCH_DEFAULT_MAX_CHARS = 20_000;
export const ANTIGRAVITY_FETCH_DEFAULT_TIMEOUT_MS = 15_000;
export const ANTIGRAVITY_FETCH_OPAQUE_ERROR =
  "page could not be fetched (upstream error, ~7 s timeout, or unsupported type such as PDF or images)";

export const ANTIGRAVITY_FETCH_TOOL_PARAMETERS = Object.freeze({
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "HTTP(S) URL."
    },
    extractMode: {
      type: "string",
      description: "Extract as markdown or text.",
      enum: ["markdown", "text"]
    },
    maxChars: {
      type: "integer",
      description: "Max chars returned; truncates.",
      minimum: 100
    }
  },
  required: ["url"]
});

const FORBIDDEN_V4 = new BlockList();
FORBIDDEN_V4.addSubnet("0.0.0.0", 8, "ipv4");
FORBIDDEN_V4.addSubnet("10.0.0.0", 8, "ipv4");
FORBIDDEN_V4.addSubnet("100.64.0.0", 10, "ipv4");
FORBIDDEN_V4.addSubnet("127.0.0.0", 8, "ipv4");
FORBIDDEN_V4.addSubnet("169.254.0.0", 16, "ipv4");
FORBIDDEN_V4.addSubnet("172.16.0.0", 12, "ipv4");
FORBIDDEN_V4.addSubnet("192.168.0.0", 16, "ipv4");

const FORBIDDEN_V6 = new BlockList();
FORBIDDEN_V6.addSubnet("::1", 128, "ipv6");
FORBIDDEN_V6.addSubnet("::", 128, "ipv6");
FORBIDDEN_V6.addSubnet("fe80::", 10, "ipv6");
FORBIDDEN_V6.addSubnet("fc00::", 7, "ipv6");
FORBIDDEN_V6.addSubnet("::ffff:0:0", 96, "ipv6");

export interface ExecuteFetchOptions {
  model?: string | undefined;
  apiKey?: string | undefined;
  auth?: { kind?: string | undefined; apiKey?: string | undefined } | undefined;
  authStore?: AuthProfileStore | undefined;
  endpoints?: Partial<AntigravityEndpoints> | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchLike | undefined;
  extractMode?: "markdown" | "text" | undefined;
  maxChars?: number | undefined;
  checkDenylist?: boolean | undefined;
  agentDir?: string | undefined;
  cfg?: unknown | undefined;
}

function v1internalUrl(endpoints: AntigravityEndpoints, rpc: string): string {
  return `${new URL(endpoints.modelsUrl).origin}/v1internal:${rpc}`;
}

export function fetchFromTrawlerCacheUrl(endpoints: AntigravityEndpoints = DEFAULT_ENDPOINTS): string {
  return v1internalUrl(endpoints, "fetchFromTrawlerCache");
}

export function checkUrlDenylistUrl(endpoints: AntigravityEndpoints = DEFAULT_ENDPOINTS): string {
  return v1internalUrl(endpoints, "checkUrlDenylist");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

export function htmlToReadable(
  html: string,
  mode: "markdown" | "text" = "markdown"
): { title?: string; text: string } {
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = rawTitle ? decodeEntities(stripTags(rawTitle)).replace(/\s+/g, " ").trim() : undefined;
  let s = html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ");
  if (mode === "markdown") {
    s = s
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
        return `\n${"#".repeat(Number(level))} ${decodeEntities(stripTags(inner)).trim()}\n`;
      })
      .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
        const label = decodeEntities(stripTags(inner)).trim() || href;
        return `[${label}](${href})`;
      })
      .replace(/<(strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/\1(?:\s[^>]*)?>/gi, (_m, _tag: string, inner: string) => {
        return `**${decodeEntities(stripTags(inner)).trim()}**`;
      })
      .replace(/<(em|i)(?:\s[^>]*)?>([\s\S]*?)<\/\1(?:\s[^>]*)?>/gi, (_m, _tag: string, inner: string) => {
        return `*${decodeEntities(stripTags(inner)).trim()}*`;
      })
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
        return `\`${decodeEntities(stripTags(inner)).trim()}\``;
      })
      .replace(/<li[^>]*>/gi, "\n- ");
  }
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|section|article|blockquote|figcaption|details|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(s)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return title ? { title, text } : { text };
}

export function sniffContentType(content: string): string | undefined {
  const head = content.trimStart().slice(0, 256);
  const lower = head.toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html") || /<html[\s>]/.test(lower)) {
    return "text/html";
  }
  if (head.startsWith("{") || head.startsWith("[")) {
    try {
      JSON.parse(content);
      return "application/json";
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function mappedIpv4(host: string): string | undefined {
  const match = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return match?.[1];
}

export function forbiddenFetchUrlReason(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Invalid URL: must be http or https";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Invalid URL: must be http or https";
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!host) {
    return "Invalid URL: missing hostname";
  }
  if (host === "localhost" || host === "localhost.localdomain" || host.endsWith(".localhost")) {
    return "Refusing loopback URL";
  }
  const kind = isIP(host);
  if (kind === 4 && FORBIDDEN_V4.check(host, "ipv4")) {
    return "Refusing private, loopback or link-local URL";
  }
  if (kind === 6) {
    const embedded = mappedIpv4(host);
    if (embedded && FORBIDDEN_V4.check(embedded, "ipv4")) {
      return "Refusing private, loopback or link-local URL";
    }
    if (FORBIDDEN_V6.check(host, "ipv6")) {
      return "Refusing private, loopback or link-local URL";
    }
  }
  return undefined;
}

async function resolveFetchApiKey(options: ExecuteFetchOptions): Promise<string | undefined> {
  let rawKey = options.auth?.apiKey ?? options.apiKey;
  if (!rawKey) {
    try {
      const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/provider-auth-runtime");
      const resolved = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        agentDir: options.agentDir,
        cfg: options.cfg as Record<string, unknown> | undefined,
        signal: options.signal
      });
      if (resolved?.apiKey) {
        rawKey = resolved.apiKey;
      }
    } catch {
      // Host helper not resolvable in a bare checkout
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
      // Fall through to validation
    }
  }
  return rawKey;
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ status: number; ok: boolean; json: unknown }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: buildAntigravityQuotaHeaders(accessToken),
    body: JSON.stringify(body),
    signal
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, json };
}

function contentFromTrawler(json: unknown): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const content = (json as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

export async function executeAntigravityFetch(
  url: string,
  options: ExecuteFetchOptions = {}
): Promise<WebFetchResultPayload> {
  const started = Date.now();
  options.signal?.throwIfAborted();
  const trimmed = url.trim();
  const blocked = forbiddenFetchUrlReason(trimmed);
  if (blocked) {
    throw new Error(blocked);
  }

  const endpoints: AntigravityEndpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
  const fetchImpl: FetchLike = options.fetchFn ?? fetch;
  const rawKey = await resolveFetchApiKey(options);
  const parsedKey = parseFormattedApiKey(rawKey);
  if (!parsedKey || !parsedKey.token) {
    throw new Error(
      "Antigravity fetch requires active authentication. Please sign in with your Antigravity subscription."
    );
  }
  const accessToken = parsedKey.token;

  const extractMode = options.extractMode === "text" ? "text" : "markdown";
  const maxChars =
    typeof options.maxChars === "number" && Number.isFinite(options.maxChars) && options.maxChars > 0
      ? Math.floor(options.maxChars)
      : ANTIGRAVITY_FETCH_DEFAULT_MAX_CHARS;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new Error(`Antigravity fetch request timed out after ${options.timeoutMs}ms`));
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
    if (options.checkDenylist !== false) {
      try {
        const denylist = await postJson(
          fetchImpl,
          checkUrlDenylistUrl(endpoints),
          accessToken,
          { url: trimmed },
          controller.signal
        );
        if (denylist.ok && denylist.json && typeof denylist.json === "object") {
          if ((denylist.json as { isDenied?: unknown }).isDenied === true) {
            throw new Error("URL is denied by the Antigravity URL denylist");
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message === "URL is denied by the Antigravity URL denylist") {
          throw err;
        }
        if (options.signal?.aborted || controller.signal.aborted) {
          throw err;
        }
        // Denylist is optional: a failed probe must not block the fetch.
      }
    }

    const trawlerUrl = fetchFromTrawlerCacheUrl(endpoints);
    let liveFetch = true;
    let result = await postJson(
      fetchImpl,
      trawlerUrl,
      accessToken,
      { url: trimmed, liveFetch },
      controller.signal
    );
    if (!result.ok && result.status === 500) {
      liveFetch = false;
      result = await postJson(
        fetchImpl,
        trawlerUrl,
        accessToken,
        { url: trimmed, liveFetch },
        controller.signal
      );
    }
    if (!result.ok) {
      if (result.status === 500) {
        throw new Error(ANTIGRAVITY_FETCH_OPAQUE_ERROR);
      }
      throw new Error(`Antigravity fetch failed with HTTP ${result.status}`);
    }
    const raw = contentFromTrawler(result.json);
    if (raw === undefined) {
      throw new Error(ANTIGRAVITY_FETCH_OPAQUE_ERROR);
    }

    const contentType = sniffContentType(raw);
    const extracted =
      contentType === "text/html" ? htmlToReadable(raw, extractMode) : { text: raw, title: undefined };
    const truncated = extracted.text.length > maxChars;
    const text = extracted.text.slice(0, maxChars);
    const payload: WebFetchResultPayload = {
      url: trimmed,
      finalUrl: trimmed,
      extractMode,
      extractor: liveFetch ? "antigravity-trawler-live" : "antigravity-trawler-cache",
      truncated,
      length: text.length,
      rawLength: extracted.text.length,
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
      text
    };
    if (contentType) {
      payload.contentType = contentType;
    }
    if (extracted.title) {
      payload.title = extracted.title;
    }
    if (!liveFetch) {
      payload.warning = "Live fetch failed; returned a cached copy.";
    }
    return payload;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (options.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}

export function buildAntigravityWebFetchProvider(
  options: BuildWebFetchProviderOptions = {}
): AntigravityWebFetchProvider {
  return {
    id: ANTIGRAVITY_FETCH_PROVIDER_ID,
    providerId: PROVIDER_ID,
    label: "Antigravity Fetch",
    hint: "Uses Antigravity subscription OAuth · fetchFromTrawlerCache (fallback web fetch)",
    authProviderId: PROVIDER_ID,
    requiresCredential: true,
    autoDetectOrder: ANTIGRAVITY_FETCH_AUTO_DETECT_ORDER,
    envVars: [],
    placeholder: "No API key required (uses Antigravity subscription OAuth)",
    signupUrl: "https://cloud.google.com",
    docsUrl: "https://docs.openclaw.ai/tools/web-fetch",
    credentialPath: ANTIGRAVITY_FETCH_CREDENTIAL_PATH,
    inactiveSecretPaths: [ANTIGRAVITY_FETCH_CREDENTIAL_PATH],
    credentialNote:
      "Uses your existing Antigravity OAuth sign-in. No separate API key is required.",
    parameters: ANTIGRAVITY_FETCH_TOOL_PARAMETERS,
    getCredentialValue: (fetchConfig?: Record<string, unknown>) => {
      const scoped = fetchConfig?.[ANTIGRAVITY_FETCH_PROVIDER_ID] ?? fetchConfig?.[PROVIDER_ID];
      if (scoped && typeof scoped === "object") {
        return (scoped as Record<string, unknown>).apiKey;
      }
      return undefined;
    },
    setCredentialValue: (fetchConfigTarget: Record<string, unknown>, value: unknown) => {
      let scoped = fetchConfigTarget[ANTIGRAVITY_FETCH_PROVIDER_ID];
      if (!scoped || typeof scoped !== "object") {
        scoped = {};
        fetchConfigTarget[ANTIGRAVITY_FETCH_PROVIDER_ID] = scoped;
      }
      (scoped as Record<string, unknown>).apiKey = value;
    },
    getConfiguredCredentialValue: (config?: Record<string, unknown>) => {
      const pluginConfig = (config?.plugins as { entries?: Record<string, { config?: { webFetch?: { apiKey?: unknown } } }> } | undefined)
        ?.entries?.[PLUGIN_ID]?.config;
      if (pluginConfig && typeof pluginConfig === "object" && "webFetch" in pluginConfig) {
        const webFetch = pluginConfig.webFetch;
        if (webFetch && typeof webFetch === "object") {
          return webFetch.apiKey;
        }
      }
      return undefined;
    },
    setConfiguredCredentialValue: (configTarget: Record<string, unknown>, value: unknown) => {
      const plugins = ((configTarget.plugins as Record<string, unknown>) ??= {});
      const entries = ((plugins.entries as Record<string, unknown>) ??= {});
      const entry = ((entries[PLUGIN_ID] as Record<string, unknown>) ??= { enabled: true });
      const config = ((entry.config as Record<string, unknown>) ??= {});
      const webFetch = ((config.webFetch as Record<string, unknown>) ??= {});
      webFetch.apiKey = value;
    },
    isConfigured: (ctx?: { cfg?: unknown; agentDir?: string }) =>
      isAntigravityConfigured(ctx, options.defaultAuthStore, options.modelAuth),
    fetch: async (req) =>
      await executeAntigravityFetch(req.url, {
        apiKey: req.apiKey ?? req.auth?.apiKey,
        agentDir: req.agentDir,
        cfg: req.cfg,
        authStore: req.authStore ?? options.defaultAuthStore,
        endpoints: options.endpoints,
        fetchFn: options.fetchFn,
        signal: req.signal,
        extractMode: req.extractMode,
        maxChars: req.maxChars,
        checkDenylist: req.checkDenylist,
        timeoutMs: ANTIGRAVITY_FETCH_DEFAULT_TIMEOUT_MS
      }),
    createTool: (ctx) => ({
      description:
        "Fetch a page through your Antigravity subscription (fallback after OpenClaw's own web fetch).",
      parameters: ANTIGRAVITY_FETCH_TOOL_PARAMETERS,
      execute: async (args, executionContext) => {
        executionContext?.signal?.throwIfAborted();
        const url = typeof args.url === "string" ? args.url.trim() : "";
        if (!url) {
          throw new Error("Fetch URL is required");
        }
        const extractMode = args.extractMode === "text" ? "text" : "markdown";
        const maxChars = typeof args.maxChars === "number" ? args.maxChars : undefined;

        let apiKey: string | undefined;
        try {
          const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/provider-auth-runtime");
          const resolvedAuth = await resolveApiKeyForProvider({
            provider: PROVIDER_ID,
            agentDir: ctx?.agentDir,
            cfg: ctx?.config as Record<string, unknown> | undefined,
            signal: executionContext?.signal
          });
          apiKey = resolvedAuth?.apiKey;
        } catch {
          // SDK helper unavailable
        }
        if (!apiKey && (ctx?.authStore ?? options.defaultAuthStore)) {
          const store = ctx?.authStore ?? options.defaultAuthStore;
          const secret = await store?.getSecret(PROVIDER_ID);
          if (secret?.accessToken) {
            apiKey = JSON.stringify({
              token: secret.accessToken,
              projectId: secret.projectId || DEFAULT_PROJECT_ID
            });
          }
        }

        return await executeAntigravityFetch(url, {
          apiKey,
          agentDir: ctx?.agentDir,
          cfg: ctx?.config,
          authStore: ctx?.authStore ?? options.defaultAuthStore,
          endpoints: options.endpoints,
          fetchFn: options.fetchFn,
          signal: executionContext?.signal,
          extractMode,
          maxChars,
          timeoutMs: ANTIGRAVITY_FETCH_DEFAULT_TIMEOUT_MS
        });
      }
    })
  };
}
