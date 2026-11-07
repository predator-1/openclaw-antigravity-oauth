import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { buildAntigravityImageGenerationProvider } from "../dist/image.js";

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
