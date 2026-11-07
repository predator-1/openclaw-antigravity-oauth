import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeError } from "../dist/sanitize.js";

const opaque = "fixture-opaque-credential";

describe("shared error sanitization", () => {
  it("redacts nested JSON token objects and nested JSON strings", () => {
    const input = JSON.stringify({ nested: [
      { token: { arbitrary: opaque } },
      { details: { accessToken: opaque, refresh_token: opaque } },
      { encoded: JSON.stringify({ inner: { id_token: opaque } }) }
    ] });
    const output = sanitizeError(input);
    assert.ok(!output.includes(opaque));
    assert.match(output, /REDACTED/);
    assert.ok(!sanitizeError(`refresh failed: ${input}`).includes(opaque));
  });
  it("redacts x-goog-api-key headers", () => {
    for (const input of [`x-goog-api-key: ${opaque}`, JSON.stringify({ headers: { "x-goog-api-key": opaque } })]) {
      assert.ok(!sanitizeError(input).includes(opaque));
    }
  });
  it("redacts Authorization Basic credentials", () => {
    assert.ok(!sanitizeError(`Authorization: Basic ${opaque}`).includes(opaque));
    assert.ok(!sanitizeError(JSON.stringify({ Authorization: `Basic ${opaque}` })).includes(opaque));
  });
  it("redacts email identities", () => {
    const address = ["fixture-user", "example.invalid"].join("@");
    assert.ok(!sanitizeError(`resolver failed for ${address}`).includes(address));
    assert.ok(!sanitizeError(JSON.stringify({ nested: { email: address } })).includes(address));
  });
  it("redacts project paths and named project fields", () => {
    const project = "fixture-project-id";
    assert.ok(!sanitizeError(`failed for projects/${project}`).includes(project));
    assert.ok(!sanitizeError(JSON.stringify({ nested: { projectId: project, project_number: "fixture-number" } })).includes(project));
    assert.ok(!sanitizeError(`projectId=${project}`).includes(project));
  });
  it("redacts message causes and reexports the identical sanitizer from the smoke", async () => {
    const smoke = await import("../scripts/integration-smoke.js");
    assert.equal(smoke.sanitizeError, sanitizeError);
    const out = sanitizeError(new Error("network failure", { cause: new Error(`apiKey=${opaque}`) }));
    assert.match(out, /network failure/); assert.ok(!out.includes(opaque));
  });
});


describe("bounded sanitizer input and fragment preservation", () => {
  const limit = 16 * 1024;
  const marker = " [TRUNCATED]";

  it("caps one MiB of unbalanced brackets before JSON or text processing", () => {
    const output = sanitizeError("[".repeat(1024 * 1024));
    assert.equal(output, "[".repeat(limit) + marker);
    assert.equal(Buffer.byteLength(output), limit + marker.length);
  });

  it("still redacts a secret inside the retained prefix of oversized input", () => {
    const input = `retained token=${opaque} ` + "[".repeat(1024 * 1024);
    const output = sanitizeError(input);
    assert.ok(!output.includes(opaque));
    assert.match(output, /token=\[REDACTED\]/);
    assert.ok(output.endsWith(marker));
    assert.ok(Buffer.byteLength(output) <= limit + marker.length);
  });

  it("uses a UTF-8 byte limit across messages and causes", () => {
    const output = sanitizeError(new Error("prefix", { cause: new Error("é".repeat(limit)) }));
    assert.ok(output.startsWith("prefix: "));
    assert.ok(output.endsWith(marker));
    assert.ok(Buffer.byteLength(output) <= limit + marker.length);
    assert.ok(!output.includes("\uFFFD"));
  });

  it("preserves surrounding text and valid redacted JSON without double-redaction", () => {
    const output = sanitizeError('failed: {"token":"sv"} tail');
    assert.equal(output, 'failed: {"token":"[REDACTED]"} tail');
    assert.deepEqual(JSON.parse(output.slice("failed: ".length, -" tail".length)), { token: "[REDACTED]" });
  });
});
