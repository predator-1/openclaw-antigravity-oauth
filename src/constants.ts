import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AntigravityEndpoints } from "./types.js";

export const PROVIDER_ID = "antigravity" as const;
export const PLUGIN_ID = "openclaw-antigravity-oauth" as const;

export const CLI_VERSION = "1.5.3" as const;

const AGY_OS_NAMES: Record<string, string> = { win32: "windows", sunos: "solaris" };
const AGY_ARCH_NAMES: Record<string, string> = { x64: "amd64", ia32: "386" };

function agyToken(value: unknown, aliases: Record<string, string>): string {
  if (typeof value !== "string" || value === "") return "unknown";
  return aliases[value] ?? value;
}

/** Map Node `os.platform()` / `os.arch()` to Go-style User-Agent tokens. Never throws. */
export function mapAgyOsArch(platform?: unknown, arch?: unknown): { os: string; arch: string } {
  return { os: agyToken(platform, AGY_OS_NAMES), arch: agyToken(arch, AGY_ARCH_NAMES) };
}

export function getAgyPlatform(): string {
  return mapAgyOsArch(os.platform(), os.arch()).os;
}

export function getAgyArch(): string {
  return mapAgyOsArch(os.platform(), os.arch()).arch;
}

export function buildAgyUserAgent(platform?: unknown, arch?: unknown): string {
  const resolvedPlatform = arguments.length > 0 ? platform : os.platform();
  const resolvedArch = arguments.length > 1 ? arch : os.arch();
  const { os: osToken, arch: archToken } = mapAgyOsArch(resolvedPlatform, resolvedArch);
  return `antigravity/cli/${CLI_VERSION} ${osToken}/${archToken}`;
}

export const DEFAULT_PROJECT_ID = "default-cli-project" as const;

export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image" as const;

export const DEFAULT_IMAGE_TIMEOUT_MS = 180_000 as const;

export const DEFAULT_ENDPOINTS: Readonly<AntigravityEndpoints> = Object.freeze({
  deviceCodeUrl: "https://oauth2.googleapis.com/device/code",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
  verifySubscriptionUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  modelsUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  usageUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  userQuotaUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
  chatCompletionsUrl:
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  loopbackRedirectUri: "http://localhost:51121/oauth-callback"
});

export const ANTIGRAVITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent": buildAgyUserAgent()
});

export const ANTIGRAVITY_CLI_USER_AGENT = buildAgyUserAgent();

export function buildAntigravityHeaders(accessToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": buildAgyUserAgent(),
    "x-activity-request-id": randomUUID()
  };
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  return headers;
}

export function buildAntigravityQuotaHeaders(accessToken: string): Record<string, string> {
  return {
    ...buildAntigravityHeaders(accessToken),
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs"
].join(" ");

/**
 * Consumer CLI / server-side native tools that must NEVER be offered or executed.
 * Spec §4: "That list includes shell, files, URL fetch, browser, inbox, message send,
 * scheduler, image generation, subagents, workflows, background tasks, notebooks, and manage_task."
 */
export const NATIVE_CLI_TOOLS: ReadonlySet<string> = new Set([
  "manage_task",
  "run_command",
  "shell",
  "bash",
  "sh",
  "zsh",
  "exec",
  "read_file",
  "write_file",
  "edit_file",
  "files",
  "list_dir",
  "glob",
  "grep",
  "url_fetch",
  "fetch_url",
  "web_fetch",
  "search_web",
  "browser",
  "open_browser",
  "inbox",
  "message_send",
  "send_message",
  "scheduler",
  "schedule",
  "image_generation",
  "generate_image",
  "subagents",
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "workflows",
  "background_tasks",
  "notebooks",
  "notebook_edit"
]);

export const NON_CHAT_MODALITIES: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "embedding",
  "embeddings",
  "speech",
  "tts",
  "asr",
  "moderation"
]);

export const NON_CHAT_ID_PATTERNS: readonly RegExp[] = [
  /\bimagen\b/i,
  /\bimage\b/i,
  /\bveo\b/i,
  /\bchirp\b/i,
  /\bembedding\b/i,
  /\btts\b/i,
  /\bwhisper\b/i,
  /\baudio\b/i,
  /\bvideo\b/i,
  /\bspeech\b/i,
  /^chat_\d+/i,
  /^tab_/i,
  /^MODEL_/i,
  /^gemini-2\.5/i,
  /^gemini-3\.1/i,
  // Other Gemini 3.5 ids stay filtered; gemini-3.5-flash-lite is the cheap chat model.
  /^gemini-3\.5(?!-flash-lite(?:-(?:low|medium|high|tiered))?$)/i
];
