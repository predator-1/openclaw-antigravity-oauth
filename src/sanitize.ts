/** Redact credentials and account identifiers without serializing raw error objects. */
export function sanitizeError(error: unknown): string {
  if (!error) return "unknown error";
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current: unknown = error; current && messages.length < 3 && !seen.has(current);) {
    seen.add(current);
    const item = current as { message?: unknown; cause?: unknown };
    messages.push(typeof item.message === "string" ? item.message : String(current));
    current = item.cause;
  }
  return redactText(messages.join(": ")).trim();
}

const SECRET_KEY = /^(?:access_?token|refresh_?token|id_?token|client_?secret|api_?key|token|secret|x-goog-api-key|authorization)$/i;
const IDENTITY_KEY = /^(?:email|project|project_?id|project_?number)$/i;

function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      SECRET_KEY.test(key) ? "[REDACTED]" : IDENTITY_KEY.test(key) ? "[REDACTED_ID]" : redactJson(item)
    ]));
  }
  return value;
}

function redactJsonFragments(text: string): string {
  let output = "";
  let cursor = 0;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '\"') quoted = false;
      } else if (char === '\"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if ((char === "}" || char === "]") && --depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, end + 1));
          output += text.slice(cursor, start) + JSON.stringify(redactJson(value));
          cursor = end + 1;
          start = end;
        } catch { /* Not JSON: field redaction still applies. */ }
        break;
      }
    }
  }
  return output + text.slice(cursor);
}

function redactText(text: string): string {
  // Whole JSON and nested JSON strings retain structure, never credential values.
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") return JSON.stringify(redactJson(parsed));
  } catch { /* Plain diagnostic text or embedded JSON: redact fields below. */ }
  return redactJsonFragments(text)
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]")
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9._~+/=-]+/gi, "$1 [REDACTED_TOKEN]")
    .replace(/\bya29\.[a-zA-Z0-9._-]+/g, "[REDACTED_TOKEN]")
    .replace(/(^|[^a-zA-Z0-9])1\/\/[a-zA-Z0-9._-]{8,}/g, "$1[REDACTED_TOKEN]")
    .replace(/\bGOCSPX-[a-zA-Z0-9_-]+/g, "[REDACTED_SECRET]")
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*/g, "[REDACTED_JWT]")
    .replace(/((?:\\?["'])?(?:access_?token|refresh_?token|id_?token|client_?secret|api_?key|token|secret|x-goog-api-key|authorization)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[^"'\\&\s,}\]{]+/gi, "$1[REDACTED]")
    .replace(/\bprojects\/[a-z0-9][a-z0-9-]*/gi, "projects/[REDACTED]")
    .replace(/((?:\\?["'])?(?:email|project_?id|project_?number)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[^"'\\&\s,}\]{]+/gi, "$1[REDACTED_ID]");
}
