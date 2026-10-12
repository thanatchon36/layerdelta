// What every source (registry, archive, Docker daemon) produces, plus the helpers they share.

/**
 * @typedef {{
 *   digest: string,
 *   diffId: string | null,
 *   compressedSize: number | null,
 *   createdBy: string | null,
 *   verify: boolean,
 *   open: () => Promise<AsyncIterable<Buffer>>,
 * }} LayerRef
 * @typedef {{
 *   ref: string,
 *   source: "registry" | "archive" | "docker-daemon",
 *   platform: string,
 *   layers: LayerRef[],
 *   close?: () => Promise<void>,
 * }} Image
 * @typedef {{ os: string, architecture: string, variant?: string }} Platform
 */

export const DEFAULT_PLATFORM = "linux/amd64";

/** @param {string} text @returns {Platform} */
export function parsePlatform(text) {
  const [os, architecture, variant, extra] = text.split("/");
  if (!os || !architecture || extra !== undefined) {
    throw new Error(`invalid platform "${text}": expected os/arch or os/arch/variant, e.g. linux/arm64`);
  }
  return variant ? { os, architecture, variant } : { os, architecture };
}

/** @param {Partial<Platform> | undefined} platform */
export function formatPlatform(platform) {
  if (!platform?.os || !platform.architecture) return "unknown";
  return [platform.os, platform.architecture, platform.variant].filter(Boolean).join("/");
}

/**
 * Picks the manifest for a platform from an OCI index or Docker manifest list. arm64 images are
 * usually published as variant v8, so a missing variant on either side matches.
 * @template {{ platform?: Partial<Platform> }} T
 * @param {T[]} manifests
 * @param {Platform} wanted
 * @param {string} ref for error messages
 * @returns {T}
 */
export function selectPlatform(manifests, wanted, ref) {
  const real = manifests.filter((m) => m.platform?.os && m.platform.os !== "unknown");
  const match = real.find(
    (m) =>
      m.platform?.os === wanted.os &&
      m.platform?.architecture === wanted.architecture &&
      (!wanted.variant || !m.platform?.variant || m.platform.variant === wanted.variant),
  );
  if (match) return match;
  const available = real.map((m) => formatPlatform(m.platform)).join(", ") || "none";
  throw new Error(`${ref} has no ${formatPlatform(wanted)} image (available: ${available}); use --platform`);
}

/**
 * Pairs config history entries with layers. Entries marked empty_layer (ENV, CMD, ...) have no
 * layer of their own.
 * @param {any} config
 * @param {number} layerCount
 * @returns {(string | null)[]}
 */
export function layerCommands(config, layerCount) {
  /** @type {any[]} */
  const history = Array.isArray(config?.history)
    ? config.history.filter((/** @type {any} */ h) => !h?.empty_layer)
    : [];
  if (history.length !== layerCount) return Array(layerCount).fill(null);
  return history.map((h) => (typeof h.created_by === "string" ? cleanCommand(h.created_by) : null));
}

/** @param {string} command */
function cleanCommand(command) {
  return command
    .replace(/^\/bin\/sh -c #\(nop\)\s*/, "")
    .replace(/^(RUN )?\/bin\/sh -c /, "RUN ")
    .replace(/^RUN \|\d+ (\S+=\S* )*\/bin\/sh -c /, "RUN ")
    .replace(/ # buildkit$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {any} config @returns {(string | null)[]} */
export function diffIds(config) {
  const ids = config?.rootfs?.diff_ids;
  return Array.isArray(ids) ? ids.map((id) => (typeof id === "string" ? id : null)) : [];
}
