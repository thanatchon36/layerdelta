// Reads images saved to disk: `docker save` tarballs (classic and Docker 25+ OCI-style) and OCI
// image layouts, either as a tar file or an unpacked directory.
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { diffIds, formatPlatform, layerCommands, selectPlatform } from "../image.js";
import { indexTarFile } from "../tar.js";

/**
 * @typedef {import("../image.js").Image} Image
 * @typedef {import("../image.js").Platform} Platform
 * @typedef {{ read: (name: string) => Promise<Buffer | null>, stream: (name: string) => AsyncIterable<Buffer>, close: () => Promise<void> }} Store
 */

/** @param {string} dir @returns {Store} */
function directoryStore(dir) {
  return {
    read: async (name) => {
      try {
        return await readFile(join(dir, name));
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
        throw error;
      }
    },
    stream: (name) => createReadStream(join(dir, name)),
    close: async () => {},
  };
}

/** @param {string} file @returns {Promise<Store>} */
async function tarStore(file) {
  const handle = await open(file);
  let index;
  try {
    index = await indexTarFile(handle);
  } catch (error) {
    await handle.close();
    throw new Error(`${file}: ${/** @type {Error} */ (error).message}`);
  }
  /** @param {string} name */
  const locate = (name) => index.get(name.replace(/^\.\//, ""));
  return {
    read: async (name) => {
      const where = locate(name);
      if (!where) return null;
      const buf = Buffer.alloc(where.size);
      await handle.read(buf, 0, where.size, where.offset);
      return buf;
    },
    stream: (name) => {
      const where = locate(name);
      if (!where) throw new Error(`${file} does not contain ${name}`);
      if (where.size === 0) return (async function* () {})();
      return createReadStream(file, { start: where.offset, end: where.offset + where.size - 1 });
    },
    close: () => handle.close(),
  };
}

/** @param {Buffer | null} buf @param {string} what */
function parseJson(buf, what) {
  if (!buf) throw new Error(`missing ${what}`);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

/** @param {string} digest */
function blobPath(digest) {
  const [algorithm, hex] = digest.split(":");
  if (!/^[a-z0-9]+$/.test(algorithm ?? "") || !/^[a-f0-9]+$/.test(hex ?? ""))
    throw new Error(`invalid digest ${digest}`);
  return `blobs/${algorithm}/${hex}`;
}

/**
 * @param {string} path
 * @param {{ platform: Platform, ref?: string, source?: Image["source"] }} options
 * @returns {Promise<Image>}
 */
export async function openArchive(path, { platform, ref = path, source = "archive" }) {
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`${path}: no such file or directory`);
  const store = info.isDirectory() ? directoryStore(path) : await tarStore(path);
  try {
    const dockerManifest = await store.read("manifest.json");
    const image = dockerManifest
      ? await fromDockerManifest(store, parseJson(dockerManifest, "manifest.json"), ref)
      : await fromOciLayout(store, platform, ref);
    return { ...image, ref, source, close: store.close };
  } catch (error) {
    await store.close();
    throw error;
  }
}

/** @param {Store} store @param {any} manifest @param {string} ref */
async function fromDockerManifest(store, manifest, ref) {
  if (!Array.isArray(manifest) || manifest.length === 0) throw new Error(`${ref}: manifest.json lists no images`);
  if (manifest.length > 1) {
    const tags = manifest.map((m) => m.RepoTags?.[0] ?? m.Config).join(", ");
    throw new Error(`${ref} contains ${manifest.length} images (${tags}); save one image per archive`);
  }
  const [entry] = manifest;
  const config = parseJson(await store.read(entry.Config), entry.Config);
  const layerPaths = /** @type {string[]} */ (entry.Layers ?? []);
  const ids = diffIds(config);
  const commands = layerCommands(config, layerPaths.length);
  return {
    platform: formatPlatform(config),
    layers: layerPaths.map((name, i) => {
      const blob = /^blobs\/(sha256|sha512)\/([a-f0-9]+)$/.exec(name);
      return {
        digest: blob ? `${blob[1]}:${blob[2]}` : (ids[i] ?? name),
        diffId: ids[i] ?? null,
        compressedSize: null,
        createdBy: commands[i],
        verify: Boolean(blob),
        open: async () => store.stream(name),
      };
    }),
  };
}

/** @param {Store} store @param {Platform} platform @param {string} ref */
async function fromOciLayout(store, platform, ref) {
  const index = await store.read("index.json");
  if (!index) throw new Error(`${ref} is neither a docker save archive (manifest.json) nor an OCI layout (index.json)`);
  let manifest = parseJson(index, "index.json");
  // Follow nested indexes (multi-platform images) down to a single image manifest.
  for (let depth = 0; Array.isArray(manifest.manifests); depth++) {
    if (depth > 4) throw new Error(`${ref}: index nesting is too deep`);
    const candidates = manifest.manifests;
    const next =
      candidates.length === 1 && !candidates[0].platform ? candidates[0] : selectPlatform(candidates, platform, ref);
    manifest = parseJson(await store.read(blobPath(next.digest)), next.digest);
  }
  const config = parseJson(await store.read(blobPath(manifest.config.digest)), manifest.config.digest);
  const layers = /** @type {{ digest: string }[]} */ (manifest.layers ?? []);
  const ids = diffIds(config);
  const commands = layerCommands(config, layers.length);
  return {
    platform: formatPlatform(config),
    layers: layers.map((layer, i) => ({
      digest: layer.digest,
      diffId: ids[i] ?? null,
      compressedSize: null,
      createdBy: commands[i],
      verify: true,
      open: async () => store.stream(blobPath(layer.digest)),
    })),
  };
}
