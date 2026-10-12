import { buildFilesystem } from "./filesystem.js";
import { DEFAULT_PLATFORM, parsePlatform } from "./image.js";
import { readLayer } from "./layer.js";
import { openArchive } from "./sources/archive.js";
import { openDaemon } from "./sources/daemon.js";
import { openRegistry } from "./sources/registry.js";

/**
 * @typedef {import("./image.js").Image} Image
 * @typedef {import("./image.js").Platform} Platform
 * @typedef {import("./layer.js").LayerEntry} LayerEntry
 */

/**
 * Chooses a source from the argument's form:
 *   docker-daemon:NAME            image in the local Docker daemon
 *   oci:PATH, docker-archive:PATH a saved image (tar file or directory)
 *   ./x, /x, x.tar, a/b/          anything that looks like a path is read from disk
 *   everything else               an image reference pulled from its registry
 * @param {string} input
 * @param {{ platform: Platform }} options
 * @returns {Promise<Image>}
 */
export function openImage(input, options) {
  if (input.startsWith("docker-daemon:")) return openDaemon(input.slice("docker-daemon:".length), options);
  for (const prefix of ["oci:", "docker-archive:"]) {
    if (input.startsWith(prefix)) return openArchive(input.slice(prefix.length), { ...options, ref: input });
  }
  if (/^(\.{1,2}\/|\/)/.test(input) || /\.tar$/.test(input) || input.endsWith("/")) {
    return openArchive(input, options);
  }
  return openRegistry(input, options);
}

/**
 * Runs `task` over `items` with at most `limit` in flight.
 * @template T, R
 * @param {T[]} items @param {number} limit @param {(item: T) => Promise<R>} task
 */
async function pool(items, limit, task) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Opens both images and reads every distinct layer once: layers the two images share (the usual
 * case for a common base image) are downloaded and parsed a single time.
 * @param {string} beforeInput
 * @param {string} afterInput
 * @param {{ platform?: string, onProgress?: (done: number, total: number) => void }} [options]
 */
export async function loadPair(beforeInput, afterInput, { platform = DEFAULT_PLATFORM, onProgress } = {}) {
  const wanted = parsePlatform(platform);
  const opened = await Promise.allSettled([
    openImage(beforeInput, { platform: wanted }),
    openImage(afterInput, { platform: wanted }),
  ]);
  const images = opened.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  try {
    const failed = opened.find((result) => result.status === "rejected");
    if (failed) throw /** @type {PromiseRejectedResult} */ (failed).reason;
    const [before, after] = images;

    /** @type {Map<string, Image["layers"][number]>} */
    const unique = new Map();
    for (const layer of [...before.layers, ...after.layers]) {
      const key = layer.diffId ?? layer.digest;
      if (!unique.has(key)) unique.set(key, layer);
    }
    let done = 0;
    onProgress?.(0, unique.size);
    const keys = [...unique.keys()];
    const parsed = await pool(keys, 4, async (key) => {
      const layer = /** @type {Image["layers"][number]} */ (unique.get(key));
      const entries = await readLayer(await layer.open(), layer.verify ? layer.digest : undefined).catch((error) => {
        throw new Error(`layer ${layer.digest}: ${error.message}`);
      });
      onProgress?.(++done, unique.size);
      return entries;
    });
    /** @type {Map<string, LayerEntry[]>} */
    const byKey = new Map(keys.map((key, i) => [key, parsed[i]]));
    /** @param {Image} image */
    const filesystem = (image) =>
      buildFilesystem(
        image.layers.map((layer) => /** @type {LayerEntry[]} */ (byKey.get(layer.diffId ?? layer.digest))),
      );
    return { before: { image: before, fs: filesystem(before) }, after: { image: after, fs: filesystem(after) } };
  } finally {
    await Promise.all(images.map((image) => image.close?.()));
  }
}
