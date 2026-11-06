import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const verify = await import(pathToFileURL(path.resolve("scripts/verify-package.js")).href);
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const cliVersion = fs.readFileSync("src/constants.ts", "utf8").match(/export const CLI_VERSION = "([^"]+)"/)?.[1];

describe("package version and release shape", () => {
  it("package version maps to the targeted agy CLI_VERSION (major.minor.patch*100+fix)", () => {
    assert.ok(cliVersion);
    assert.ok(verify.expectedVersionMatches(pkg.version, cliVersion), `${pkg.version} vs agy ${cliVersion}`);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[""].version, pkg.version);
  });

  it("CLI_VERSION equals the agy version recorded in the shared fingerprint baseline", () => {
    const baseline = JSON.parse(fs.readFileSync("upstream/agy-fingerprint.json", "utf8"));
    assert.equal(baseline.cliVersion, cliVersion);
    for (const extra of ["platform", "binaryFormat", "binarySha256"]) {
      assert.equal(baseline[extra], undefined, extra);
    }
  });

  it("expectedVersionMatches accepts patch*100 + fix (0..99) only", () => {
    assert.equal(verify.expectedVersionMatches("1.4.1200", "1.4.12"), true);
    assert.equal(verify.expectedVersionMatches("1.4.1201", "1.4.12"), true);
    assert.equal(verify.expectedVersionMatches("1.4.1299", "1.4.12"), true);
    assert.equal(verify.expectedVersionMatches("1.4.1300", "1.4.12"), false);
    assert.equal(verify.expectedVersionMatches("1.4.1199", "1.4.12"), false);
    assert.equal(verify.expectedVersionMatches("1.4.12", "1.4.12"), false, "raw agy version is not a plugin version");
    assert.equal(verify.expectedVersionMatches("1.4.12-1", "1.4.12"), false, "-N suffixes are not used");
    assert.equal(verify.expectedVersionMatches("1.4.1200-beta.1", "1.4.12"), false);
    assert.equal(verify.expectedVersionMatches("1.5.1200", "1.4.12"), false);
  });

  it("plugin-version mapping round-trips and orders fixes above the base", async () => {
    const pv = await import(pathToFileURL(path.resolve("scripts/plugin-version.js")).href);
    assert.equal(pv.pluginVersionFor("1.4.12"), "1.4.1200");
    assert.equal(pv.pluginVersionFor("1.4.12", 1), "1.4.1201");
    assert.equal(pv.pluginVersionFor("1.4.0", 7), "1.4.7");
    assert.equal(pv.pluginVersionFor("2.0.3", 99), "2.0.399");
    assert.throws(() => pv.pluginVersionFor("1.4.12", 100), /out of range/);
    assert.throws(() => pv.pluginVersionFor("1.4.12", -1), /out of range/);
    assert.throws(() => pv.pluginVersionFor("1.4.12-beta"), /not plain/);
    assert.deepEqual(pv.parsePluginVersion("1.4.1203"), { agyVersion: "1.4.12", fix: 3 });
    assert.deepEqual(pv.parsePluginVersion("1.4.7"), { agyVersion: "1.4.0", fix: 7 });
    assert.equal(pv.agyVersionFromPlugin("1.4.1299"), "1.4.12");
    assert.equal(pv.parsePluginVersion("1.4.1200-1"), null);
    for (let fix = 0; fix <= 99; fix++) {
      assert.equal(pv.agyVersionFromPlugin(pv.pluginVersionFor("1.4.12", fix)), "1.4.12");
    }
    // Fixes sort above the base and below the next agy patch (numeric semver patch order).
    const order = ["1.4.1200", "1.4.1201", "1.4.1299", "1.4.1300"].map((v) => Number(v.split(".")[2]));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  it("checkPackedFiles requires the compiled entry and manifest and rejects sources/secrets", () => {
    const good = ["package.json", "openclaw.plugin.json", "README.md", "dist/index.js"];
    assert.deepEqual(verify.checkPackedFiles(good, pkg), []);
    const bad = verify.checkPackedFiles(["package.json", "README.md", "src/index.ts", "dist/oauth-token.json"], pkg);
    assert.ok(bad.some((p: string) => p.includes("missing from package: openclaw.plugin.json")));
    assert.ok(bad.some((p: string) => p.includes("missing from package: dist/index.js")));
    assert.ok(bad.some((p: string) => p.includes("unexpected file in package: src/index.ts")));
    assert.ok(bad.some((p: string) => p.includes("credential-like file")));
  });

  it("dist/ is build output, not source", () => {
    assert.match(fs.readFileSync(".gitignore", "utf8"), /^dist\/$/m);
    assert.deepEqual(pkg.openclaw.extensions, ["./dist/index.js"]);
    assert.equal(pkg.scripts.prepack, "npm run build");
  });
});

const notes = await import(pathToFileURL(path.resolve("scripts/release-notes.js")).href);

describe("release notes", () => {
  const changelog = "# Changelog\n\n## [Unreleased]\n\n- wip\n\n## [1.4.1201] - 2026-11-02\n\n- fix A\n\n## [1.4.1200] - 2026-11-01\n\n- first\n";

  it("extracts exactly the tagged CHANGELOG section", () => {
    assert.equal(notes.changelogSection(changelog, "1.4.1200"), "- first");
    assert.equal(notes.changelogSection(changelog, "1.4.1201"), "- fix A");
    assert.equal(notes.changelogSection(changelog, "9.9.9"), null);
  });

  it("includes the git @release / @v<version> install, update, the optional tarball and the agy version", () => {
    const out = notes.releaseNotes("1.4.1201", "predator-1/openclaw-antigravity-oauth", changelog);
    assert.match(out, /openclaw plugins install git:github\.com\/predator-1\/openclaw-antigravity-oauth@release/);
    assert.match(out, /openclaw plugins install git:github\.com\/predator-1\/openclaw-antigravity-oauth@v1\.4\.1201/);
    assert.match(out, /openclaw plugins update openclaw-antigravity-oauth/);
    assert.match(out, /openclaw plugins install npm-pack:\.\/openclaw-antigravity-oauth-1\.4\.1201\.tgz --force/);
    assert.match(out, /Targets agy 1\.4\.12\./);
    assert.match(out, /sha256sum -c --ignore-missing SHA256SUMS/);
  });
});

describe("release commit shape", () => {
  const files = ["package.json", "package-lock.json", "openclaw.plugin.json", "src/index.ts", "src/auth.ts", "src/ambient.d.ts"];
  const dist = ["dist/index.js", "dist/index.d.ts", "dist/auth.js"];

  it("checkReleaseTree requires dist/ with the manifest entry, main, types and one .js per source", () => {
    assert.deepEqual(verify.checkReleaseTree([...files, ...dist], pkg), []);
    const none = verify.checkReleaseTree(files, pkg);
    assert.ok(none.includes("release tree has no dist/"));
    assert.ok(none.includes("manifest entry not compiled: dist/index.js"));
    const partial = verify.checkReleaseTree([...files, "dist/index.js", "dist/index.d.ts"], pkg);
    assert.deepEqual(partial, ["not compiled: src/auth.ts (dist/auth.js missing)"]);
  });

  it("checkReleaseCommitShape: one parent (the tagged commit), only dist/ changes", () => {
    assert.deepEqual(verify.checkReleaseCommitShape({ parents: ["abc"], changed: dist, expectedParent: "abc" }), []);
    assert.match(verify.checkReleaseCommitShape({ parents: ["abc"], changed: dist, expectedParent: "def" })[0], /not the tagged commit/);
    assert.match(verify.checkReleaseCommitShape({ parents: ["a", "b"], changed: dist })[0], /exactly one parent/);
    assert.deepEqual(verify.checkReleaseCommitShape({ parents: ["abc"], changed: [...dist, "README.md"] }), [
      "release commit changes a non-dist file: README.md"
    ]);
    assert.match(verify.checkReleaseCommitShape({ parents: ["abc"], changed: [] })[0], /adds nothing/);
  });
});

describe("npm resolution without PATH", () => {
  it("resolveNpmCommand runs npm-cli.js with the current node, or the npm next to node", async () => {
    const { resolveNpmCommand } = await import(pathToFileURL(path.resolve("scripts/resolve-npm.js")).href);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-resolve-"));
    const node = path.join(root, "bin", "node");
    const cli = path.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(cli, "");
    assert.deepEqual(resolveNpmCommand(node, {}), { command: node, args: [cli] });
    const viaEnv = path.join(root, "custom-npm-cli.js");
    fs.writeFileSync(viaEnv, "");
    assert.deepEqual(resolveNpmCommand(node, { npm_execpath: viaEnv }), { command: node, args: [viaEnv] });
    fs.rmSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "npm"), "");
    assert.deepEqual(resolveNpmCommand(node, {}), { command: path.join(root, "bin", "npm"), args: [] });
  });
});

describe("GitHub Actions pins", () => {
  // SHAs from before the Dependabot bump; each action.yml declared `runs.using: node20`.
  const node20Shas = new Set([
    "11d5960a326750d5838078e36cf38b85af677262", // actions/checkout@v4.4.0
    "49933ea5288caeca8642d1e84afbd3f7d6820020", // actions/setup-node@v4.4.0
    "ea165f8d65b6e75b540449e92b4886f43607fa02", // actions/upload-artifact@v4.6.2
    "d3f86a106a0bac45b974a628896c90dbdf5c8093" // actions/download-artifact@v4.3.0
  ]);
  // First release that sets `runs.using: node24` (not the deprecated Node 20 action runtime).
  const minNode24: Record<string, [number, number, number]> = {
    "actions/checkout": [5, 0, 0],
    "actions/setup-node": [5, 0, 0],
    "actions/upload-artifact": [6, 0, 0],
    "actions/download-artifact": [7, 0, 0]
  };

  it("workflow actions are SHA-pinned and off the deprecated Node 20 runtime", () => {
    const dir = path.resolve(".github/workflows");
    const files = fs.readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"));
    assert.ok(files.includes("ci.yml"));
    assert.ok(files.includes("release.yml"));
    const uses =
      /^\s+uses:\s+(\S+?)@([0-9a-f]{40})(?:\s+#\s+v?(\d+\.\d+\.\d+))?\s*$/i;
    let count = 0;
    for (const file of files) {
      const rel = `.github/workflows/${file}`;
      for (const [i, line] of fs.readFileSync(path.join(dir, file), "utf8").split(/\r?\n/).entries()) {
        if (!/\buses:/.test(line)) continue;
        const m = line.match(uses);
        assert.ok(m, `${rel}:${i + 1} must pin uses: owner/repo@<40-hex-sha> (got ${line.trim()})`);
        const [, action, sha, version] = m;
        count += 1;
        assert.equal(sha.length, 40, `${rel}:${i + 1} ${action} sha`);
        assert.ok(!node20Shas.has(sha), `${rel}:${i + 1} ${action}@${sha} is a known Node 20 pin`);
        const min = minNode24[action];
        if (!min) continue;
        assert.ok(version, `${rel}:${i + 1} ${action} needs a # vX.Y.Z comment`);
        const got = version.split(".").map(Number) as [number, number, number];
        const cmp = got[0] - min[0] || got[1] - min[1] || got[2] - min[2];
        assert.ok(cmp >= 0, `${rel}:${i + 1} ${action}@v${version} is below first node24 release v${min.join(".")}`);
      }
    }
    assert.ok(count >= 5, `expected pinned actions in ci.yml and release.yml, found ${count}`);
  });
});
