/**
 * Minimal test double for OpenClaw's `openclaw/plugin-sdk/media-understanding`.
 *
 * Emulates the host flow: resolve the provider's apiKey from cfg, build the
 * provider's streamFn, send the image as a user message, and collect text.
 * HTTP goes through globalThis.fetch at call time so tests can mock it.
 */
import { createAntigravityProvider } from "../../../dist/index.js";

function stripProvider(model) {
  const raw = String(model ?? "gemini-3.8-flash");
  return raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw;
}

async function run(req, images) {
  const providerId = req.provider ?? "antigravity";
  const apiKey = req.cfg?.models?.providers?.[providerId]?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key configured for provider "${providerId}"`);
  }
  const { provider } = createAntigravityProvider({
    fetchImpl: (...args) => globalThis.fetch(...args)
  });
  const modelId = stripProvider(req.model);
  const content = [{ type: "text", text: req.prompt ?? "Describe the image." }];
  for (const img of images) {
    content.push({
      type: "image",
      data: Buffer.from(img.buffer).toString("base64"),
      mimeType: img.mime ?? "image/png"
    });
  }
  const stream = provider.createStreamFn()(
    { id: modelId, provider: providerId },
    { messages: [{ role: "user", content }] },
    { apiKey }
  );
  let text = "";
  for await (const ev of stream) {
    if (ev?.type === "text_delta" && typeof ev.delta === "string") text += ev.delta;
    if (ev?.type === "error") {
      throw new Error(String(ev.error?.errorMessage ?? ev.error ?? "stream error"));
    }
  }
  return { text, model: modelId };
}

export async function describeImageWithModel(req) {
  return run(req, [{ buffer: req.buffer, mime: req.mime }]);
}

export async function describeImagesWithModel(req) {
  return run(req, req.images ?? []);
}
