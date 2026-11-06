import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const smoke = await import(pathToFileURL(path.resolve("scripts/integration-smoke.js")).href);

// Obviously fake values shaped like real Google credentials.
const FAKE_ACCESS = "ya29.FAKE-access-token-for-tests_0123456789";
const FAKE_REFRESH = "1//0FAKE-refresh-token-for-tests_abcdef";

function writeTmp(name: string, content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-login-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

describe("integration-smoke: argument parsing", () => {
  it("defaults to the openclaw auth source (agy is opt-in), agy default path under HOME, and 5 usage windows", () => {
    const args = smoke.parseArgs([], {});
    assert.equal(args.authSource, "openclaw");
    assert.equal(args.agentId, "main");
    assert.equal(args.minUsageWindows, 5);
    assert.equal(args.agyTokenFile, path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token"));
  });

  it("honours --auth-source, --agy-token-file, AGY_TOKEN_FILE and --min-usage-windows", () => {
    const a = smoke.parseArgs(["--auth-source=agy", "--agy-token-file=/x/token", "--min-usage-windows=3", "--json"], {});
    assert.deepEqual(
      { s: a.authSource, f: a.agyTokenFile, m: a.minUsageWindows, j: a.json },
      { s: "agy", f: "/x/token", m: 3, j: true }
    );
    assert.equal(smoke.parseArgs([], { AGY_TOKEN_FILE: "/env/token" }).agyTokenFile, "/env/token");
    assert.equal(smoke.parseArgs(["--model=antigravity/a=b"], {}).targetModel, "antigravity/a=b");
  });

  it("rejects invalid values", () => {
    assert.throws(() => smoke.parseArgs(["--auth-source=keychain"], {}), /Invalid --auth-source/);
    assert.throws(() => smoke.parseArgs(["--min-usage-windows=-1"], {}), /Invalid --min-usage-windows/);
    assert.throws(() => smoke.parseArgs(["--min-usage-windows=two"], {}), /Invalid --min-usage-windows/);
  });
});

describe("integration-smoke: agy auth source", () => {
  it("maps the agy login file to an in-memory profile without a projectId", () => {
    const file = writeTmp(
      "antigravity-oauth-token",
      JSON.stringify({
        token: { access_token: FAKE_ACCESS, token_type: "Bearer", refresh_token: FAKE_REFRESH, expiry: "2026-11-01T20:59:56+02:00" },
        auth_method: "consumer"
      })
    );
    const before = fs.readFileSync(file, "utf8");
    const p = smoke.loadAgyCliProfile(file);
    assert.equal(p.source, "agy");
    assert.equal(p.accessToken, FAKE_ACCESS);
    assert.equal(p.refreshToken, FAKE_REFRESH);
    assert.equal(p.expiresAt, Date.parse("2026-11-01T18:59:56Z"));
    assert.equal(p.projectId, undefined);
    assert.equal(fs.readFileSync(file, "utf8"), before, "login file must not be modified");
  });

  it("treats a missing expiry as expired so the token is refreshed in memory", () => {
    const file = writeTmp("t", JSON.stringify({ token: { access_token: FAKE_ACCESS, refresh_token: FAKE_REFRESH } }));
    assert.equal(smoke.loadAgyCliProfile(file).expiresAt, 0);
  });

  it("returns null when the file does not exist", () => {
    assert.equal(smoke.loadAgyCliProfile(path.join(os.tmpdir(), "definitely-missing-agy-token")), null);
  });

  it("never echoes file contents in errors", () => {
    const bad = writeTmp("t", `{"token": "${FAKE_ACCESS}"`);
    assert.throws(
      () => smoke.loadAgyCliProfile(bad),
      (err: Error) => /not valid JSON/.test(err.message) && !err.message.includes(FAKE_ACCESS)
    );
    const wrongShape = writeTmp("t", JSON.stringify({ token: { foo: FAKE_ACCESS } }));
    assert.throws(
      () => smoke.loadAgyCliProfile(wrongShape),
      (err: Error) => /unexpected shape/.test(err.message) && !err.message.includes(FAKE_ACCESS)
    );
  });

  it("resolveSmokeProfile honours the requested source and auto fallback order", async () => {
    const openclaw = async () => ({ accessToken: "oc", refreshToken: "r", expiresAt: 1 });
    const none = async () => null;
    const agy = () => ({ accessToken: "agy", refreshToken: "r", expiresAt: 1 });
    assert.equal((await smoke.resolveSmokeProfile({ authSource: "auto" }, { openclaw, agy })).source, "openclaw");
    assert.equal((await smoke.resolveSmokeProfile({ authSource: "auto" }, { openclaw: none, agy })).source, "agy");
    assert.equal((await smoke.resolveSmokeProfile({ authSource: "agy" }, { openclaw, agy })).source, "agy");
    assert.equal(await smoke.resolveSmokeProfile({ authSource: "openclaw" }, { openclaw: none, agy }), null);
    assert.equal(await smoke.resolveSmokeProfile({ authSource: "agy" }, { openclaw, agy: () => null }), null);
    // Without an explicit source the agy login is never consulted
    let agyCalled = false;
    const spyAgy = () => {
      agyCalled = true;
      return { accessToken: "agy", refreshToken: "r", expiresAt: 1 };
    };
    assert.equal(await smoke.resolveSmokeProfile({}, { openclaw: none, agy: spyAgy }), null);
    assert.equal(agyCalled, false);
  });
});

describe("integration-smoke: evaluation and redaction", () => {
  it("pong requires the word pong", () => {
    assert.equal(smoke.evaluatePongTurn("m", { text: "Pong." }).status, "pass");
    assert.equal(smoke.evaluatePongTurn("m", { text: "ping" }).status, "fail");
    assert.equal(smoke.evaluatePongTurn("m", { text: "" }).status, "fail");
  });

  it("image describe requires non-empty text", () => {
    assert.equal(smoke.evaluateImageDescribe("m", { text: "Red" }).status, "pass");
    assert.equal(smoke.evaluateImageDescribe("m", { text: "  " }).status, "fail");
  });

  it("usage minimum is configurable", () => {
    const quota = { buckets: [{}, {}, {}] };
    assert.equal(smoke.evaluateUsage(quota).status, "fail");
    assert.equal(smoke.evaluateUsage(quota, 3).status, "pass");
  });

  it("fetch requires the run-time nonce in the body", () => {
    assert.equal(smoke.evaluateFetch({ text: "n=abc-123 more" }, "abc-123").status, "pass");
    assert.equal(smoke.evaluateFetch({ text: "cached page" }, "abc-123").status, "fail");
  });

  it("redacts bare access/refresh tokens, client secrets, JWTs and token fields", () => {
    const msg = [
      `access ${FAKE_ACCESS}`,
      `refresh ${FAKE_REFRESH}`,
      "secret GOCSPX-FAKEFAKEFAKEFAKE",
      "jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
      `{"refresh_token":"opaque-value-123"}`,
      "client_secret=opaque&x=1"
    ].join(" | ");
    const out = smoke.sanitizeError(msg);
    for (const leaked of [FAKE_ACCESS, FAKE_REFRESH, "GOCSPX-FAKE", "eyJhbGci", "opaque-value-123", "client_secret=opaque"]) {
      assert.ok(!out.includes(leaked), `leaked ${leaked}: ${out}`);
    }
    // Ordinary paths and URLs survive
    assert.equal(smoke.sanitizeError("GET https://example.com/v1/models failed"), "GET https://example.com/v1/models failed");
  });
  it("redacts camelCase/compact token fields and named project ids", () => {
    const msg = [
      `{"accessToken":"opaque-a-111"}`,
      `{"refreshToken": "opaque-r-222"}`,
      "idToken=opaque-i-333",
      `{"clientSecret":"opaque-c-444"}`,
      "ACCESSTOKEN: opaque-u-555",
      "projects/my-secret-proj-42/locations/global",
      "projects/1234567890"
    ].join(" | ");
    const out = smoke.sanitizeError(msg);
    for (const leaked of ["opaque-a-111", "opaque-r-222", "opaque-i-333", "opaque-c-444", "opaque-u-555", "my-secret-proj-42", "1234567890"]) {
      assert.ok(!out.includes(leaked), `leaked ${leaked}: ${out}`);
    }
    assert.match(out, /projects\/\[REDACTED\]\/locations\/global/);
  });

  it("treats model 404 / unknown model / NOT_FOUND as fail, not a quota skip", () => {
    const a = smoke.classifySmokeResult(
      Object.assign(new Error("unknown model: gemini-4-argon (HTTP 404 NOT_FOUND: Requested entity was not found.)"), {
        status: 404
      })
    );
    assert.equal(a.status, "fail");
    assert.match(String(a.error), /unknown model/);

    const b = smoke.classifySmokeResult(new Error("HTTP 404 NOT_FOUND: Requested entity was not found."));
    assert.equal(b.status, "fail");

    const quota = smoke.classifySmokeResult(
      new Error("Individual quota reached. Please upgrade your subscription. Resets in 2h.")
    );
    assert.equal(quota.status, "skipped");
    assert.equal(quota.reason, "quota_exhausted");
  });

  it("redacts the quota reset hint copied from upstream errors", () => {
    const res = smoke.classifySmokeResult(
      new Error(`429 quota exhausted. Resets in 3h for projects/my-proj-9 user someone@example.com token ${FAKE_ACCESS}`)
    );
    assert.equal(res.status, "skipped");
    for (const leaked of ["my-proj-9", "someone@example.com", FAKE_ACCESS]) {
      assert.ok(!res.resetTime.includes(leaked), `leaked ${leaked}: ${res.resetTime}`);
    }
    assert.match(res.resetTime, /^3h/);
  });

  it("--json routes console.log/info/debug to stderr and keeps stdout for the JSON report", () => {
    const errors: unknown[][] = [];
    const stdout: string[] = [];
    const fakeConsole: any = { log: () => assert.fail("stdout"), info: () => assert.fail("stdout"), debug: () => assert.fail("stdout"), error: (...a: unknown[]) => errors.push(a) };
    const emit = smoke.routeConsoleToStderr(fakeConsole, (t: string) => stdout.push(t));
    fakeConsole.info("[antigravity] OAuth token refresh succeeded");
    fakeConsole.log("x");
    fakeConsole.debug("y");
    emit(JSON.stringify({ status: "ok" }));
    assert.equal(errors.length, 3);
    assert.deepEqual(stdout, ['{"status":"ok"}\n']);
    assert.deepEqual(JSON.parse(stdout.join("")), { status: "ok" });
  });
});

describe("integration-smoke: image generation retry", () => {
  it("retries once on HTTP 503 / UNAVAILABLE, deadline expired and HTTP 500 INTERNAL only", () => {
    const t = smoke.isTransientImageError;
    assert.equal(t(new Error("[antigravity] Image generation failed with HTTP 503: UNAVAILABLE")), true);
    assert.equal(t(new Error("[antigravity] Image generation failed with HTTP 500: INTERNAL: Internal error encountered.")), true);
    assert.equal(t(new Error("deadline expired before operation could complete")), true);
    assert.equal(t(new Error("[antigravity] Image generation failed with HTTP 400: INVALID_ARGUMENT")), false);
    assert.equal(t(new Error("[antigravity] Quota exceeded HTTP 429: RESOURCE_EXHAUSTED")), false);
    assert.equal(t(new Error("Antigravity image generation blocked (SAFETY)")), false);
    // Model-aware HTTP diagnostics must preserve the smoke's retry classification.
    for (const [status, summary, transient] of [
      [503, "UNAVAILABLE", true],
      [500, "INTERNAL", true],
      [400, "INVALID_ARGUMENT", false],
      [404, "NOT_FOUND", false],
      [429, "RESOURCE_EXHAUSTED", false]
    ] as const) {
      assert.equal(t(new Error(`[antigravity] Image generation failed with HTTP ${status} (model gemini-3.1-flash-image): ${summary}`)), transient);
    }
  });
});

describe("integration-smoke: catalog check", () => {
  it("compares upstream against published models only; legacy mapping ids are never 'removed'", async () => {
    const catalog = await import(pathToFileURL(path.resolve("dist/catalog.js")).href);
    for (const id of ["gemini-2.5-flash", "gemini-2.5-flash-thinking", "gemini-2.5-pro", "gemini-3.1-flash-lite"]) {
      assert.ok(!catalog.KNOWN_CATALOG_MODELS.includes(id), id);
      assert.ok(catalog.LEGACY_MAPPED_MODELS.includes(id), id);
    }
    const published = ["claude-opus-5-5", "claude-sonnet-5-5", "gemini-3.8-flash", "gpt-oss-120b", "gemini-4-argon"];
    for (const id of published) assert.ok(catalog.KNOWN_CATALOG_MODELS.includes(id), id);
    const res = smoke.evaluateCatalog(published.map((id) => ({ id })), catalog.KNOWN_CATALOG_MODELS);
    assert.deepEqual(res.data.added, []);
    assert.ok(res.data.removed.every((id: string) => !catalog.LEGACY_MAPPED_MODELS.includes(id)));
  });
});
