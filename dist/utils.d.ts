/**
 * Safely unwrap candidates from either a raw Gemini chunk ({ candidates: [...] })
 * or an Antigravity v1internal wrapped chunk ({ response: { candidates: [...] } }).
 */
export declare function unwrapCandidates<T = any>(chunk: unknown): T[];
//# sourceMappingURL=utils.d.ts.map