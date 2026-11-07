import { isAntigravityConfigured, isAntigravityConfiguredAsync, parseFormattedApiKey } from "./auth.js";
import {
  DEFAULT_ENDPOINTS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_TIMEOUT_MS,
  DEFAULT_PROJECT_ID,
  PROVIDER_ID,
  buildAntigravityHeaders
} from "./constants.js";
import { extractErrorSummary, formatResetTime } from "./turn.js";
import { unwrapCandidates } from "./utils.js";
import type {
  AntigravityEndpoints,
  AntigravityImageGenerationProvider,
  AuthProfileStore,
  FetchLike,
  GeneratedImageAsset,
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelAuthRuntime
} from "./types.js";

export interface BuildImageProviderOptions {
  endpoints?: Partial<AntigravityEndpoints> | undefined;
  fetchFn?: FetchLike | undefined;
  defaultAuthStore?: AuthProfileStore | undefined;
  modelAuth?: ModelAuthRuntime | undefined;
}

export const BLOCKED_FINISH_REASONS: ReadonlySet<string> = Object.freeze(
  new Set([
    "SAFETY",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "RECITATION",
    "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT",
    "IMAGE_RECITATION"
  ])
);

export function resolveImageModel(model?: string): { canonicalId: string; upstreamSlug: string } {
  const raw = (model ?? "").trim();
  const stripped = raw.startsWith(`${PROVIDER_ID}/`) ? raw.slice(PROVIDER_ID.length + 1) : raw;

  if (!raw || stripped === DEFAULT_IMAGE_MODEL || stripped === "flash-image") {
    return { canonicalId: DEFAULT_IMAGE_MODEL, upstreamSlug: DEFAULT_IMAGE_MODEL };
  }

  throw new Error(
    `Unsupported Antigravity image model "${raw}". Supported model: ${DEFAULT_IMAGE_MODEL}. Set agents.defaults.mediaModels.image or pass a per-call model override.`
  );
}

export function mapSizeToImageConfig(size?: string): { aspectRatio?: string; imageSize?: string } | undefined {
  if (!size) return undefined;
  const normalized = size.trim().toLowerCase();
  const aspectRatioMap: Record<string, string> = {
    "1024x1024": "1:1",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
    "1024x1792": "9:16",
    "1792x1024": "16:9"
  };
  const aspectRatio = aspectRatioMap[normalized];
  const parts = normalized.split("x");
  if (!parts[0] || !parts[1]) {
    return aspectRatio ? { aspectRatio } : undefined;
  }
  const width = parseInt(parts[0], 10);
  const height = parseInt(parts[1], 10);
  if (isNaN(width) || isNaN(height)) {
    return aspectRatio ? { aspectRatio } : undefined;
  }
  const longestEdge = Math.max(width, height);
  const imageSize = longestEdge >= 3072 ? "4K" : longestEdge >= 1536 ? "2K" : undefined;
  if (!aspectRatio && !imageSize) return undefined;
  return {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {})
  };
}

export async function executeAntigravityImageGeneration(
  req: ImageGenerationRequest,
  options: BuildImageProviderOptions = {}
): Promise<ImageGenerationResult> {
  const { canonicalId, upstreamSlug } = resolveImageModel(req.model);
  const endpoints: AntigravityEndpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
  const fetchImpl: FetchLike = options.fetchFn ?? fetch;

  let accessToken: string | undefined;
  let projectId: string = DEFAULT_PROJECT_ID;

  // 1. Resolve authentication
  // A. Check explicit apiKey on request
  if (req.apiKey) {
    const parsedKey = parseFormattedApiKey(req.apiKey);
    if (parsedKey?.token) {
      accessToken = parsedKey.token;
      projectId = parsedKey.projectId || DEFAULT_PROJECT_ID;
    }
  }

  // B. Check explicit authStore
  if (!accessToken) {
    const store = req.authStore ?? options.defaultAuthStore;
    if (store) {
      const secret = await store.getSecret(PROVIDER_ID);
      if (secret?.accessToken) {
        accessToken = secret.accessToken;
        projectId = secret.projectId || DEFAULT_PROJECT_ID;
      }
    }
  }

  // C. Try resolving via OpenClaw SDK if available
  if (!accessToken) {
    try {
      const { resolveApiKeyForProvider } = await import(
        "openclaw/plugin-sdk/provider-auth-runtime"
      );
      const resolvedAuth = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        cfg: req.cfg,
        agentDir: req.agentDir,
        signal: req.signal
      });
      if (resolvedAuth?.apiKey) {
        const parsedKey = parseFormattedApiKey(resolvedAuth.apiKey);
        if (parsedKey?.token) {
          accessToken = parsedKey.token;
          projectId = parsedKey.projectId || DEFAULT_PROJECT_ID;
        }
      }
    } catch {
      // If SDK resolution is unavailable (e.g. unit tests), fall through
    }
  }

  if (!accessToken) {
    throw new Error(
      "Antigravity image generation requires active authentication. Please sign in with your Antigravity subscription."
    );
  }

  // 2. Prepare payload
  const inputParts: Array<Record<string, unknown>> = [];
  if (Array.isArray(req.inputImages) && req.inputImages.length > 0) {
    for (const img of req.inputImages) {
      if (img?.buffer) {
        inputParts.push({
          inlineData: {
            mimeType: img.mimeType || "image/png",
            data: img.buffer.toString("base64")
          }
        });
      }
    }
  }

  inputParts.push({ text: req.prompt });

  const imageConfig: Record<string, string> = {};
  if (req.size) {
    const sizeConfig = mapSizeToImageConfig(req.size);
    if (sizeConfig?.aspectRatio) imageConfig.aspectRatio = sizeConfig.aspectRatio;
    if (sizeConfig?.imageSize) imageConfig.imageSize = sizeConfig.imageSize;
  }
  if (req.aspectRatio?.trim()) {
    imageConfig.aspectRatio = req.aspectRatio.trim();
  }
  if (req.resolution) {
    imageConfig.imageSize = req.resolution;
  }

  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"]
  };
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig;
  }

  const requestBody = {
    project: projectId,
    model: upstreamSlug,
    request: {
      contents: [
        {
          role: "user",
          parts: inputParts
        }
      ],
      generationConfig
    }
  };

  const headers: Record<string, string> = {
    ...buildAntigravityHeaders(accessToken),
    "Content-Type": "application/json",
    Accept: "text/event-stream"
  };

  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 3. Timeout and abort signal
    const timeoutMs = req.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Image generation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onExternalAbort = (): void => {
      controller.abort(req.signal?.reason);
    };
    if (req.signal) {
      if (req.signal.aborted) {
        clearTimeout(timer);
        throw req.signal.reason ?? new Error("Image generation aborted");
      }
      req.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetchImpl(endpoints.chatCompletionsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (req.signal) {
        req.signal.removeEventListener("abort", onExternalAbort);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (req.signal) {
        req.signal.removeEventListener("abort", onExternalAbort);
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 429) {
        let resetNotice = "";
        try {
          const errorJson = JSON.parse(errorText) as {
            error?: {
              details?: Array<{
                metadata?: {
                  quotaResetTimeStamp?: string;
                  quotaResetDelay?: string;
                };
              }>;
            };
          };
          const details = errorJson.error?.details;
          if (Array.isArray(details)) {
            for (const d of details) {
              const time = d.metadata?.quotaResetTimeStamp;
              if (time) {
                const formatted = formatResetTime(time);
                if (formatted) {
                  resetNotice = ` (Resets ${formatted.relative})`;
                  break;
                }
              }
            }
          }
        } catch {
          // Ignore json parse error
        }
        throw new Error(`[antigravity] Quota exceeded HTTP 429 (model ${canonicalId}): ${extractErrorSummary(errorText)}${resetNotice}`);
      }
      throw new Error(`[antigravity] Image generation failed with HTTP ${response.status} (model ${canonicalId}): ${extractErrorSummary(errorText)}`);
    }

    const responseText = await response.text();
    const images: GeneratedImageAsset[] = [];
    let textAccumulated = "";
    let finishReason: string | undefined;
    let blockReason: string | undefined;
    const safetyDetails: Array<{ category: string; probability: string }> = [];

    const recordSafetyRatings = (ratings: unknown) => {
      if (!Array.isArray(ratings)) return;
      for (const r of ratings) {
        const category = typeof r?.category === "string" ? r.category : "UNKNOWN";
        const probability = typeof r?.probability === "string" ? r.probability.toUpperCase() : "";
        const blocked = r?.blocked === true;
        if (blocked || probability === "HIGH") {
          if (!safetyDetails.some((s) => s.category === category)) {
            safetyDetails.push({ category, probability: probability || "BLOCKED" });
          }
        }
      }
    };

    const lines = responseText.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const dataContent = trimmed.slice(5).trim();
      if (!dataContent || dataContent === "[DONE]") {
        continue;
      }
      try {
        const parsed = JSON.parse(dataContent) as Record<string, any>;
        const respObj = parsed.response ?? parsed;

        if (respObj?.promptFeedback) {
          if (typeof respObj.promptFeedback.blockReason === "string") {
            blockReason = respObj.promptFeedback.blockReason;
          }
          recordSafetyRatings(respObj.promptFeedback.safetyRatings ?? respObj.promptFeedback.safety_ratings);
        }

        const candidates = unwrapCandidates(parsed);
        for (const candidate of candidates) {
          if (candidate.finishReason && typeof candidate.finishReason === "string") {
            finishReason = candidate.finishReason;
          }
          recordSafetyRatings(candidate.safetyRatings ?? candidate.safety_ratings);
          const parts = candidate.content?.parts ?? [];
          for (const part of parts) {
            if (typeof part.text === "string" && part.text) {
              textAccumulated += part.text;
            }
            const inline = part.inlineData ?? part.inline_data;
            const data = inline?.data;
            if (data && typeof data === "string") {
              const mimeType = (inline.mimeType ?? inline.mime_type ?? "image/jpeg").toLowerCase();
              const extension = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
              images.push({
                buffer: Buffer.from(data, "base64"),
                mimeType,
                fileName: `generated-${images.length + 1}.${extension}`
              });
            }
          }
        }
      } catch {
        // Ignore unparseable SSE line
      }
    }

    if (images.length > 0) {
      return {
        images,
        model: canonicalId
      };
    }

    // No image part arrived
    const isBlocked = Boolean(
      blockReason ||
      (finishReason && BLOCKED_FINISH_REASONS.has(finishReason.toUpperCase()))
    );

    const safetyStr =
      safetyDetails.length > 0
        ? ` [safety: ${safetyDetails.map((s) => `${s.category}=${s.probability}`).join(", ")}]`
        : "";

    if (isBlocked) {
      const reason = blockReason ?? finishReason ?? "SAFETY";
      const snippet = textAccumulated.trim().slice(0, 300);
      throw new Error(
        `Antigravity image generation blocked (${reason})${safetyStr}${snippet ? `: "${snippet}"` : ""}`
      );
    }

    // Retry exactly once only when no image, no block, and finishReason is STOP or undefined/missing
    const isStopOrMissing = !finishReason || finishReason.toUpperCase() === "STOP";
    if (attempt === 0 && isStopOrMissing && !req.signal?.aborted) {
      continue;
    }

    const snippet = textAccumulated.trim().slice(0, 300);
    const details: string[] = [];
    if (finishReason) details.push(`finishReason: ${finishReason}`);
    if (blockReason) details.push(`blockReason: ${blockReason}`);
    if (safetyDetails.length > 0) {
      details.push(`safety: ${safetyDetails.map((s) => `${s.category}=${s.probability}`).join(", ")}`);
    }
    if (snippet) details.push(`model text: "${snippet}"`);
    const detailStr = details.length > 0 ? ` (${details.join(", ")})` : "";
    throw new Error(`Antigravity image generation response missing image data${detailStr}`);
  }

  throw new Error("Antigravity image generation response missing image data");
}

export function buildAntigravityImageGenerationProvider(
  options: BuildImageProviderOptions = {}
): AntigravityImageGenerationProvider {
  return {
    id: PROVIDER_ID,
    label: "Antigravity",
    defaultModel: DEFAULT_IMAGE_MODEL,
    models: [DEFAULT_IMAGE_MODEL],
    defaultTimeoutMs: DEFAULT_IMAGE_TIMEOUT_MS,
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true
      },
      edit: {
        enabled: true,
        maxCount: 1,
        maxInputImages: 5,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true
      },
      geometry: {
        sizes: [
          "1024x1024",
          "1024x1536",
          "1536x1024",
          "1024x1792",
          "1792x1024"
        ],
        aspectRatios: [
          "1:1",
          "2:3",
          "3:2",
          "3:4",
          "4:3",
          "4:5",
          "5:4",
          "9:16",
          "16:9",
          "21:9"
        ],
        resolutions: [
          "1K",
          "2K",
          "4K"
        ]
      },
      output: {
        formats: ["jpeg"]
      }
    },
    isConfigured: (ctx?: { cfg?: unknown; agentDir?: string }) =>
      isAntigravityConfigured(ctx, options.defaultAuthStore, options.modelAuth),
    isConfiguredAsync: (ctx?: { cfg?: unknown; agentDir?: string }) =>
      isAntigravityConfiguredAsync(ctx, options.defaultAuthStore, options.modelAuth),
    generateImage: async (req: ImageGenerationRequest) =>
      await executeAntigravityImageGeneration(req, options)
  };
}
