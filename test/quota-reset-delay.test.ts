import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyGoogleRpc429 } from "../dist/turn.js";

const NOW = Date.UTC(2026, 10, 7, 20, 0, 0);

function quotaError(delay: unknown, metadata: Record<string, unknown> = {}, reason = "QUOTA_EXHAUSTED", domain = "cloudcode.googleapis.com") {
  return JSON.stringify({ error: {
    code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota fixture",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain,
      metadata: { quotaResetDelay: delay, ...metadata } }]
  } });
}

describe("quotaResetDelay token parsing through classifyGoogleRpc429", () => {
  const valid: [string, number][] = [
    ["1h", 3_600_000], ["2m", 120_000], ["3s", 3_000],
    ["1h2m3.5s", 3_723_500], ["123.456ms", 123.456], ["1.5s", 1_500],
    ["1ms", 1], ["1h2m3s4.5ms", 3_723_004.5], ["1.5h", 5_400_000],
    [".5m", 30_000], ["1.s", 1_000], ["1s250ms", 1_250]
  ];
  for (const [delay, ms] of valid) {
    it("parses " + delay, (t) => {
      t.mock.method(Date, "now", () => NOW);
      const result = classifyGoogleRpc429(quotaError(delay));
      assert.equal(result.type, "terminal_quota");
      assert.equal(result.reason, "QUOTA_EXHAUSTED");
      assert.equal(result.domain, "cloudcode.googleapis.com");
      assert.equal(result.resetAt, new Date(NOW + ms).toISOString());
      assert.equal(result.retryDelayMs, undefined);
    });
  }

  const invalid: unknown[] = [
    "", " ", "garbage", "garbage1h", "1hgarbage", "1h2", "1e3s", "1.2.3s",
    "1h 2m", "123.456mss", "3us", "-1s", "+1s", "NaNs", "Infinitys", "0s",
    null, 1234, {}, true, "999999999999999999h", "9".repeat(400) + "s"
  ];
  for (const [index, delay] of invalid.entries()) {
    it("omits resetAt for invalid/nonpositive/out-of-range value " + index, (t) => {
      t.mock.method(Date, "now", () => NOW);
      const result = classifyGoogleRpc429(quotaError(delay));
      assert.equal(result.type, "terminal_quota");
      assert.equal(result.reason, "QUOTA_EXHAUSTED");
      assert.equal(result.resetAt, undefined);
    });
  }

  it("keeps timestamp precedence over a valid delay", (t) => {
    t.mock.method(Date, "now", () => NOW);
    const timestamp = "2026-11-08T01:02:03Z";
    assert.equal(classifyGoogleRpc429(quotaError("1.5s", { quotaResetTimeStamp: timestamp })).resetAt, timestamp);
  });

  it("keeps timestamp precedence over a malformed delay", () => {
    const timestamp = "2026-11-08T01:02:03Z";
    assert.equal(classifyGoogleRpc429(quotaError("garbage1h", { quotaResetTimeStamp: timestamp })).resetAt, timestamp);
  });

  it("leaves transient classification and Retry-After handling unchanged", () => {
    const result = classifyGoogleRpc429(quotaError("1h", {}, "RATE_LIMIT_EXCEEDED"), {
      get: (name) => name === "retry-after" ? "2" : null
    });
    assert.equal(result.type, "transient_rate_limit");
    assert.equal(result.resetAt, undefined);
    assert.equal(result.retryDelayMs, 2_000);
  });

  it("still ignores quota metadata from other domains", () => {
    const result = classifyGoogleRpc429(quotaError("1h", {}, "QUOTA_EXHAUSTED", "storage.googleapis.com"));
    assert.equal(result.type, "unclassified");
    assert.equal(result.resetAt, undefined);
  });
});
