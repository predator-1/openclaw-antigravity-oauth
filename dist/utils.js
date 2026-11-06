/**
 * Safely unwrap candidates from either a raw Gemini chunk ({ candidates: [...] })
 * or an Antigravity v1internal wrapped chunk ({ response: { candidates: [...] } }).
 */
export function unwrapCandidates(chunk) {
    if (!chunk || typeof chunk !== "object") {
        return [];
    }
    const obj = chunk;
    const candidates = obj.response?.candidates ?? obj.candidates;
    return Array.isArray(candidates) ? candidates : [];
}
//# sourceMappingURL=utils.js.map