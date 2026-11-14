import { randomUUID } from "node:crypto";
import { parseFormattedApiKey } from "./auth.js";
import {
  DEFAULT_ENDPOINTS,
  DEFAULT_PROJECT_ID,
  PROVIDER_ID,
  buildAntigravityHeaders
} from "./constants.js";
import { unwrapCandidates } from "./utils.js";
import type {
  AntigravityEndpoints,
  AntigravityMediaUnderstandingProvider,
  FetchLike,
  MediaUnderstandingAudioRequest,
  MediaUnderstandingImageRequest,
  MediaUnderstandingImagesRequest,
  MediaUnderstandingTextResult,
  MediaUnderstandingVideoRequest
} from "./types.js";

export const ANTIGRAVITY_MEDIA_UNDERSTANDING_DEFAULT_MODELS = Object.freeze({
  image: "gemini-3.8-flash",
  audio: "gemini-3.8-flash",
  video: "gemini-3.8-flash"
});

export const ANTIGRAVITY_MEDIA_UNDERSTANDING_CAPABILITIES = Object.freeze([
  "image",
  "audio",
  "video"
] as const);

export const ANTIGRAVITY_MEDIA_UNDERSTANDING_AUTO_PRIORITY = Object.freeze({
  image: 90,
  audio: 90,
  video: 90
});

/**
 * Documented Gemini inline-data budget for the whole request (~20 MiB).
 * Covers base64(audio) plus prompt/envelope, not the raw buffer alone.
 */
export const INLINE_AUDIO_REQUEST_MAX_BYTES = 20 * 1024 * 1024;

/** Bytes reserved for prompt text and the JSON request envelope. */
const INLINE_AUDIO_REQUEST_OVERHEAD_BYTES = 256 * 1024;

/**
 * Max raw audio buffer so that base64 size (`Math.ceil(n / 3) * 4`) plus a
 * small prompt/envelope overhead stays ≤ INLINE_AUDIO_REQUEST_MAX_BYTES
 * (~14.81 MiB raw → ~19.75 MiB base64). Live v1internal cutoff for 5/15/25 MB
 * clips is unverified (see docs/protocol.md).
 */
export const INLINE_AUDIO_MAX_BYTES = Math.floor(
  ((INLINE_AUDIO_REQUEST_MAX_BYTES - INLINE_AUDIO_REQUEST_OVERHEAD_BYTES) * 3) / 4
);

export function assertInlineAudioWithinLimit(buffer: { byteLength: number }): void {
  const size = buffer.byteLength;
  if (size > INLINE_AUDIO_MAX_BYTES) {
    throw new Error(
      `Antigravity audio transcription rejected a ${size}-byte clip; ` +
        `the Gemini inline data limit is ~${INLINE_AUDIO_REQUEST_MAX_BYTES} bytes (20 MiB) for the whole request, ` +
        `so raw audio is capped at ${INLINE_AUDIO_MAX_BYTES} bytes after base64 expansion. ` +
        `v1internal has no media upload path.`
    );
  }
}

export function inferMediaMimeType(fileName?: string, fallback = "application/octet-stream"): string {
  if (!fileName) {
    return fallback;
  }
  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "pdf":
      return "application/pdf";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "m4a":
      return "audio/mp4";
    case "flac":
      return "audio/flac";
    case "mp4":
      return "video/mp4";
    case "mov":
      return "video/quicktime";
    case "webm":
      return "video/webm";
    default:
      return fallback;
  }
}

function resolveUpstreamModelSlug(rawModel?: string): { canonicalId: string; upstreamSlug: string } {
  let modelId = (rawModel ?? "").trim();
  if (modelId.startsWith(`${PROVIDER_ID}/`)) {
    modelId = modelId.slice(`${PROVIDER_ID}/`.length);
  }
  if (!modelId) {
    modelId = ANTIGRAVITY_MEDIA_UNDERSTANDING_DEFAULT_MODELS.image;
  }

  if (modelId === "gemini-3.8-flash") {
    return { canonicalId: modelId, upstreamSlug: "gemini-3.8-flash-tiered" };
  }
  if (modelId === "gemini-4-argon" || modelId === "MODEL_PLACEHOLDER_M124") {
    return { canonicalId: "gemini-4-argon", upstreamSlug: "gemini-4-argon-medium" };
  }
  // agy 1.5.9 built-in table: every Hydrogen tier is image/PDF/video capable; the bare
  // canonical id is not an upstream slug, so media requests use the default tier.
  if (modelId === "gemini-4-hydrogen") {
    return { canonicalId: "gemini-4-hydrogen", upstreamSlug: "gemini-4-hydrogen-medium" };
  }
  return { canonicalId: modelId, upstreamSlug: modelId };
}

export interface ExecuteMediaUnderstandingOptions {
  model?: string | undefined;
  apiKey?: string | undefined;
  auth?: { kind?: string | undefined; apiKey?: string | undefined } | undefined;
  endpoints?: Partial<AntigravityEndpoints> | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fetchFn?: FetchLike | undefined;
  agentDir?: string | undefined;
  cfg?: unknown | undefined;
}

export async function executeMediaUnderstanding(
  parts: Array<Record<string, unknown>>,
  options: ExecuteMediaUnderstandingOptions
): Promise<MediaUnderstandingTextResult> {
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

  const parsedKey = parseFormattedApiKey(rawKey);
  if (!parsedKey || !parsedKey.token) {
    throw new Error("Antigravity media understanding requires a valid access token");
  }

  const accessToken = parsedKey.token;
  const projectId = parsedKey.projectId ?? DEFAULT_PROJECT_ID;

  const { canonicalId, upstreamSlug } = resolveUpstreamModelSlug(options.model);

  const requestBody = {
    project: projectId,
    model: upstreamSlug,
    request: {
      contents: [
        {
          role: "user",
          parts
        }
      ]
    },
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `media-${randomUUID()}`
  };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(
        new Error(`Antigravity media understanding request timed out after ${options.timeoutMs}ms`)
      );
    }, options.timeoutMs);
  }
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    const response = await fetchImpl(endpoints.chatCompletionsUrl, {
      method: "POST",
      headers: {
        ...buildAntigravityHeaders(accessToken),
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json"
      },
      body: JSON.stringify(requestBody),
      signal: requestSignal
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
        // Fallback if not JSON
      }
      if (!errorDetail) {
        errorDetail = response.statusText || `status ${response.status}`;
      }
      throw new Error(
        `Antigravity media understanding failed with HTTP ${response.status} (${errorDetail})`
      );
    }

    let fullText = "";
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
            const candidates = unwrapCandidates<{ content?: { parts?: Array<{ text?: string }> } }>(chunk);
            for (const cand of candidates) {
              const candParts = cand.content?.parts;
              if (Array.isArray(candParts)) {
                for (const p of candParts) {
                  if (typeof p.text === "string") {
                    fullText += p.text;
                  }
                }
              }
            }
          } catch {
            // Ignore SSE chunk JSON parse errors
          }
        }
      }
    } else {
      const rawJson = await response.json();
      const candidates = unwrapCandidates<{ content?: { parts?: Array<{ text?: string }> } }>(rawJson);
      for (const cand of candidates) {
        const candParts = cand.content?.parts;
        if (Array.isArray(candParts)) {
          for (const p of candParts) {
            if (typeof p.text === "string") {
              fullText += p.text;
            }
          }
        }
      }
    }

    const resultText = fullText.trim();
    if (!resultText) {
      throw new Error("Antigravity media understanding returned an empty response");
    }

    return {
      text: resultText,
      model: canonicalId
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Image description is delegated to the OpenClaw host SDK. Outside the host runtime
 * (bare Node, unit tests without a stub) surface a clear error instead of a raw
 * ERR_MODULE_NOT_FOUND.
 */
async function loadMediaUnderstandingSdk(): Promise<typeof import("openclaw/plugin-sdk/media-understanding")> {
  try {
    return await import("openclaw/plugin-sdk/media-understanding");
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(
        "Antigravity image description requires the OpenClaw host runtime (openclaw/plugin-sdk/media-understanding is unavailable)"
      );
    }
    throw err;
  }
}

export function buildAntigravityMediaUnderstandingProvider(options?: {
  endpoints?: Partial<AntigravityEndpoints>;
  fetchFn?: FetchLike;
}): AntigravityMediaUnderstandingProvider {
  return {
    id: PROVIDER_ID,
    capabilities: ANTIGRAVITY_MEDIA_UNDERSTANDING_CAPABILITIES,
    defaultModels: { ...ANTIGRAVITY_MEDIA_UNDERSTANDING_DEFAULT_MODELS },
    autoPriority: { ...ANTIGRAVITY_MEDIA_UNDERSTANDING_AUTO_PRIORITY },
    nativeDocumentInputs: ["pdf"] as const,

    async describeImage(req: MediaUnderstandingImageRequest): Promise<MediaUnderstandingTextResult> {
      const { describeImageWithModel } = await loadMediaUnderstandingSdk();
      const res = await describeImageWithModel(req as any);
      return {
        text: res.text,
        model: res.model ?? req.model ?? ANTIGRAVITY_MEDIA_UNDERSTANDING_DEFAULT_MODELS.image
      };
    },

    async describeImages(req: MediaUnderstandingImagesRequest): Promise<MediaUnderstandingTextResult> {
      const { describeImagesWithModel } = await loadMediaUnderstandingSdk();
      const res = await describeImagesWithModel(req as any);
      return {
        text: res.text,
        model: res.model ?? req.model ?? ANTIGRAVITY_MEDIA_UNDERSTANDING_DEFAULT_MODELS.image
      };
    },

    async transcribeAudio(req: MediaUnderstandingAudioRequest): Promise<MediaUnderstandingTextResult> {
      assertInlineAudioWithinLimit(req.buffer);
      const mime = req.mime ?? inferMediaMimeType(req.fileName, "audio/wav");
      let prompt =
        req.prompt && req.prompt.trim().length > 0
          ? req.prompt.trim()
          : "Transcribe the audio speech verbatim.";
      if (req.language && !req.prompt) {
        prompt = `Transcribe the audio speech verbatim in ${req.language}.`;
      }

      const parts: Array<Record<string, unknown>> = [
        { text: prompt },
        {
          inlineData: {
            mimeType: mime,
            data: req.buffer.toString("base64")
          }
        }
      ];

      return await executeMediaUnderstanding(
        parts,
        {
          model: req.model ?? ANTIGRAVITY_MEDIA_UNDERSTANDING_DEFAULT_MODELS.audio,
          apiKey: req.apiKey,
          auth: req.auth,
          agentDir: (req as any).agentDir ?? (req as any).ctx?.agentDir,
          cfg: (req as any).cfg ?? (req as any).ctx?.cfg,
          endpoints: options?.endpoints,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          fetchFn: options?.fetchFn
        }
      );
    },

    async describeVideo(req: MediaUnderstandingVideoRequest): Promise<MediaUnderstandingTextResult> {
      const mime = req.mime ?? inferMediaMimeType(req.fileName, "video/mp4");
      const prompt =
        req.prompt && req.prompt.trim().length > 0
          ? req.prompt.trim()
          : "Describe the video in detail, summarizing key scenes, actions, timing, and visible text.";

      const parts: Array<Record<string, unknown>> = [
        { text: prompt },
        {
          inlineData: {
            mimeType: mime,
            data: req.buffer.toString("base64")
          }
        }
      ];

      return await executeMediaUnderstanding(
        parts,
        {
          model: req.model ?? ANTIGRAVITY_MEDIA_UNDERSTANDING_DEFAULT_MODELS.video,
          apiKey: req.apiKey,
          auth: req.auth,
          agentDir: (req as any).agentDir ?? (req as any).ctx?.agentDir,
          cfg: (req as any).cfg ?? (req as any).ctx?.cfg,
          endpoints: options?.endpoints,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          fetchFn: options?.fetchFn
        }
      );
    }
  };
}
