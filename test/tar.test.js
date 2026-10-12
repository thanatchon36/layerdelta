import assert from "node:assert/strict";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { readLayer } from "../src/layer.js";
import { indexTarFile, tarEntries } from "../src/tar.js";
import { chunked, makeTar, sha256, tempDir } from "./helpers.js";

/** @param {AsyncIterable<any>} iterable */
async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test("lists entries and skips contents, across tiny and odd-sized chunks", async () => {
  const tar = makeTar([
    { name: "usr/", type: "dir" },
    { name: "usr/bin/tool", size: 1000 },
    { name: "usr/bin/link", type: "symlink", linkname: "tool" },
    { name: "empty", size: 0 },
    { name: "exact", size: 512 },
  ]);
  for (const size of [1, 7, 511, 513, tar.length]) {
    const entries = await collect(tarEntries(chunked(tar, size)));
    assert.deepEqual(
      entries.map((e) => [e.name, e.type, e.size]),
      [
        ["usr/", "dir", 0],
        ["usr/bin/tool", "file", 1000],
        ["usr/bin/link", "symlink", 0],
        ["empty", "file", 0],
        ["exact", "file", 512],
      ],
      `chunk size ${size}`,
    );
  }
});

test("reads pax and GNU long names", async () => {
  const long = `${"a".repeat(80)}/${"b".repeat(80)}/file.txt`;
  const entries = await collect(
    tarEntries(
      chunked(
        makeTar([
          { name: long, size: 3, pax: true },
          { name: `${long}.gnu`, size: 4, gnuLongName: true },
        ]),
      ),
    ),
  );
  assert.deepEqual(
    entries.map((e) => [e.name, e.size]),
    [
      [long, 3],
      [`${long}.gnu`, 4],
    ],
  );
});

test("rejects data that is not a tar archive", async () => {
  await assert.rejects(collect(tarEntries(chunked(Buffer.alloc(1024, 0x41)))), /not a tar archive/);
});

test("rejects a truncated archive", async () => {
  const tar = makeTar([{ name: "big", size: 4000 }]);
  await assert.rejects(collect(tarEntries(chunked(tar.subarray(0, 2048)))), /truncated/);
});

test("readLayer handles gzip and plain tar and verifies digests", async () => {
  const tar = makeTar([{ name: "./app/main.js", size: 10 }]);
  const gz = gzipSync(tar);
  assert.deepEqual(await readLayer(chunked(gz, 100), sha256(gz)), [{ path: "app/main.js", type: "file", size: 10 }]);
  assert.deepEqual(await readLayer(chunked(tar, 100)), [{ path: "app/main.js", type: "file", size: 10 }]);
  await assert.rejects(readLayer(chunked(gz, 100), sha256(tar)), /digest mismatch/);
});

test("indexTarFile finds file offsets by reading headers only", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const file = join(dir, "a.tar");
    await writeFile(file, makeTar([{ name: "x/", type: "dir" }, { name: "x/hello", content: "hello world" }]));
    const handle = await open(file);
    const index = await indexTarFile(handle);
    const where = index.get("x/hello");
    assert.ok(where);
    const buf = Buffer.alloc(where.size);
    await handle.read(buf, 0, where.size, where.offset);
    await handle.close();
    assert.equal(buf.toString(), "hello world");
  } finally {
    await cleanup();
  }
});
