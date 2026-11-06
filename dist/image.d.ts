import type { AntigravityEndpoints, AntigravityImageGenerationProvider, AuthProfileStore, FetchLike, ImageGenerationRequest, ImageGenerationResult, ModelAuthRuntime } from "./types.js";
export interface BuildImageProviderOptions {
    endpoints?: Partial<AntigravityEndpoints> | undefined;
    fetchFn?: FetchLike | undefined;
    defaultAuthStore?: AuthProfileStore | undefined;
    modelAuth?: ModelAuthRuntime | undefined;
}
export declare const BLOCKED_FINISH_REASONS: ReadonlySet<string>;
export declare function resolveImageModel(model?: string): {
    canonicalId: string;
    upstreamSlug: string;
};
export declare function mapSizeToImageConfig(size?: string): {
    aspectRatio?: string;
    imageSize?: string;
} | undefined;
export declare function executeAntigravityImageGeneration(req: ImageGenerationRequest, options?: BuildImageProviderOptions): Promise<ImageGenerationResult>;
export declare function buildAntigravityImageGenerationProvider(options?: BuildImageProviderOptions): AntigravityImageGenerationProvider;
//# sourceMappingURL=image.d.ts.map