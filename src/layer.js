import { createHash } from "node:crypto";
import { compose, Readable } from "node:stream";
import zlib from "node:zlib";
import { normalizePath, tarEntries } from "./tar.js";

/** @typedef {{ path: string, type: import("./tar.js").EntryType, size: number }} LayerEntry */

/**
 * Hashes the stream as it passes through and fails at the end if the digest does not match,
 * so a corrupted or tampered download is never reported as a result.
 * @param {AsyncIterable<Buffer>} source
 * @param {string} digest e.g. "sha256:abc..."
 * @returns {AsyncGenerator<Buffer>}
 */
async function* verified(source, digest) {
  const [algorithm, expected] = digest.split(":");
  if (algorithm !== "sha256" && algorithm !== "sha512") {
    yield* source;
    return;
  }
  const hash = createHash(algorithm);
  for await (const chunk of source) {
    hash.update(chunk);
    yield chunk;
  }
  const actual = hash.digest("hex");
  if (actual !== expected) throw new Error(`digest mismatch for ${digest}: got ${algorithm}:${actual}`);
}

/**
 * Detects gzip, zstd, or plain tar from the first bytes rather than trusting the media type;
 * `docker save` archives and some registries label uncompressed layers inconsistently.
 * @param {AsyncIterable<Buffer>} source
 * @returns {Promise<AsyncIterable<Buffer>>}
 */
async function decompress(source) {
  const iterator = source[Symbol.asyncIterator]();
  /** @type {Buffer[]} */
  const head = [];
  let headLength = 0;
  let done = false;
  while (headLength < 4) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    head.push(next.value);
    headLength += next.value.length;
  }
  const first = Buffer.concat(head);
  const replay = Readable.from(
    (async function* () {
      if (first.length) yield first;
      if (done) return;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    })(),
  );
  if (first[0] === 0x1f && first[1] === 0x8b) return compose(replay, zlib.createGunzip());
  if (first.length >= 4 && first.readUInt32LE(0) === 0xfd2fb528) {
    if (typeof zlib.createZstdDecompress !== "function") {
      throw new Error(`this layer is zstd-compressed, which needs Node.js 22.15 or newer (running ${process.version})`);
    }
    return compose(replay, zlib.createZstdDecompress());
  }
  return replay;
}

/**
 * Reads a (possibly compressed) layer blob and lists its entries.
 * @param {AsyncIterable<Buffer>} source
 * @param {string} [digest] when given, the compressed bytes are checked against it
 * @returns {Promise<LayerEntry[]>}
 */
export async function readLayer(source, digest) {
  const input = digest ? verified(source, digest) : source;
  /** @type {LayerEntry[]} */
  const entries = [];
  for await (const entry of tarEntries(await decompress(input))) {
    const path = normalizePath(entry.name);
    if (path === "") continue;
    entries.push({ path, type: entry.type, size: entry.type === "file" ? entry.size : 0 });
  }
  return entries;
}
