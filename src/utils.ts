/**
 * Safely unwrap candidates from either a raw Gemini chunk ({ candidates: [...] })
 * or an Antigravity v1internal wrapped chunk ({ response: { candidates: [...] } }).
 */
export function unwrapCandidates<T = any>(chunk: unknown): T[] {
  if (!chunk || typeof chunk !== "object") {
    return [];
  }
  const obj = chunk as Record<string, any>;
  const candidates = obj.response?.candidates ?? obj.candidates;
  return Array.isArray(candidates) ? candidates : [];
}
