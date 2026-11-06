import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import { describe, it } from "node:test";

describe("hermetic test bootstrap", () => {
  it("sandboxes HOME", () => {
    assert.match(os.homedir(), /agy-oauth-test-home-/);
  });

  it("rejects unmocked fetch", async () => {
    await assert.rejects(fetch("https://example.com/"), /hermetic test/);
  });

  it("rejects raw TCP, TLS and DNS to non-loopback hosts", async () => {
    assert.throws(() => net.connect(443, "example.com"), /hermetic test/);
    assert.throws(() => net.createConnection({ host: "8.8.8.8", port: 53 }), /hermetic test/);
    assert.throws(() => tls.connect({ host: "oauth2.googleapis.com", port: 443 }), /hermetic test/);
    assert.throws(() => dns.lookup("example.com", () => {}), /hermetic test/);
    await assert.rejects(dns.promises.lookup("example.com"), /hermetic test/);
  });

  it("still allows loopback servers (OAuth callback)", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }).on("error", reject);
    });
    server.close();
    assert.equal(body, "ok");
  });

  it("resolves the media-understanding stub through the registered hook", async () => {
    const mod = await import("openclaw/plugin-sdk/media-understanding");
    assert.equal(typeof mod.describeImageWithModel, "function");
    assert.equal(typeof mod.describeImagesWithModel, "function");
    await assert.rejects(() => import("openclaw/plugin-sdk/does-not-exist"), /Cannot find package 'openclaw'/);
  });
});
