#!/usr/bin/env node
/**
 * scripts/sync-upstream-vars.js
 *
 * Deterministic fingerprinting and upstream variable synchronization tool.
 * Evaluates the installed `agy` CLI binary against the shared baseline
 * `upstream/agy-fingerprint.json`. Mach-O and ELF parsing work on any host OS.
 *
 * Supported agy binaries: Mach-O 64-bit (thin or universal) and ELF64 little-endian
 * (including PIE builds). PE/COFF is unsupported (verdict 30).
 *
 * Exit codes per mode:
 * - `--check`:
 *   - 0:  NO_CHANGE (up to date)
 *   - 10: SAFE (only safe fields changed: cliVersion, latestChangelog, or non-plugin rpc/hosts)
 *   - 20: REVIEW_NEEDED (protocol/API/used-by-plugin changes detected)
 *   - 30: ERROR (agy missing, constants missing, unparsable fingerprint, or extraction failure)
 * - Default (dry-run):
 *   - Outputs human or JSON report and exits with the verdict code (0, 10, 20, 30).
 * - `--apply`:
 *   - 0:  SUCCESS (verdict 0 nothing to apply with applied:false; or a writable verdict applied,
 *         verified & dist built with applied:true). REVIEW_NEEDED is writable only with
 *         `--investigated=<issue>` after the investigation issue records the findings.
 *   - 20: REVIEW_NEEDED (protocol changes detected, nothing applied unless `--investigated=<N>`)
 *   - 30: ERROR (verification build/test failed, constants/fingerprint parse failure, applied:false;
 *         written files are rolled back and dist/ rebuilt, see `rolledBack` in JSON)
 */

import { nextPluginVersion } from "./plugin-version.js";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const constantsPath = path.join(repoRoot, "src", "constants.ts");
export const FINGERPRINT_PATH = path.join(repoRoot, "upstream", "agy-fingerprint.json");
export const BASELINE_FIELDS = [
  "cliVersion",
  "latestChangelog",
  "rpcNames",
  "googleHosts",
  "oauthClientPrefixes",
  "consumerClientParity",
  "oauthScopes",
  "requestShapeMarkers",
  "subcommands",
  "models"
];

export const VERDICT = {
  NO_CHANGE: 0,
  SAFE: 10,
  REVIEW_NEEDED: 20,
  ERROR: 30
};

export function parseInvestigatedIssue(raw) {
  const value = String(raw ?? "").trim();
  const matched = value.match(/^#?(\d+)$/);
  const issue = matched ? Number(matched[1]) : 0;
  if (!matched || issue < 1) {
    throw new Error(
      `Invalid --investigated value '${raw}' (expected an issue number, e.g. --investigated=38)`
    );
  }
  return issue;
}

export function parseArgs(rawArgs = process.argv.slice(2)) {
  const apply = rawArgs.includes("--apply");
  const check = rawArgs.includes("--check");
  const dryRun = rawArgs.includes("--dry-run") || (!apply && !check);
  const json = rawArgs.includes("--json");

  const agyBinArg = rawArgs.find((a) => a.startsWith("--agy-bin="));
  const agyBin = agyBinArg ? agyBinArg.split("=")[1]?.trim() : process.env.AGY_BIN;

  if (rawArgs.includes("--force") || rawArgs.some((a) => a === "--platform" || a.startsWith("--platform="))) {
    throw new Error(
      "--platform and --force were removed; agy fingerprints share one baseline (upstream/agy-fingerprint.json)"
    );
  }

  const investigatedArg = rawArgs.find((a) => a.startsWith("--investigated="));
  const investigated = investigatedArg
    ? parseInvestigatedIssue(investigatedArg.slice("--investigated=".length))
    : undefined;

  return { apply, check, dryRun, json, agyBin, ...(investigated !== undefined ? { investigated } : {}) };
}

/** REVIEW_NEEDED applies only when `--investigated=<issue>` names the findings issue. */
export function shouldApplyUpdate(verdict, investigated) {
  if (verdict === VERDICT.SAFE) return true;
  if (verdict === VERDICT.REVIEW_NEEDED && investigated) return true;
  return false;
}

export function toBaselineFingerprint(fingerprint) {
  const out = {};
  for (const key of BASELINE_FIELDS) {
    if (fingerprint && Object.prototype.hasOwnProperty.call(fingerprint, key)) {
      out[key] = fingerprint[key];
    }
  }
  return out;
}

import { resolveNpmBinary } from "./resolve-npm.js";
export { resolveNpmBinary };

/**
 * Resolve installed agy binary.
 * Priority: explicit --agy-bin / env.AGY_BIN -> which agy -> ~/.local/bin/agy
 */
export function resolveAgyBinary(explicitPath) {
  if (explicitPath) {
    if (fs.existsSync(explicitPath)) return explicitPath;
    throw new Error(`Configured agy binary not found at: ${explicitPath}`);
  }

  // 1. Try which agy
  try {
    const whichRes = spawnSync("which", ["agy"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"]
    });
    const which = (whichRes.stdout || "").trim();
    if (which && fs.existsSync(which)) return which;
  } catch {
    // Ignore and fallback
  }

  // 2. Default ~/.local/bin/agy
  const defaultPath = path.join(os.homedir(), ".local", "bin", "agy");
  if (fs.existsSync(defaultPath)) return defaultPath;

  throw new Error(`agy CLI binary not found. Checked 'which agy' and '${defaultPath}'`);
}

/**
 * Execute allowed agy commands safely.
 * Only allowed: agy --version, agy --help, agy changelog, agy models.
 */
function runAgyCommand(binPath, subcommand) {
  const allowed = {
    "--version": ["--version"],
    "--help": ["--help"],
    changelog: ["changelog"],
    models: ["models"]
  };

  const args = allowed[subcommand];
  if (!args) {
    throw new Error(`Disallowed agy invocation: '${subcommand}'. Only --version, --help, changelog, models are permitted.`);
  }

  const res = spawnSync(binPath, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  if (res.error) {
    throw new Error(`Failed to execute 'agy ${args.join(" ")}': ${res.error.message}`);
  }

  const output = (res.stdout || "") + (res.stderr || "");
  if (res.status !== 0 && subcommand !== "--help") {
    throw new Error(`Command 'agy ${args.join(" ")}' exited with code ${res.status}: ${output}`);
  }

  return output;
}

/**
 * Extract version string from agy --version output
 */
export function extractCliVersion(rawVersion) {
  const match = rawVersion.trim().match(/^[vV]?([0-9]+\.[0-9]+\.[0-9]+[a-zA-Z0-9.-]*)/);
  if (!match) {
    throw new Error(`Unable to parse version from agy output: "${rawVersion.trim()}"`);
  }
  return match[1];
}

/**
 * Extract subcommands from agy --help
 */
export function extractSubcommands(rawHelp) {
  const lines = rawHelp.split("\n");
  const subcommands = new Set();
  let inSubcommandsSection = false;

  for (const line of lines) {
    if (/available subcommands:/i.test(line)) {
      inSubcommandsSection = true;
      continue;
    }
    if (inSubcommandsSection) {
      if (/^[a-zA-Z0-9]/.test(line.trim()) && line.startsWith("  ")) {
        const cmd = line.trim().split(/\s+/)[0];
        if (cmd) subcommands.add(cmd);
      } else if (line.trim().length === 0) {
        inSubcommandsSection = false;
      }
    }
  }

  if (subcommands.size === 0) {
    const fallbackMatch = rawHelp.match(/Available subcommands:[\s\S]*?(?=\n\n|\n[A-Z]|$)/i);
    if (fallbackMatch) {
      const cmdRegex = /^\s{2,}([a-z0-9_-]+)/gm;
      let m;
      while ((m = cmdRegex.exec(fallbackMatch[0])) !== null) {
        subcommands.add(m[1]);
      }
    }
  }

  return Array.from(subcommands).sort();
}

/**
 * Extract models list from agy models
 */
export function extractModels(rawModels) {
  return rawModels
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !/^fetching/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean)
    .sort();
}

/**
 * Extract latest changelog entry block from agy changelog
 */
export function extractLatestChangelog(rawChangelog) {
  const trimmed = rawChangelog.trim();
  if (!trimmed) return "";
  const sections = trimmed.split(/\n\s*\n(?=[vV]?[0-9]+\.[0-9]+:?)/);
  return (sections[0] || "").trim();
}

/**
 * Read constants.ts to get consumer client config and CLI_VERSION.
 * Throws if constants.ts is missing or any required field is missing (no silent fallback).
 */
export function readConstantsConfig(customPath = constantsPath) {
  if (!fs.existsSync(customPath)) {
    throw new Error(`constants.ts not found at: ${customPath}`);
  }
  const content = fs.readFileSync(customPath, "utf8");

  const cliVerMatch = content.match(/export const CLI_VERSION = ["']([^"']+)["']/);
  if (!cliVerMatch || !cliVerMatch[1]) {
    throw new Error(`CLI_VERSION constant missing in ${customPath}`);
  }

  const clientIdMatch = content.match(/clientId:\s*["']([^"']+)["']/);
  if (!clientIdMatch || !clientIdMatch[1]) {
    throw new Error(`clientId constant missing in ${customPath}`);
  }

  const secretMatch = content.match(/clientSecret:\s*["']([^"']+)["']/);
  if (!secretMatch || !secretMatch[1]) {
    throw new Error(`clientSecret constant missing in ${customPath}`);
  }

  return {
    cliVersion: cliVerMatch[1],
    clientId: clientIdMatch[1],
    clientSecret: secretMatch[1]
  };
}

/**
 * Scan src/ to find RPCs and Google hosts referenced by the plugin
 */
export function getPluginReferencedRpcAndHosts(srcDir = path.join(repoRoot, "src")) {
  const usedRpcs = new Set();
  const usedHosts = new Set();

  if (!fs.existsSync(srcDir)) {
    return { usedRpcs: [], usedHosts: [] };
  }

  const files = fs.readdirSync(srcDir, { recursive: true });
  for (const f of files) {
    if (typeof f !== "string" || (!f.endsWith(".ts") && !f.endsWith(".js"))) continue;
    const fullPath = path.join(srcDir, f);
    if (!fs.statSync(fullPath).isFile()) continue;
    const content = fs.readFileSync(fullPath, "utf8");

    // Scan for v1internal:rpcName
    const rpcRegex = /v1internal:([a-zA-Z0-9]+)/g;
    let m;
    while ((m = rpcRegex.exec(content)) !== null) {
      usedRpcs.add(`v1internal:${m[1]}`);
    }

    // Scan for *.googleapis.com
    const hostRegex = /([a-zA-Z0-9.-]+\.googleapis\.com)/g;
    while ((m = hostRegex.exec(content)) !== null) {
      const h = m[1].toLowerCase();
      if (!h.startsWith(".") && !h.includes("/")) {
        usedHosts.add(h);
      }
    }
  }

  return {
    usedRpcs: Array.from(usedRpcs).sort(),
    usedHosts: Array.from(usedHosts).sort()
  };
}

/**
 * Parse semver string into comparable components
 */
export function parseSemver(v) {
  if (!v || typeof v !== "string") return { major: 0, minor: 0, patch: 0, prerelease: "", raw: "" };
  const clean = v.trim().replace(/^v/i, "");
  const [core, prerelease] = clean.split("-");
  const parts = core.split(".").map((p) => parseInt(p, 10) || 0);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    prerelease: prerelease || "",
    raw: clean
  };
}

/**
 * Compare two semver strings: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareSemver(v1, v2) {
  const p1 = parseSemver(v1);
  const p2 = parseSemver(v2);

  if (p1.major !== p2.major) return p1.major < p2.major ? -1 : 1;
  if (p1.minor !== p2.minor) return p1.minor < p2.minor ? -1 : 1;
  if (p1.patch !== p2.patch) return p1.patch < p2.patch ? -1 : 1;

  if (p1.prerelease && !p2.prerelease) return -1;
  if (!p1.prerelease && p2.prerelease) return 1;
  if (p1.prerelease && p2.prerelease) {
    if (p1.prerelease < p2.prerelease) return -1;
    if (p1.prerelease > p2.prerelease) return 1;
  }
  return 0;
}

const MACHO_ARCH_CPU = { arm64: 0x0100000c, x64: 0x01000007 };

/**
 * Pick the slice of a fat/universal Mach-O to analyse. Prefers the 64-bit slice whose
 * architecture matches `preferredArch` (default: the host's process.arch), then any
 * 64-bit slice, then the first slice. Returns the slice file offset or null.
 */
export function selectFatSliceOffset(binaryBuffer, isBe, nfatArch, preferredArch = process.arch) {
  const preferredCpu = MACHO_ARCH_CPU[preferredArch];
  let first = null;
  let first64 = null;
  for (let i = 0; i < nfatArch; i++) {
    const archOffset = 8 + i * 20;
    if (archOffset + 20 > binaryBuffer.length) break;
    const cputype = isBe ? binaryBuffer.readUInt32BE(archOffset) : binaryBuffer.readUInt32LE(archOffset);
    const offset = isBe ? binaryBuffer.readUInt32BE(archOffset + 8) : binaryBuffer.readUInt32LE(archOffset + 8);
    if (preferredCpu !== undefined && cputype === preferredCpu) return offset;
    if (first64 === null && (cputype === 0x0100000c || cputype === 0x01000007)) first64 = offset;
    if (first === null) first = offset;
  }
  return first64 ?? first;
}

/**
 * Parse Mach-O 64-bit load commands (LC_SEGMENT_64) to extract valid segments
 * and address ranges for string data (__TEXT, __DATA_CONST, __DATA).
 * Throws if binary is not a valid 64-bit Mach-O binary or load commands cannot be parsed.
 */
export function parseMachOSegments(binaryBuffer) {
  if (!binaryBuffer || binaryBuffer.length < 32) {
    throw new Error("Unable to parse Mach-O header: binary too small");
  }

  let headerOffset = 0;
  const magic = binaryBuffer.readUInt32LE(0);

  // Check for Mach-O Fat / Universal binary (0xcafebabe or 0xbebafeca)
  if (magic === 0xcafebabe || magic === 0xbebafeca || binaryBuffer.readUInt32BE(0) === 0xcafebabe) {
    const isBe = binaryBuffer.readUInt32BE(0) === 0xcafebabe;
    const nfatArch = isBe ? binaryBuffer.readUInt32BE(4) : binaryBuffer.readUInt32LE(4);
    const chosenOffset = selectFatSliceOffset(binaryBuffer, isBe, nfatArch);

    if (chosenOffset === null || chosenOffset + 32 > binaryBuffer.length) {
      throw new Error("Unable to parse Mach-O header: no valid 64-bit slice found in fat binary");
    }
    headerOffset = chosenOffset;
  }

  const sliceMagic = binaryBuffer.readUInt32LE(headerOffset);
  // Mach-O 64-bit little-endian magic is 0xfeedfacf
  if (sliceMagic !== 0xfeedfacf) {
    throw new Error(`Unable to parse Mach-O header: magic 0x${sliceMagic.toString(16)} is not Mach-O 64-bit (0xfeedfacf)`);
  }

  const ncmds = binaryBuffer.readUInt32LE(headerOffset + 16);
  const sizeofcmds = binaryBuffer.readUInt32LE(headerOffset + 20);

  let cmdOffset = headerOffset + 32;
  const endCommands = cmdOffset + sizeofcmds;
  if (endCommands > binaryBuffer.length) {
    throw new Error("Unable to parse Mach-O header: load commands exceed binary length");
  }

  const segments = [];
  const LC_SEGMENT_64 = 0x19;

  for (let i = 0; i < ncmds; i++) {
    if (cmdOffset + 8 > endCommands) break;
    const cmd = binaryBuffer.readUInt32LE(cmdOffset);
    const cmdsize = binaryBuffer.readUInt32LE(cmdOffset + 4);
    if (cmdsize < 8 || cmdOffset + cmdsize > endCommands) break;

    if (cmd === LC_SEGMENT_64) {
      // Segment name is 16 bytes at cmdOffset + 8
      let nameRaw = binaryBuffer.slice(cmdOffset + 8, cmdOffset + 24).toString("utf8");
      const nullIdx = nameRaw.indexOf("\0");
      if (nullIdx !== -1) nameRaw = nameRaw.slice(0, nullIdx);
      const segname = nameRaw.trim();

      const vmaddr = binaryBuffer.readBigUInt64LE(cmdOffset + 24);
      const vmsize = binaryBuffer.readBigUInt64LE(cmdOffset + 32);
      const fileoff = binaryBuffer.readBigUInt64LE(cmdOffset + 40);
      const filesize = binaryBuffer.readBigUInt64LE(cmdOffset + 48);

      segments.push({
        segname,
        vmaddr,
        vmsize,
        // In a fat/universal binary, segment file offsets are relative to the slice.
        fileoff: fileoff + BigInt(headerOffset),
        filesize
      });
    }

    cmdOffset += cmdsize;
  }

  if (segments.length === 0) {
    throw new Error("Unable to parse Mach-O header: no LC_SEGMENT_64 load commands found");
  }

  return segments;
}

const MACHO_CPU_ARCH = { 0x0100000c: "arm64", 0x01000007: "x64" };
const ELF_MACHINE_ARCH = { 0x3e: "x64", 0xb7: "arm64" };

/**
 * Return the 64-bit Mach-O slice header offset and cputype (handles fat/universal binaries).
 */
function machOSliceInfo(binaryBuffer) {
  const magicLE = binaryBuffer.readUInt32LE(0);
  const isFat = magicLE === 0xcafebabe || magicLE === 0xbebafeca || binaryBuffer.readUInt32BE(0) === 0xcafebabe;
  let headerOffset = 0;
  if (isFat) {
    const isBe = binaryBuffer.readUInt32BE(0) === 0xcafebabe;
    const nfatArch = isBe ? binaryBuffer.readUInt32BE(4) : binaryBuffer.readUInt32LE(4);
    const chosen = selectFatSliceOffset(binaryBuffer, isBe, nfatArch);
    if (chosen !== null) headerOffset = chosen;
  }
  const cputype = headerOffset + 8 <= binaryBuffer.length ? binaryBuffer.readUInt32LE(headerOffset + 4) : 0;
  return { headerOffset, cputype };
}

/**
 * Detect executable container format from magic bytes.
 * @returns {"macho" | "elf" | "pe" | "unknown"}
 */
export function detectBinaryFormat(binaryBuffer) {
  if (!binaryBuffer || binaryBuffer.length < 4) return "unknown";
  const be = binaryBuffer.readUInt32BE(0);
  const le = binaryBuffer.readUInt32LE(0);
  if (be === 0x7f454c46) return "elf";
  if (le === 0xfeedfacf || le === 0xfeedface || be === 0xcafebabe || le === 0xcafebabe || le === 0xbebafeca) {
    return "macho";
  }
  if (binaryBuffer[0] === 0x4d && binaryBuffer[1] === 0x5a) return "pe";
  return "unknown";
}

/**
 * Parse ELF64 little-endian program headers and return PT_LOAD segments in the same
 * shape as parseMachOSegments ({ segname, vmaddr, vmsize, fileoff, filesize }).
 * Throws if the buffer is not a parsable 64-bit little-endian ELF file.
 */
export function parseElfSegments(binaryBuffer) {
  if (!binaryBuffer || binaryBuffer.length < 64) {
    throw new Error("Unable to parse ELF header: binary too small");
  }
  if (binaryBuffer.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error("Unable to parse ELF header: missing \\x7fELF magic");
  }
  const eiClass = binaryBuffer[4];
  const eiData = binaryBuffer[5];
  if (eiClass !== 2) {
    throw new Error(`Unable to parse ELF header: EI_CLASS ${eiClass} is not ELFCLASS64`);
  }
  if (eiData !== 1) {
    throw new Error(`Unable to parse ELF header: EI_DATA ${eiData} is not little-endian`);
  }

  const ePhoff = binaryBuffer.readBigUInt64LE(0x20);
  const ePhentsize = binaryBuffer.readUInt16LE(0x36);
  const ePhnum = binaryBuffer.readUInt16LE(0x38);
  if (ePhentsize < 56) {
    throw new Error(`Unable to parse ELF header: e_phentsize ${ePhentsize} is smaller than Elf64_Phdr`);
  }
  const phStart = Number(ePhoff);
  if (!Number.isSafeInteger(phStart) || phStart + ePhnum * ePhentsize > binaryBuffer.length) {
    throw new Error("Unable to parse ELF header: program headers exceed binary length");
  }

  const PT_LOAD = 1;
  const segments = [];
  for (let i = 0; i < ePhnum; i++) {
    const off = phStart + i * ePhentsize;
    const pType = binaryBuffer.readUInt32LE(off);
    if (pType !== PT_LOAD) continue;
    const pFlags = binaryBuffer.readUInt32LE(off + 4);
    segments.push({
      segname: `PT_LOAD[${segments.length}]`,
      flags: pFlags,
      fileoff: binaryBuffer.readBigUInt64LE(off + 8),
      vmaddr: binaryBuffer.readBigUInt64LE(off + 16),
      filesize: binaryBuffer.readBigUInt64LE(off + 32),
      vmsize: binaryBuffer.readBigUInt64LE(off + 40)
    });
  }

  if (segments.length === 0) {
    throw new Error("Unable to parse ELF header: no PT_LOAD program headers found");
  }
  return segments;
}

/**
 * Position-independent ELF executables (ET_DYN, e.g. Go `-buildmode=pie`) store absolute
 * pointers in data as zero and carry the real target in R_*_RELATIVE relocation addends.
 * Return a copy of the buffer with those relocations applied (image base 0) so Go
 * {ptr, len} string headers resolve exactly like in a non-PIE binary. Returns the
 * original buffer when the file is not ET_DYN or has no RELATIVE relocations.
 */
export function applyElfRelativeRelocations(binaryBuffer, segments = parseElfSegments(binaryBuffer)) {
  const eType = binaryBuffer.readUInt16LE(0x10);
  if (eType !== 3) return binaryBuffer; // only ET_DYN needs relocation

  const machine = binaryBuffer.readUInt16LE(0x12);
  const RELATIVE = machine === 0xb7 ? 1027 : 8; // R_AARCH64_RELATIVE : R_X86_64_RELATIVE
  const vmToFile = (vaddr) => {
    for (const seg of segments) {
      if (vaddr >= seg.vmaddr && vaddr < seg.vmaddr + seg.filesize) {
        return Number(seg.fileoff + (vaddr - seg.vmaddr));
      }
    }
    return null;
  };

  const phoff = Number(binaryBuffer.readBigUInt64LE(0x20));
  const phentsize = binaryBuffer.readUInt16LE(0x36);
  const phnum = binaryBuffer.readUInt16LE(0x38);
  let dynOff = null;
  let dynSize = 0;
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (binaryBuffer.readUInt32LE(off) === 2) {
      dynOff = Number(binaryBuffer.readBigUInt64LE(off + 8));
      dynSize = Number(binaryBuffer.readBigUInt64LE(off + 32));
      break;
    }
  }
  if (dynOff === null) return binaryBuffer;

  let rela = null;
  let relaSz = 0;
  let relaEnt = 24;
  for (let off = dynOff; off + 16 <= dynOff + dynSize && off + 16 <= binaryBuffer.length; off += 16) {
    const tag = binaryBuffer.readBigInt64LE(off);
    const val = binaryBuffer.readBigUInt64LE(off + 8);
    if (tag === 0n) break;
    if (tag === 36n || tag === 35n || tag === 37n) {
      // DT_RELR / DT_RELRSZ / DT_RELRENT: packed relative relocations are not decoded
      // here. Refuse instead of silently under-extracting pointer-based strings.
      throw new Error(
        "Unsupported agy binary format: ELF uses DT_RELR packed relocations, which this script does not decode yet"
      );
    }
    if (tag === 7n) rela = val;
    else if (tag === 8n) relaSz = Number(val);
    else if (tag === 9n) relaEnt = Number(val);
  }
  if (rela === null || relaSz === 0 || relaEnt < 24) return binaryBuffer;
  const relaFile = vmToFile(rela);
  if (relaFile === null || relaFile + relaSz > binaryBuffer.length) return binaryBuffer;

  const patched = Buffer.from(binaryBuffer);
  let applied = 0;
  for (let off = relaFile; off + 24 <= relaFile + relaSz; off += relaEnt) {
    const type = Number(binaryBuffer.readBigUInt64LE(off + 8) & 0xffffffffn);
    if (type !== RELATIVE) continue;
    const target = vmToFile(binaryBuffer.readBigUInt64LE(off));
    if (target === null || target + 8 > patched.length) continue;
    patched.writeBigInt64LE(binaryBuffer.readBigInt64LE(off + 16), target);
    applied++;
  }
  return applied > 0 ? patched : binaryBuffer;
}

/**
 * Format-agnostic segment parser used by analyzeBinary.
 * Returns the container format, the "<os>-<arch>" platform key derived from the binary
 * itself (not the host), all segments, and the subset that can hold string data.
 */
export function parseBinarySegments(binaryBuffer) {
  const format = detectBinaryFormat(binaryBuffer);
  if (format === "macho") {
    const segments = parseMachOSegments(binaryBuffer);
    const { cputype } = machOSliceInfo(binaryBuffer);
    const arch = MACHO_CPU_ARCH[cputype] ?? `cpu${cputype.toString(16)}`;
    const stringSegments = segments.filter((s) => ["__TEXT", "__DATA_CONST", "__DATA"].includes(s.segname));
    if (stringSegments.length === 0) {
      throw new Error("Unable to parse Mach-O header: no string segments (__TEXT, __DATA_CONST, __DATA) found");
    }
    return { format, platform: `darwin-${arch}`, segments, stringSegments };
  }
  if (format === "elf") {
    const segments = parseElfSegments(binaryBuffer);
    const machine = binaryBuffer.readUInt16LE(0x12);
    const arch = ELF_MACHINE_ARCH[machine] ?? `em${machine.toString(16)}`;
    // Go places string data in the read-only and data PT_LOAD segments; all PT_LOAD
    // segments are file-backed views, so all of them are valid pointer targets.
    return {
      format,
      platform: `linux-${arch}`,
      segments,
      stringSegments: segments,
      scanBuffer: applyElfRelativeRelocations(binaryBuffer, segments)
    };
  }
  if (format === "pe") {
    throw new Error("Unsupported agy binary format: PE/COFF (Windows) is not supported yet");
  }
  const magic = binaryBuffer && binaryBuffer.length >= 4 ? binaryBuffer.readUInt32LE(0).toString(16) : "n/a";
  throw new Error(`Unsupported agy binary format: magic 0x${magic} is neither Mach-O 64-bit nor ELF64`);
}

/**
 * Helper to construct a mock ELF64 (x86_64 or aarch64) binary for tests and fixtures.
 * Uses one PT_LOAD segment mapped at vaddr 0x400000 and the same payload layout as
 * createMockMachOBinary (protobuf RPC descriptors, client markers, Go string headers).
 */
export function createMockElfBinary(options = {}) {
  const size = options.size || 8192;
  const buf = Buffer.alloc(size);
  const base = options.pie ? 0n : 0x400000n;
  const machine = options.arch === "arm64" ? 0xb7 : 0x3e;

  // ELF64 header
  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // ELFDATA2LSB
  buf[6] = 1; // EV_CURRENT
  buf.writeUInt16LE(options.pie ? 3 : 2, 0x10); // ET_DYN (PIE) or ET_EXEC
  buf.writeUInt16LE(machine, 0x12);
  buf.writeUInt32LE(1, 0x14);
  buf.writeBigUInt64LE(base, 0x18); // e_entry
  buf.writeBigUInt64LE(64n, 0x20); // e_phoff
  buf.writeBigUInt64LE(0n, 0x28); // e_shoff
  buf.writeUInt16LE(64, 0x34); // e_ehsize
  buf.writeUInt16LE(56, 0x36); // e_phentsize
  buf.writeUInt16LE(options.pie ? 3 : 2, 0x38); // e_phnum
  // PT_PHDR-like non-load header first (must be ignored)
  buf.writeUInt32LE(6, 64);
  // PT_LOAD covering whole file
  const ph = 64 + 56;
  buf.writeUInt32LE(1, ph);
  buf.writeUInt32LE(5, ph + 4);
  buf.writeBigUInt64LE(0n, ph + 8);
  buf.writeBigUInt64LE(base, ph + 16);
  buf.writeBigUInt64LE(base, ph + 24);
  buf.writeBigUInt64LE(BigInt(size), ph + 32);
  buf.writeBigUInt64LE(BigInt(size), ph + 40);
  buf.writeBigUInt64LE(0x1000n, ph + 48);

  const { cur, pointerSlots } = writeMockPayload(buf, 256, base, options);

  if (options.pie) {
    // PIE: pointers are zero on disk and restored from R_*_RELATIVE relocations.
    const relativeType = machine === 0xb7 ? 1027n : 8n;
    let at = (cur + 7) & ~7;
    const relaStart = at;
    for (const { slot, value } of pointerSlots) {
      buf.writeBigUInt64LE(0n, slot);
      buf.writeBigUInt64LE(base + BigInt(slot), at);
      buf.writeBigUInt64LE(relativeType, at + 8);
      buf.writeBigInt64LE(value, at + 16);
      at += 24;
    }
    const relaSize = at - relaStart;
    const dynStart = at;
    const dyn = [
      [7n, base + BigInt(relaStart)],
      [8n, BigInt(relaSize)],
      [9n, 24n],
      ...(options.relr ? [[36n, 0n]] : []), // DT_RELR marker for unsupported-format tests
      [0n, 0n]
    ];
    for (const [tag, val] of dyn) {
      buf.writeBigInt64LE(tag, at);
      buf.writeBigUInt64LE(val, at + 8);
      at += 16;
    }
    const dph = 64 + 2 * 56;
    buf.writeUInt32LE(2, dph); // PT_DYNAMIC
    buf.writeUInt32LE(6, dph + 4);
    buf.writeBigUInt64LE(BigInt(dynStart), dph + 8);
    buf.writeBigUInt64LE(base + BigInt(dynStart), dph + 16);
    buf.writeBigUInt64LE(base + BigInt(dynStart), dph + 24);
    buf.writeBigUInt64LE(BigInt(at - dynStart), dph + 32);
    buf.writeBigUInt64LE(BigInt(at - dynStart), dph + 40);
  }
  return buf;
}

/**
 * Shared fixture payload writer (RPC descriptors, markers, Go {ptr,len} headers).
 */
function writeMockPayload(buf, start, vmBase, options) {
  let cur = start;
  const rpcs = options.rpcs || ["loadCodeAssist", "fetchAvailableModels", "streamGenerateContent"];
  for (const rpc of rpcs) {
    const str = `/v1internal:${rpc}`;
    buf[cur++] = 0x12;
    buf[cur++] = str.length;
    buf.write(str, cur, "utf8");
    cur += str.length;
  }

  const clientId = options.clientId || "1071006060591-test.apps.googleusercontent.com";
  const clientSecret = options.clientSecret || "";
  const markers = options.markers || "ideType platform pluginType ANTIGRAVITY VSCODE LINUX MACOS WINDOWS x-goog-user-project";
  const textPayload = [clientId, clientSecret, markers].join("\0");
  buf.write(textPayload, cur, "utf8");
  cur += textPayload.length + 8;

  const hosts = options.hosts || ["daily-cloudcode-pa.googleapis.com", "oauth2.googleapis.com"];
  const scopes = options.scopes || ["https://www.googleapis.com/auth/cloud-platform"];
  const entries = [];
  for (const str of [...hosts, ...scopes]) {
    cur = (cur + 7) & ~7;
    buf.write(str, cur, "utf8");
    entries.push({ off: cur, len: str.length });
    cur += str.length + 8;
  }
  const pointerSlots = [];
  for (const { off, len } of entries) {
    cur = (cur + 7) & ~7;
    buf.writeBigUInt64LE(vmBase + BigInt(off), cur);
    buf.writeBigUInt64LE(BigInt(len), cur + 8);
    pointerSlots.push({ slot: cur, value: vmBase + BigInt(off) });
    cur += 16;
  }
  return { cur, pointerSlots };
}

/**
 * Helper to construct a mock 64-bit Mach-O binary buffer for tests and fixtures
 */
export function createMockMachOBinary(options = {}) {
  const size = options.size || 8192;
  const buf = Buffer.alloc(size);

  // Mach-O 64-bit header
  buf.writeUInt32LE(0xfeedfacf, 0); // magic
  buf.writeUInt32LE(0x0100000c, 4); // cputype ARM64
  buf.writeUInt32LE(0, 8);          // cpusubtype
  buf.writeUInt32LE(2, 12);         // filetype MH_EXECUTE
  buf.writeUInt32LE(1, 16);         // ncmds = 1
  buf.writeUInt32LE(72, 20);        // sizeofcmds = 72
  buf.writeUInt32LE(0, 24);         // flags
  buf.writeUInt32LE(0, 28);         // reserved

  // LC_SEGMENT_64 load command (__TEXT)
  buf.writeUInt32LE(0x19, 32);      // cmd = LC_SEGMENT_64
  buf.writeUInt32LE(72, 36);        // cmdsize = 72
  buf.write("__TEXT\0\0\0\0\0\0\0\0\0\0", 40, "utf8");
  buf.writeBigUInt64LE(0x100000000n, 56);   // vmaddr
  buf.writeBigUInt64LE(BigInt(size), 64);   // vmsize
  buf.writeBigUInt64LE(0n, 72);             // fileoff
  buf.writeBigUInt64LE(BigInt(size), 80);   // filesize
  buf.writeUInt32LE(7, 88);                 // maxprot
  buf.writeUInt32LE(5, 92);                 // initprot
  buf.writeUInt32LE(0, 96);                 // nsects
  buf.writeUInt32LE(0, 100);                // flags

  let cur = 112;

  // 1. Embed protobuf RPC descriptors (tag 0x12, len, "/v1internal:<method>")
  const rpcs = options.rpcs || [
    "loadCodeAssist",
    "fetchAvailableModels",
    "streamGenerateContent"
  ];
  for (const rpc of rpcs) {
    const s = `/v1internal:${rpc}`;
    buf[cur++] = 0x12;
    buf[cur++] = s.length;
    buf.write(s, cur, "utf8");
    cur += s.length;
  }

  // 2. Embed client IDs, secrets, and request shape markers
  const clientId = options.clientId || "1071006060591-test.apps.googleusercontent.com";
  const clientSecret = options.clientSecret || "";
  const markers = options.markers || "ideType platform pluginType ANTIGRAVITY VSCODE LINUX MACOS WINDOWS x-goog-user-project";

  const textPayload = [clientId, clientSecret, markers].join("\0");
  buf.write(textPayload, cur, "utf8");
  cur += textPayload.length + 8;

  // Align to 8 bytes for Go string headers
  const hosts = options.hosts || ["daily-cloudcode-pa.googleapis.com", "oauth2.googleapis.com"];
  const hostEntries = [];
  for (const host of hosts) {
    cur = (cur + 7) & ~7;
    const off = cur;
    buf.write(host, off, "utf8");
    cur += host.length + 8;
    hostEntries.push({ off, len: host.length });
  }

  const scopes = options.scopes || ["https://www.googleapis.com/auth/cloud-platform"];
  const scopeEntries = [];
  for (const scope of scopes) {
    cur = (cur + 7) & ~7;
    const off = cur;
    buf.write(scope, off, "utf8");
    cur += scope.length + 8;
    scopeEntries.push({ off, len: scope.length });
  }

  // Write Go {ptr, len} headers for hosts
  for (const { off, len } of hostEntries) {
    cur = (cur + 7) & ~7;
    buf.writeBigUInt64LE(0x100000000n + BigInt(off), cur);
    buf.writeBigUInt64LE(BigInt(len), cur + 8);
    cur += 16;
  }

  // Write Go {ptr, len} headers for scopes
  for (const { off, len } of scopeEntries) {
    cur = (cur + 7) & ~7;
    buf.writeBigUInt64LE(0x100000000n + BigInt(off), cur);
    buf.writeBigUInt64LE(BigInt(len), cur + 8);
    cur += 16;
  }

  return buf;
}

/**
 * Static binary analysis to extract fingerprint markers without concatenation noise
 */
export function analyzeBinary(rawBinaryBuffer, constantsConfig, srcReferences) {
  const binarySha256 = crypto.createHash("sha256").update(rawBinaryBuffer).digest("hex");

  // Parse Mach-O 64-bit or ELF64 segments dynamically (throws if invalid / unsupported).
  // For PIE ELF binaries, pointer scans run over a relocated view of the file.
  const parsed = parseBinarySegments(rawBinaryBuffer);
  const { format: binaryFormat, platform, stringSegments } = parsed;
  const binaryBuffer = parsed.scanBuffer || rawBinaryBuffer;
  const text = rawBinaryBuffer.toString("binary");

  const minVmAddr = stringSegments.reduce(
    (min, s) => (s.vmaddr < min ? s.vmaddr : min),
    stringSegments[0].vmaddr
  );
  const maxVmAddr = stringSegments.reduce(
    (max, s) => (s.vmaddr + s.vmsize > max ? s.vmaddr + s.vmsize : max),
    stringSegments[0].vmaddr + stringSegments[0].vmsize
  );

  function vmToOffset(ptr) {
    for (const seg of stringSegments) {
      if (ptr >= seg.vmaddr && ptr < seg.vmaddr + seg.vmsize) {
        const rel = ptr - seg.vmaddr;
        if (rel < seg.filesize) {
          const off = Number(seg.fileoff + rel);
          if (off < binaryBuffer.length) return off;
        }
      }
    }
    return null;
  }

  function offsetToVm(offset) {
    const o = BigInt(offset);
    for (const seg of stringSegments) {
      if (o >= seg.fileoff && o < seg.fileoff + seg.filesize) {
        return seg.vmaddr + (o - seg.fileoff);
      }
    }
    return null;
  }

  // 1. sorted v1internal:* RPC names
  const allRpcs = new Set();
  let rpcPos = 0;
  while (true) {
    const idx = binaryBuffer.indexOf("/v1internal:", rpcPos);
    if (idx === -1) break;
    rpcPos = idx + 12;

    const prevLen = binaryBuffer[idx - 1];
    const prevTag = binaryBuffer[idx - 2];
    if ((prevTag === 0x22 || prevTag === 0x12) && prevLen >= 13 && prevLen <= 90) {
      const full = binaryBuffer.slice(idx + 12, idx + prevLen).toString("utf8");
      const method = full.split("/")[0].split("{")[0].split("?")[0].trim();
      if (/^[a-zA-Z0-9]+$/.test(method)) {
        allRpcs.add(`v1internal:${method}`);
      }
    }
  }

  // 2. sorted *.googleapis.com hosts
  const allHosts = new Set();

  // Scan Go {ptr, len} structs in binary mapped through Mach-O / ELF segments
  for (let off = 0; off + 16 <= binaryBuffer.length; off += 8) {
    const ptr = binaryBuffer.readBigUInt64LE(off);
    const len = binaryBuffer.readBigUInt64LE(off + 8);
    if (ptr >= minVmAddr && ptr < maxVmAddr && len >= 8n && len <= 120n) {
      const fileOffset = vmToOffset(ptr);
      if (fileOffset !== null && fileOffset + Number(len) <= binaryBuffer.length) {
        const slice = binaryBuffer.slice(fileOffset, fileOffset + Number(len)).toString("utf8");
        if (slice.includes("googleapis.com")) {
          const m = slice.match(/(?:https?:\/\/|\/|\b)([a-zA-Z0-9.-]+\.googleapis\.com)/);
          if (m) {
            const h = m[1].toLowerCase().replace(/^\.+/, "");
            if (!h.includes("/") && h.length < 80) allHosts.add(h);
          }
        }
      }
    }
  }

  // Also scan protobuf descriptors for *.googleapis.com
  let hPos = 0;
  while (true) {
    const idx = binaryBuffer.indexOf(".googleapis.com", hPos);
    if (idx === -1) break;
    hPos = idx + 15;

    let start = idx;
    while (start > 0 && start > idx - 60) {
      const c = binaryBuffer[start - 1];
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46) {
        start--;
      } else {
        break;
      }
    }
    const prev = binaryBuffer[start - 1];
    const prevTag = binaryBuffer[start - 2];
    const candidate = binaryBuffer.slice(start, idx + 15).toString("utf8");
    if (/^[a-z0-9][a-z0-9.-]*\.googleapis\.com$/.test(candidate)) {
      if (
        prevTag === 0x22 ||
        prevTag === 0x12 ||
        prev === 0x2f ||
        prev === 0x22 ||
        prev === 0x27 ||
        prev === 0x0a ||
        prev === 0x3a
      ) {
        allHosts.add(candidate.toLowerCase());
      }
    }
  }

  // Split RPCs and Hosts into used (referenced by plugin in src/) and other
  const usedRpcSet = new Set(srcReferences?.usedRpcs || []);
  const usedHostSet = new Set(srcReferences?.usedHosts || []);

  const rpcUsed = Array.from(allRpcs).filter((r) => usedRpcSet.has(r)).sort();
  const rpcOther = Array.from(allRpcs).filter((r) => !usedRpcSet.has(r)).sort();

  const hostsUsed = Array.from(allHosts).filter((h) => usedHostSet.has(h)).sort();
  const hostsOther = Array.from(allHosts).filter((h) => !usedHostSet.has(h)).sort();

  // 3. OAuth client-id numeric prefixes
  const oauthClientPrefixes = new Set();
  const clientRegex = /([0-9]{10,})-[a-zA-Z0-9_]+\.apps\.googleusercontent\.com/g;
  let m;
  while ((m = clientRegex.exec(text)) !== null) {
    oauthClientPrefixes.add(m[1]);
  }
  const prefixRegex = /(?:[^0-9]|^)(1071006060591|1098991175725|884354919052)(?:[^0-9]|$)/g;
  while ((m = prefixRegex.exec(text)) !== null) {
    oauthClientPrefixes.add(m[1]);
  }

  // 4. Consumer client parity
  const matchesClientId = Boolean(
    constantsConfig.clientId && text.includes(constantsConfig.clientId)
  );
  const matchesClientSecret = Boolean(
    constantsConfig.clientSecret && text.includes(constantsConfig.clientSecret)
  );
  const secretSha256 = constantsConfig.clientSecret
    ? crypto.createHash("sha256").update(constantsConfig.clientSecret).digest("hex")
    : "";

  const consumerClientParity = {
    matchesClientId,
    matchesClientSecret,
    secretSha256
  };

  // 5. googleapis.com/auth/* scopes (Go string header resolution via Mach-O / ELF segment mapper)
  const oauthScopes = new Set();
  const scopePrefix = "https://www.googleapis.com/auth/";
  const scopePrefixLen = scopePrefix.length;

  let pos = 0;
  const prefixOffsets = [];
  while (true) {
    const idx = binaryBuffer.indexOf(scopePrefix, pos);
    if (idx === -1) break;
    prefixOffsets.push(idx);
    pos = idx + scopePrefixLen;
  }

  for (const off of prefixOffsets) {
    const targetAddr = offsetToVm(off);
    if (targetAddr === null) continue;
    const targetBuffer = Buffer.alloc(8);
    targetBuffer.writeBigUInt64LE(targetAddr, 0);

    let searchPos = 0;
    while (true) {
      const sIdx = binaryBuffer.indexOf(targetBuffer, searchPos);
      if (sIdx === -1) break;
      if (sIdx + 16 <= binaryBuffer.length) {
        const len = binaryBuffer.readBigUInt64LE(sIdx + 8);
        if (len > BigInt(scopePrefixLen) && len < 120n) {
          const scopeStr = binaryBuffer.slice(off, off + Number(len)).toString("utf8");
          oauthScopes.add(scopeStr);
        }
      }
      searchPos = sIdx + 8;
    }
  }

  // 6. Request shape markers
  const requestShapeMarkers = new Set();
  const candidateMarkers = [
    "ideType",
    "platform",
    "pluginType",
    "IDE_UNSPECIFIED",
    "ANTIGRAVITY",
    "VSCODE",
    "INTELLIJ",
    "CLOUD_SHELL",
    "PLATFORM_UNSPECIFIED",
    "MACOS",
    "LINUX",
    "WINDOWS",
    "PLUGIN_UNSPECIFIED"
  ];
  for (const marker of candidateMarkers) {
    if (text.includes(marker)) {
      requestShapeMarkers.add(marker);
    }
  }
  const xGoogRegex = /\b(x-goog-[a-z0-9_-]+)\b/gi;
  while ((m = xGoogRegex.exec(text)) !== null) {
    const hdr = m[1].toLowerCase();
    if (!hdr.includes("failed") && !hdr.includes("session") && hdr.length < 40) {
      requestShapeMarkers.add(hdr);
    }
  }
  const xActivityRegex = /\b(x-activity-[a-z0-9_-]+)\b/gi;
  while ((m = xActivityRegex.exec(text)) !== null) {
    const hdr = m[1].toLowerCase();
    if (hdr.length < 40) {
      requestShapeMarkers.add(hdr);
    }
  }

  return {
    binaryFormat,
    platform,
    binarySha256,
    rpcNames: {
      used: rpcUsed,
      other: rpcOther
    },
    googleHosts: {
      used: hostsUsed,
      other: hostsOther
    },
    oauthClientPrefixes: Array.from(oauthClientPrefixes).sort(),
    consumerClientParity,
    oauthScopes: Array.from(oauthScopes).sort(),
    requestShapeMarkers: Array.from(requestShapeMarkers).sort()
  };
}

/**
 * Extract full fingerprint from installed agy binary
 */
export function extractAgyFingerprint(binPath, options = {}) {
  const rawVersion = runAgyCommand(binPath, "--version");
  const cliVersion = extractCliVersion(rawVersion);

  const rawHelp = runAgyCommand(binPath, "--help");
  const subcommands = extractSubcommands(rawHelp);

  const rawModels = runAgyCommand(binPath, "models");
  const models = extractModels(rawModels);

  const rawChangelog = runAgyCommand(binPath, "changelog");
  const latestChangelog = extractLatestChangelog(rawChangelog);

  const binaryBuffer = options.binaryBuffer || fs.readFileSync(binPath);
  const constantsConfig = options.constantsConfig || readConstantsConfig();
  const srcReferences = options.srcReferences || getPluginReferencedRpcAndHosts();

  const binaryAnalysis = analyzeBinary(binaryBuffer, constantsConfig, srcReferences);

  return {
    platform: binaryAnalysis.platform,
    binaryFormat: binaryAnalysis.binaryFormat,
    cliVersion,
    binarySha256: binaryAnalysis.binarySha256,
    latestChangelog,
    rpcNames: binaryAnalysis.rpcNames,
    googleHosts: binaryAnalysis.googleHosts,
    oauthClientPrefixes: binaryAnalysis.oauthClientPrefixes,
    consumerClientParity: binaryAnalysis.consumerClientParity,
    oauthScopes: binaryAnalysis.oauthScopes,
    requestShapeMarkers: binaryAnalysis.requestShapeMarkers,
    subcommands,
    models
  };
}

/**
 * Load the shared baseline. Throws on unparsable JSON so the caller can report verdict 30.
 * @returns {{ fingerprint: object, path: string } | null}
 */
export function loadFingerprintBaseline(file = FINGERPRINT_PATH) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return { fingerprint: JSON.parse(fs.readFileSync(file, "utf8")), path: file };
  } catch (err) {
    throw new Error(`Stored fingerprint at ${file} is unparsable JSON: ${err.message}`);
  }
}

/**
 * Compute differences between old and new fingerprints and determine verdict
 */
export function evaluateFingerprints(stored, current) {
  const diff = {};

  const allKeys = BASELINE_FIELDS;

  for (const key of allKeys) {
    const oldVal = stored ? stored[key] : undefined;
    const newVal = current[key];

    const oldJson = JSON.stringify(oldVal);
    const newJson = JSON.stringify(newVal);

    if (oldJson !== newJson) {
      diff[key] = {
        old: oldVal,
        new: newVal
      };
    }
  }

  const changedFields = Object.keys(diff);

  if (changedFields.length === 0) {
    return {
      verdict: VERDICT.NO_CHANGE,
      verdictName: "NO_CHANGE",
      diff,
      changedFields
    };
  }

  // Safe fields:
  // - cliVersion, latestChangelog
  // - rpcNames: safe only if rpcNames.used did NOT change (only other changed)
  // - googleHosts: safe only if googleHosts.used did NOT change (only other changed)
  let hasReviewNeededField = false;

  for (const field of changedFields) {
    if (field === "cliVersion" || field === "latestChangelog") {
      continue;
    }
    if (field === "rpcNames") {
      const oldUsedJson = JSON.stringify(stored?.rpcNames?.used ?? []);
      const newUsedJson = JSON.stringify(current?.rpcNames?.used ?? []);
      if (oldUsedJson !== newUsedJson) {
        hasReviewNeededField = true;
      }
      continue;
    }
    if (field === "googleHosts") {
      const oldUsedJson = JSON.stringify(stored?.googleHosts?.used ?? []);
      const newUsedJson = JSON.stringify(current?.googleHosts?.used ?? []);
      if (oldUsedJson !== newUsedJson) {
        hasReviewNeededField = true;
      }
      continue;
    }
    hasReviewNeededField = true;
  }

  if (hasReviewNeededField) {
    return {
      verdict: VERDICT.REVIEW_NEEDED,
      verdictName: "REVIEW_NEEDED",
      diff,
      changedFields
    };
  }

  return {
    verdict: VERDICT.SAFE,
    verdictName: "SAFE",
    diff,
    changedFields
  };
}

/**
 * Check GitHub latest release of google-antigravity/antigravity-cli (optional, report only)
 */
async function checkGitHubRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(
      "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest",
      {
        headers: {
          "User-Agent": "openclaw-antigravity-sync/1.0",
          Accept: "application/vnd.github.v3+json"
        },
        signal: controller.signal
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const tag = (data.tag_name || "").replace(/^v/i, "").trim();
    return tag || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Plugin version policy (see scripts/plugin-version.js): plugin version =
 * <agyMajor>.<agyMinor>.<agyPatch*100 + fix>. An agy bump resets fix to 00
 * (agy 1.4.13 -> 1.4.1300); a version already targeting this agy keeps its fix number.
 */
export function pluginVersionForAgy(currentPackageVersion, agyVersion) {
  return nextPluginVersion(currentPackageVersion, agyVersion);
}

function writeJsonPreservingFormat(filePath, mutate) {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  mutate(data);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + (raw.endsWith("\n") ? "\n" : ""), "utf8");
}

/**
 * Apply updates on a writable verdict:
 * - Writes CLI_VERSION in src/constants.ts
 * - Bumps package.json / package-lock.json version to the new agy version
 * - Writes upstream/agy-fingerprint.json (compared fields only)
 * - Executes build, check, test using resolved npm from process.execPath
 * - On any failure after the first write: restores every touched file, removes a newly
 *   created fingerprint (and newly created parent directory), rebuilds dist/ from the restored
 *   sources, and throws with err.rolledBack reflecting whether all of that succeeded.
 */
export function applySafeUpdate(newVersion, newFingerprint, options = {}) {
  const filesChanged = [];
  const stepResults = [];
  const targetConstantsPath = options.customConstantsPath || constantsPath;
  // Tests that redirect constants.ts must not touch the real package.json: the version
  // bump only targets the repo manifests when no custom constants path is given.
  const isolated = Boolean(options.customConstantsPath);
  const targetPackageJsonPath =
    options.customPackageJsonPath || (isolated ? null : path.join(repoRoot, "package.json"));
  const targetPackageLockPath =
    options.customPackageLockPath || (isolated ? null : path.join(repoRoot, "package-lock.json"));
  const targetFingerprintPath = options.customFingerprintPath || FINGERPRINT_PATH;
  const buildCwd = options.cwd || repoRoot;
  const spawnEnv = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ""}` };

  if (!fs.existsSync(targetConstantsPath)) {
    throw new Error(`constants.ts not found at: ${targetConstantsPath}`);
  }
  const content = fs.readFileSync(targetConstantsPath, "utf8");
  const cliRegex = /export const CLI_VERSION = ["'][^"']+["'] as const;/;
  if (!cliRegex.test(content)) {
    throw new Error(`CLI_VERSION declaration regex did not match in ${targetConstantsPath}`);
  }

  // Snapshot everything this function may touch before the first write.
  const snapshot = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
  const previous = {
    packageJson: snapshot(targetPackageJsonPath),
    packageLock: snapshot(targetPackageLockPath),
    fingerprint: snapshot(targetFingerprintPath)
  };
  const upstreamDir = path.dirname(targetFingerprintPath);
  // Remember the outermost directory we create so rollback can remove exactly that.
  let createdDir = null;
  for (let dir = upstreamDir; !fs.existsSync(dir); dir = path.dirname(dir)) createdDir = dir;

  let npmPath = options.customNpmPath || null;
  const rollback = () => {
    let ok = true;
    const restore = (p, prev) => {
      try {
        if (prev === null) fs.rmSync(p, { force: true });
        else fs.writeFileSync(p, prev, "utf8");
      } catch {
        ok = false;
      }
    };
    restore(targetConstantsPath, content);
    restore(targetFingerprintPath, previous.fingerprint);
    if (previous.packageJson !== null) restore(targetPackageJsonPath, previous.packageJson);
    if (previous.packageLock !== null) restore(targetPackageLockPath, previous.packageLock);
    if (createdDir) {
      try {
        fs.rmSync(createdDir, { recursive: true, force: true });
      } catch {
        ok = false;
      }
    }
    if (stepResults.length > 0) {
      // The prebuild step deletes dist/, so any verification step that ran (even a failed
      // build) may have left dist/ missing or built from the updated sources. Always
      // rebuild from the restored sources and only report success if that build passes.
      try {
        const rebuild = spawnSync(npmPath || resolveNpmBinary(), ["run", "build"], {
          cwd: buildCwd,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          env: spawnEnv
        });
        if (rebuild.error || rebuild.status !== 0) ok = false;
      } catch {
        ok = false;
      }
    }
    return ok;
  };

  try {
    // 1. Update CLI_VERSION in src/constants.ts
    const updated = content.replace(cliRegex, `export const CLI_VERSION = "${newVersion}" as const;`);
    if (updated !== content) {
      fs.writeFileSync(targetConstantsPath, updated, "utf8");
      filesChanged.push(path.relative(repoRoot, targetConstantsPath));
    }

    // 2. Keep the plugin version in lockstep with agy
    if (previous.packageJson !== null) {
      const currentVersion = JSON.parse(previous.packageJson).version;
      const nextVersion = pluginVersionForAgy(currentVersion, newVersion);
      if (nextVersion !== currentVersion) {
        writeJsonPreservingFormat(targetPackageJsonPath, (pkg) => {
          pkg.version = nextVersion;
        });
        filesChanged.push(path.relative(repoRoot, targetPackageJsonPath));
        if (previous.packageLock !== null) {
          writeJsonPreservingFormat(targetPackageLockPath, (lock) => {
            lock.version = nextVersion;
            if (lock.packages && lock.packages[""]) lock.packages[""].version = nextVersion;
          });
          filesChanged.push(path.relative(repoRoot, targetPackageLockPath));
        }
      }
    }

    // 3. Write upstream/agy-fingerprint.json (compared fields only)
    fs.mkdirSync(upstreamDir, { recursive: true });
    fs.writeFileSync(targetFingerprintPath, JSON.stringify(toBaselineFingerprint(newFingerprint), null, 2) + "\n", "utf8");
    filesChanged.push(path.relative(repoRoot, targetFingerprintPath));

    // 4. Resolve npm and run build, check, test
    npmPath = npmPath || resolveNpmBinary();
    const steps = [
      { name: "build", args: ["run", "build"] },
      { name: "check", args: ["run", "check"] },
      { name: "test", args: ["test"] }
    ];

    for (const step of steps) {
      const start = Date.now();
      const res = spawnSync(npmPath, step.args, {
        cwd: buildCwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        env: spawnEnv
      });
      const durationMs = Date.now() - start;
      const combinedOutput = ((res.stdout || "") + "\n" + (res.stderr || "")).trim();
      const outputLines = combinedOutput ? combinedOutput.split("\n") : [];
      const tailOutput = outputLines.slice(-20).join("\n");

      stepResults.push({
        step: step.name,
        command: `npm ${step.args.join(" ")}`,
        status: res.status ?? (res.error ? 1 : 0),
        durationMs,
        ...(res.error ? { error: res.error.message } : {}),
        tailOutput
      });

      if (res.status !== 0 || res.error) {
        const errDetail = res.error?.message || `exited with code ${res.status}`;
        const err = new Error(`Verification step '${step.name}' failed (${errDetail}). Tail output:\n${tailOutput}`);
        err.failingStep = step.name;
        err.tailOutput = tailOutput;
        throw err;
      }
    }
  } catch (err) {
    err.rolledBack = rollback();
    err.stepResults = stepResults;
    if (!err.failingStep) err.failingStep = "write";
    if (err.tailOutput === undefined) err.tailOutput = "";
    throw err;
  }

  return { filesChanged, stepResults };
}

/**
 * Main entry point
 */
export async function main() {
  const options = parseArgs();
  const timestamp = new Date().toISOString();

  let binPath;
  try {
    binPath = resolveAgyBinary(options.agyBin);
  } catch (err) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            timestamp,
            verdict: VERDICT.ERROR,
            verdictName: "ERROR",
            applied: false,
            error: err.message
          },
          null,
          2
        )
      );
    } else {
      console.error(`\x1b[31m[ERROR]\x1b[0m ${err.message}`);
    }
    process.exit(VERDICT.ERROR);
  }

  let constantsConfig;
  try {
    constantsConfig = readConstantsConfig();
  } catch (err) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            timestamp,
            verdict: VERDICT.ERROR,
            verdictName: "ERROR",
            applied: false,
            error: err.message
          },
          null,
          2
        )
      );
    } else {
      console.error(`\x1b[31m[ERROR]\x1b[0m ${err.message}`);
    }
    process.exit(VERDICT.ERROR);
  }

  let currentFingerprint;
  try {
    const srcReferences = getPluginReferencedRpcAndHosts();
    currentFingerprint = extractAgyFingerprint(binPath, {
      constantsConfig,
      srcReferences
    });
  } catch (err) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            timestamp,
            verdict: VERDICT.ERROR,
            verdictName: "ERROR",
            applied: false,
            error: `Extraction failed: ${err.message}`
          },
          null,
          2
        )
      );
    } else {
      console.error(`\x1b[31m[ERROR]\x1b[0m Extraction failed: ${err.message}`);
    }
    process.exit(VERDICT.ERROR);
  }

  let storedFingerprint = null;
  let baseline = null;
  try {
    baseline = loadFingerprintBaseline();
    storedFingerprint = baseline?.fingerprint ?? null;
  } catch (err) {
    const msg = err.message;
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            timestamp,
            verdict: VERDICT.ERROR,
            verdictName: "ERROR",
            applied: false,
            error: msg
          },
          null,
          2
        )
      );
    } else {
      console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
    }
    process.exit(VERDICT.ERROR);
  }
  const baselineInfo = {
    baselinePath: baseline ? path.relative(repoRoot, baseline.path) : null
  };

  const evaluation = evaluateFingerprints(storedFingerprint, currentFingerprint);

  let githubRelease = null;
  let semverComparison = null;
  try {
    githubRelease = await checkGitHubRelease();
    if (githubRelease) {
      const cmp = compareSemver(currentFingerprint.cliVersion, githubRelease);
      semverComparison = cmp < 0 ? "behind" : cmp === 0 ? "equal" : "ahead";
    }
  } catch {
    // optional report-only
  }

  // Handle --check mode
  if (options.check) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            timestamp,
            verdict: evaluation.verdict,
            verdictName: evaluation.verdictName,
            cliVersion: currentFingerprint.cliVersion,
            ...baselineInfo,
            changedFields: evaluation.changedFields
          },
          null,
          2
        )
      );
    } else {
      console.log(`Verdict: ${evaluation.verdict} (${evaluation.verdictName})`);
    }
    process.exit(evaluation.verdict);
  }

  // Handle --apply mode
  if (options.apply) {
    if (evaluation.verdict === VERDICT.NO_CHANGE) {
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              timestamp,
              verdict: VERDICT.NO_CHANGE,
              verdictName: "NO_CHANGE",
              applied: false,
              cliVersion: currentFingerprint.cliVersion,
              ...baselineInfo,
              message: "Installed agy is up to date. Nothing to apply."
            },
            null,
            2
          )
        );
      } else {
        console.log("Installed agy is up to date. Nothing to apply.");
      }
      process.exit(0);
    }

    if (!shouldApplyUpdate(evaluation.verdict, options.investigated)) {
      if (evaluation.verdict === VERDICT.REVIEW_NEEDED) {
        const message =
          "Protocol changes detected. Review needed. Nothing was written. After the investigation issue lands, re-run with --apply --investigated=<N>.";
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                timestamp,
                verdict: VERDICT.REVIEW_NEEDED,
                verdictName: "REVIEW_NEEDED",
                applied: false,
                cliVersion: currentFingerprint.cliVersion,
                ...baselineInfo,
                changedFields: evaluation.changedFields,
                diff: evaluation.diff,
                message
              },
              null,
              2
            )
          );
        } else {
          console.error(
            `\x1b[33m[REVIEW NEEDED]\x1b[0m Protocol changes detected in fields: ${evaluation.changedFields.join(", ")}. Nothing was applied. After the investigation issue lands, re-run with --apply --investigated=<N>.`
          );
        }
        process.exit(VERDICT.REVIEW_NEEDED);
      }
    } else {
      try {
        const { filesChanged, stepResults } = applySafeUpdate(
          currentFingerprint.cliVersion,
          currentFingerprint
        );
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                timestamp,
                verdict: evaluation.verdict,
                verdictName: evaluation.verdictName,
                applied: true,
                cliVersion: currentFingerprint.cliVersion,
                ...baselineInfo,
                ...(options.investigated ? { investigated: options.investigated } : {}),
                filesChanged,
                stepResults,
                ...(githubRelease ? { githubRelease, semverComparison } : {})
              },
              null,
              2
            )
          );
        } else {
          console.log(`Successfully applied safe updates to: ${filesChanged.join(", ")}`);
          console.log("Verification steps (build, check, test) passed cleanly.");
        }
        process.exit(0);
      } catch (err) {
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                timestamp,
                verdict: VERDICT.ERROR,
                verdictName: "ERROR",
                applied: false,
                cliVersion: currentFingerprint.cliVersion,
                ...baselineInfo,
                error: err.message,
                failingStep: err.failingStep || "unknown",
                rolledBack: err.rolledBack === true,
                tailOutput: err.tailOutput || "",
                stepResults: err.stepResults || []
              },
              null,
              2
            )
          );
        } else {
          console.error(`\x1b[31m[APPLY FAILED]\x1b[0m ${err.message}`);
        }
        process.exit(VERDICT.ERROR);
      }
    }
  }

  // Default dry-run mode
  if (options.json) {
    const reportJson = {
      timestamp,
      verdict: evaluation.verdict,
      verdictName: evaluation.verdictName,
      cliVersion: currentFingerprint.cliVersion,
      ...baselineInfo,
      binarySha256: currentFingerprint.binarySha256,
      storedVersion: storedFingerprint?.cliVersion ?? null,
      changedFields: evaluation.changedFields,
      diff: evaluation.diff,
      filesChanged: [],
      ...(githubRelease ? { githubRelease, semverComparison } : {})
    };
    console.log(JSON.stringify(reportJson, null, 2));
    process.exit(evaluation.verdict);
  }

  // Human readable dry-run report
  console.log("=================================================");
  console.log("       ANTIGRAVITY UPSTREAM SYNC REPORT          ");
  console.log("=================================================");
  console.log(`Timestamp:        ${timestamp}`);
  console.log(`Binary Path:      ${binPath}`);
  console.log(`Baseline:         ${baselineInfo.baselinePath ?? "(none)"}`);
  console.log(`Installed Version:${currentFingerprint.cliVersion}`);
  console.log(`Stored Version:   ${storedFingerprint?.cliVersion ?? "(none)"}`);
  console.log(`Binary SHA256:    ${currentFingerprint.binarySha256}`);
  if (githubRelease) {
    const relation =
      semverComparison === "behind"
        ? `(installed agy is behind latest GitHub release v${githubRelease})`
        : semverComparison === "equal"
          ? `(installed agy is equal to latest GitHub release v${githubRelease})`
          : `(installed agy is ahead of latest GitHub release v${githubRelease})`;
    console.log(`GitHub Release:   v${githubRelease} ${relation}`);
  }
  console.log("-------------------------------------------------");
  console.log(`Verdict:          ${evaluation.verdict} [${evaluation.verdictName}]`);
  console.log("-------------------------------------------------");

  if (evaluation.changedFields.length === 0) {
    console.log("No upstream changes detected. Everything is up to date.");
  } else {
    console.log(`Changed fields (${evaluation.changedFields.length}):`);
    for (const field of evaluation.changedFields) {
      const fieldDiff = evaluation.diff[field];
      console.log(`\n• Field: \x1b[36m${field}\x1b[0m`);
      if (Array.isArray(fieldDiff.new)) {
        const oldSet = new Set(fieldDiff.old || []);
        const newSet = new Set(fieldDiff.new || []);
        const added = fieldDiff.new.filter((x) => !oldSet.has(x));
        const removed = (fieldDiff.old || []).filter((x) => !newSet.has(x));
        if (added.length > 0) console.log(`  Added:   ${JSON.stringify(added)}`);
        if (removed.length > 0) console.log(`  Removed: ${JSON.stringify(removed)}`);
      } else if (typeof fieldDiff.new === "object" && fieldDiff.new !== null) {
        console.log(`  Old: ${JSON.stringify(fieldDiff.old)}`);
        console.log(`  New: ${JSON.stringify(fieldDiff.new)}`);
      } else {
        console.log(`  Old: ${JSON.stringify(fieldDiff.old)}`);
        console.log(`  New: ${JSON.stringify(fieldDiff.new)}`);
      }
    }
  }

  console.log("=================================================");
  process.exit(evaluation.verdict);
}

// Only run CLI when invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(VERDICT.ERROR);
  });
}
