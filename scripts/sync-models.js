#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const repoTmpDir = process.env.SYNC_MODELS_TMP_DIR || path.join(repoRoot, ".tmp");

function findOpenClawBin() {
  if (process.env.OPENCLAW_BIN) {
    return process.env.OPENCLAW_BIN;
  }
  const customPath = path.join(os.homedir(), ".openclaw", "bin", "openclaw");
  if (fs.existsSync(customPath)) {
    return customPath;
  }
  return "openclaw";
}

const openclawBin = findOpenClawBin();

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;
  const pruneStaticCatalog = args.includes("--prune-static-catalog");
  return { apply: !dryRun, dryRun, pruneStaticCatalog };
}

const { apply, dryRun, pruneStaticCatalog } = parseArgs();

const configPath =
  process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json");
if (!fs.existsSync(configPath)) {
  console.error("openclaw.json not found at:", configPath);
  process.exit(1);
}

// Read-only inspection of the current openclaw.json
let currentConfig = {};
try {
  currentConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  console.error("Failed to parse openclaw.json:", err.message);
  process.exit(1);
}

const DEFAULT_BASE_URL =
  currentConfig.models?.providers?.antigravity?.baseUrl ||
  "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";

const plannedOperations = [];

// 1. models.providers.antigravity baseUrl, api, auth
const currentProvider = currentConfig.models?.providers?.antigravity;
if (!currentProvider?.baseUrl || currentProvider.baseUrl !== DEFAULT_BASE_URL) {
  plannedOperations.push({
    type: "set",
    path: "models.providers.antigravity.baseUrl",
    valueJson: JSON.stringify(DEFAULT_BASE_URL),
    description: `Set Antigravity provider baseUrl to ${DEFAULT_BASE_URL}`
  });
}
if (!currentProvider?.api || currentProvider.api !== "openai-completions") {
  plannedOperations.push({
    type: "set",
    path: "models.providers.antigravity.api",
    valueJson: JSON.stringify("openai-completions"),
    description: "Set Antigravity provider api to openai-completions"
  });
}
if (!currentProvider?.auth || currentProvider.auth !== "oauth") {
  plannedOperations.push({
    type: "set",
    path: "models.providers.antigravity.auth",
    valueJson: JSON.stringify("oauth"),
    description: "Set Antigravity provider auth to oauth"
  });
}

// 2. agents.defaults.models["antigravity/*"]
const currentWildcard = currentConfig.agents?.defaults?.models?.["antigravity/*"];
if (
  !currentWildcard ||
  typeof currentWildcard !== "object" ||
  currentWildcard.agentRuntime?.id !== "openclaw"
) {
  plannedOperations.push({
    type: "set",
    path: 'agents.defaults.models["antigravity/*"].agentRuntime.id',
    valueJson: JSON.stringify("openclaw"),
    description: "Authorize Antigravity provider wildcard for agents runtime"
  });
}

// 3. Canonical model aliases and explicit openclaw runtime (per-field granularity)
const canonicalModelAliases = {
  "antigravity/gemini-4-argon": "argon",
  "antigravity/gemini-3.8-flash": "flash",
  "antigravity/gemini-3-flash": "gemini3-flash",
  "antigravity/claude-opus-5-5": "agy-opus",
  "antigravity/claude-sonnet-5-5": "agy-sonnet",
  "antigravity/gpt-oss-120b": "gpt-oss"
};

for (const [modelKey, alias] of Object.entries(canonicalModelAliases)) {
  const currentModelConfig = currentConfig.agents?.defaults?.models?.[modelKey];

  if (!currentModelConfig || typeof currentModelConfig !== "object") {
    // If model entry doesn't exist yet, create base with owned fields
    plannedOperations.push({
      type: "set",
      path: `agents.defaults.models["${modelKey}"]`,
      valueJson: JSON.stringify({ alias, agentRuntime: { id: "openclaw" } }),
      description: `Configure ${modelKey} with alias '${alias}' and openclaw runtime`
    });
    continue;
  }

  // Preserve user-added manual fields: only mutate owned fields if different
  if (currentModelConfig.alias !== alias) {
    plannedOperations.push({
      type: "set",
      path: `agents.defaults.models["${modelKey}"].alias`,
      valueJson: JSON.stringify(alias),
      description: `Set alias for ${modelKey} to '${alias}'`
    });
  }

  if (currentModelConfig.agentRuntime?.id !== "openclaw") {
    plannedOperations.push({
      type: "set",
      path: `agents.defaults.models["${modelKey}"].agentRuntime.id`,
      valueJson: JSON.stringify("openclaw"),
      description: `Set agentRuntime.id for ${modelKey} to 'openclaw'`
    });
  }
}

// 4. If modelPolicy.allow is configured, ensure antigravity/* is included
if (Array.isArray(currentConfig.agents?.defaults?.modelPolicy?.allow)) {
  if (!currentConfig.agents.defaults.modelPolicy.allow.includes("antigravity/*")) {
    const updatedAllow = [...currentConfig.agents.defaults.modelPolicy.allow, "antigravity/*"];
    plannedOperations.push({
      type: "set",
      path: "agents.defaults.modelPolicy.allow",
      valueJson: JSON.stringify(updatedAllow),
      description: "Append antigravity/* to agents.defaults.modelPolicy.allow"
    });
  }
}

// 5. Static catalog pruning (opt-in via --prune-static-catalog)
function getDynamicCatalogModelIds() {
  try {
    const stdout = execFileSync(
      openclawBin,
      ["models", "list", "--all", "--provider", "antigravity", "--json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.models)
        ? parsed.models
        : Array.isArray(parsed?.items)
          ? parsed.items
          : null;
    if (Array.isArray(list)) {
      const ids = new Set();
      for (const item of list) {
        const rawId = (typeof item === "string" ? item : item?.key ?? item?.id ?? item?.model ?? "")
          .replace(/^antigravity\//, "")
          .trim();
        if (rawId) {
          ids.add(rawId);
        }
      }
      return ids;
    }
  } catch {
    // Dynamic catalog unavailable via CLI
  }
  return null;
}

const staticModels = currentConfig.models?.providers?.antigravity?.models;
if (Array.isArray(staticModels) && staticModels.length > 0) {
  const staticIds = staticModels
    .map((m) => (typeof m === "string" ? m : m?.id))
    .filter(Boolean);

  const dynamicCatalogModelIds = getDynamicCatalogModelIds();

  if (dynamicCatalogModelIds === null) {
    if (pruneStaticCatalog) {
      console.error(
        "Cannot prune static catalog: unable to read dynamic catalog from OpenClaw (openclaw models list --all --provider antigravity --json). Start the OpenClaw gateway or ensure provider is configured."
      );
      process.exit(1);
    } else {
      console.warn(
        "Warning: Could not read dynamic model catalog from OpenClaw; skipping static catalog verification."
      );
    }
  } else {
    const missingIds = staticIds.filter((id) => !dynamicCatalogModelIds.has(id));

    if (pruneStaticCatalog) {
      if (missingIds.length > 0) {
        console.error(
          `Cannot prune static catalog: the following models are not served by the dynamic catalog: ${missingIds.join(", ")}`
        );
        process.exit(1);
      }
      plannedOperations.push({
        type: "prune-static-verified",
        path: "models.providers.antigravity.models",
        description: "Verify dynamic catalog & remove duplicate static model list in models.providers.antigravity.models (backed up to repo .tmp/, rolled back on model loss)",
        staticModels,
        staticIds
      });
    } else {
      if (missingIds.length > 0) {
        console.warn(
          `Warning: The following static models in models.providers.antigravity.models are not in the dynamic catalog: ${missingIds.join(", ")}`
        );
      }
      console.log(
        `Note: Static model list present (${staticModels.length} models). Pass '--prune-static-catalog' to verify and remove models.providers.antigravity.models once dynamic catalog is verified.`
      );
    }
  }
}

if (plannedOperations.length === 0) {
  console.log("All Antigravity model configurations are already up to date. No changes needed.");
  process.exit(0);
}

if (dryRun) {
  console.log(`[dry-run] Found ${plannedOperations.length} pending configuration change(s):`);
  for (const op of plannedOperations) {
    console.log(`  # ${op.description}`);
    if (op.type === "prune-static-verified") {
      console.log(`  [verify & rollback] Step 1: Save backup to ${path.join(repoTmpDir, "static-models-backup-<timestamp>.json")}`);
      console.log(`  [verify & rollback] Step 2: ${openclawBin} config unset '${op.path}'`);
      console.log(`  [verify & rollback] Step 3: ${openclawBin} models list --all --provider antigravity --json (verify no models lost)`);
      console.log(`  [verify & rollback] Step 4: ${openclawBin} config set '${op.path}' '<backupJson>' --strict-json (rollback if any model is missing)`);
    } else if (op.type === "unset") {
      console.log(`  ${openclawBin} config unset '${op.path}'`);
    } else {
      console.log(`  ${openclawBin} config set '${op.path}' '${op.valueJson}' --strict-json`);
    }
  }
  console.log(
    "\nDry run complete. No configuration was changed. Run with '--apply' to apply these changes."
  );
  process.exit(0);
}

// Apply mode: execute each operation via the OpenClaw CLI one key at a time
console.log(`Applying ${plannedOperations.length} configuration change(s) via OpenClaw CLI...`);
let appliedCount = 0;
for (const op of plannedOperations) {
  console.log(`- ${op.description}`);
  try {
    if (op.type === "prune-static-verified") {
      // 1. Save backup to repo .tmp/
      if (!fs.existsSync(repoTmpDir)) {
        fs.mkdirSync(repoTmpDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupFile = path.join(repoTmpDir, `static-models-backup-${timestamp}.json`);
      fs.writeFileSync(backupFile, JSON.stringify(op.staticModels, null, 2), "utf8");
      console.log(`  Saved static models backup to ${backupFile}`);

      // 2. Unset static models
      execFileSync(openclawBin, ["config", "unset", op.path], {
        stdio: "pipe",
        encoding: "utf8"
      });

      // 3. Query catalog after unset
      const afterCatalog = getDynamicCatalogModelIds();
      if (afterCatalog === null) {
        console.error("  Verification failed: unable to read dynamic catalog after unset. Rolling back...");
        execFileSync(
          openclawBin,
          ["config", "set", op.path, JSON.stringify(op.staticModels), "--strict-json"],
          { stdio: "pipe", encoding: "utf8" }
        );
        console.error(`  Rolled back static models from ${backupFile}.`);
        process.exit(1);
      }

      // 4. Verify no models lost
      const lostModels = op.staticIds.filter((id) => !afterCatalog.has(id));
      if (lostModels.length > 0) {
        console.error(
          `  Verification failed: dynamic catalog is missing models: ${lostModels.join(", ")}. Rolling back...`
        );
        execFileSync(
          openclawBin,
          ["config", "set", op.path, JSON.stringify(op.staticModels), "--strict-json"],
          { stdio: "pipe", encoding: "utf8" }
        );
        console.error(`  Rolled back static models from ${backupFile}. Static models were restored.`);
        process.exit(1);
      }

      console.log(`  Verification succeeded: all models verified in dynamic catalog without static list. Prune complete.`);
    } else if (op.type === "unset") {
      execFileSync(openclawBin, ["config", "unset", op.path], {
        stdio: "pipe",
        encoding: "utf8"
      });
    } else {
      execFileSync(openclawBin, ["config", "set", op.path, op.valueJson, "--strict-json"], {
        stdio: "pipe",
        encoding: "utf8"
      });
    }
    appliedCount++;
  } catch (err) {
    console.error(`Failed to execute ${op.path}:`, err.message);
    process.exit(1);
  }
}

console.log(`Successfully applied ${appliedCount} configuration change(s).`);
