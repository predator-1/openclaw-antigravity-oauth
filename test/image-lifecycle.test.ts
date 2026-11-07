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
