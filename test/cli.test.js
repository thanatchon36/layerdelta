import assert from "node:assert/strict";
import { join } from "node:path";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import { main } from "../src/cli.js";
import { buildImage, tempDir, writeDockerArchive } from "./helpers.js";

const base = [
  { name: "usr/lib/libc.so", size: 50_000 },
  { name: "etc/hostname", size: 10 },
];
const v1 = buildImage({
  layers: [
    base,
    [
      { name: "app/server.js", size: 4_000 },
      { name: "app/node_modules/left-pad/index.js", size: 1_000 },
    ],
  ],
  history: ["ADD rootfs.tar /", "COPY . /app"],
});
const v2 = buildImage({
  layers: [
    base,
    [
      { name: "root/.cache/pip/http/a", size: 3_000_000 },
      { name: "root/.cache/pip/http/b", size: 1_500_000 },
      { name: "usr/lib/python3/site-packages/numpy/core.so", size: 2_500_000 },
      { name: "usr/lib/python3/site-packages/numpy/linalg.so", size: 700_000 },
    ],
    [
      { name: "root/.wh..cache", size: 0 },
      { name: "var/lib/apt/lists/deb_main", size: 1_200_000 },
    ],
    [{ name: "app/server.js", size: 4_500 }],
  ],
  history: ["ADD rootfs.tar /", "RUN pip install numpy", "RUN rm -rf /root/.cache && apt-get update", "COPY . /app"],
});

let dir = "";
let cleanup = async () => {};
before(async () => {
  ({ dir, cleanup } = await tempDir());
  await writeDockerArchive(v1, join(dir, "v1.tar"));
  await writeDockerArchive(v2, join(dir, "v2.tar"));
});
after(() => cleanup());

/** @param {string[]} args */
async function run(args) {
  let stdout = "";
  let stderr = "";
  const sink = (/** @type {(s: string) => void} */ push) =>
    new Writable({
      write(chunk, _encoding, done) {
        push(String(chunk));
        done();
      },
    });
  const code = await main(args, {
    stdout: sink((s) => (stdout += s)),
    stderr: sink((s) => (stderr += s)),
    env: {},
  });
  return { code, stdout, stderr };
}

test("text report explains growth, wasted bytes, caches, and new layers", async () => {
  const { code, stdout, stderr } = await run([join(dir, "v1.tar"), join(dir, "v2.tar")]);
  assert.equal(stderr, "");
  assert.equal(code, 0);
  const lines = stdout.split("\n");
  assert.match(stdout, /size\s+55\.0 kB\s+4\.5 MB\s+\+4\.4 MB/);
  assert.match(stdout, /wasted\s+0 B\s+4\.5 MB\s+\+4\.5 MB/);
  assert.match(stdout, /layers\s+2\s+4\s+1 shared/);
  assert.ok(lines.includes("    +3.2 MB  usr/lib/python3/site-packages/numpy/  +2 files"), stdout);
  assert.ok(lines.includes("    +1.2 MB  var/lib/apt/lists/deb_main            +1 file"), stdout);
  assert.match(stdout, /4\.5 MB {2}root\/\.cache\/pip\/http\/ {2}2 files/);
  assert.match(stdout, /added {4}layer 2 {2}RUN pip install numpy/);
  assert.match(stdout, /deleted {2}layer 3 {2}RUN rm -rf \/root\/\.cache && apt-get update/);
  assert.match(stdout, /1\.2 MB {2}var\/lib\/apt\/lists\/ {2}apt package lists, new/);
  assert.match(stdout, /Layers in after not shared with before \(3 of 4\)/);
  assert.ok(!stdout.includes("\u001b["), "no color when stdout is not a TTY");
});

test("json report has stable fields for scripts", async () => {
  const { code, stdout } = await run(["--format", "json", join(dir, "v1.tar"), join(dir, "v2.tar")]);
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.delta.size, 4_400_000 + 500 - 1_000);
  assert.deepEqual(
    { added: report.delta.added, removed: report.delta.removed, resized: report.delta.resized },
    { added: 3, removed: 1, resized: 1 },
  );
  assert.equal(report.sharedLayers, 1);
  assert.equal(report.budget, null);
  assert.deepEqual(report.files[0], {
    path: "usr/lib/python3/site-packages/numpy/core.so",
    before: null,
    after: 2_500_000,
    delta: 2_500_000,
  });
  assert.deepEqual(report.wasted[0], {
    path: "root/.cache/pip/http",
    files: 2,
    size: 4_500_000,
    addedIn: 2,
    removedIn: 3,
    how: "deleted",
    inherited: false,
  });
});

test("markdown report is ready for a pull request comment", async () => {
  const { stdout } = await run(["--format", "markdown", join(dir, "v1.tar"), join(dir, "v2.tar")]);
  assert.match(stdout, /^### layerdelta: `.*v1\.tar` → `.*v2\.tar`/);
  assert.match(stdout, /\| size \| 55\.0 kB \| 4\.5 MB \| \+4\.4 MB/);
  assert.match(stdout, /```text\n[\s\S]*numpy\/[\s\S]*```/);
  assert.match(
    stdout,
    /- 4\.5 MB in `root\/\.cache\/pip\/http\/` \(2 files\): added by layer 2 \(`RUN pip install numpy`\)/,
  );
});

test("--fail-over sets the exit code from an absolute or relative budget", async () => {
  const images = [join(dir, "v1.tar"), join(dir, "v2.tar")];
  const over = await run(["--fail-over", "1MB", ...images]);
  assert.equal(over.code, 1);
  assert.match(over.stdout, /Over budget: size grew by \+4\.4 MB, more than 1\.0 MB\./);
  const within = await run(["--fail-over", "5MB", ...images]);
  assert.equal(within.code, 0);
  assert.match(within.stdout, /Within budget/);
  assert.equal((await run(["--fail-over", "10%", ...images])).code, 1);
  const json = JSON.parse((await run(["--format", "json", "--fail-over", "10000%", ...images])).stdout);
  assert.deepEqual(json.budget, { limit: "10000% (5.5 MB)", exceeded: false });
});

test("comparing an image with itself reports no change", async () => {
  const { code, stdout } = await run([join(dir, "v1.tar"), join(dir, "v1.tar")]);
  assert.equal(code, 0);
  assert.match(stdout, /No file sizes changed\./);
  assert.match(stdout, /files\s+4\s+4\s+no change/);
});

test("waste the before image already had is summarized, not listed", async () => {
  const { stdout } = await run([join(dir, "v2.tar"), join(dir, "v2.tar")]);
  assert.match(stdout, /4\.5 MB {2}in 1 place inherited from layers shared with before/);
  assert.doesNotMatch(stdout, /root\/\.cache\/pip\/http\//);
});

test("usage errors exit with status 2 and say what is wrong", async () => {
  assert.deepEqual(
    [await run([])].map((r) => [r.code, /expected two images, got 0/.test(r.stderr)]),
    [[2, true]],
  );
  const format = await run(["--format", "xml", "a", "b"]);
  assert.equal(format.code, 2);
  assert.match(format.stderr, /--format must be text, markdown, or json/);
  const budget = await run(["--fail-over", "lots", join(dir, "v1.tar"), join(dir, "v2.tar")]);
  assert.equal(budget.code, 2);
  assert.match(budget.stderr, /invalid size "lots"/);
  const unknown = await run(["--nope"]);
  assert.equal(unknown.code, 2);
  const missing = await run([join(dir, "v1.tar"), join(dir, "nope.tar")]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /nope\.tar: no such file or directory/);
  const platform = await run(["--platform", "linux", "a", "b"]);
  assert.match(platform.stderr, /invalid platform "linux"/);
});

test("--help and --version", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: layerdelta \[options\] <before> <after>/);
  const version = await run(["--version"]);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
});
