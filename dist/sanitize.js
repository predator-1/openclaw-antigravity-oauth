const MAX_INPUT_BYTES = 16 * 1024;
const TRUNCATION_MARKER = " [TRUNCATED]";
/** Redact credentials and account identifiers without serializing raw error objects. */
export function sanitizeError(error) {
    if (!error)
        return "unknown error";
    const messages = [];
    const seen = new Set();
    let remaining = MAX_INPUT_BYTES;
    let truncated = false;
    for (let current = error; current && messages.length < 3 && !seen.has(current);) {
        seen.add(current);
        const item = current;
        const message = typeof item.message === "string" ? item.message : String(current);
        const separatorBytes = messages.length ? 2 : 0;
        if (remaining <= separatorBytes) {
            truncated = true;
            break;
        }
        remaining -= separatorBytes;
        // Slice first: even UTF-8 encoding only sees a bounded prefix, never the full input.
        const prefix = message.slice(0, remaining);
        const encoded = Buffer.from(prefix, "utf8");
        // Streaming decode omits any partial trailing UTF-8 code point at the byte limit.
        const retained = new TextDecoder().decode(encoded.subarray(0, remaining), { stream: true });
        messages.push(retained);
        truncated = prefix.length < message.length || encoded.length > remaining;
        remaining -= Buffer.byteLength(retained, "utf8");
        if (truncated)
            break;
        current = item.cause;
    }
    return redactText(messages.join(": ")).trim() + (truncated ? TRUNCATION_MARKER : "");
}
const SECRET_KEY = /^(?:access_?token|refresh_?token|id_?token|client_?secret|api_?key|token|secret|x-goog-api-key|authorization)$/i;
const IDENTITY_KEY = /^(?:email|project|project_?id|project_?number)$/i;
function redactJson(value) {
    if (typeof value === "string")
        return redactText(value);
    if (Array.isArray(value))
        return value.map(redactJson);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
            SECRET_KEY.test(key) ? "[REDACTED]" : IDENTITY_KEY.test(key) ? "[REDACTED_ID]" : redactJson(item)
        ]));
    }
    return value;
}
function redactJsonFragments(text) {
    let output = "";
    let cursor = 0;
    for (let start = 0; start < text.length; start++) {
        if (text[start] !== "{" && text[start] !== "[")
            continue;
        let depth = 0;
        let quoted = false;
        let escaped = false;
        for (let end = start; end < text.length; end++) {
            const char = text[end];
            if (quoted) {
                if (escaped)
                    escaped = false;
                else if (char === "\\")
                    escaped = true;
                else if (char === '\"')
                    quoted = false;
            }
            else if (char === '\"')
                quoted = true;
            else if (char === "{" || char === "[")
                depth++;
            else if ((char === "}" || char === "]") && --depth === 0) {
                try {
                    const value = JSON.parse(text.slice(start, end + 1));
                    output += redactPlainText(text.slice(cursor, start)) + JSON.stringify(redactJson(value));
                    cursor = end + 1;
                    start = end;
                }
                catch { /* Not JSON: field redaction still applies. */ }
                break;
            }
        }
    }
    return output + redactPlainText(text.slice(cursor));
}
function redactText(text) {
    // Whole JSON and nested JSON strings retain structure, never credential values.
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object")
            return JSON.stringify(redactJson(parsed));
    }
    catch { /* Plain diagnostic text or embedded JSON: redact fields below. */ }
    return redactJsonFragments(text);
}
function redactPlainText(text) {
    return text
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
//# sourceMappingURL=sanitize.js.map