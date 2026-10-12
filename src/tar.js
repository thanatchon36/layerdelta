// Minimal tar reader. Layers can hold hundreds of thousands of files, and layerdelta only needs
// names, types, and sizes, so file contents are skipped, never buffered.

const BLOCK = 512;

/**
 * @typedef {"file" | "dir" | "symlink" | "hardlink" | "other"} EntryType
 * @typedef {{ name: string, type: EntryType, size: number, linkname: string }} TarEntry
 * @typedef {{ path?: string, linkpath?: string, size?: number }} PaxOverrides
 */

/**
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 */
function readString(buf, start, end) {
  const zero = buf.indexOf(0, start);
  return buf.toString("utf8", start, zero === -1 || zero > end ? end : zero);
}

/**
 * Tar numbers are octal text, or big-endian base-256 when the high bit of the first byte is set
 * (GNU extension for values that do not fit, e.g. files over 8 GiB).
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 */
function readNumber(buf, start, end) {
  if (buf[start] & 0x80) {
    let value = buf[start] & 0x7f;
    for (let i = start + 1; i < end; i++) value = value * 256 + buf[i];
    return value;
  }
  const text = readString(buf, start, end).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** @param {Buffer} header */
function checksumMatches(header) {
  const expected = readNumber(header, 148, 156);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum === expected;
}

/** @param {string} flag @returns {EntryType} */
function entryType(flag) {
  switch (flag) {
    case "0":
    case "\0":
    case "":
    case "7":
      return "file";
    case "1":
      return "hardlink";
    case "2":
      return "symlink";
    case "5":
      return "dir";
    default:
      return "other";
  }
}

/** @param {Buffer} data @returns {PaxOverrides} */
function parsePax(data) {
  /** @type {PaxOverrides} */
  const out = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const length = Number.parseInt(data.toString("utf8", pos, space), 10);
    if (!(length > 0)) break;
    const record = data.toString("utf8", space + 1, pos + length - 1);
    const eq = record.indexOf("=");
    const key = record.slice(0, eq);
    const value = record.slice(eq + 1);
    if (key === "path") out.path = value;
    else if (key === "linkpath") out.linkpath = value;
    else if (key === "size") out.size = Number(value);
    pos += length;
  }
  return out;
}

/** @param {Buffer} block */
function isZeroBlock(block) {
  for (let i = 0; i < BLOCK; i++) if (block[i] !== 0) return false;
  return true;
}

/**
 * Parses one header block. Returns null for the end-of-archive marker.
 * @param {Buffer} header
 * @returns {{ name: string, flag: string, size: number, linkname: string } | null}
 */
export function parseHeader(header) {
  if (isZeroBlock(header)) return null;
  if (!checksumMatches(header)) throw new Error("not a tar archive (header checksum mismatch)");
  let name = readString(header, 0, 100);
  // POSIX ustar splits long names into prefix + name. GNU tar ("ustar  ") reuses those bytes.
  if (header.toString("latin1", 257, 263) === "ustar\0") {
    const prefix = readString(header, 345, 500);
    if (prefix) name = `${prefix}/${name}`;
  }
  return {
    name,
    flag: String.fromCharCode(header[156]).replace("\0", "0"),
    size: readNumber(header, 124, 136),
    linkname: readString(header, 157, 257),
  };
}

/**
 * Turns a raw header plus pending pax/GNU long-name records into an entry.
 * @param {{ name: string, flag: string, size: number, linkname: string }} raw
 * @param {PaxOverrides} pax
 * @returns {TarEntry}
 */
function toEntry(raw, pax) {
  return {
    name: pax.path ?? raw.name,
    type: entryType(raw.flag),
    size: pax.size ?? raw.size,
    linkname: pax.linkpath ?? raw.linkname,
  };
}

/**
 * Streams entries from an uncompressed tar byte stream, skipping file contents.
 * @param {AsyncIterable<Buffer>} chunks
 * @returns {AsyncGenerator<TarEntry>}
 */
export async function* tarEntries(chunks) {
  /** @type {Buffer[]} */
  let pending = [];
  let pendingLength = 0;
  let skip = 0;
  /** @type {null | { kind: "pax" | "globalpax" | "longname" | "longlink", size: number }} */
  let reading = null;
  /** @type {PaxOverrides} */
  let pax = {};
  let ended = false;

  /** @param {number} n */
  const take = (n) => {
    const all = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLength);
    const head = all.subarray(0, n);
    const rest = all.subarray(n);
    pending = rest.length ? [rest] : [];
    pendingLength = rest.length;
    return head;
  };

  for await (const input of chunks) {
    let chunk = input;
    if (ended) continue; // drain the stream so decompressors and digest checks see all of it
    if (skip > 0) {
      const n = Math.min(skip, chunk.length);
      skip -= n;
      chunk = chunk.subarray(n);
      if (chunk.length === 0) continue;
    }
    pending.push(chunk);
    pendingLength += chunk.length;

    while (!ended) {
      if (skip > 0) {
        const n = Math.min(skip, pendingLength);
        take(n);
        skip -= n;
        if (skip > 0) break;
      }
      if (reading) {
        const padded = Math.ceil(reading.size / BLOCK) * BLOCK;
        if (pendingLength < padded) break;
        const data = take(padded).subarray(0, reading.size);
        if (reading.kind === "pax") pax = { ...pax, ...parsePax(data) };
        else if (reading.kind === "longname") pax.path = readString(data, 0, data.length);
        else if (reading.kind === "longlink") pax.linkpath = readString(data, 0, data.length);
        reading = null;
        continue;
      }
      if (pendingLength < BLOCK) break;
      const raw = parseHeader(take(BLOCK));
      if (raw === null) {
        ended = true;
        break;
      }
      const kind =
        raw.flag === "x"
          ? "pax"
          : raw.flag === "g"
            ? "globalpax"
            : raw.flag === "L"
              ? "longname"
              : raw.flag === "K"
                ? "longlink"
                : null;
      if (kind) {
        reading = { kind, size: raw.size };
        continue;
      }
      const entry = toEntry(raw, pax);
      pax = {};
      // Hard links and directories carry no data even if a size is recorded.
      skip = entry.type === "hardlink" || entry.type === "dir" ? 0 : Math.ceil(entry.size / BLOCK) * BLOCK;
      yield entry;
    }
  }
  if (!ended && (pendingLength > 0 || skip > 0 || reading)) {
    throw new Error("tar archive is truncated");
  }
}

/**
 * Indexes an uncompressed tar file on disk by reading only its headers.
 * @param {import("node:fs/promises").FileHandle} handle
 * @returns {Promise<Map<string, { offset: number, size: number }>>}
 */
export async function indexTarFile(handle) {
  /** @type {Map<string, { offset: number, size: number }>} */
  const index = new Map();
  const { size: fileSize } = await handle.stat();
  const header = Buffer.alloc(BLOCK);
  /** @type {PaxOverrides} */
  let pax = {};
  let offset = 0;
  while (offset + BLOCK <= fileSize) {
    await handle.read(header, 0, BLOCK, offset);
    const raw = parseHeader(header);
    if (raw === null) break;
    const dataOffset = offset + BLOCK;
    const padded = Math.ceil(raw.size / BLOCK) * BLOCK;
    if (raw.flag === "x" || raw.flag === "L" || raw.flag === "K") {
      const data = Buffer.alloc(raw.size);
      await handle.read(data, 0, raw.size, dataOffset);
      if (raw.flag === "x") pax = { ...pax, ...parsePax(data) };
      else if (raw.flag === "L") pax.path = readString(data, 0, data.length);
      else pax.linkpath = readString(data, 0, data.length);
    } else if (raw.flag !== "g") {
      const entry = toEntry(raw, pax);
      pax = {};
      if (entry.type === "file") index.set(normalizePath(entry.name), { offset: dataOffset, size: entry.size });
    }
    offset = dataOffset + padded;
  }
  return index;
}

/**
 * "./usr/bin/" and "/usr/bin" both become "usr/bin".
 * @param {string} name
 */
export function normalizePath(name) {
  return name
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}
