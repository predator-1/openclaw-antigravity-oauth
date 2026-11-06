import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Resolve npm next to the running node (process.execPath); do not rely on PATH.
 * Falls back to `which npm` only when nothing is found next to node.
 */
export function resolveNpmBinary(execPath = process.execPath) {
  const nodeDir = path.dirname(execPath);
  const candidates = [path.join(nodeDir, "npm"), path.join(nodeDir, "npm.cmd"), path.join(nodeDir, "npm.ps1")];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const whichRes = spawnSync("which", ["npm"], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const which = (whichRes.stdout || "").trim();
    if (which && fs.existsSync(which)) return which;
  } catch {}
  throw new Error(`npm binary could not be resolved from process.execPath: ${execPath}`);
}

/**
 * Command to run npm without relying on PATH: { command, args }.
 * Order: npm_execpath (set by `npm run`), npm-cli.js of the running node's install
 * (run with process.execPath), the npm binary next to node, then `which npm`.
 */
export function resolveNpmCommand(execPath = process.execPath, env = process.env) {
  const viaNode = (js) => ({ command: execPath, args: [js] });
  if (env.npm_execpath && /\.c?js$/.test(env.npm_execpath) && fs.existsSync(env.npm_execpath)) {
    return viaNode(env.npm_execpath);
  }
  const nodeDir = path.dirname(execPath);
  for (const js of [
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "node_modules", "npm", "bin", "npm-cli.js")
  ]) {
    if (fs.existsSync(js)) return viaNode(js);
  }
  return { command: resolveNpmBinary(execPath), args: [] };
}
