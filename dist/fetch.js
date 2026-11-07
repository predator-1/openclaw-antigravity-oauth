import { isIP, BlockList } from "node:net";
import { isAntigravityConfigured, parseFormattedApiKey } from "./auth.js";
import { DEFAULT_ENDPOINTS, DEFAULT_PROJECT_ID, PLUGIN_ID, PROVIDER_ID, buildAntigravityQuotaHeaders } from "./constants.js";
export const ANTIGRAVITY_FETCH_PROVIDER_ID = "antigravity-fetch";
export const ANTIGRAVITY_FETCH_AUTO_DETECT_ORDER = 40;
export const ANTIGRAVITY_FETCH_CREDENTIAL_PATH = `plugins.entries.${PLUGIN_ID}.config.webFetch.apiKey`;
export const ANTIGRAVITY_FETCH_DEFAULT_MAX_CHARS = 20_000;
export const ANTIGRAVITY_FETCH_DEFAULT_TIMEOUT_MS = 15_000;
export const ANTIGRAVITY_FETCH_OPAQUE_ERROR = "page could not be fetched (upstream error, ~7 s timeout, or unsupported type such as PDF or images)";
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
function v1internalUrl(endpoints, rpc) {
    return `${new URL(endpoints.modelsUrl).origin}/v1internal:${rpc}`;
}
export function fetchFromTrawlerCacheUrl(endpoints = DEFAULT_ENDPOINTS) {
    return v1internalUrl(endpoints, "fetchFromTrawlerCache");
}
export function checkUrlDenylistUrl(endpoints = DEFAULT_ENDPOINTS) {
    return v1internalUrl(endpoints, "checkUrlDenylist");
}
function decodeEntities(value) {
    return value
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
        const code = Number.parseInt(hex, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
        .replace(/&#(\d+);/g, (_, dec) => {
        const code = Number.parseInt(dec, 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}
function stripTags(value) {
    return value.replace(/<[^>]+>/g, " ");
}
export function htmlToReadable(html, mode = "markdown") {
    const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const title = rawTitle ? decodeEntities(stripTags(rawTitle)).replace(/\s+/g, " ").trim() : undefined;
    let s = html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ");
    if (mode === "markdown") {
        s = s
            .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => {
            return `\n${"#".repeat(Number(level))} ${decodeEntities(stripTags(inner)).trim()}\n`;
        })
            .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
            const label = decodeEntities(stripTags(inner)).trim() || href;
            return `[${label}](${href})`;
        })
            .replace(/<(strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/\1(?:\s[^>]*)?>/gi, (_m, _tag, inner) => {
            return `**${decodeEntities(stripTags(inner)).trim()}**`;
        })
            .replace(/<(em|i)(?:\s[^>]*)?>([\s\S]*?)<\/\1(?:\s[^>]*)?>/gi, (_m, _tag, inner) => {
            return `*${decodeEntities(stripTags(inner)).trim()}*`;
        })
            .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => {
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
export function sniffContentType(content) {
    const head = content.trimStart().slice(0, 256);
    const lower = head.toLowerCase();
    if (lower.startsWith("<!doctype html") || lower.startsWith("<html") || /<html[\s>]/.test(lower)) {
        return "text/html";
    }
    if (head.startsWith("{") || head.startsWith("[")) {
        try {
            JSON.parse(content);
            return "application/json";
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function mappedIpv4(host) {
    const match = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return match?.[1];
}
export function forbiddenFetchUrlReason(raw) {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
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
async function resolveFetchApiKey(options) {
    let rawKey = options.auth?.apiKey ?? options.apiKey;
    if (!rawKey) {
        try {
            const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/provider-auth-runtime");
            const resolved = await resolveApiKeyForProvider({
                provider: PROVIDER_ID,
                agentDir: options.agentDir,
                cfg: options.cfg,
                signal: options.signal
            });
            if (resolved?.apiKey) {
                rawKey = resolved.apiKey;
            }
        }
        catch {
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
        }
        catch {
            // Fall through to validation
        }
    }
    return rawKey;
}
async function postJson(fetchImpl, url, accessToken, body, signal) {
    const response = await fetchImpl(url, {
        method: "POST",
        headers: buildAntigravityQuotaHeaders(accessToken),
        body: JSON.stringify(body),
        signal
    });
    let json = null;
    try {
        json = await response.json();
    }
    catch {
        json = null;
    }
    return { status: response.status, ok: response.ok, json };
}
function contentFromTrawler(json) {
    if (!json || typeof json !== "object") {
        return undefined;
    }
    const content = json.content;
    return typeof content === "string" ? content : undefined;
}
export async function executeAntigravityFetch(url, options = {}) {
    const started = Date.now();
    options.signal?.throwIfAborted();
    const trimmed = url.trim();
    const blocked = forbiddenFetchUrlReason(trimmed);
    if (blocked) {
        throw new Error(blocked);
    }
    const endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
    const fetchImpl = options.fetchFn ?? fetch;
    const rawKey = await resolveFetchApiKey(options);
    const parsedKey = parseFormattedApiKey(rawKey);
    if (!parsedKey || !parsedKey.token) {
        throw new Error("Antigravity fetch requires active authentication. Please sign in with your Antigravity subscription.");
    }
    const accessToken = parsedKey.token;
    const extractMode = options.extractMode === "text" ? "text" : "markdown";
    const maxChars = typeof options.maxChars === "number" && Number.isFinite(options.maxChars) && options.maxChars > 0
        ? Math.floor(options.maxChars)
        : ANTIGRAVITY_FETCH_DEFAULT_MAX_CHARS;
    const controller = new AbortController();
    let timer;
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
        }
        else {
            options.signal.addEventListener("abort", onAbort, { once: true });
        }
    }
    try {
        if (options.checkDenylist !== false) {
            try {
                const denylist = await postJson(fetchImpl, checkUrlDenylistUrl(endpoints), accessToken, { url: trimmed }, controller.signal);
                if (denylist.ok && denylist.json && typeof denylist.json === "object") {
                    if (denylist.json.isDenied === true) {
                        throw new Error("URL is denied by the Antigravity URL denylist");
                    }
                }
            }
            catch (err) {
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
        let result = await postJson(fetchImpl, trawlerUrl, accessToken, { url: trimmed, liveFetch }, controller.signal);
        if (!result.ok && result.status === 500) {
            liveFetch = false;
            result = await postJson(fetchImpl, trawlerUrl, accessToken, { url: trimmed, liveFetch }, controller.signal);
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
        const extracted = contentType === "text/html" ? htmlToReadable(raw, extractMode) : { text: raw, title: undefined };
        const truncated = extracted.text.length > maxChars;
        const text = extracted.text.slice(0, maxChars);
        const payload = {
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
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
        if (options.signal) {
            options.signal.removeEventListener("abort", onAbort);
        }
    }
}
export function buildAntigravityWebFetchProvider(options = {}) {
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
        credentialNote: "Uses your existing Antigravity OAuth sign-in. No separate API key is required.",
        parameters: ANTIGRAVITY_FETCH_TOOL_PARAMETERS,
        getCredentialValue: (fetchConfig) => {
            const scoped = fetchConfig?.[ANTIGRAVITY_FETCH_PROVIDER_ID] ?? fetchConfig?.[PROVIDER_ID];
            if (scoped && typeof scoped === "object") {
                return scoped.apiKey;
            }
            return undefined;
        },
        setCredentialValue: (fetchConfigTarget, value) => {
            let scoped = fetchConfigTarget[ANTIGRAVITY_FETCH_PROVIDER_ID];
            if (!scoped || typeof scoped !== "object") {
                scoped = {};
                fetchConfigTarget[ANTIGRAVITY_FETCH_PROVIDER_ID] = scoped;
            }
            scoped.apiKey = value;
        },
        getConfiguredCredentialValue: (config) => {
            const pluginConfig = config?.plugins
                ?.entries?.[PLUGIN_ID]?.config;
            if (pluginConfig && typeof pluginConfig === "object" && "webFetch" in pluginConfig) {
                const webFetch = pluginConfig.webFetch;
                if (webFetch && typeof webFetch === "object") {
                    return webFetch.apiKey;
                }
            }
            return undefined;
        },
        setConfiguredCredentialValue: (configTarget, value) => {
            const plugins = (configTarget.plugins ??= {});
            const entries = (plugins.entries ??= {});
            const entry = (entries[PLUGIN_ID] ??= { enabled: true });
            const config = (entry.config ??= {});
            const webFetch = (config.webFetch ??= {});
            webFetch.apiKey = value;
        },
        isConfigured: (ctx) => isAntigravityConfigured(ctx, options.defaultAuthStore, options.modelAuth),
        fetch: async (req) => await executeAntigravityFetch(req.url, {
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
            description: "Fetch a page through your Antigravity subscription (fallback after OpenClaw's own web fetch).",
            parameters: ANTIGRAVITY_FETCH_TOOL_PARAMETERS,
            execute: async (args, executionContext) => {
                executionContext?.signal?.throwIfAborted();
                const url = typeof args.url === "string" ? args.url.trim() : "";
                if (!url) {
                    throw new Error("Fetch URL is required");
                }
                const extractMode = args.extractMode === "text" ? "text" : "markdown";
                const maxChars = typeof args.maxChars === "number" ? args.maxChars : undefined;
                let apiKey;
                try {
                    const { resolveApiKeyForProvider } = await import("openclaw/plugin-sdk/provider-auth-runtime");
                    const resolvedAuth = await resolveApiKeyForProvider({
                        provider: PROVIDER_ID,
                        agentDir: ctx?.agentDir,
                        cfg: ctx?.config,
                        signal: executionContext?.signal
                    });
                    apiKey = resolvedAuth?.apiKey;
                }
                catch {
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
//# sourceMappingURL=fetch.js.map