import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFilesystem, findCaches } from "../src/filesystem.js";

/** @param {string} path @param {number} [size] @returns {import("../src/layer.js").LayerEntry} */
const file = (path, size = 10) => ({ path, type: "file", size });
/** @param {string} path @returns {import("../src/layer.js").LayerEntry} */
const dir = (path) => ({ path, type: "dir", size: 0 });

test("later layers replace files, and the replaced bytes count as wasted", () => {
  const fs = buildFilesystem([[dir("app"), file("app/a", 100), file("app/b", 5)], [file("app/a", 30)]]);
  assert.deepEqual(fs.files.get("app/a"), { type: "file", size: 30, layer: 1 });
  assert.deepEqual(fs.wasted, [{ path: "app/a", size: 100, addedIn: 0, removedIn: 1, how: "replaced" }]);
  assert.deepEqual(fs.layerSizes, [105, 30]);
});

test("whiteouts delete files and whole directories from lower layers", () => {
  const fs = buildFilesystem([
    [file("root/.cache/pip/x", 40), file("root/.cache/pip/y", 2), file("etc/keep")],
    [file("root/.wh..cache", 0)],
  ]);
  assert.deepEqual([...fs.files.keys()], ["etc/keep"]);
  assert.equal(
    fs.wasted.reduce((sum, w) => sum + w.size, 0),
    42,
  );
  assert.ok(fs.wasted.every((w) => w.how === "deleted" && w.removedIn === 1));
});

test("opaque whiteouts hide lower content but not files from the same layer, wherever the marker is", () => {
  const fs = buildFilesystem([
    [file("data/old", 7)],
    [file("data/new", 3), file("data/.wh..wh..opq", 0)],
  ]);
  assert.deepEqual([...fs.files.keys()], ["data/new"]);
  assert.deepEqual(
    fs.wasted.map((w) => [w.path, w.how]),
    [["data/old", "deleted"]],
  );
});

test("a file replacing a directory discards everything under it", () => {
  const fs = buildFilesystem([[file("opt/tool/bin", 8), file("opt/tool/lib", 2)], [file("opt/tool", 1)]]);
  assert.deepEqual([...fs.files.keys()], ["opt/tool"]);
  assert.equal(fs.wasted.length, 2);
});

test("implicit parent directories are created and directories merge across layers", () => {
  const fs = buildFilesystem([[file("a/b/c", 1)], [dir("a"), file("a/d", 2)]]);
  assert.deepEqual([...fs.files.keys()].sort(), ["a/b/c", "a/d"]);
  assert.deepEqual(fs.wasted, []);
});

test("whiteouts for paths that do not exist are ignored", () => {
  const fs = buildFilesystem([[file("a", 1)], [file("missing/.wh.x", 0), file(".wh.nope", 0)]]);
  assert.deepEqual([...fs.files.keys()], ["a"]);
});

test("findCaches totals well-known cache directories", () => {
  const fs = buildFilesystem([
    [file("var/lib/apt/lists/a", 300), file("var/lib/apt/lists/b", 200), file("root/.cache/pip/w", 50)],
    [file("home/app/.npm/_cacache/x", 9), file("usr/lib/x", 1000)],
  ]);
  assert.deepEqual(findCaches(fs.files), [
    { label: "apt package lists", path: "var/lib/apt/lists", size: 500, files: 2 },
    { label: "pip cache", path: "root/.cache/pip", size: 50, files: 1 },
    { label: "npm cache", path: "home/app/.npm/_cacache", size: 9, files: 1 },
  ]);
});
