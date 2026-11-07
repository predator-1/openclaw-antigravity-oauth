import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { buildAntigravityImageGenerationProvider } from "../dist/image.js";
import { InMemoryAuthProfileStore } from "../dist/auth.js";
import { DEFAULT_ENDPOINTS } from "../dist/constants.js";

describe("image response lifetime", () => {
  for (const status of [200, 400]) {
    it(`times out a stalled ${status} body after headers`, async () => {
      let bodyStarted = false;
      const caller = new AbortController();
      const provider = buildAntigravityImageGenerationProvider({
        fetchFn: async () => {
          const response = new Response(null, { status });
          response.text = () => {
            bodyStarted = true;
            return new Promise<string>(() => {});
          };
          return response;
        }
      });
      await assert.rejects(provider.generateImage({
        prompt: "draw a star", apiKey: "fixture", timeoutMs: 20, signal: caller.signal
      }), /Image generation timed out after 20ms/);
      assert.equal(bodyStarted, true);
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    });
  }

  it("preserves caller abort reason while the body is stalled", async () => {
    const caller = new AbortController();
    let startBody: () => void = () => {};
    const bodyStarted = new Promise<void>((resolve) => { startBody = resolve; });
    const provider = buildAntigravityImageGenerationProvider({
      fetchFn: async () => {
        const response = new Response(null);
        response.text = () => {
          startBody();
          return new Promise<string>(() => {});
        };
        return response;
      }
    });
    const result = provider.generateImage({
      prompt: "draw a star", apiKey: "fixture", timeoutMs: 1000, signal: caller.signal
    });
    const reason = new Error("caller cancelled body");
    const rejected = assert.rejects(result, (error) => error === reason);
    await bodyStarted;
    caller.abort(reason);
    await rejected;
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  });
});

function imageResponse(): Response {
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: {
    mimeType: "image/jpeg", data: Buffer.from("fixture-image").toString("base64")
  } }] } }] })}\n\n`);
}

describe("stored image credentials", () => {
  for (const expired of [true, false]) {
    it(expired ? "refreshes an expired stored credential" : "uses a valid stored credential without refresh", async () => {
      const store = new InMemoryAuthProfileStore();
      await store.setSecret("antigravity", {
        accessToken: "stored-fixture", refreshToken: "refresh-fixture",
        expiresAt: Date.now() + (expired ? -3600000 : 3600000)
      });
      let refreshCalls = 0;
      let imageCalls = 0;
      const provider = buildAntigravityImageGenerationProvider({
        defaultAuthStore: store,
        fetchFn: async (url, init) => {
          if (String(url) === DEFAULT_ENDPOINTS.tokenUrl) {
            refreshCalls++;
            return new Response(JSON.stringify({ access_token: "refreshed-fixture", expires_in: 3600 }));
          }
          imageCalls++;
          assert.equal((init?.headers as Record<string, string>).Authorization,
            `Bearer ${expired ? "refreshed-fixture" : "stored-fixture"}`);
          return imageResponse();
        }
      });
      assert.equal((await provider.generateImage({ prompt: "draw a star" })).images.length, 1);
      assert.equal(refreshCalls, expired ? 1 : 0);
      assert.equal(imageCalls, 1);
    });
  }

  for (const refreshToken of ["", "managed-by-openclaw"]) {
    it(`does not send an expired non-refreshable stored credential (${refreshToken ? "managed" : "static"})`, async () => {
      const store = new InMemoryAuthProfileStore();
      await store.setSecret("antigravity", {
        accessToken: "expired-fixture", refreshToken, expiresAt: Date.now() - 3600000
      });
      let calls = 0;
      const provider = buildAntigravityImageGenerationProvider({
        fetchFn: async () => { calls++; return imageResponse(); }
      });
      await assert.rejects(provider.generateImage({ prompt: "draw a star", authStore: store }), /requires active authentication/);
      assert.equal(calls, 0);
    });
  }
});

function rpc429(reason: string, metadata: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: {
    status: "RESOURCE_EXHAUSTED", message: reason,
    details: [
      { reason, domain: "cloudcode", metadata },
      { retryDelay: "0.001s" }
    ]
  } }), { status: 429 });
}

describe("image quota classification", () => {
  for (const metadata of [
    { quotaResetTimeStamp: new Date(Date.now() + 3600000).toISOString() },
    { quotaResetDelay: "1h" }
  ]) {
    it(`reports terminal reset from ${Object.keys(metadata)[0]} without retry`, async () => {
      let calls = 0;
      const provider = buildAntigravityImageGenerationProvider({
        fetchFn: async () => { calls++; return rpc429("QUOTA_EXHAUSTED", metadata); }
      });
      await assert.rejects(provider.generateImage({ prompt: "draw a star", apiKey: "fixture" }), (error: Error) => {
        assert.match(error.message, /Quota exceeded HTTP 429 \(model gemini-3.1-flash-image\)/);
        assert.match(error.message, /Resets in/);
        return true;
      });
      assert.equal(calls, 1);
    });
  }

  for (const succeeds of [true, false]) {
    it(succeeds ? "retries capacity and succeeds" : "bounds capacity retries without quota language", async () => {
      let calls = 0;
      const provider = buildAntigravityImageGenerationProvider({
        fetchFn: async () => {
          calls++;
          return succeeds && calls === 2 ? imageResponse() : rpc429("MODEL_CAPACITY_EXHAUSTED");
        }
      });
      const result = provider.generateImage({ prompt: "draw a star", apiKey: "fixture" });
      if (succeeds) {
        assert.equal((await result).images.length, 1);
      } else {
        await assert.rejects(result, (error: Error & { isTransientRateLimit?: boolean }) => {
          assert.doesNotMatch(error.message, /Quota exceeded/);
          assert.match(error.message, /rate or capacity limit/);
          assert.equal(error.isTransientRateLimit, true);
          return true;
        });
      }
      assert.equal(calls, succeeds ? 2 : 3);
    });
  }
});

describe("image host auth failures", () => {
  it("rethrows the caller's abort reason from the resolver", async () => {
    const caller = new AbortController();
    const reason = new Error("caller cancelled host auth");
    const provider = buildAntigravityImageGenerationProvider({
      loadHostAuth: async () => ({ resolveApiKeyForProvider: async (params) => {
        assert.equal(params.signal, caller.signal);
        caller.abort(reason);
        throw new Error("Resolver aborted");
      } })
    });
    await assert.rejects(provider.generateImage({ prompt: "draw a star", signal: caller.signal }), (error) => error === reason);
  });

  for (const missing of [
    Object.assign(new Error("Missing login"), { code: "missing-provider-auth", provider: "antigravity" }),
    Object.assign(new Error("Missing key"), { code: "missing-api-key", provider: "antigravity" }),
    new Error('No API key found for provider "antigravity".')
  ]) {
    it(`keeps sign-in guidance for ${missing.message}`, async () => {
      const provider = buildAntigravityImageGenerationProvider({
        loadHostAuth: async () => ({ resolveApiKeyForProvider: async () => { throw missing; } })
      });
      await assert.rejects(provider.generateImage({ prompt: "draw a star" }), /requires active authentication/);
    });
  }

  for (const label of ["network unavailable", "refresh failed"]) {
    it(`surfaces ${label} with sensitive values redacted`, async () => {
      const sensitive = "fixture-sensitive-value";
      const provider = buildAntigravityImageGenerationProvider({
        loadHostAuth: async () => ({ resolveApiKeyForProvider: async () => {
          throw new Error(`${label}: Bearer ${sensitive}`, { cause: new Error(`refresh_token=${sensitive}`) });
        } })
      });
      await assert.rejects(provider.generateImage({ prompt: "draw a star" }), (error: Error) => {
        assert.ok(error.message.includes(label));
        assert.ok(error.message.includes("[REDACTED]"));
        assert.ok(!error.message.includes(sensitive));
        assert.doesNotMatch(error.message, /Please sign in/);
        return true;
      });
    });
  }

  it("redacts common bare and named auth-secret shapes", async () => {
    const values = [
      "ya29." + "fixture-access", "1//" + "fixture-refresh",
      "GOCSPX-" + "fixture-secret", "eyJ" + "fixtureheader.payload.signature"
    ];
    const named = "fixture-named-value";
    const provider = buildAntigravityImageGenerationProvider({
      loadHostAuth: async () => ({ resolveApiKeyForProvider: async () => {
        throw new Error(`refresh error: ${values.join(" ")} token=${named} apiKey=${named}`);
      } })
    });
    await assert.rejects(provider.generateImage({ prompt: "draw a star" }), (error: Error) => {
      for (const value of [...values, named]) assert.ok(!error.message.includes(value));
      assert.match(error.message, /refresh error/);
      return true;
    });
  });

  it("keeps sign-in fallback for an unavailable SDK", async () => {
    const provider = buildAntigravityImageGenerationProvider({
      loadHostAuth: async () => { throw new Error("SDK module unavailable"); }
    });
    await assert.rejects(provider.generateImage({ prompt: "draw a star" }), /requires active authentication/);
  });

  it("resolves expired static credentials through the host instead of sending them", async () => {
    const store = new InMemoryAuthProfileStore();
    await store.setSecret("antigravity", {
      accessToken: "expired-fixture", refreshToken: "", expiresAt: Date.now() - 3600000
    });
    let resolved = 0;
    const provider = buildAntigravityImageGenerationProvider({
      defaultAuthStore: store,
      loadHostAuth: async () => ({ resolveApiKeyForProvider: async () => {
        resolved++; return { apiKey: "host-fixture" };
      } }),
      fetchFn: async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer host-fixture");
        return imageResponse();
      }
    });
    assert.equal((await provider.generateImage({ prompt: "draw a star" })).images.length, 1);
    assert.equal(resolved, 1);
  });
});


describe("image stored credential host boundary", () => {
  it("falls through for a native host store without getSecret", async () => {
    let resolved = 0;
    const provider = buildAntigravityImageGenerationProvider({
      loadHostAuth: async () => ({ resolveApiKeyForProvider: async () => {
        resolved++; return { apiKey: "host-fixture" };
      } }),
      fetchFn: async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer host-fixture");
        return imageResponse();
      }
    });
    await provider.generateImage({ prompt: "draw a star", authStore: { profiles: {} } as any });
    assert.equal(resolved, 1);
  });

  for (const refreshToken of ["", " ", "managed-by-openclaw"]) {
    it(`uses host auth inside the 60-second skew without usable refresh (${JSON.stringify(refreshToken)})`, async () => {
      const store = new InMemoryAuthProfileStore();
      await store.setSecret("antigravity", {
        accessToken: "near-expiry-fixture", refreshToken, expiresAt: Date.now() + 30_000
      });
      let resolved = 0;
      let calls = 0;
      const provider = buildAntigravityImageGenerationProvider({
        defaultAuthStore: store,
        loadHostAuth: async () => ({ resolveApiKeyForProvider: async () => {
          resolved++; return { apiKey: "host-fixture" };
        } }),
        fetchFn: async (url, init) => {
          calls++; assert.notEqual(String(url), DEFAULT_ENDPOINTS.tokenUrl);
          assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer host-fixture");
          return imageResponse();
        }
      });
      await provider.generateImage({ prompt: "draw a star" });
      assert.equal(resolved, 1); assert.equal(calls, 1);
    });
  }
});


describe("image stored refresh lifetime and fallback", () => {
  async function expiredStore() {
    const store = new InMemoryAuthProfileStore();
    await store.setSecret("antigravity", {
      accessToken: "expired-fixture", refreshToken: "revoked-fixture", expiresAt: Date.now() - 3600000
    });
    return store;
  }

  for (const stalledBody of [false, true]) {
    it(`bounds a stalled token ${stalledBody ? "body" : "endpoint"} by timeoutMs`, async () => {
      const store = await expiredStore();
      const caller = new AbortController();
      let tokenSignal: AbortSignal | undefined;
      let calls = 0;
      const provider = buildAntigravityImageGenerationProvider({
        defaultAuthStore: store,
        loadHostAuth: async () => { assert.fail("timeout must not fall through"); },
        fetchFn: async (url, init) => {
          calls++; assert.equal(String(url), DEFAULT_ENDPOINTS.tokenUrl);
          tokenSignal = init?.signal as AbortSignal;
          if (!stalledBody) return await new Promise<Response>(() => {});
          const response = new Response(null);
          response.json = () => new Promise(() => {});
          return response;
        }
      });
      await assert.rejects(provider.generateImage({ prompt: "draw a star", timeoutMs: 20, signal: caller.signal }),
        /Image generation timed out after 20ms/);
      assert.equal(calls, 1); assert.equal(tokenSignal?.aborted, true);
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    });
  }

  it("preserves caller abort reason at a stalled token endpoint and cleans the listener", async () => {
    const store = await expiredStore();
    const caller = new AbortController();
    const reason = new Error("caller cancelled token refresh");
    let started: () => void = () => {};
    const tokenStarted = new Promise<void>((resolve) => { started = resolve; });
    const provider = buildAntigravityImageGenerationProvider({
      defaultAuthStore: store,
      loadHostAuth: async () => { assert.fail("abort must not fall through"); },
      fetchFn: async () => { started(); return await new Promise<Response>(() => {}); }
    });
    const pending = provider.generateImage({ prompt: "draw a star", timeoutMs: 1000, signal: caller.signal });
    const rejected = assert.rejects(pending, (error) => error === reason);
    await tokenStarted; caller.abort(reason); await rejected;
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  });

  for (const hostWorks of [true, false]) {
    it(`falls through after revoked refresh to ${hostWorks ? "working host auth" : "sign-in guidance"} without leaking credentials`, async (t) => {
      const store = await expiredStore();
      const messages: string[] = [];
      t.mock.method(console, "warn", (...args: unknown[]) => { messages.push(args.join(" ")); });
      let hostCalls = 0;
      let tokenCalls = 0;
      let imageCalls = 0;
      const provider = buildAntigravityImageGenerationProvider({
        defaultAuthStore: store,
        loadHostAuth: async () => ({ resolveApiKeyForProvider: async () => {
          hostCalls++; return hostWorks ? { apiKey: "host-fixture" } : {};
        } }),
        fetchFn: async (url, init) => {
          if (String(url) === DEFAULT_ENDPOINTS.tokenUrl) {
            tokenCalls++;
            return new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh_token=revoked-fixture" }), { status: 400 });
          }
          imageCalls++;
          assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer host-fixture");
          return imageResponse();
        }
      });
      const pending = provider.generateImage({ prompt: "draw a star" });
      if (hostWorks) assert.equal((await pending).images.length, 1);
      else await assert.rejects(pending, (error: Error) => {
        messages.push(error.message); assert.match(error.message, /requires active authentication/); return true;
      });
      assert.equal(hostCalls, 1); assert.equal(tokenCalls, 1); assert.equal(imageCalls, hostWorks ? 1 : 0);
      for (const message of messages) {
        for (const value of ["expired-fixture", "revoked-fixture", "host-fixture"]) assert.ok(!message.includes(value));
      }
    });
  }
});


describe("image quota fallback parity", () => {
  for (const classified of [false, true]) {
    it(`${classified ? "QUOTA_EXHAUSTED" : "unclassified 429"} is terminal quota without retry`, async () => {
      let calls = 0;
      const provider = buildAntigravityImageGenerationProvider({ fetchFn: async () => {
        calls++;
        return classified ? rpc429("QUOTA_EXHAUSTED") : new Response("RESOURCE_EXHAUSTED", { status: 429 });
      } });
      await assert.rejects(provider.generateImage({ prompt: "draw a star", apiKey: "fixture" }),
        (error: Error & { isTerminalQuota?: boolean; isTransientRateLimit?: boolean }) => {
          assert.match(error.message, /Quota exceeded HTTP 429/);
          assert.equal(error.isTerminalQuota, true); assert.equal(error.isTransientRateLimit, false); return true;
        });
      assert.equal(calls, 1);
    });
  }

  it("reads reset timestamp from any details entry, even after an invalid one", async (t) => {
    const now = Date.parse("2026-11-07T10:00:00Z");
    t.mock.timers.enable({ apis: ["Date"], now });
    let calls = 0;
    const provider = buildAntigravityImageGenerationProvider({ fetchFn: async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED", details: [
        null,
        { metadata: { quotaResetTimeStamp: "invalid fixture timestamp" } },
        { metadata: { quotaResetTimeStamp: new Date(now + 3600_000).toISOString() } }
      ] } }), { status: 429 });
    } });
    await assert.rejects(provider.generateImage({ prompt: "draw a star", apiKey: "fixture" }), /Quota exceeded.*Resets in 1h/);
    assert.equal(calls, 1);
  });
});
