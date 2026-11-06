import { randomUUID } from "node:crypto";
import { getValidAccessToken } from "./auth.js";
import type { CatalogService } from "./catalog.js";
import {
  DEFAULT_ENDPOINTS,
  NATIVE_CLI_TOOLS,
  PROVIDER_ID,
  buildAntigravityHeaders
} from "./constants.js";
import { unwrapCandidates } from "./utils.js";
import type {
  AntigravityEndpoints,
  AuthProfileStore,
  FetchLike,
  HostToolCall,
  SubscriptionModelRow,
  TurnRequest,
  TurnResponse,
  TurnUsageCounts
} from "./types.js";

interface RawToolCallFunction {
  name?: string;
  arguments?: string | Record<string, unknown>;
  thoughtSignature?: string;
  thought_signature?: string;
}

interface RawToolCall {
  id?: string;
  type?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  function?: RawToolCallFunction;
  thoughtSignature?: string;
  thought_signature?: string;
}

interface RawChoiceDeltaOrMessage {
  content?: string | null;
  tool_calls?: RawToolCall[];
}

interface RawChoice {
  delta?: RawChoiceDeltaOrMessage;
  message?: RawChoiceDeltaOrMessage;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
}

interface RawGeminiFunctionCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown> | string;
  thoughtSignature?: string;
  thought_signature?: string;
}

interface RawGeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: RawGeminiFunctionCall;
  thoughtSignature?: string;
  thought_signature?: string;
}

interface RawGeminiCandidate {
  content?: {
    role?: string;
    parts?: RawGeminiPart[];
  };
}

interface RawGeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface RawCompletionPayload {
  error?: unknown;
  choices?: RawChoice[];
  usage?: RawUsage;
  candidates?: RawGeminiCandidate[];
  usageMetadata?: RawGeminiUsageMetadata;
  response?: {
    error?: unknown;
    candidates?: RawGeminiCandidate[];
    usageMetadata?: RawGeminiUsageMetadata;
    offered_tools?: string[];
    native_tools?: string[];
    server_tools?: string[];
  };
  offered_tools?: string[];
  native_tools?: string[];
  server_tools?: string[];
}

function stripProviderPrefix(modelRef: string): string {
  return modelRef.startsWith("antigravity/") ? modelRef.slice("antigravity/".length) : modelRef;
}

export function toUpstreamThinkingLevel(effort: string): string {
  if (effort === "xhigh") {
    return "EXTRA_HIGH";
  }
  if (effort === "max") {
    return "MAX";
  }
  return effort.toUpperCase();
}

function unsupportedReasoningEffortMessage(
  effort: string,
  modelId: string,
  validLevels: readonly string[]
): string {
  return `unsupported reasoning effort "${effort}" for model ${modelId} (valid: ${validLevels.join(", ")})`;
}

export const GEMINI_THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";

export function extractThoughtSignature(...sources: unknown[]): string | undefined {
  for (const src of sources) {
    if (!src || typeof src !== "object") {
      continue;
    }
    const rec = src as Record<string, unknown>;
    const camel = rec.thoughtSignature;
    if (typeof camel === "string" && camel.length > 0) {
      return camel;
    }
    const snake = rec.thought_signature;
    if (typeof snake === "string" && snake.length > 0) {
      return snake;
    }
  }
  return undefined;
}

export function extractThoughtSignatureModel(...sources: unknown[]): string | undefined {
  for (const src of sources) {
    if (!src || typeof src !== "object") {
      continue;
    }
    const rec = src as Record<string, unknown>;
    for (const key of ["thoughtSignatureModel", "thought_signature_model"] as const) {
      const value = rec[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

export function resolveReplayThoughtSignature(
  toolCall: unknown,
  bareModelId: string
): string {
  const signature = extractThoughtSignature(toolCall);
  if (!signature) {
    return GEMINI_THOUGHT_SIGNATURE_SENTINEL;
  }
  const producedBy = extractThoughtSignatureModel(toolCall);
  if (producedBy && producedBy !== bareModelId) {
    return GEMINI_THOUGHT_SIGNATURE_SENTINEL;
  }
  return signature;
}

function modelUsesGeminiThoughtSignatures(bareModelId: string): boolean {
  return /^gemini-/i.test(bareModelId) || bareModelId.startsWith("MODEL_PLACEHOLDER_M");
}

function parseArguments(
  rawArgs: string | Record<string, unknown> | undefined
): Record<string, unknown> | string {
  if (rawArgs === undefined) {
    return {};
  }
  if (typeof rawArgs === "object" && rawArgs !== null) {
    return rawArgs;
  }
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return rawArgs;
  } catch {
    return rawArgs;
  }
}

function checkOfferedNativeTools(payload: RawCompletionPayload, headers?: Headers): void {
  const headerOffered = headers?.get("x-antigravity-native-tools") ?? headers?.get("x-offered-tools");
  if (headerOffered && headerOffered.trim().length > 0) {
    throw new Error("native tools offered");
  }

  const arraysToCheck = [
    payload.offered_tools,
    payload.native_tools,
    payload.server_tools,
    payload.response?.offered_tools,
    payload.response?.native_tools,
    payload.response?.server_tools
  ];
  for (const list of arraysToCheck) {
    if (Array.isArray(list) && list.length > 0) {
      throw new Error("native tools offered");
    }
  }
}

function validateAndNormalizeToolCall(
  raw: RawToolCall,
  allowedHostTools: ReadonlySet<string>,
  index: number,
  toolNameMapper?: ToolNameMapper
): HostToolCall {
  const rawName = (raw.function?.name ?? raw.name ?? "").trim();
  if (!rawName) {
    throw new Error("Invalid tool call with empty name from endpoint");
  }
  const name = toolNameMapper ? toolNameMapper.toOriginalName(rawName) : rawName;

  // Contract §4 & §6.6: Refuse if the endpoint emits a native CLI tool (e.g. manage_task, run_command).
  // Host tools (e.g. exec, browser, session_status, view_image) are owned and executed by OpenClaw.
  if (NATIVE_CLI_TOOLS.has(name) && !allowedHostTools.has(name)) {
    throw new Error(`native tool refused: ${name}`);
  }

  const rawArgs = raw.function?.arguments ?? raw.arguments;
  const thoughtSignature = extractThoughtSignature(raw, raw.function);
  return {
    id: raw.id ?? `call_${index}`,
    name,
    arguments: parseArguments(rawArgs),
    ...(thoughtSignature ? { thoughtSignature } : {})
  };
}

function extractUsage(
  raw: RawUsage | undefined,
  geminiUsage?: RawGeminiUsageMetadata
): TurnUsageCounts | undefined {
  if (raw) {
    return {
      inputTokens: raw.inputTokens ?? raw.prompt_tokens ?? 0,
      outputTokens: raw.outputTokens ?? raw.completion_tokens ?? 0,
      thinkingTokens: raw.thinkingTokens ?? raw.thinking_tokens ?? 0,
      cacheReadTokens: raw.cacheReadTokens ?? raw.cache_read_tokens ?? 0
    };
  }
  if (geminiUsage) {
    return {
      inputTokens: geminiUsage.promptTokenCount ?? 0,
      outputTokens: geminiUsage.candidatesTokenCount ?? 0,
      thinkingTokens: geminiUsage.thoughtsTokenCount ?? 0,
      cacheReadTokens: geminiUsage.cachedContentTokenCount ?? 0
    };
  }
  return undefined;
}

function cleanSchemaNode(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { type: "string" };
  }
  const obj = { ...(raw as Record<string, unknown>) };
  let isNullable = obj.nullable === true;

  // 1. anyOf / oneOf flattening
  if (Array.isArray(obj.anyOf) || Array.isArray(obj.oneOf)) {
    const branches = (obj.anyOf || obj.oneOf) as any[];
    const hasNullBranch = branches.some(
      (b) =>
        b &&
        typeof b === "object" &&
        (b.type === "null" ||
          b.nullable === true ||
          (Array.isArray(b.type) && b.type.includes("null")))
    );
    if (hasNullBranch) {
      isNullable = true;
    }
    const nonNullCandidate = branches.find(
      (b) =>
        b &&
        typeof b === "object" &&
        b.type !== "null" &&
        (!Array.isArray(b.type) || b.type.some((t: any) => t !== "null"))
    );
    const chosenBranch = nonNullCandidate || branches.find((b) => b && typeof b === "object");
    if (chosenBranch) {
      const inheritedDesc = obj.description;
      Object.assign(obj, chosenBranch);
      if (inheritedDesc && !chosenBranch.description) {
        obj.description = inheritedDesc;
      }
    }
    delete obj.anyOf;
    delete obj.oneOf;
  }

  // 2. Type array handling ["x", "null"] -> x + nullable
  let resolvedType: string;
  if (Array.isArray(obj.type)) {
    const rawTypes = obj.type
      .map((t: unknown) => (typeof t === "string" ? t.toLowerCase().trim() : ""))
      .filter(Boolean);
    if (rawTypes.includes("null")) {
      isNullable = true;
    }
    const nonNullType = rawTypes.find((t: string) => t !== "null");
    resolvedType = nonNullType || "string";
  } else if (typeof obj.type === "string") {
    const t = obj.type.toLowerCase().trim();
    if (t === "null") {
      resolvedType = "string";
      isNullable = true;
    } else {
      resolvedType = t;
    }
  } else if (obj.properties) {
    resolvedType = "object";
  } else if (obj.items) {
    resolvedType = "array";
  } else if (obj.enum) {
    resolvedType = "string";
  } else {
    // Never drop a type silently
    resolvedType = "string";
  }

  const cleaned: Record<string, unknown> = {
    type: resolvedType
  };
  if (isNullable) {
    cleaned.nullable = true;
  }

  if (typeof obj.description === "string" && obj.description.length > 0) {
    cleaned.description = obj.description;
  }

  // 3. Stringify enum values
  if (Array.isArray(obj.enum)) {
    const stringified = Array.from(
      new Set(
        obj.enum
          .filter((v: unknown) => v !== null && v !== undefined)
          .map((v: unknown) => String(v))
      )
    );
    if (stringified.length > 0) {
      cleaned.enum = stringified;
    }
  }

  if (Array.isArray(obj.required)) {
    cleaned.required = obj.required.filter((r): r is string => typeof r === "string");
  }

  if (typeof obj.format === "string") {
    cleaned.format = obj.format;
  }

  // 4. Recurse into properties
  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj.properties as Record<string, unknown>)) {
      props[key] = cleanSchemaNode(val);
    }
    cleaned.properties = props;
  }

  // 5. Recurse into items
  if (obj.items && typeof obj.items === "object" && !Array.isArray(obj.items)) {
    cleaned.items = cleanSchemaNode(obj.items);
  }

  return cleaned;
}

export function cleanJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const root = cleanSchemaNode(schema);
  if (root.type !== "object") {
    root.type = "object";
  }
  if (!root.properties) {
    root.properties = {};
  }
  return root;
}

/** Sanitize a response schema without forcing the root to an object (arrays/strings stay). */
export function cleanResponseJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const root = cleanSchemaNode(schema);
  if (typeof root.type !== "string" || root.type.length === 0) {
    root.type = "object";
  }
  if (root.type === "object" && root.properties === undefined) {
    root.properties = {};
  }
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeJsonSchema(value: Record<string, unknown>): boolean {
  return (
    typeof value.type === "string" ||
    value.properties !== undefined ||
    value.items !== undefined ||
    value.$schema !== undefined ||
    value.required !== undefined ||
    value.anyOf !== undefined ||
    value.oneOf !== undefined ||
    value.allOf !== undefined ||
    value.additionalProperties !== undefined
  );
}

/** Gemini and MODEL_PLACEHOLDER_* aliases; Claude and GPT-OSS do not get these fields. */
export function modelSupportsStructuredOutput(modelId: string): boolean {
  const id = modelId.replace(/^antigravity\//i, "");
  return /^gemini-/i.test(id) || /^MODEL_PLACEHOLDER_M/i.test(id);
}

/**
 * Read the host's `StreamOptions.responseFormat` (also `response_format`).
 * Accepts a raw JSON Schema or an OpenAI-style `{ type, json_schema }` wrapper.
 */
export function extractHostResponseFormat(
  options?: Record<string, unknown> | null
): { responseMimeType: string; responseSchema?: Record<string, unknown> } | undefined {
  if (!options) {
    return undefined;
  }
  const raw = options.responseFormat ?? options.response_format;
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw.type === "text") {
    return undefined;
  }
  if (raw.type === "json_object") {
    return { responseMimeType: "application/json" };
  }
  let schema: unknown;
  if (raw.type === "json_schema") {
    const descriptor = isRecord(raw.json_schema) ? raw.json_schema : undefined;
    if (!descriptor || !isRecord(descriptor.schema)) {
      return { responseMimeType: "application/json" };
    }
    schema = descriptor.schema;
  } else if (looksLikeJsonSchema(raw)) {
    schema = raw;
  }
  if (!isRecord(schema)) {
    return undefined;
  }
  return {
    responseMimeType: "application/json",
    responseSchema: cleanResponseJsonSchema(schema)
  };
}

const VALID_TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

export class ToolNameMapper {
  private originalToSafe = new Map<string, string>();
  private safeToOriginal = new Map<string, string>();

  public toSafeName(original: string): string {
    if (!original || typeof original !== "string") {
      return "tool";
    }
    const existing = this.originalToSafe.get(original);
    if (existing) {
      return existing;
    }

    if (VALID_TOOL_NAME_RE.test(original)) {
      if (!this.safeToOriginal.has(original) || this.safeToOriginal.get(original) === original) {
        this.originalToSafe.set(original, original);
        this.safeToOriginal.set(original, original);
        return original;
      }
      // If original is already taken as a safe name for a different original,
      // fall through to the suffix path below.
    }

    let base = original.replace(/[^a-zA-Z0-9_]/g, "_");
    if (!/^[a-zA-Z_]/.test(base)) {
      base = `_${base}`;
    }
    base = base.slice(0, 64);

    let candidate = base;
    let counter = 1;
    while (this.safeToOriginal.has(candidate) && this.safeToOriginal.get(candidate) !== original) {
      const suffix = `_${counter++}`;
      candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    }

    this.originalToSafe.set(original, candidate);
    this.safeToOriginal.set(candidate, original);
    return candidate;
  }

  public toOriginalName(safe: string): string {
    return this.safeToOriginal.get(safe) ?? safe;
  }
}

function buildV1InternalRequestEnvelope(
  bareModelId: string,
  projectId: string,
  request: TurnRequest,
  allowedHostToolNames: Set<string>,
  toolNameMapper: ToolNameMapper,
  catalogModelId: string = bareModelId
): Record<string, unknown> {
  const systemParts: string[] = [];
  if (request.systemPrompt && request.systemPrompt.length > 0) {
    systemParts.push(request.systemPrompt);
  }

  const contents: Array<Record<string, unknown>> = [];
  for (const msg of request.messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string" && msg.content.length > 0) {
        systemParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as readonly unknown[]) {
          if (typeof part === "string" && part.length > 0) {
            systemParts.push(part);
          } else if (
            part &&
            typeof part === "object" &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            systemParts.push((part as { text: string }).text);
          }
        }
      }
      continue;
    }
    if (msg.role === "user") {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content.length > 0 ? msg.content : " " });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content as readonly unknown[]) {
          if (typeof item === "string") {
            if (item.length > 0) {
              parts.push({ text: item });
            }
          } else if (item && typeof item === "object") {
            const partObj = item as Record<string, unknown>;
            if (partObj.type === "text" && typeof partObj.text === "string") {
              if (partObj.text.length > 0) {
                parts.push({ text: partObj.text });
              }
            } else if (
              partObj.type === "image_url" &&
              typeof partObj.image_url === "object" &&
              partObj.image_url !== null
            ) {
              const imgUrlObj = partObj.image_url as Record<string, unknown>;
              const url = typeof imgUrlObj.url === "string" ? imgUrlObj.url : "";
              const match = /^data:([^;]+);base64,(.+)$/.exec(url);
              if (match) {
                parts.push({
                  inlineData: {
                    mimeType: match[1],
                    data: match[2]
                  }
                });
              } else if (url.length > 0) {
                parts.push({ text: `[Image: ${url}]` });
              }
            } else if (
              partObj.type === "image" &&
              typeof partObj.data === "string" &&
              partObj.data.length > 0
            ) {
              const mime =
                typeof partObj.mimeType === "string"
                  ? partObj.mimeType
                  : typeof partObj.mime === "string"
                    ? partObj.mime
                    : "image/png";
              parts.push({
                inlineData: {
                  mimeType: mime,
                  data: partObj.data
                }
              });
            } else if (
              partObj.type === "image" &&
              typeof partObj.source === "object" &&
              partObj.source !== null
            ) {
              const src = partObj.source as Record<string, unknown>;
              const mime = typeof src.media_type === "string" ? src.media_type : "image/png";
              const data = typeof src.data === "string" ? src.data : "";
              if (data.length > 0) {
                parts.push({
                  inlineData: {
                    mimeType: mime,
                    data
                  }
                });
              }
            } else if (
              partObj.type === "input_audio" &&
              typeof partObj.input_audio === "object" &&
              partObj.input_audio !== null
            ) {
              const audio = partObj.input_audio as Record<string, unknown>;
              const format = typeof audio.format === "string" ? audio.format : "wav";
              const data = typeof audio.data === "string" ? audio.data : "";
              if (data.length > 0) {
                parts.push({
                  inlineData: {
                    mimeType: `audio/${format}`,
                    data
                  }
                });
              }
            } else if (partObj.inlineData && typeof partObj.inlineData === "object") {
              parts.push({ inlineData: partObj.inlineData });
            } else if (partObj.inline_data && typeof partObj.inline_data === "object") {
              const id = partObj.inline_data as Record<string, unknown>;
              parts.push({
                inlineData: {
                  mimeType: id.mime_type ?? id.mimeType ?? "application/octet-stream",
                  data: id.data
                }
              });
            } else if (typeof partObj.text === "string" && partObj.text.length > 0) {
              parts.push({ text: partObj.text });
            }
          }
        }
      }
      if (parts.length === 0) {
        parts.push({ text: " " });
      }
      contents.push({
        role: "user",
        parts
      });
      continue;
    }
    if (msg.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof msg.content === "string" && msg.content.length > 0) {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content as readonly unknown[]) {
          if (typeof item === "string" && item.length > 0) {
            parts.push({ text: item });
          } else if (item && typeof item === "object") {
            const p = item as Record<string, unknown>;
            if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
              parts.push({ text: p.text });
            }
          }
        }
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          const safeName = toolNameMapper.toSafeName(tc.name);
          const callPart: Record<string, unknown> = {
            functionCall: {
              ...(tc.id ? { id: tc.id } : {}),
              name: safeName,
              args:
                typeof tc.arguments === "string"
                  ? parseArguments(tc.arguments)
                  : tc.arguments
            }
          };
          if (modelUsesGeminiThoughtSignatures(catalogModelId) || modelUsesGeminiThoughtSignatures(bareModelId)) {
            const signature = resolveReplayThoughtSignature(tc, catalogModelId);
            callPart.thoughtSignature = signature;
            callPart.thought_signature = signature;
          }
          parts.push(callPart);
        }
      }
      if (parts.length > 0) {
        contents.push({
          role: "model",
          parts
        });
      }
      continue;
    }
    if (msg.role === "tool") {
      let toolOutput = "";
      const inlineImages: Array<{ mimeType: string; data: string }> = [];

      if (typeof msg.content === "string") {
        toolOutput = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        for (const item of msg.content as readonly unknown[]) {
          if (typeof item === "string") {
            textParts.push(item);
          } else if (item && typeof item === "object") {
            const p = item as Record<string, unknown>;
            if (p.type === "text" && typeof p.text === "string") {
              textParts.push(p.text);
            } else if (
              p.type === "image" &&
              typeof p.data === "string" &&
              p.data.length > 0
            ) {
              const mime =
                typeof p.mimeType === "string"
                  ? p.mimeType
                  : typeof p.mime === "string"
                    ? p.mime
                    : "image/png";
              inlineImages.push({ mimeType: mime, data: p.data });
            } else if (
              p.type === "image" &&
              p.source &&
              typeof (p.source as Record<string, unknown>).data === "string"
            ) {
              const src = p.source as Record<string, unknown>;
              const mime = typeof src.media_type === "string" ? src.media_type : "image/png";
              inlineImages.push({ mimeType: mime, data: src.data as string });
            } else if (p.inlineData && typeof (p.inlineData as Record<string, unknown>).data === "string") {
              const id = p.inlineData as Record<string, unknown>;
              inlineImages.push({
                mimeType: (id.mimeType ?? id.mime_type ?? "image/png") as string,
                data: id.data as string
              });
            } else if (p.inline_data && typeof (p.inline_data as Record<string, unknown>).data === "string") {
              const id = p.inline_data as Record<string, unknown>;
              inlineImages.push({
                mimeType: (id.mime_type ?? id.mimeType ?? "image/png") as string,
                data: id.data as string
              });
            } else {
              textParts.push("[Tool output block]");
            }
          }
        }
        toolOutput = textParts.join("\n");
      }

      const functionResponseObj: Record<string, unknown> = {
        name: toolNameMapper.toSafeName(msg.name ?? "tool"),
        ...(msg.toolCallId ? { id: msg.toolCallId } : {}),
        response: { output: toolOutput }
      };

      if (inlineImages.length > 0) {
        functionResponseObj.parts = inlineImages.map((img) => ({
          inlineData: img
        }));
      }

      const toolParts: Array<Record<string, unknown>> = [
        {
          functionResponse: functionResponseObj
        }
      ];

      contents.push({
        role: "user",
        parts: toolParts
      });
      continue;
    }
  }

  const innerRequest: Record<string, unknown> = {
    contents
  };

  if (systemParts.length > 0) {
    innerRequest.systemInstruction = {
      parts: [{ text: systemParts.join("\n\n") }]
    };
  }

  if (request.tools && request.tools.length > 0) {
    innerRequest.tools = [
      {
        functionDeclarations: request.tools.map((tool) => {
          allowedHostToolNames.add(tool.name);
          const safeName = toolNameMapper.toSafeName(tool.name);
          return {
            name: safeName,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            parameters: cleanJsonSchema(tool.parameters)
          };
        })
      }
    ];
  }

  const isPreTieredModel = /-(?:low|medium|high)$/i.test(bareModelId);
  if (request.reasoningEffort !== undefined && !isPreTieredModel) {
    if (request.reasoningEffort === "off") {
      innerRequest.generationConfig = {
        thinkingConfig: {
          includeThoughts: false,
          thinkingBudget: 0
        }
      };
    } else if (/^gemini-2\.5-/i.test(bareModelId)) {
      const budget =
        request.reasoningEffort === "low"
          ? 2048
          : request.reasoningEffort === "medium"
            ? 8192
            : 24576;
      innerRequest.generationConfig = {
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: budget
        }
      };
    } else {
      const levelUpper = toUpstreamThinkingLevel(request.reasoningEffort);
      innerRequest.generationConfig = {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: levelUpper
        }
      };
    }
  }

  const hasFunctionTools = Array.isArray(innerRequest.tools) && innerRequest.tools.length > 0;
  if (
    modelSupportsStructuredOutput(bareModelId) &&
    !hasFunctionTools &&
    (request.responseMimeType !== undefined || request.responseSchema !== undefined)
  ) {
    const generationConfig = {
      ...((innerRequest.generationConfig as Record<string, unknown> | undefined) ?? {})
    };
    if (request.responseMimeType !== undefined) {
      generationConfig.responseMimeType = request.responseMimeType;
    }
    if (request.responseSchema !== undefined) {
      generationConfig.responseSchema = request.responseSchema;
    }
    innerRequest.generationConfig = generationConfig;
  }

  return {
    project: projectId,
    model: bareModelId,
    request: innerRequest,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: `agent-${randomUUID()}`
  };
}

export function formatResetTime(
  resetTimeStr?: string,
  nowMs: number = Date.now()
): { formatted: string; relative: string } | null {
  if (!resetTimeStr || typeof resetTimeStr !== "string" || resetTimeStr.trim().length === 0) {
    return null;
  }
  const resetMs = Date.parse(resetTimeStr);
  if (isNaN(resetMs) || !Number.isFinite(resetMs)) {
    return null;
  }
  const diffMs = resetMs - nowMs;
  const d = new Date(resetMs);
  const timeFormatted = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateFormatted = d.toLocaleDateString([], { month: "short", day: "numeric" });
  const isToday = new Date(nowMs).toDateString() === d.toDateString();
  const formatted = isToday ? timeFormatted : `${dateFormatted}, ${timeFormatted}`;

  if (diffMs <= 0) {
    return { formatted, relative: "momentarily" };
  }
  const totalMins = Math.ceil(diffMs / 60_000);
  if (totalMins < 60) {
    return { formatted, relative: `in ${totalMins}m` };
  }
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const relative = mins > 0 ? `in ${hours}h ${mins}m` : `in ${hours}h`;
  return { formatted, relative };
}

export function extractErrorSummary(errorBody: string): string {
  try {
    const parsed = JSON.parse(errorBody) as {
      error?: { code?: number; message?: string; status?: string };
    };
    if (parsed?.error?.message) {
      return `${parsed.error.status ?? "ERROR"}: ${parsed.error.message}`;
    }
  } catch {
    // Ignore JSON parse errors
  }
  return errorBody.slice(0, 200).trim();
}

export interface GoogleRpc429Classification {
  type: "terminal_quota" | "transient_rate_limit" | "unclassified";
  reason?: string;
  domain?: string;
  retryDelayMs?: number;
  resetAt?: string;
  errorSummary: string;
}

export function classifyGoogleRpc429(
  errorBody: string,
  headers?: { get(name: string): string | null }
): GoogleRpc429Classification {
  const errorSummary = extractErrorSummary(errorBody);
  let parsed: any;
  try {
    parsed = JSON.parse(errorBody);
  } catch {
    // If error body is not valid JSON, check plain text patterns
    const retryMatch = errorBody.match(/(?:Please )?retry in\s+([0-9.]+)\s*s/i);
    let retryDelayMs: number | undefined;
    if (retryMatch && retryMatch[1]) {
      const sec = parseFloat(retryMatch[1]);
      if (Number.isFinite(sec) && sec > 0) {
        retryDelayMs = Math.round(sec * 1000);
      }
    }
    const retryHeader = headers?.get("retry-after");
    if (!retryDelayMs && retryHeader) {
      const sec = parseFloat(retryHeader);
      if (Number.isFinite(sec) && sec > 0) {
        retryDelayMs = Math.round(sec * 1000);
      }
    }
    return {
      type: "unclassified",
      errorSummary,
      ...(retryDelayMs !== undefined ? { retryDelayMs } : {})
    };
  }

  const errorObj = parsed?.error ?? parsed;
  const details = Array.isArray(errorObj?.details) ? errorObj.details : [];

  let classificationType: "terminal_quota" | "transient_rate_limit" | "unclassified" = "unclassified";
  let matchedReason: string | undefined;
  let matchedDomain: string | undefined;
  let resetAt: string | undefined;
  let retryDelayMs: number | undefined;

  for (const item of details) {
    if (!item || typeof item !== "object") continue;

    // Check ErrorInfo
    const typeStr = String(item["@type"] ?? "");
    const isErrorInfo = typeStr.endsWith("google.rpc.ErrorInfo") || (item.reason && item.domain);
    if (isErrorInfo) {
      const domain = String(item.domain ?? "").trim();
      // Requirement: Ignore ErrorInfo whose domain is not a cloudcode/cloudaicompanion domain
      if (domain && !/cloudcode|cloudaicompanion/i.test(domain)) {
        continue;
      }

      const reason = String(item.reason ?? "").trim();
      if (reason === "QUOTA_EXHAUSTED") {
        classificationType = "terminal_quota";
        matchedReason = reason;
        matchedDomain = domain;
        if (item.metadata?.quotaResetTimeStamp) {
          resetAt = String(item.metadata.quotaResetTimeStamp);
        } else if (item.metadata?.quotaResetDelay) {
          let ms = 0;
          const delayStr = String(item.metadata.quotaResetDelay);
          const h = delayStr.match(/(\d+)h/);
          const m = delayStr.match(/(\d+)m/);
          const s = delayStr.match(/(\d+)s/);
          if (h && h[1]) ms += parseInt(h[1], 10) * 3600_000;
          if (m && m[1]) ms += parseInt(m[1], 10) * 60_000;
          if (s && s[1]) ms += parseInt(s[1], 10) * 1000;
          if (ms > 0) resetAt = new Date(Date.now() + ms).toISOString();
        }
      } else if (reason === "RATE_LIMIT_EXCEEDED" || reason === "MODEL_CAPACITY_EXHAUSTED") {
        classificationType = "transient_rate_limit";
        matchedReason = reason;
        matchedDomain = domain;
      }
    }

    // Check RetryInfo
    const isRetryInfo = typeStr.endsWith("google.rpc.RetryInfo") || item.retryDelay !== undefined;
    if (isRetryInfo && item.retryDelay !== undefined) {
      if (typeof item.retryDelay === "string") {
        const sec = parseFloat(item.retryDelay.replace(/s$/i, ""));
        if (Number.isFinite(sec) && sec > 0) {
          retryDelayMs = Math.round(sec * 1000);
        }
      } else if (typeof item.retryDelay === "number" && Number.isFinite(item.retryDelay) && item.retryDelay > 0) {
        retryDelayMs = Math.round(item.retryDelay * 1000);
      } else if (typeof item.retryDelay === "object" && item.retryDelay !== null) {
        const sec = Number(item.retryDelay.seconds || 0);
        const nanos = Number(item.retryDelay.nanos || 0);
        const totalMs = sec * 1000 + Math.round(nanos / 1_000_000);
        if (totalMs > 0) {
          retryDelayMs = totalMs;
        }
      }
    }
  }

  // Fallback retry delay from error message or header
  const msg = String(errorObj?.message ?? "");
  const retryMsgMatch = msg.match(/(?:Please )?retry in\s+([0-9.]+)\s*s/i);
  if (!retryDelayMs && retryMsgMatch && retryMsgMatch[1]) {
    const sec = parseFloat(retryMsgMatch[1]);
    if (Number.isFinite(sec) && sec > 0) {
      retryDelayMs = Math.round(sec * 1000);
    }
  }

  const retryHeader = headers?.get("retry-after");
  if (!retryDelayMs && retryHeader) {
    const sec = parseFloat(retryHeader);
    if (Number.isFinite(sec) && sec > 0) {
      retryDelayMs = Math.round(sec * 1000);
    }
  }

  return {
    type: classificationType,
    ...(matchedReason ? { reason: matchedReason } : {}),
    ...(matchedDomain ? { domain: matchedDomain } : {}),
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    ...(resetAt ? { resetAt } : {}),
    errorSummary
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function processPayloadChunk(
  chunk: RawCompletionPayload,
  allowedHostToolNames: ReadonlySet<string>,
  emittedToolCalls: HostToolCall[],
  onTextDelta?: (delta: string) => void,
  toolNameMapper?: ToolNameMapper,
  onReasoningDelta?: (delta: string) => void
): { textDelta: string; usage?: TurnUsageCounts } {
  if (chunk.error || chunk.response?.error) {
    const rawErr = chunk.error ?? chunk.response?.error;
    const summary =
      rawErr && typeof rawErr === "object"
        ? (rawErr as { message?: string; status?: string }).message
          ? `${(rawErr as { status?: string }).status ?? "ERROR"}: ${(rawErr as { message?: string }).message}`
          : JSON.stringify(rawErr).slice(0, 200)
        : String(rawErr);
    console.error(`[antigravity] SSE chunk reported error: ${summary}`);
    throw new Error(`Endpoint error: ${summary}`);
  }

  checkOfferedNativeTools(chunk);

  let textDelta = "";
  const usage = extractUsage(chunk.usage, chunk.response?.usageMetadata ?? chunk.usageMetadata);

  // 1. OpenAI-compatible choices array
  if (Array.isArray(chunk.choices)) {
    for (const choice of chunk.choices) {
      const delta = choice.delta ?? choice.message;
      if (!delta) {
        continue;
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        textDelta += delta.content;
        onTextDelta?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawTc of delta.tool_calls) {
          const normalizedTc = validateAndNormalizeToolCall(
            rawTc,
            allowedHostToolNames,
            emittedToolCalls.length,
            toolNameMapper
          );
          emittedToolCalls.push(normalizedTc);
        }
      }
    }
  }

  // 2. Antigravity v1internal:streamGenerateContent candidates array
  const candidates = unwrapCandidates<RawGeminiCandidate>(chunk);
  for (const candidate of candidates) {
      const parts = candidate.content?.parts;
      if (!Array.isArray(parts)) {
        continue;
      }
      for (const part of parts) {
        if (part.thought === true) {
          if (typeof part.text === "string" && part.text.length > 0) {
            onReasoningDelta?.(part.text);
          }
          continue;
        }
        if (typeof part.text === "string" && part.text.length > 0) {
          textDelta += part.text;
          onTextDelta?.(part.text);
        }
        if (part.functionCall) {
          const thoughtSignature = extractThoughtSignature(part, part.functionCall);
          const normalizedTc = validateAndNormalizeToolCall(
            {
              ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
              ...(part.functionCall.name ? { name: part.functionCall.name } : {}),
              ...(part.functionCall.args !== undefined
                ? { arguments: part.functionCall.args }
                : {}),
              ...(thoughtSignature ? { thoughtSignature } : {})
            },
            allowedHostToolNames,
            emittedToolCalls.length,
            toolNameMapper
          );
          emittedToolCalls.push(normalizedTc);
        }
      }
    }

  return {
    textDelta,
    ...(usage !== undefined ? { usage } : {})
  };
}

export async function executeTurn(
  request: TurnRequest,
  authStore: AuthProfileStore,
  catalog: CatalogService,
  endpoints: AntigravityEndpoints = DEFAULT_ENDPOINTS,
  fetchImpl: FetchLike = fetch
): Promise<TurnResponse> {
  // 1. Validate credential before any network call
  const accessToken = await getValidAccessToken(authStore, endpoints, fetchImpl);
  const storedSecret = await authStore.getSecret(PROVIDER_ID);

  // 2. Validate model against known subscription catalog before any billable call (Contract §3)
  const bareModelId = stripProviderPrefix(request.model.trim());
  const cachedModels: readonly SubscriptionModelRow[] | null = catalog.getCachedModels();

  if (!cachedModels || cachedModels.length === 0) {
    throw new Error(`unknown model: ${bareModelId}`);
  }

  const resolvedModel = catalog.resolveModelForTurn(bareModelId, request.reasoningEffort);
  if (!resolvedModel) {
    throw new Error(`unknown model: ${bareModelId}`);
  }
  const { matchedModel, upstreamModelId, effectiveEffort } = resolvedModel;

  // 3. Validate reasoning effort if specified by host (Contract §4.2)
  if (request.reasoningEffort !== undefined) {
    if (request.reasoningEffort === "off" && !matchedModel.canDisableReasoning) {
      throw new Error(
        unsupportedReasoningEffortMessage("off", bareModelId, matchedModel.reasoningLevels)
      );
    }
    if (!matchedModel.reasoningLevels.includes(request.reasoningEffort)) {
      throw new Error(
        unsupportedReasoningEffortMessage(
          request.reasoningEffort,
          bareModelId,
          matchedModel.reasoningLevels
        )
      );
    }
  }

  // 4. Construct exact passthrough payload (Contract §4: system prompt, conversation, host tools)
  const allowedHostToolNames = new Set<string>();
  const toolNameMapper = new ToolNameMapper();
  let requestBody: Record<string, unknown>;

  if (
    storedSecret?.projectId &&
    endpoints.chatCompletionsUrl.includes(":streamGenerateContent")
  ) {
    requestBody = buildV1InternalRequestEnvelope(
      upstreamModelId,
      storedSecret.projectId,
      request,
      allowedHostToolNames,
      toolNameMapper,
      bareModelId
    );
  } else {
    const wireMessages: Array<Record<string, unknown>> = [];
    if (request.systemPrompt !== undefined && request.systemPrompt.length > 0) {
      wireMessages.push({
        role: "system",
        content: request.systemPrompt
      });
    }

    for (const msg of request.messages) {
      const wireMsg: Record<string, unknown> = {
        role: msg.role,
        content: msg.content
      };
      if (msg.name !== undefined) {
        wireMsg.name = toolNameMapper.toSafeName(msg.name);
      }
      if (msg.toolCallId !== undefined) {
        wireMsg.tool_call_id = msg.toolCallId;
      }
      if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
        wireMsg.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: toolNameMapper.toSafeName(tc.name),
            arguments:
              typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments)
          }
        }));
      }
      wireMessages.push(wireMsg);
    }

    const wireTools =
      request.tools && request.tools.length > 0
        ? request.tools.map((tool) => {
            allowedHostToolNames.add(tool.name);
            const safeName = toolNameMapper.toSafeName(tool.name);
            return {
              type: "function",
              function: {
                name: safeName,
                ...(tool.description !== undefined ? { description: tool.description } : {}),
                parameters: cleanJsonSchema(tool.parameters)
              }
            };
          })
        : undefined;

    requestBody = {
      model: upstreamModelId,
      messages: wireMessages,
      stream: true
    };

    if (wireTools !== undefined) {
      requestBody.tools = wireTools;
    }
    if (request.reasoningEffort !== undefined) {
      requestBody.reasoning_effort = request.reasoningEffort;
    }
  }

  // 5. Handle timeout / abort signal
  const timeoutController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = (): void => {
    timeoutController.abort(request.signal?.reason ?? new Error("Turn aborted"));
  };

  if (request.signal) {
    if (request.signal.aborted) {
      throw new Error("Turn timeout or aborted before request");
    }
    request.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timeoutController.abort(new Error("Turn request timed out"));
    }, request.timeoutMs);
  }

  const maxRateLimitRetries = 2;
  let rateLimitAttempt = 0;
  let response!: Response;

  while (true) {
    try {
      // Contract §4 & §4.2: Exactly one HTTPS request to the subscription endpoint per turn.
      response = await fetchImpl(endpoints.chatCompletionsUrl, {
        method: "POST",
        headers: {
          ...buildAntigravityHeaders(accessToken),
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json"
        },
        body: JSON.stringify(requestBody),
        signal: timeoutController.signal
      });
    } catch (err) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      request.signal?.removeEventListener("abort", onExternalAbort);
      const message = err instanceof Error ? err.message : String(err);
      if (timeoutController.signal.aborted || /abort|timed?\s*out/i.test(message)) {
        throw new Error("Turn timed out");
      }
      throw err;
    }

    if (response.status === 429) {
      const errorBody = await response.text().catch(() => "");
      const classification = classifyGoogleRpc429(errorBody, response.headers);

      if (classification.type === "transient_rate_limit" && rateLimitAttempt < maxRateLimitRetries) {
        rateLimitAttempt++;
        const rawDelay = classification.retryDelayMs ?? 1000;
        const boundedDelay = Math.min(Math.max(rawDelay, 100), 10_000);
        console.warn(
          `[antigravity] Transient rate limit (429 / ${classification.reason ?? "RATE_LIMIT_EXCEEDED"}). Retrying in ${boundedDelay}ms (attempt ${rateLimitAttempt}/${maxRateLimitRetries})...`
        );
        await sleep(boundedDelay, timeoutController.signal);
        continue;
      }

      console.error(`[antigravity] Quota exceeded HTTP 429: ${classification.errorSummary}`);
      const isTransient = classification.type === "transient_rate_limit";
      const quotaErr = new Error(
        isTransient
          ? `Subscription rate limit exceeded (429): ${classification.errorSummary}`
          : `Subscription quota exceeded (429): ${classification.errorSummary}`
      );
      const info: {
        status: number;
        retryAfter?: string;
        errorBody?: string;
        isTransientRateLimit?: boolean;
        isTerminalQuota?: boolean;
        resetAt?: string;
      } = {
        status: 429,
        errorBody,
        ...(isTransient ? { isTransientRateLimit: true } : { isTerminalQuota: true })
      };
      if (classification.resetAt) {
        info.resetAt = classification.resetAt;
      }
      const retryHeader = response.headers.get("retry-after");
      if (retryHeader) {
        info.retryAfter = retryHeader;
      }
      Object.assign(quotaErr, info);
      throw quotaErr;
    }

    break;
  }

  try {
    if (response.status === 401 || response.status === 403) {
      const errorBody = await response.text().catch(() => "");
      const errorSummary = extractErrorSummary(errorBody);
      if (response.status === 403 && /quota|RESOURCE_EXHAUSTED|exhausted/i.test(errorBody)) {
        console.error(`[antigravity] Quota exceeded HTTP 403: ${errorSummary}`);
        const classification = classifyGoogleRpc429(errorBody, response.headers);
        const quotaErr = new Error(`Subscription quota exceeded (403): ${errorSummary}`);
        const info: {
          status: number;
          retryAfter?: string;
          errorBody?: string;
          isTerminalQuota?: boolean;
          resetAt?: string;
        } = {
          status: 429,
          errorBody,
          isTerminalQuota: true
        };
        if (classification.resetAt) {
          info.resetAt = classification.resetAt;
        }
        const retryHeader = response.headers.get("retry-after");
        if (retryHeader) {
          info.retryAfter = retryHeader;
        }
        Object.assign(quotaErr, info);
        throw quotaErr;
      }
      console.error(`[antigravity] Auth error HTTP ${response.status}: ${errorSummary}`);
      const authErr = new Error(`Authentication error (${response.status}): ${errorSummary}`);
      (authErr as any).status = response.status;
      (authErr as any).code = "UNAUTHENTICATED";
      throw authErr;
    }
    if (response.status === 404) {
      const errorBody = await response.text().catch(() => "");
      const errorSummary = extractErrorSummary(errorBody);
      console.error(
        `[antigravity] Not found HTTP 404 for upstream model ${upstreamModelId} (requested ${bareModelId}): ${errorSummary}`
      );
      const notFoundErr = new Error(`unknown model: ${bareModelId} (${errorSummary})`);
      Object.assign(notFoundErr, {
        status: 404,
        errorBody
      });
      throw notFoundErr;
    }
    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const errorSummary = extractErrorSummary(errorBody);
      console.error(`[antigravity] Subscription turn failed with HTTP ${response.status}: ${errorSummary}`);
      const turnErr = new Error(`Subscription turn failed with HTTP ${response.status}: ${errorSummary}`);
      Object.assign(turnErr, {
        status: response.status,
        code: response.status === 401 ? "UNAUTHENTICATED" : undefined,
        errorBody
      });
      throw turnErr;
    }

    checkOfferedNativeTools({}, response.headers);

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    let fullText = "";
    const emittedToolCalls: HostToolCall[] = [];
    let finalUsage: TurnUsageCounts | undefined;

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

          const chunk = JSON.parse(dataStr) as RawCompletionPayload;
          const processed = processPayloadChunk(
            chunk,
            allowedHostToolNames,
            emittedToolCalls,
            request.onTextDelta,
            toolNameMapper,
            request.onReasoningDelta
          );
          fullText += processed.textDelta;
          if (processed.usage) {
            finalUsage = processed.usage;
          }
        }
      }
    } else {
      const payload = (await response.json()) as RawCompletionPayload;
      checkOfferedNativeTools(payload, response.headers);

      const processed = processPayloadChunk(
        payload,
        allowedHostToolNames,
        emittedToolCalls,
        request.onTextDelta,
        toolNameMapper,
        request.onReasoningDelta
      );
      fullText += processed.textDelta;
      if (processed.usage) {
        finalUsage = processed.usage;
      }
    }

    // Contract §4.1: "An empty reply with a success status is a failure."
    if (fullText.length === 0 && emittedToolCalls.length === 0) {
      throw new Error("Empty reply from subscription endpoint");
    }

    const stampedToolCalls = emittedToolCalls.map((tc) =>
      tc.thoughtSignature && !tc.thoughtSignatureModel
        ? { ...tc, thoughtSignatureModel: bareModelId }
        : tc
    );

    return {
      text: fullText,
      toolCalls: stampedToolCalls,
      ...(finalUsage !== undefined ? { usage: finalUsage } : {})
    };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    request.signal?.removeEventListener("abort", onExternalAbort);
  }
}
