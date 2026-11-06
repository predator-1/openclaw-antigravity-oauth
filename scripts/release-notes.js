#!/usr/bin/env node
/**
 * Build GitHub Release notes for v<version>: the CHANGELOG section plus the exact
 * OpenClaw git install/update commands (@release, @v<version>) and the optional tarball.
 * Usage: node scripts/release-notes.js <version> <owner/repo> > NOTES.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agyVersionFromPlugin } from "./plugin-version.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

export function releaseNotes(version, repo, changelog) {
  const agyVersion = agyVersionFromPlugin(version) ?? version;
  const tarball = `openclaw-antigravity-oauth-${version}.tgz`;
  const git = `git:github.com/${repo}`;
  return [
    changelogSection(changelog, version) || "See CHANGELOG.md.",
    "",
    `Targets agy ${agyVersion}. Tag \`v${version}\` and branch \`release\` point at the release commit`,
    "(the tagged main sources plus the built `dist/`).",
    "",
    "### Install or update",
    "",
    "```bash",
    `openclaw plugins install ${git}@release          # follow releases`,
    `openclaw plugins install ${git}@v${version}   # pin this version`,
    "openclaw plugins update openclaw-antigravity-oauth",
    "```",
    "",
    "Coming from an `@main` install: reinstall once from `@release` with `--force`.",
    "",
    `Optional npm-pack asset: \`gh release download v${version} -R ${repo} -p "${tarball}" -p SHA256SUMS\`,`,
    `\`sha256sum -c --ignore-missing SHA256SUMS\`, \`openclaw plugins install npm-pack:./${tarball} --force\`.`,
    ""
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, repo] = process.argv.slice(2);
  if (!version || !repo) {
    console.error("usage: release-notes.js <version> <owner/repo>");
    process.exit(2);
  }
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  process.stdout.write(releaseNotes(version, repo, changelog));
}
