/**
 * Plugin version <-> agy version mapping.
 *
 *   plugin version = <agyMajor>.<agyMinor>.<agyPatch * 100 + fix>     fix = 0..99
 *
 * agy 1.4.12 -> plugin 1.4.1200; plugin-only fixes for the same agy version are
 * 1.4.1201, 1.4.1202, ... (they sort above the base in semver, so npm/ClawHub/OpenClaw
 * "latest" logic works). Back-mapping: agy patch = floor(plugin patch / 100),
 * fix = plugin patch % 100. Plain x.y.z only: no prerelease or build suffixes.
 */
const SEMVER_CORE = /^(\d+)\.(\d+)\.(\d+)$/;
export const MAX_FIX = 99;

export function pluginVersionFor(agyVersion, fix = 0) {
  const m = SEMVER_CORE.exec(String(agyVersion));
  if (!m) throw new Error(`agy version '${agyVersion}' is not plain <major>.<minor>.<patch>`);
  if (!Number.isInteger(fix) || fix < 0 || fix > MAX_FIX) {
    throw new Error(`fix number ${fix} out of range 0..${MAX_FIX}`);
  }
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3]) * 100 + fix}`;
}

/** @returns {{ agyVersion: string, fix: number } | null} */
export function parsePluginVersion(pluginVersion) {
  const m = SEMVER_CORE.exec(String(pluginVersion));
  if (!m) return null;
  const patch = Number(m[3]);
  return { agyVersion: `${Number(m[1])}.${Number(m[2])}.${Math.floor(patch / 100)}`, fix: patch % 100 };
}

export function agyVersionFromPlugin(pluginVersion) {
  return parsePluginVersion(pluginVersion)?.agyVersion ?? null;
}

/** True when pluginVersion is a valid mapping of agyVersion (any fix 0..99). */
export function pluginVersionMatchesAgy(pluginVersion, agyVersion) {
  const parsed = parsePluginVersion(pluginVersion);
  return parsed !== null && SEMVER_CORE.test(String(agyVersion)) && parsed.agyVersion === agyVersion;
}

/**
 * Version to write when targeting agyVersion: keep the current plugin version (and its
 * fix number) if it already targets that agy version, otherwise <agy mapping>.00.
 */
export function nextPluginVersion(currentPluginVersion, agyVersion) {
  return pluginVersionMatchesAgy(currentPluginVersion, agyVersion)
    ? currentPluginVersion
    : pluginVersionFor(agyVersion, 0);
}
