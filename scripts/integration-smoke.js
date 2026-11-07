#!/usr/bin/env node
/**
 * scripts/integration-smoke.js
 *
 * Integration smoke test executing against real upstream Antigravity endpoints
 * using the built dist/ code paths.
 *
 * Runs sequentially, rate-limit friendly, with pass / skipped (quota) / fail reporting.
 *
 * LOCAL / OPT-IN ONLY: this script talks to real Google endpoints with a real
 * subscription login. It is never run in CI.
 *
 * Usage:
 *   node scripts/integration-smoke.js [--json] [--agent=<id>] [--model=<id>]
 *     [--auth-source=auto|openclaw|agy] [--agy-token-file=<path>]
 *     [--min-usage-windows=<n>]
 *
 * Auth sources:
 *   openclaw  (default) OpenClaw's SQLite auth stores (~/.openclaw), opened read-only.
 *   agy       The official Antigravity CLI login file
 *             (~/.gemini/antigravity-cli/antigravity-oauth-token, or
 *             --agy-token-file / AGY_TOKEN_FILE). Read-only: the file is never
 *             written, and refreshed tokens live only in process memory.
 *   auto      openclaw first, then agy (explicit opt-in, like agy).
 *
 * The default is openclaw: the agy login is only read when explicitly requested.
 *
 * Tokens are never printed or logged; error text is passed through sanitizeError().
 */

import { sanitizeError } from "../dist/sanitize.js";
export { sanitizeError };

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CatalogService, KNOWN_CATALOG_MODELS } from "../dist/catalog.js";
import { InMemoryAuthProfileStore, getValidAccessToken } from "../dist/auth.js";
import { executeTurn } from "../dist/turn.js";
import { buildAntigravityWebSearchProvider } from "../dist/search.js";
import { buildAntigravityWebFetchProvider } from "../dist/fetch.js";
import { buildAntigravityImageGenerationProvider } from "../dist/image.js";
import { DEFAULT_ENDPOINTS, DEFAULT_IMAGE_MODEL, DEFAULT_PROJECT_ID, PROVIDER_ID } from "../dist/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export const AUTH_SOURCES = Object.freeze(["auto", "openclaw", "agy"]);
export const DEFAULT_MIN_USAGE_WINDOWS = 5;

export function defaultAgyTokenFile(env = process.env, homeDir = os.homedir()) {
  if (env.AGY_TOKEN_FILE && env.AGY_TOKEN_FILE.trim()) return env.AGY_TOKEN_FILE.trim();
  return path.join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

export function parseArgs(rawArgs = process.argv.slice(2), env = process.env) {
  const valueOf = (name) => {
    const arg = rawArgs.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3).trim() : undefined;
  };
  const json = rawArgs.includes("--json");
  const agentId = valueOf("agent") || "main";
  const targetModel = valueOf("model") || undefined;

  const authSource = valueOf("auth-source") || "openclaw";
  if (!AUTH_SOURCES.includes(authSource)) {
    throw new Error(`Invalid --auth-source "${authSource}" (expected one of: ${AUTH_SOURCES.join(", ")})`);
  }
  const agyTokenFile = valueOf("agy-token-file") || defaultAgyTokenFile(env);

  const minRaw = valueOf("min-usage-windows");
  let minUsageWindows = DEFAULT_MIN_USAGE_WINDOWS;
  if (minRaw !== undefined) {
    minUsageWindows = Number(minRaw);
    if (!Number.isInteger(minUsageWindows) || minUsageWindows < 0) {
      throw new Error(`Invalid --min-usage-windows "${minRaw}" (expected a non-negative integer)`);
    }
  }
  return { json, agentId, targetModel, authSource, agyTokenFile, minUsageWindows };
}

/**
 * Classify check result into pass, skipped (quota exhausted), or fail
 */
export function classifySmokeResult(err) {
  if (!err) {
    return { status: "pass" };
  }

  const rawMsg = typeof err === "string" ? err : err?.message || String(err);
  const status = typeof err === "object" && err !== null ? err.status || err.statusCode : undefined;

  const isModelNotFound =
    status === 404 ||
    /unknown model/i.test(rawMsg) ||
    /\bNOT_FOUND\b/.test(rawMsg) ||
    /Requested entity was not found/i.test(rawMsg);

  if (isModelNotFound) {
    return {
      status: "fail",
      error: sanitizeError(err)
    };
  }

  const isTransientRateLimit =
    err?.isTransientRateLimit === true ||
    (err?.isTerminalQuota !== true && /RATE_LIMIT_EXCEEDED|MODEL_CAPACITY_EXHAUSTED|rate or capacity limit/i.test(rawMsg));
  if (isTransientRateLimit) {
    return { status: "fail", error: sanitizeError(err) };
  }

  const isQuota =
    status === 429 ||
    /quota exceeded/i.test(rawMsg) ||
    /RESOURCE_EXHAUSTED/i.test(rawMsg) ||
    /rate_limit/i.test(rawMsg) ||
    /Individual quota reached/i.test(rawMsg) ||
    /429/i.test(rawMsg);

  if (isQuota) {
    const resetMatch =
      rawMsg.match(/Resets in ([^\.]+)/i) ||
      rawMsg.match(/resets in ([^\.]+)/i) ||
      rawMsg.match(/reset[:\s]+([^\.,\n]+)/i);
    // The reset hint is copied from the upstream error, so it goes through the same redaction.
    const resetTime = resetMatch ? sanitizeError(resetMatch[1].trim()) : "subscription quota reset pending";
    return {
      status: "skipped",
      reason: "quota_exhausted",
      resetTime
    };
  }

  return {
    status: "fail",
    error: sanitizeError(err)
  };
}

/**
 * Safely load stored Antigravity OAuth profile through OpenClaw's SQLite store.
 * Opens SQLite databases in strict read-only mode and verifies table and column schemas.
 * Fails loudly if a required SQLite schema differs.
 */
export async function loadStoredAntigravityProfile(agentId = "main", options = {}) {
  const openclawDir = options.openclawDir || path.join(os.homedir(), ".openclaw");

  const extractAntigravity = (storeJson) => {
    if (!storeJson || typeof storeJson !== "object") return null;
    const profiles = storeJson.profiles || {};
    const antigravityProfile = Object.values(profiles).find(
      (p) => p && p.provider === PROVIDER_ID
    );
    if (antigravityProfile && (antigravityProfile.access || antigravityProfile.token)) {
      return {
        type: "oauth",
        provider: PROVIDER_ID,
        accessToken: antigravityProfile.access || antigravityProfile.token,
        refreshToken: antigravityProfile.refresh || antigravityProfile.refreshToken || "",
        expiresAt: antigravityProfile.expires || antigravityProfile.expiresAt || Date.now() + 3600_000,
        projectId: antigravityProfile.projectId || "default-cli-project"
      };
    }
    return null;
  };

  const tryReadFromDb = async (dbPath, targetTable, keyColumn, valueColumn, rowKey) => {
    if (!fs.existsSync(dbPath)) return null;

    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const tableCheck = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
        ).get(targetTable);
        if (!tableCheck) return null;

        const tableInfo = db.prepare(`PRAGMA table_info(${targetTable})`).all();
        const colNames = tableInfo.map((c) => c.name);
        if (!colNames.includes(keyColumn) || !colNames.includes(valueColumn)) {
          throw new Error(
            `SQLite schema mismatch in ${dbPath}: table '${targetTable}' missing expected columns '${keyColumn}' or '${valueColumn}' (found: ${colNames.join(", ")})`
          );
        }

        const row = db.prepare(
          `SELECT ${valueColumn} AS val FROM ${targetTable} WHERE ${keyColumn} = ?`
        ).get(rowKey);
        if (row && typeof row.val === "string") {
          return JSON.parse(row.val);
        }
        return null;
      } finally {
        db.close();
      }
    } catch (err) {
      if (err.message && err.message.includes("schema mismatch")) {
        throw err;
      }

      // Fallback: child_process sqlite3 CLI in -readonly mode
      try {
        const { execFileSync } = await import("node:child_process");
        const tableOut = execFileSync(
          "sqlite3",
          ["-readonly", dbPath, `SELECT name FROM sqlite_master WHERE type='table' AND name='${targetTable}';`],
          { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
        ).trim();
        if (!tableOut) return null;

        const infoOut = execFileSync(
          "sqlite3",
          ["-readonly", dbPath, `PRAGMA table_info(${targetTable});`],
          { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
        );
        const colNames = infoOut
          .split("\n")
          .map((line) => line.split("|")[1]?.trim())
          .filter(Boolean);
        if (!colNames.includes(keyColumn) || !colNames.includes(valueColumn)) {
          throw new Error(
            `SQLite schema mismatch in ${dbPath}: table '${targetTable}' missing expected columns '${keyColumn}' or '${valueColumn}' (found: ${colNames.join(", ")})`
          );
        }

        const rowOut = execFileSync(
          "sqlite3",
          ["-readonly", dbPath, `SELECT ${valueColumn} FROM ${targetTable} WHERE ${keyColumn} = '${rowKey}';`],
          { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
        ).trim();
        if (rowOut) {
          return JSON.parse(rowOut);
        }
      } catch (fallbackErr) {
        if (fallbackErr.message && fallbackErr.message.includes("schema mismatch")) {
          throw fallbackErr;
        }
      }
    }
    return null;
  };

  // 1. Check per-agent SQLite store
  const agentDbPath = path.join(openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  const agentStore = await tryReadFromDb(
    agentDbPath,
    "auth_profile_store",
    "store_key",
    "store_json",
    "primary"
  );
  const agentProfile = extractAntigravity(agentStore);
  if (agentProfile) return agentProfile;

  // 2. Check shared-state SQLite store
  const sharedDbPath = path.join(openclawDir, "state", "openclaw.sqlite");
  const sharedStore = await tryReadFromDb(
    sharedDbPath,
    "config_machine_state",
    "state_key",
    "value_json",
    "authProfiles.store"
  );
  const sharedProfile = extractAntigravity(sharedStore);
  if (sharedProfile) return sharedProfile;

  return null;
}

/**
 * Load the official Antigravity CLI (agy) login as a smoke-test profile.
 *
 * The file is opened read-only and never written back. Its contents never appear in
 * thrown errors. projectId is left undefined so the plugin resolves the managed project
 * the same way it does for a fresh OpenClaw login.
 *
 * Expected shape (agy 1.4.x):
 *   { token: { access_token, refresh_token, token_type, expiry }, auth_method, ... }
 */
export function loadAgyCliProfile(tokenFile = defaultAgyTokenFile(), options = {}) {
  const readFile = options.readFile || ((p) => fs.readFileSync(p, { encoding: "utf8", flag: "r" }));
  let raw;
  try {
    raw = readFile(tokenFile);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw new Error(`Cannot read agy login file ${tokenFile}: ${err?.code || "read error"}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`agy login file ${tokenFile} is not valid JSON (contents not shown)`);
  }
  const tok = parsed && typeof parsed === "object" ? parsed.token ?? parsed : null;
  const accessToken = typeof tok?.access_token === "string" ? tok.access_token.trim() : "";
  const refreshToken = typeof tok?.refresh_token === "string" ? tok.refresh_token.trim() : "";
  if (!accessToken && !refreshToken) {
    throw new Error(
      `agy login file ${tokenFile} has an unexpected shape (expected token.access_token / token.refresh_token; contents not shown)`
    );
  }

  let expiresAt = 0; // unknown expiry => treat as expired so the plugin refreshes in memory
  if (typeof tok.expiry === "string") {
    const t = Date.parse(tok.expiry);
    if (Number.isFinite(t)) expiresAt = t;
  } else if (typeof tok.expiry === "number" && Number.isFinite(tok.expiry)) {
    expiresAt = tok.expiry < 1e12 ? tok.expiry * 1000 : tok.expiry;
  }

  return {
    type: "oauth",
    provider: PROVIDER_ID,
    source: "agy",
    accessToken: accessToken || "expired",
    refreshToken,
    expiresAt: accessToken ? expiresAt : 0,
    projectId: undefined
  };
}

/**
 * Resolve the smoke-test profile from the requested auth source.
 */
export async function resolveSmokeProfile(options = {}, loaders = {}) {
  const loadOpenclaw = loaders.openclaw || ((agentId) => loadStoredAntigravityProfile(agentId));
  const loadAgy = loaders.agy || ((file) => loadAgyCliProfile(file));
  const source = options.authSource || "openclaw";

  if (source === "openclaw" || source === "auto") {
    const p = await loadOpenclaw(options.agentId || "main");
    if (p && p.accessToken) return { ...p, source: "openclaw" };
    if (source === "openclaw") return null;
  }
  const p = await loadAgy(options.agyTokenFile || defaultAgyTokenFile());
  if (p && (p.accessToken || p.refreshToken)) return { ...p, source: "agy" };
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Image generation errors worth one retry: HTTP 503 / UNAVAILABLE, deadline expired,
 * and HTTP 500 INTERNAL (a transient 500 once failed the smoke).
 */
export function isTransientImageError(err) {
  const msg = String(err?.message || err);
  if (/\b503\b|UNAVAILABLE|deadline expired/i.test(msg)) return true;
  return /HTTP 500\b/.test(msg) || /\bINTERNAL\b/.test(msg);
}

/**
 * Pure evaluation functions for smoke test checks (exercised by main and unit tests)
 */
export function evaluateCatalog(upstreamModels, knownModelIds) {
  const staticModelIds = Array.from(knownModelIds || []);
  const upstreamIds = (upstreamModels || []).map((m) => m.id);
  const added = upstreamIds.filter((id) => !staticModelIds.includes(id));
  const removed = staticModelIds.filter((id) => !upstreamIds.includes(id));
  return {
    check: "catalog",
    target: "fetchAvailableModels",
    status: "pass",
    details: `Discovered ${upstreamIds.length} models (added: ${added.length}, removed: ${removed.length})`,
    data: { total: upstreamIds.length, added, removed }
  };
}

export function evaluatePongTurn(modelId, res) {
  const text = (res?.text || "").trim();
  if (/\bpong\b/i.test(text)) {
    return {
      check: "turn:pong",
      target: modelId,
      status: "pass",
      details: `Turn completed: "${text.slice(0, 30)}"`
    };
  }
  return {
    check: "turn:pong",
    target: modelId,
    status: "fail",
    details: text ? `Expected "pong", got: "${text.slice(0, 40)}"` : "Turn completed with empty text"
  };
}

export function evaluateToolRoundTrip(modelId, turn1, turn2) {
  if (turn1?.toolCalls && turn1.toolCalls.length > 0) {
    const call = turn1.toolCalls[0];
    const answer = (turn2?.text || "").trim();
    return {
      check: "turn:tool_roundtrip",
      target: modelId,
      status: "pass",
      details: `Mapped call '${call.name}' -> final answer: "${answer.slice(0, 30)}"`
    };
  }
  return {
    check: "turn:tool_roundtrip",
    target: modelId,
    status: "fail",
    details: `Model answered directly without calling tool: "${(turn1?.text || "").trim().slice(0, 40)}"`
  };
}

export function evaluateUsage(quota, minWindows = DEFAULT_MIN_USAGE_WINDOWS) {
  const bucketCount = quota?.buckets?.length || 0;
  if (bucketCount >= minWindows) {
    return {
      check: "usage",
      target: "retrieveUserQuotaSummary",
      status: "pass",
      details: `Found ${bucketCount} quota windows (${minWindows} expected)`
    };
  }
  return {
    check: "usage",
    target: "retrieveUserQuotaSummary",
    status: "fail",
    details: `Expected ${minWindows} quota windows, but found ${bucketCount}`
  };
}

export function evaluateSearch(res) {
  const citationsCount = res?.citations?.length || 0;
  if (citationsCount > 0) {
    return {
      check: "search",
      target: "antigravity-search",
      status: "pass",
      details: `Returned ${citationsCount} citations from Google search`
    };
  }
  return {
    check: "search",
    target: "antigravity-search",
    status: "fail",
    details: `Search succeeded but returned 0 citations (${res?.text ? "text generated" : "empty response"})`
  };
}


export function evaluateFetch(res, nonce) {
  const text = res?.text || "";
  if (nonce && String(text).includes(nonce)) {
    return {
      check: "fetch",
      target: "antigravity-fetch",
      status: "pass",
      details: `Fetched nonce echo (${text.length} chars)`
    };
  }
  return {
    check: "fetch",
    target: "antigravity-fetch",
    status: "fail",
    details: nonce
      ? "Fetch succeeded but the run-time nonce was missing from the body"
      : "Fetch succeeded with an empty nonce"
  };
}

export function evaluateImageGeneration(modelId, res) {
  const imgCount = res?.images?.length || 0;
  if (imgCount > 0) {
    const img0 = res.images[0];
    const len = img0.buffer ? img0.buffer.length : 0;
    return {
      check: "image:generation",
      target: modelId,
      status: "pass",
      details: `Generated ${imgCount} image (${img0.mimeType || "unknown"}, ${len} bytes)`
    };
  }
  return {
    check: "image:generation",
    target: modelId,
    status: "fail",
    details: "Image generation completed but no images returned"
  };
}

export function evaluateImageDescribe(modelId, res) {
  const text = (res?.text || "").trim();
  if (!text) {
    return {
      check: "image:describe",
      target: modelId,
      status: "fail",
      details: "Image describe returned empty text"
    };
  }
  return {
    check: "image:describe",
    target: modelId,
    status: "pass",
    details: `Described image: "${text.slice(0, 30)}"`
  };
}

/**
 * In --json mode stdout must carry only the JSON report. Plugin code logs through
 * console.log/info/debug (e.g. "OAuth token refresh succeeded" in src/auth.ts), so route
 * those to stderr and return a writer that is the only path to stdout.
 */
export function routeConsoleToStderr(target = console, writeStdout = (text) => process.stdout.write(text)) {
  const toStderr = (...args) => target.error(...args);
  target.log = toStderr;
  target.info = toStderr;
  target.debug = toStderr;
  return (text) => writeStdout(`${text}\n`);
}

let emitJson = (text) => process.stdout.write(`${text}\n`);

export async function main() {
  let options;
  try {
    options = parseArgs();
  } catch (err) {
    console.error(`\x1b[31m[ARGS ERROR]\x1b[0m ${sanitizeError(err)}`);
    process.exit(2);
  }
  if (options.json) emitJson = routeConsoleToStderr();
  const results = [];

  // 1. Auth resolution
  let profile = null;
  try {
    profile = await resolveSmokeProfile(options);
  } catch (err) {
    if (options.json) {
      emitJson(
        JSON.stringify(
          {
            status: "error",
            error: sanitizeError(err),
            checks: []
          },
          null,
          2
        )
      );
    } else {
      console.error(`\x1b[31m[AUTH ERROR]\x1b[0m ${sanitizeError(err)}`);
    }
    process.exit(1);
  }

  if (!profile || !profile.accessToken) {
    const errorMsg =
      `Authentication error: no Antigravity login found (auth source: ${options.authSource}).\n` +
      "Sign in with: openclaw models auth login --provider antigravity\n" +
      "or, for local smoke runs only, sign in to the official agy CLI and pass --auth-source=agy";
    if (options.json) {
      emitJson(
        JSON.stringify(
          {
            status: "error",
            error: errorMsg,
            checks: []
          },
          null,
          2
        )
      );
    } else {
      console.error(`\x1b[31m[AUTH ERROR]\x1b[0m ${errorMsg}`);
    }
    process.exit(1);
  }

  const inMemStore = new InMemoryAuthProfileStore();
  await inMemStore.setSecret(PROVIDER_ID, {
    accessToken: profile.accessToken,
    refreshToken: profile.refreshToken,
    expiresAt: profile.expiresAt,
    ...(profile.projectId !== undefined ? { projectId: profile.projectId } : {})
  });
  if (!options.json) {
    console.log(`Auth source: ${profile.source} (token kept in memory only; never printed)`);
  }

  const catalog = new CatalogService(DEFAULT_ENDPOINTS);

  // 2. Catalog check: fetchAvailableModels
  let catalogResult;
  try {
    const upstreamModels = await catalog.listModels(inMemStore, { refresh: true });
    catalogResult = evaluateCatalog(upstreamModels, KNOWN_CATALOG_MODELS);
  } catch (err) {
    const classified = classifySmokeResult(err);
    catalogResult = {
      check: "catalog",
      target: "fetchAvailableModels",
      status: classified.status,
      details: classified.status === "skipped" ? `Skipped (${classified.reason}: ${classified.resetTime})` : classified.error
    };
  }
  results.push(catalogResult);
  await sleep(500);

  // Logins without a stored projectId (e.g. --auth-source=agy) resolve the managed
  // Cloud Code project the same way the plugin's usage path does, and keep it in the
  // in-memory store. Chat turns on the v1internal endpoint need it in the envelope.
  if (!(await inMemStore.getSecret(PROVIDER_ID))?.projectId) {
    try {
      await catalog.getUsage(inMemStore);
    } catch {
      // Reported by the usage check below.
    }
    const resolved = await inMemStore.getSecret(PROVIDER_ID);
    if (resolved && !resolved.projectId) {
      await inMemStore.setSecret(PROVIDER_ID, { ...resolved, projectId: DEFAULT_PROJECT_ID });
    }
  }

  // Determine chat models to test
  const allModels = catalog.getCachedModels() || [];
  let chatModels = allModels.filter((m) => !m.id.includes("image"));
  if (chatModels.length === 0) {
    chatModels = KNOWN_CATALOG_MODELS.map((id) => ({ id }));
  }
  if (options.targetModel) {
    chatModels = chatModels.filter((m) => m.id === options.targetModel || `antigravity/${m.id}` === options.targetModel);
  }

  const toolDefinition = {
    name: "jira:get_ticket",
    description: "Lookup ticket details by ticket ID",
    parameters: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "The ticket identifier" },
        priority: {
          description: "Optional priority filter",
          anyOf: [{ type: "string" }, { type: "null" }]
        }
      },
      required: ["ticketId"]
    }
  };

  // 3. For EVERY chat model: (a) reply pong turn, (b) host-tool round trip
  for (const m of chatModels) {
    const modelRef = `antigravity/${m.id}`;

    // 3a. Reply pong
    let pongResult;
    try {
      const res = await executeTurn(
        {
          model: modelRef,
          messages: [{ role: "user", content: "Reply with the single word: pong" }]
        },
        inMemStore,
        catalog,
        DEFAULT_ENDPOINTS
      );
      pongResult = evaluatePongTurn(m.id, res);
    } catch (err) {
      const c = classifySmokeResult(err);
      pongResult = {
        check: "turn:pong",
        target: m.id,
        status: c.status,
        details: c.status === "skipped" ? `Skipped (${c.reason}: ${c.resetTime})` : c.error
      };
    }
    results.push(pongResult);
    await sleep(600);

    // 3b. Host-tool round trip with colon in name and anyOf/nullable
    let toolResult;
    try {
      const turn1 = await executeTurn(
        {
          model: modelRef,
          messages: [
            {
              role: "user",
              content: "Please check ticket 'PROJ-99' using jira:get_ticket and report its status."
            }
          ],
          tools: [toolDefinition]
        },
        inMemStore,
        catalog,
        DEFAULT_ENDPOINTS
      );

      let turn2 = null;
      if (turn1.toolCalls && turn1.toolCalls.length > 0) {
        const call = turn1.toolCalls[0];
        turn2 = await executeTurn(
          {
            model: modelRef,
            messages: [
              {
                role: "user",
                content: "Please check ticket 'PROJ-99' using jira:get_ticket and report its status."
              },
              {
                role: "assistant",
                content: turn1.text || "",
                toolCalls: [call]
              },
              {
                role: "tool",
                toolCallId: call.id,
                name: call.name,
                content: JSON.stringify({ summary: "Upstream sync task", status: "Resolved" })
              }
            ],
            tools: [toolDefinition]
          },
          inMemStore,
          catalog,
          DEFAULT_ENDPOINTS
        );
      }
      toolResult = evaluateToolRoundTrip(m.id, turn1, turn2);
    } catch (err) {
      const c = classifySmokeResult(err);
      toolResult = {
        check: "turn:tool_roundtrip",
        target: m.id,
        status: c.status,
        details: c.status === "skipped" ? `Skipped (${c.reason}: ${c.resetTime})` : c.error
      };
    }
    results.push(toolResult);
    await sleep(600);
  }

  // 4. Usage: 5 windows present
  let usageResult;
  try {
    const quota = await catalog.getUsage(inMemStore);
    usageResult = evaluateUsage(quota, options.minUsageWindows);
  } catch (err) {
    const c = classifySmokeResult(err);
    usageResult = {
      check: "usage",
      target: "retrieveUserQuotaSummary",
      status: c.status,
      details: c.status === "skipped" ? `Skipped (${c.reason}: ${c.resetTime})` : c.error
    };
  }
  results.push(usageResult);
  await sleep(500);

  // 5. Search: citations returned
  let searchResult;
  try {
    const searchProvider = buildAntigravityWebSearchProvider({ endpoints: DEFAULT_ENDPOINTS });
    // Use the live in-memory credential (it may have been refreshed or had its managed
    // project resolved by earlier checks).
    const accessToken = await getValidAccessToken(inMemStore, DEFAULT_ENDPOINTS);
    const live = await inMemStore.getSecret(PROVIDER_ID);
    const res = await searchProvider.search({
      query: "Google DeepMind Gemini news",
      apiKey: JSON.stringify({
        token: accessToken,
        ...(live?.projectId ? { projectId: live.projectId } : {})
      })
    });
    searchResult = evaluateSearch(res);
  } catch (err) {
    const c = classifySmokeResult(err);
    searchResult = {
      check: "search",
      target: "antigravity-search",
      status: c.status,
      details: c.status === "skipped" ? `Skipped (${c.reason}: ${c.resetTime})` : c.error
    };
  }
  results.push(searchResult);
  await sleep(500);


  // 5b. Web fetch: run-time nonce echo URL
  let fetchResult;
  try {
    const fetchProvider = buildAntigravityWebFetchProvider({ endpoints: DEFAULT_ENDPOINTS });
    const accessToken = await getValidAccessToken(inMemStore, DEFAULT_ENDPOINTS);
    const live = await inMemStore.getSecret(PROVIDER_ID);
    const nonce = randomUUID();
    const res = await fetchProvider.fetch({
      url: `https://postman-echo.com/get?n=${nonce}`,
      extractMode: "text",
      apiKey: JSON.stringify({
        token: accessToken,
        ...(live?.projectId ? { projectId: live.projectId } : {})
      })
    });
    fetchResult = evaluateFetch(res, nonce);
  } catch (err) {
    const c = classifySmokeResult(err);
    fetchResult = {
      check: "fetch",
      target: "antigravity-fetch",
      status: c.status,
      details: c.status === "skipped" ? `Skipped (${c.reason}: ${c.resetTime})` : c.error
    };
  }
  results.push(fetchResult);
  await sleep(500);

  // 6. Image generation on default model
  let imageGenResult;
  try {
    const imageProvider = buildAntigravityImageGenerationProvider({
      endpoints: DEFAULT_ENDPOINTS,
      defaultAuthStore: inMemStore
    });
    let res;
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await imageProvider.generateImage({
          prompt: "a minimalist geometric cube on black background",
          model: DEFAULT_IMAGE_MODEL,
          authStore: inMemStore
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt === 0 && isTransientImageError(e)) {
          await sleep(2000);
          continue;
        }
        throw e;
      }
    }
    if (lastErr) throw lastErr;
    imageGenResult = evaluateImageGeneration(DEFAULT_IMAGE_MODEL, res);
  } catch (err) {
    const c = classifySmokeResult(err);
    imageGenResult = {
      check: "image:generation",
      target: DEFAULT_IMAGE_MODEL,
      status: c.status,
      details: c.status === "skipped" ? `Skipped (${c.reason}: ${c.resetTime})` : c.error
    };
  }
  results.push(imageGenResult);
  await sleep(500);

  // 7. Image describe on default model
  let imageDescribeResult;
  try {
    const redPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await executeTurn(
      {
        model: "antigravity/gemini-3.8-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What color is this image? Reply in one word." },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${redPng}` }
              }
            ]
          }
        ]
      },
      inMemStore,
      catalog,
      DEFAULT_ENDPOINTS
    );
    imageDescribeResult = evaluateImageDescribe("gemini-3.8-flash", res);
  } catch (err) {
    const c = classifySmokeResult(err);
    imageDescribeResult = {
      check: "image:describe",
      target: "gemini-3.8-flash",
      status: c.status,
      details: c.status === "skipped" ? `Skipped (${c.reason}: ${c.resetTime})` : c.error
    };
  }
  results.push(imageDescribeResult);

  // Summary counts
  const passed = results.filter((r) => r.status === "pass").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "fail").length;

  if (options.json) {
    emitJson(
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          authSource: profile.source,
          summary: { passed, skipped, failed, total: results.length },
          checks: results
        },
        null,
        2
      )
    );
    process.exit(failed > 0 ? 1 : 0);
  }

  // Readable table
  console.log("\n==========================================================================================");
  console.log("                       ANTIGRAVITY INTEGRATION SMOKE REPORT                               ");
  console.log("==========================================================================================");
  console.log(
    "Check".padEnd(22) +
      "Target".padEnd(28) +
      "Result".padEnd(12) +
      "Details"
  );
  console.log("------------------------------------------------------------------------------------------");

  for (const r of results) {
    let statusColored = r.status;
    if (r.status === "pass") {
      statusColored = "\x1b[32mPASS\x1b[0m";
    } else if (r.status === "skipped") {
      statusColored = "\x1b[33mSKIPPED\x1b[0m";
    } else {
      statusColored = "\x1b[31mFAIL\x1b[0m";
    }
    console.log(
      r.check.padEnd(22) +
        r.target.padEnd(28) +
        statusColored.padEnd(21) +
        r.details
    );
  }

  console.log("==========================================================================================");
  console.log(`Summary: \x1b[32m${passed} passed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m, \x1b[31m${failed} failed\x1b[0m (Total: ${results.length})`);
  console.log("==========================================================================================\n");

  process.exit(failed > 0 ? 1 : 0);
}

// Only run CLI when invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("Fatal:", sanitizeError(err));
    process.exit(1);
  });
}
