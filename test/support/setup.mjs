/**
 * Hermetic test bootstrap (loaded with `node --import`).
 *
 * 1. Points HOME/USERPROFILE at a throwaway directory so no test can read or
 *    write real credentials (~/.openclaw, ~/.gemini, keychains, ...).
 * 2. Replaces globalThis.fetch with a guard that rejects any request a test did
 *    not explicitly mock, so the suite never touches the network.
 * 3. Patches net.Socket#connect (which net.connect, tls.connect, http/https
 *    agents and other raw-socket clients all go through) and dns lookups so any
 *    non-loopback connection fails loudly too. Loopback TCP and local IPC
 *    sockets stay allowed for in-process servers such as the OAuth callback.
 * 4. Registers a resolve hook that maps the host-provided
 *    `openclaw/plugin-sdk/media-understanding` module to a local test double.
 *    Other `openclaw/*` imports stay unresolved, exactly like a bare checkout,
 *    so the plugin's "host runtime unavailable" fallbacks remain covered.
 *    Uses module.registerHooks() (Node 22.15+ / 24) when present; falls back
 *    to module.register() on older Node 22.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register, registerHooks } from "node:module";
import net from "node:net";
import dns from "node:dns";
import { resolve as resolveOpenClawSdkStub } from "./openclaw-sdk/hooks.mjs";

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-oauth-test-home-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
delete process.env.AGY_BIN;
delete process.env.AGY_TOKEN_FILE;
process.on("exit", () => {
  try {
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

globalThis.fetch = async (input) => {
  throw new Error(`[hermetic test] unexpected network request to ${String(input)}; mock fetch in the test`);
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const isLoopback = (host) => host === undefined || host === null || host === "" || LOOPBACK_HOSTS.has(String(host).toLowerCase()) || /^127\./.test(String(host));
const blocked = (what) => new Error(`[hermetic test] unexpected network connection to ${what}; mock the client in the test`);

function connectTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // internal normalized-args form
  if (first && typeof first === "object") {
    if (first.path) return { local: true };
    return { host: first.host ?? first.hostname, port: first.port };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { local: true }; // IPC path
  return { host: typeof args[1] === "string" ? args[1] : undefined, port: first };
}

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = connectTarget(args);
  if (!target.local && !isLoopback(target.host)) {
    throw blocked(`${target.host}:${target.port}`);
  }
  return originalSocketConnect.apply(this, args);
};

for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  const original = dns[name];
  if (typeof original !== "function") continue;
  dns[name] = function guardedDns(host, ...rest) {
    if (isLoopback(host)) return original.call(this, host, ...rest);
    throw blocked(`dns:${host}`);
  };
}
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  if (typeof dns.promises?.[name] !== "function") continue;
  const original = dns.promises[name];
  dns.promises[name] = async function guardedDnsPromise(host, ...rest) {
    if (isLoopback(host)) return original.call(this, host, ...rest);
    throw blocked(`dns:${host}`);
  };
}

if (typeof registerHooks === "function") {
  registerHooks({ resolve: resolveOpenClawSdkStub });
} else {
  register(new URL("./openclaw-sdk/hooks.mjs", import.meta.url));
}
