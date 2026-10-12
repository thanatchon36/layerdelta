// Builds small but real tar archives and image layouts, so tests exercise the same bytes that
// `docker save` and registries produce instead of hand-written fixtures.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

/**
 * @typedef {{ name: string, type?: "file" | "dir" | "symlink" | "hardlink", size?: number,
 *   content?: Buffer | string, linkname?: string, pax?: boolean, gnuLongName?: boolean }} Spec
 */

const TYPE_FLAGS = { file: "0", hardlink: "1", symlink: "2", dir: "5" };

/** @param {Buffer} buf @param {number} offset @param {number} length @param {number} value */
function writeOctal(buf, offset, length, value) {
  buf.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "latin1");
}

/** @param {{ name: string, flag: string, size: number, linkname?: string, gnu?: boolean }} h */
function header({ name, flag, size, linkname = "", gnu = false }) {
  const buf = Buffer.alloc(512);
  buf.write(name.slice(0, 100), 0, 100, "utf8");
  writeOctal(buf, 100, 8, 0o644);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, 0);
  buf.write(flag, 156, 1, "latin1");
  buf.write(linkname.slice(0, 100), 157, 100, "utf8");
  buf.write(gnu ? "ustar  \0" : "ustar\x0000", 257, 8, "latin1");
  buf.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return buf;
}

/** @param {Buffer} data */
function padded(data) {
  const rest = data.length % 512;
  return rest ? Buffer.concat([data, Buffer.alloc(512 - rest)]) : data;
}

/** @param {Record<string, string>} records */
function paxData(records) {
  let out = "";
  for (const [key, value] of Object.entries(records)) {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    while (`${length}${body}`.length !== length) length += 1;
    out += `${length}${body}`;
  }
  return Buffer.from(out, "utf8");
}

/** @param {Spec[]} specs @returns {Buffer} */
export function makeTar(specs) {
  /** @type {Buffer[]} */
  const parts = [];
  for (const spec of specs) {
    const type = spec.type ?? "file";
    const content =
      type === "file"
        ? typeof spec.content === "string"
          ? Buffer.from(spec.content)
          : (spec.content ?? Buffer.alloc(spec.size ?? 0, 0x61))
        : Buffer.alloc(0);
    if (spec.pax) {
      const data = paxData({ path: spec.name });
      parts.push(header({ name: "PaxHeader", flag: "x", size: data.length }), padded(data));
    }
    if (spec.gnuLongName) {
      const data = Buffer.from(`${spec.name}\0`);
      parts.push(header({ name: "././@LongLink", flag: "L", size: data.length, gnu: true }), padded(data));
    }
    parts.push(
      header({ name: spec.name, flag: TYPE_FLAGS[type], size: content.length, linkname: spec.linkname }),
      padded(content),
    );
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** @param {Buffer} buf @param {number} [chunkSize] */
export function chunked(buf, chunkSize = 7) {
  return Readable.from(
    (function* () {
      for (let i = 0; i < buf.length; i += chunkSize) yield buf.subarray(i, i + chunkSize);
    })(),
  );
}

/** @param {Buffer} buf */
export function sha256(buf) {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

/**
 * @typedef {{ layers: Spec[][], history?: string[], architecture?: string, gzip?: boolean }} ImageSpec
 * @typedef {{ config: Buffer, configDigest: string, layers: { blob: Buffer, digest: string, diffId: string }[] }} BuiltImage
 */

/** @param {ImageSpec} image @returns {BuiltImage} */
export function buildImage({ layers, history = [], architecture = "amd64", gzip = true }) {
  const built = layers.map((specs) => {
    const tar = makeTar(specs);
    const blob = gzip ? gzipSync(tar) : tar;
    return { blob, digest: sha256(blob), diffId: sha256(tar) };
  });
  const config = Buffer.from(
    JSON.stringify({
      architecture,
      os: "linux",
      rootfs: { type: "layers", diff_ids: built.map((layer) => layer.diffId) },
      history: built.map((_, i) => ({ created_by: history[i] ?? `layer ${i}` })),
    }),
  );
  return { config, configDigest: sha256(config), layers: built };
}

/**
 * Writes an image as a classic `docker save` tar (manifest.json + <id>/layer.tar).
 * @param {BuiltImage} image @param {string} file
 */
export async function writeDockerArchive(image, file) {
  const configName = `${image.configDigest.slice(7)}.json`;
  const layerNames = image.layers.map((layer) => `${layer.diffId.slice(7)}/layer.tar`);
  const manifest = JSON.stringify([{ Config: configName, RepoTags: ["example:latest"], Layers: layerNames }]);
  const tar = makeTar([
    { name: configName, content: image.config },
    ...image.layers.map((layer, i) => ({ name: layerNames[i], content: layer.blob })),
    { name: "manifest.json", content: manifest },
  ]);
  await writeFile(file, tar);
}

/** @param {BuiltImage} image */
export function ociManifest(image) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: image.configDigest,
        size: image.config.length,
      },
      layers: image.layers.map((layer) => ({
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: layer.digest,
        size: layer.blob.length,
      })),
    }),
  );
}

/** @returns {Promise<{ dir: string, cleanup: () => Promise<void> }>} */
export async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "layerdelta-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
