import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const sync = await import(pathToFileURL(path.resolve("scripts/sync-upstream-vars.js")).href);

const constants = { clientId: "1071006060591-test.apps.googleusercontent.com", clientSecret: "" };
const refs = {
  usedRpcs: ["v1internal:fetchAvailableModels", "v1internal:loadCodeAssist", "v1internal:streamGenerateContent"],
  usedHosts: ["daily-cloudcode-pa.googleapis.com", "oauth2.googleapis.com"]
};
const PROTOCOL_FIELDS = ["rpcNames", "googleHosts", "oauthClientPrefixes", "oauthScopes", "requestShapeMarkers"] as const;

function protocolView(a: Record<string, unknown>) {
  return Object.fromEntries(PROTOCOL_FIELDS.map((k) => [k, a[k]]));
}

describe("sync-upstream-vars: binary formats", () => {
  it("detects Mach-O, ELF, PE and unknown containers", () => {
    assert.equal(sync.detectBinaryFormat(sync.createMockMachOBinary()), "macho");
    assert.equal(sync.detectBinaryFormat(sync.createMockElfBinary()), "elf");
    assert.equal(sync.detectBinaryFormat(Buffer.from("MZ\x90\x00 windows")), "pe");
    assert.equal(sync.detectBinaryFormat(Buffer.from("#!/bin/sh\n")), "unknown");
    assert.equal(sync.detectBinaryFormat(Buffer.alloc(0)), "unknown");
  });

  it("parses ELF64 PT_LOAD segments and ignores non-load program headers", () => {
    const segs = sync.parseElfSegments(sync.createMockElfBinary({ size: 4096 }));
    assert.equal(segs.length, 1);
    assert.equal(segs[0].vmaddr, 0x400000n);
    assert.equal(segs[0].fileoff, 0n);
    assert.equal(segs[0].filesize, 4096n);
  });

  it("rejects malformed ELF files loudly", () => {
    assert.throws(() => sync.parseElfSegments(Buffer.alloc(16)), /binary too small/);
    const notElf = Buffer.alloc(128);
    assert.throws(() => sync.parseElfSegments(notElf), /missing .*ELF magic/);
    const elf32 = sync.createMockElfBinary();
    elf32[4] = 1;
    assert.throws(() => sync.parseElfSegments(elf32), /not ELFCLASS64/);
    const bigEndian = sync.createMockElfBinary();
    bigEndian[5] = 2;
    assert.throws(() => sync.parseElfSegments(bigEndian), /not little-endian/);
    const truncated = sync.createMockElfBinary();
    truncated.writeUInt16LE(0xffff, 0x38);
    assert.throws(() => sync.parseElfSegments(truncated), /program headers exceed/);
    const noLoad = sync.createMockElfBinary();
    noLoad.writeUInt32LE(4, 64 + 56); // PT_LOAD -> PT_NOTE
    assert.throws(() => sync.parseElfSegments(noLoad), /no PT_LOAD/);
  });

  it("reports PE/unknown binaries as unsupported (verdict 30 path)", () => {
    assert.throws(() => sync.parseBinarySegments(Buffer.from("MZ" + "\0".repeat(62))), /PE\/COFF/);
    assert.throws(() => sync.parseBinarySegments(Buffer.from("#!/bin/sh\necho hi\n")), /Unsupported agy binary format/);
  });

  it("derives the platform key from the binary itself", () => {
    assert.equal(sync.parseBinarySegments(sync.createMockMachOBinary()).platform, "darwin-arm64");
    assert.equal(sync.parseBinarySegments(sync.createMockElfBinary()).platform, "linux-x64");
    assert.equal(sync.parseBinarySegments(sync.createMockElfBinary({ arch: "arm64" })).platform, "linux-arm64");
  });

  it("extracts the same protocol fingerprint from equivalent Mach-O, ELF and PIE ELF binaries", () => {
    const macho = sync.analyzeBinary(sync.createMockMachOBinary(), constants, refs);
    const elf = sync.analyzeBinary(sync.createMockElfBinary(), constants, refs);
    const pie = sync.analyzeBinary(sync.createMockElfBinary({ pie: true }), constants, refs);
    assert.deepEqual(protocolView(elf), protocolView(macho));
    assert.deepEqual(protocolView(pie), protocolView(macho));
    assert.deepEqual(elf.oauthScopes, ["https://www.googleapis.com/auth/cloud-platform"]);
    assert.equal(elf.binaryFormat, "elf");
    assert.equal(pie.platform, "linux-x64");
    assert.notEqual(elf.binarySha256, macho.binarySha256);
  });

  it("applies R_X86_64_RELATIVE relocations for PIE binaries without mutating the input", () => {
    const pie = sync.createMockElfBinary({ pie: true });
    const before = Buffer.from(pie);
    const patched = sync.applyElfRelativeRelocations(pie);
    assert.notEqual(patched, pie, "PIE binaries must yield a relocated copy");
    assert.ok(pie.equals(before), "input buffer must not be mutated");
    assert.ok(!patched.equals(pie));
    // Non-PIE binaries are returned unchanged
    const exec = sync.createMockElfBinary();
    assert.equal(sync.applyElfRelativeRelocations(exec), exec);
  });

  it("maps Mach-O fat slices with slice-relative file offsets", () => {
    const thin = sync.createMockMachOBinary({ size: 4096 });
    const sliceOffset = 4096;
    const fat = Buffer.alloc(sliceOffset + thin.length);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(1, 4);
    fat.writeUInt32BE(0x0100000c, 8); // cputype arm64
    fat.writeUInt32BE(0, 12);
    fat.writeUInt32BE(sliceOffset, 16);
    fat.writeUInt32BE(thin.length, 20);
    fat.writeUInt32BE(14, 24);
    thin.copy(fat, sliceOffset);
    const segs = sync.parseMachOSegments(fat);
    assert.equal(segs[0].fileoff, BigInt(sliceOffset));
    const thinFp = sync.analyzeBinary(thin, constants, refs);
    const fatFp = sync.analyzeBinary(fat, constants, refs);
    assert.deepEqual(protocolView(fatFp), protocolView(thinFp));
  });
  it("refuses ELF binaries that use DT_RELR packed relocations", () => {
    const bin = sync.createMockElfBinary({ pie: true, relr: true });
    assert.throws(() => sync.parseBinarySegments(bin), /Unsupported agy binary format: ELF uses DT_RELR/);
  });

  it("prefers the fat Mach-O slice matching the host architecture", () => {
    const arm = sync.createMockMachOBinary();
    const x64 = Buffer.from(sync.createMockMachOBinary());
    x64.writeUInt32LE(0x01000007, 4);
    const header = Buffer.alloc(4096);
    header.writeUInt32BE(0xcafebabe, 0);
    header.writeUInt32BE(2, 4);
    const slices: Array<[number, Buffer]> = [[0x0100000c, arm], [0x01000007, x64]];
    let offset = header.length;
    slices.forEach(([cpu, buf], i) => {
      const at = 8 + i * 20;
      header.writeUInt32BE(cpu, at);
      header.writeUInt32BE(0, at + 4);
      header.writeUInt32BE(offset, at + 8);
      header.writeUInt32BE(buf.length, at + 12);
      header.writeUInt32BE(12, at + 16);
      offset += buf.length;
    });
    const fat = Buffer.concat([header, arm, x64]);
    assert.equal(sync.selectFatSliceOffset(fat, true, 2, "arm64"), header.length);
    assert.equal(sync.selectFatSliceOffset(fat, true, 2, "x64"), header.length + arm.length);
    assert.equal(sync.selectFatSliceOffset(fat, true, 2, "riscv64"), header.length, "falls back to the first 64-bit slice");
    const expected = process.arch === "x64" ? "darwin-x64" : "darwin-arm64";
    if (process.arch === "x64" || process.arch === "arm64") {
      assert.equal(sync.parseBinarySegments(fat).platform, expected);
    }
  });
});

describe("sync-upstream-vars: shared baseline", () => {
  function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agy-fp-"));
  }

  it("loads the shared baseline and fails loudly on unparsable JSON", () => {
    const dir = tmp();
    const file = path.join(dir, "agy-fingerprint.json");
    assert.equal(sync.loadFingerprintBaseline(file), null);
    fs.writeFileSync(file, JSON.stringify({ cliVersion: "1.5.1" }));
    const loaded = sync.loadFingerprintBaseline(file);
    assert.equal(loaded.fingerprint.cliVersion, "1.5.1");
    assert.equal(loaded.path, file);
    fs.writeFileSync(file, "{ nope");
    assert.throws(() => sync.loadFingerprintBaseline(file), /unparsable JSON/);
  });

  it("identical protocol fields compare equal even when binarySha256 differs", () => {
    const macho = { cliVersion: "1.4.12", latestChangelog: "x", subcommands: [], models: [], consumerClientParity: {}, ...sync.analyzeBinary(sync.createMockMachOBinary(), constants, refs) };
    const elf = { ...macho, ...sync.analyzeBinary(sync.createMockElfBinary({ pie: true }), constants, refs) };
    assert.notEqual(elf.binarySha256, macho.binarySha256);
    const res = sync.evaluateFingerprints(macho, elf);
    assert.equal(res.verdict, sync.VERDICT.NO_CHANGE);
    assert.deepEqual(res.changedFields, []);
  });

  it("toBaselineFingerprint keeps compared fields and drops reference-only keys", () => {
    const baseline = sync.toBaselineFingerprint({
      platform: "linux-x64",
      binaryFormat: "elf",
      binarySha256: "abc",
      cliVersion: "1.5.1",
      latestChangelog: "notes",
      extra: true
    });
    assert.deepEqual(Object.keys(baseline).sort(), ["cliVersion", "latestChangelog"]);
    assert.equal(baseline.cliVersion, "1.5.1");
    assert.equal(baseline.platform, undefined);
    assert.equal(baseline.binarySha256, undefined);
  });

  it("parseArgs rejects removed --platform/--force and accepts --investigated", () => {
    assert.equal(sync.parseArgs([]).investigated, undefined);
    assert.equal(sync.parseArgs(["--investigated=38"]).investigated, 38);
    assert.equal(sync.parseArgs(["--investigated=#38"]).investigated, 38);
    assert.throws(() => sync.parseArgs(["--investigated=yes"]), /Invalid --investigated/);
    assert.throws(() => sync.parseArgs(["--investigated=0"]), /Invalid --investigated/);
    assert.throws(() => sync.parseArgs(["--platform=linux-arm64"]), /were removed/);
    assert.throws(() => sync.parseArgs(["--force"]), /were removed/);
  });

  it("shouldApplyUpdate refuses REVIEW_NEEDED unless an investigation issue is named", () => {
    assert.equal(sync.shouldApplyUpdate(sync.VERDICT.SAFE, undefined), true);
    assert.equal(sync.shouldApplyUpdate(sync.VERDICT.REVIEW_NEEDED, undefined), false);
    assert.equal(sync.shouldApplyUpdate(sync.VERDICT.REVIEW_NEEDED, 38), true);
    assert.equal(sync.shouldApplyUpdate(sync.VERDICT.NO_CHANGE, 38), false);
  });

  it("pluginVersionForAgy maps agy x.y.z to x.y.(z*100+fix) and resets fix on an agy bump", () => {
    assert.equal(sync.pluginVersionForAgy("1.4.1200", "1.4.13"), "1.4.1300");
    assert.equal(sync.pluginVersionForAgy("1.4.1202", "1.4.13"), "1.4.1300");
    assert.equal(sync.pluginVersionForAgy("1.4.1202", "1.4.12"), "1.4.1202", "fix kept while agy unchanged");
    assert.equal(sync.pluginVersionForAgy("1.4.1200", "1.4.12"), "1.4.1200");
    assert.equal(sync.pluginVersionForAgy("0.2.0", "1.4.12"), "1.4.1200");
    assert.equal(sync.pluginVersionForAgy("1.4.1200", "2.0.0"), "2.0.0");
    assert.equal(sync.pluginVersionForAgy("1.4.1200", "1.5.3"), "1.5.300");
  });

  function applyFixture(npmScript: string, opts: { fpDirExists?: boolean; badPackageJson?: boolean } = {}) {
    const dir = tmp();
    const constantsPath = path.join(dir, "constants.ts");
    const original = `export const CLI_VERSION = "1.4.12" as const;\n`;
    fs.writeFileSync(constantsPath, original);
    const pkgPath = path.join(dir, "package.json");
    const pkgRaw = opts.badPackageJson ? "{ not json" : JSON.stringify({ name: "x", version: "1.4.1201" }, null, 2) + "\n";
    fs.writeFileSync(pkgPath, pkgRaw);
    const lockPath = path.join(dir, "package-lock.json");
    const lockRaw = JSON.stringify({ name: "x", version: "1.4.1201", lockfileVersion: 3, packages: { "": { name: "x", version: "1.4.1201" } } }, null, 2) + "\n";
    fs.writeFileSync(lockPath, lockRaw);
    const upstreamDir = path.join(dir, "upstream");
    if (opts.fpDirExists) fs.mkdirSync(upstreamDir, { recursive: true });
    const fpPath = path.join(upstreamDir, "agy-fingerprint.json");
    const log = path.join(dir, "npm.log");
    const npm = path.join(dir, "fake-npm");
    fs.writeFileSync(npm, `#!/bin/sh\necho "$@" >> "${log}"\n${npmScript}\n`, { mode: 0o755 });
    const run = () =>
      sync.applySafeUpdate("1.4.13", { platform: "linux-x64", binarySha256: "abc", cliVersion: "1.4.13", latestChangelog: "1.4.13" }, {
        customNpmPath: npm,
        customConstantsPath: constantsPath,
        customFingerprintPath: fpPath,
        customPackageJsonPath: pkgPath,
        customPackageLockPath: lockPath
      });
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
    return { dir, constantsPath, original, pkgPath, pkgRaw, lockPath, lockRaw, upstreamDir, fpPath, run, calls };
  }

  function captureError(fn: () => unknown): any {
    try {
      fn();
    } catch (e) {
      return e;
    }
    assert.fail("expected an error");
  }

  it("applySafeUpdate writes only the shared baseline fields and bumps package versions", () => {
    const f = applyFixture("exit 0");
    const res = f.run();
    assert.equal(JSON.parse(fs.readFileSync(f.pkgPath, "utf8")).version, "1.4.1300");
    const lock = JSON.parse(fs.readFileSync(f.lockPath, "utf8"));
    assert.equal(lock.version, "1.4.1300");
    assert.equal(lock.packages[""].version, "1.4.1300");
    assert.ok(res.filesChanged.some((p: string) => p.endsWith("package.json")));
    assert.match(fs.readFileSync(f.constantsPath, "utf8"), /"1\.4\.13"/);
    const written = JSON.parse(fs.readFileSync(f.fpPath, "utf8"));
    assert.equal(written.cliVersion, "1.4.13");
    assert.equal(written.latestChangelog, "1.4.13");
    assert.equal(written.platform, undefined);
    assert.equal(written.binaryFormat, undefined);
    assert.equal(written.binarySha256, undefined);
  });

  it("applySafeUpdate rolls back versions and rebuilds dist when the build itself fails", () => {
    const f = applyFixture(`if [ "$1" = "run" ] && [ "$2" = "build" ] && [ ! -f "$(dirname "$0")/built-once" ]; then touch "$(dirname "$0")/built-once"; exit 1; fi\nexit 0`);
    const err = captureError(f.run);
    assert.equal(err.failingStep, "build");
    assert.equal(err.rolledBack, true);
    assert.deepEqual(f.calls(), ["run build", "run build"], "a failed build must still trigger a rebuild from restored sources");
    assert.equal(fs.readFileSync(f.constantsPath, "utf8"), f.original);
    assert.equal(fs.readFileSync(f.pkgPath, "utf8"), f.pkgRaw);
    assert.equal(fs.readFileSync(f.lockPath, "utf8"), f.lockRaw);
  });

  it("applySafeUpdate reports rolledBack:false when the rollback rebuild fails", () => {
    const f = applyFixture(`if [ "$1" = "run" ] && [ "$2" = "build" ]; then exit 1; fi\nexit 0`);
    const err = captureError(f.run);
    assert.equal(err.failingStep, "build");
    assert.equal(err.rolledBack, false);
    assert.equal(fs.readFileSync(f.constantsPath, "utf8"), f.original, "files are still restored");
  });

  it("applySafeUpdate rolls back when a write after constants.ts throws", () => {
    const f = applyFixture("exit 0", { badPackageJson: true });
    const err = captureError(f.run);
    assert.equal(err.failingStep, "write");
    assert.equal(err.rolledBack, true);
    assert.equal(fs.readFileSync(f.constantsPath, "utf8"), f.original);
    assert.deepEqual(f.calls(), [], "no rebuild needed when no verification step ran");
  });

  it("applySafeUpdate removes a newly created fingerprint directory on rollback", () => {
    const f = applyFixture(`if [ "$1" = "test" ]; then exit 1; fi\nexit 0`);
    const err = captureError(f.run);
    assert.equal(err.failingStep, "test");
    assert.equal(err.rolledBack, true);
    assert.equal(fs.existsSync(path.join(f.dir, "upstream")), false);
  });

  it("applySafeUpdate keeps a pre-existing fingerprint directory on rollback", () => {
    const f = applyFixture(`if [ "$1" = "test" ]; then exit 1; fi\nexit 0`, { fpDirExists: true });
    captureError(f.run);
    assert.equal(fs.existsSync(f.upstreamDir), true);
    assert.equal(fs.existsSync(f.fpPath), false);
  });

  it("applySafeUpdate rolls back constants and fingerprint when verification fails", () => {
    const dir = tmp();
    const constantsPath = path.join(dir, "constants.ts");
    const original = `export const CLI_VERSION = "1.4.12" as const;\n`;
    fs.writeFileSync(constantsPath, original);
    const fpPath = path.join(dir, "agy-fingerprint.json");
    const npm = path.join(dir, "fake-npm");
    fs.writeFileSync(npm, `#!/bin/sh\nif [ "$1" = "test" ]; then echo boom >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
    let err: any;
    try {
      sync.applySafeUpdate("1.4.13", { platform: "darwin-arm64", binarySha256: "abc", cliVersion: "1.4.13" }, {
        customNpmPath: npm,
        customConstantsPath: constantsPath,
        customFingerprintPath: fpPath
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "apply must throw");
    assert.equal(err.failingStep, "test");
    assert.equal(err.rolledBack, true);
    assert.equal(fs.readFileSync(constantsPath, "utf8"), original);
    assert.equal(fs.existsSync(fpPath), false, "newly created baseline must be removed on rollback");
  });
});
