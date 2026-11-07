#!/usr/bin/env node
/**
 * Release-shape checks.
 *
 *   node scripts/verify-package.js
 *     Checks the npm-pack tarball (optional GitHub Release asset), after `npm run build`:
 *     - package version maps to agy CLI_VERSION: <major>.<minor>.<agyPatch*100 + fix>
 *     - tarball contains the compiled entry, manifest and docs; no sources, tests,
 *       fingerprints or credential-like files
 *
 *   node scripts/verify-package.js --release-commit=<rev> [--parent=<sha>]
 *     Checks a release commit (what `git:` installs of @release / @v<version> fetch):
 *     - exactly one parent (the tagged main commit; must equal --parent when given)
 *     - it differs from its parent only under dist/
 *     - dist/ is present: the manifest's entry (package.json openclaw.extensions), main,
 *       types, and one compiled .js per src/*.ts
 *     - package version maps to CLI_VERSION
 *
 * Exits non-zero with a reason on any violation. npm is resolved next to process.execPath.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginVersionFor, pluginVersionMatchesAgy } from "./plugin-version.js";
import { resolveNpmCommand } from "./resolve-npm.js";


const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function expectedVersionMatches(packageVersion, cliVersion) {
  return pluginVersionMatchesAgy(packageVersion, cliVersion);
}

export function checkPackedFiles(files, pkg) {
  const problems = [];
  const required = ["package.json", "openclaw.plugin.json", "README.md", ...pkg.openclaw.extensions.map((e) => e.replace(/^\.\//, ""))];
  for (const f of required) if (!files.includes(f)) problems.push(`missing from package: ${f}`);
  // ClawHub rejects external code plugins without these (docs.openclaw.ai/clawhub/publishing).
  if (!pkg.openclaw?.compat?.pluginApi) problems.push("package.json openclaw.compat.pluginApi is required for ClawHub");
  if (!pkg.openclaw?.build?.openclawVersion) problems.push("package.json openclaw.build.openclawVersion is required for ClawHub");
  for (const f of files) {
    if (/^(src|test|scripts|upstream|ci|\.github)\//.test(f)) problems.push(`unexpected file in package: ${f}`);
    if (/(token|credential|\.env|\.pem|\.key)/i.test(path.basename(f))) problems.push(`credential-like file in package: ${f}`);
  }
  return problems;
}

/** Files a release commit must contain: the compiled manifest entry, main, types, one .js per source. */
export function checkReleaseTree(files, pkg) {
  const problems = [];
  const has = new Set(files);
  if (!files.some((f) => f.startsWith("dist/"))) problems.push("release tree has no dist/");
  const strip = (p) => String(p).replace(/^\.\//, "");
  const required = [...(pkg.openclaw?.extensions ?? []).map(strip), ...(pkg.main ? [strip(pkg.main)] : []), ...(pkg.types ? [strip(pkg.types)] : [])];
  for (const f of new Set(required)) if (!has.has(f)) problems.push(`manifest entry not compiled: ${f}`);
  for (const f of ["package.json", "openclaw.plugin.json"]) if (!has.has(f)) problems.push(`missing from release tree: ${f}`);
  for (const f of files) {
    const m = f.match(/^src\/([^/]+)\.ts$/);
    if (m && !f.endsWith(".d.ts") && !has.has(`dist/${m[1]}.js`)) problems.push(`not compiled: ${f} (dist/${m[1]}.js missing)`);
  }
  return problems;
}

/** A release commit is its parent (the tagged main commit) plus dist/ and nothing else. */
export function checkReleaseCommitShape({ parents, changed, expectedParent }) {
  const problems = [];
  if (parents.length !== 1) problems.push(`release commit must have exactly one parent (has ${parents.length})`);
  else if (expectedParent && parents[0] !== expectedParent) problems.push(`release commit parent ${parents[0]} is not the tagged commit ${expectedParent}`);
  if (changed.length === 0) problems.push("release commit adds nothing (dist/ missing)");
  for (const f of changed) if (!f.startsWith("dist/")) problems.push(`release commit changes a non-dist file: ${f}`);
  return problems;
}

function git(args) {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || "").trim()}`);
  return res.stdout;
}

function versionProblems(pkg, constants, lock) {
  const problems = [];
  const cliVersion = constants.match(/export const CLI_VERSION = ["']([^"']+)["']/)?.[1];
  if (!cliVersion) problems.push("CLI_VERSION not found in src/constants.ts");
  else if (!expectedVersionMatches(pkg.version, cliVersion)) {
    problems.push(
      `package.json version ${pkg.version} does not map to agy CLI_VERSION ${cliVersion} ` +
        `(expected ${pluginVersionFor(cliVersion, 0)} .. ${pluginVersionFor(cliVersion, 99)})`
    );
  }
  if (lock && (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version)) {
    problems.push(`package-lock.json version (${lock.version}) does not match package.json (${pkg.version}); run npm install`);
  }
  return problems;
}

function report(problems, okMessage) {
  if (problems.length) {
    for (const p of problems) console.error(`verify-package: ${p}`);
    process.exit(1);
  }
  console.log(okMessage);
}

function verifyReleaseCommit(rev, expectedParent) {
  const sha = git(["rev-parse", "--verify", `${rev}^{commit}`]).trim();
  const parents = git(["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/).slice(1);
  const changed = parents.length === 1 ? git(["diff", "--name-only", "--no-renames", parents[0], sha]).split("\n").filter(Boolean) : [];
  const files = git(["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean);
  const show = (f) => git(["show", `${sha}:${f}`]);
  const pkg = JSON.parse(show("package.json"));
  const problems = [
    ...checkReleaseCommitShape({ parents, changed, expectedParent }),
    ...checkReleaseTree(files, pkg),
    ...versionProblems(pkg, show("src/constants.ts"), JSON.parse(show("package-lock.json")))
  ];
  report(problems, `release commit OK: ${sha} = ${parents[0]} + dist/ (${changed.length} files), version ${pkg.version}`);
}

function main() {
  const arg = (name) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const releaseCommit = arg("release-commit");
  if (releaseCommit) return verifyReleaseCommit(releaseCommit, arg("parent"));

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const constants = fs.readFileSync(path.join(repoRoot, "src", "constants.ts"), "utf8");
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  const problems = versionProblems(pkg, constants, lock);

  // The release commit = this tree + dist/: check the built dist/ covers the manifest entry and every source.
  const tracked = git(["ls-files"]).split("\n").filter((f) => f && !f.startsWith("dist/"));
  const distDir = path.join(repoRoot, "dist");
  const built = fs.existsSync(distDir)
    ? fs.readdirSync(distDir, { recursive: true }).map((f) => `dist/${String(f).split(path.sep).join("/")}`)
    : [];
  problems.push(...checkReleaseTree([...tracked, ...built], pkg));

  // Resolve npm from process.execPath (do not rely on PATH), like sync-upstream-vars.js.
  const npm = resolveNpmCommand();
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` };
  const res = spawnSync(npm.command, [...npm.args, "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    shell: process.platform === "win32" && /\.cmd$/i.test(npm.command)
  });
  if (res.status !== 0) {
    problems.push(`npm pack --dry-run failed: ${(res.stderr || "").trim()}`);
  } else {
    const [info] = JSON.parse(res.stdout);
    const files = info.files.map((f) => f.path);
    problems.push(...checkPackedFiles(files, pkg));
    if (problems.length === 0) {
      console.log(`package OK: ${info.filename} (${files.length} files, ${info.size} bytes)`);
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`verify-package: ${p}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
