import type { AntigravityEndpoints } from "./types.js";
export declare const PROVIDER_ID: "antigravity";
export declare const PLUGIN_ID: "openclaw-antigravity-oauth";
export declare const CLI_VERSION: "1.5.2";
/** Map Node `os.platform()` / `os.arch()` to Go-style User-Agent tokens. Never throws. */
export declare function mapAgyOsArch(platform?: unknown, arch?: unknown): {
    os: string;
    arch: string;
};
export declare function getAgyPlatform(): string;
export declare function getAgyArch(): string;
export declare function buildAgyUserAgent(platform?: unknown, arch?: unknown): string;
export declare const DEFAULT_PROJECT_ID: "default-cli-project";
export declare const DEFAULT_IMAGE_MODEL: "gemini-3.1-flash-image";
export declare const DEFAULT_IMAGE_TIMEOUT_MS: 180000;
export declare const DEFAULT_ENDPOINTS: Readonly<AntigravityEndpoints>;
export declare const ANTIGRAVITY_HEADERS: Readonly<Record<string, string>>;
export declare const ANTIGRAVITY_CLI_USER_AGENT: string;
export declare function buildAntigravityHeaders(accessToken?: string): Record<string, string>;
export declare function buildAntigravityQuotaHeaders(accessToken: string): Record<string, string>;
export declare const OAUTH_SCOPES: string;
/**
 * Consumer CLI / server-side native tools that must NEVER be offered or executed.
 * Spec §4: "That list includes shell, files, URL fetch, browser, inbox, message send,
 * scheduler, image generation, subagents, workflows, background tasks, notebooks, and manage_task."
 */
export declare const NATIVE_CLI_TOOLS: ReadonlySet<string>;
export declare const NON_CHAT_MODALITIES: ReadonlySet<string>;
export declare const NON_CHAT_ID_PATTERNS: readonly RegExp[];
//# sourceMappingURL=constants.d.ts.map