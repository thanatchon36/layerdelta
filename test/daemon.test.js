import assert from "node:assert/strict";
import { chmod, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { openImage } from "../src/load.js";
import { buildImage, tempDir, writeDockerArchive } from "./helpers.js";

const platform = { os: "linux", architecture: "amd64" };

/**
 * Puts a stand-in `docker` on PATH that copies a prepared archive to the --output path, and
 * fails for any image name other than "app:dev", the way `docker image save` does.
 * @param {(dir: string) => Promise<void>} fn
 */
async function withFakeDocker(fn) {
  const { dir, cleanup } = await tempDir();
  const originalPath = process.env.PATH;
  try {
    await writeDockerArchive(buildImage({ layers: [[{ name: "bin/app", size: 42 }]] }), join(dir, "saved.tar"));
    const script = join(dir, "docker");
    await writeFile(
      script,
      `#!/usr/bin/env node
const { copyFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.at(-1) !== "app:dev") {
  process.stderr.write("Error response from daemon: reference does not exist\\n");
  process.exit(1);
}
copyFileSync(${JSON.stringify(join(dir, "saved.tar"))}, args[args.indexOf("--output") + 1]);
`,
    );
    await chmod(script, 0o755);
    process.env.PATH = `${dir}${delimiter}${originalPath}`;
    await fn(dir);
  } finally {
    process.env.PATH = originalPath;
    await cleanup();
  }
}

/** Temporary directories this tool created and has not removed. */
async function leftovers() {
  return (await readdir(tmpdir())).filter(
    (name) => name.startsWith("layerdelta-") && !name.startsWith("layerdelta-test-"),
  );
}

test("docker-daemon: exports the image with docker image save and cleans up", async (t) => {
  if (process.platform === "win32") return t.skip("the stand-in docker is a shebang script");
  const before = await leftovers();
  await withFakeDocker(async () => {
    const img = await openImage("docker-daemon:app:dev", { platform });
    assert.equal(img.ref, "docker-daemon:app:dev");
    assert.equal(img.source, "docker-daemon");
    assert.equal(img.layers.length, 1);
    await img.close?.();
    await assert.rejects(
      openImage("docker-daemon:missing:tag", { platform }),
      /docker image save failed: Error response from daemon: reference does not exist/,
    );
  });
  assert.deepEqual(await leftovers(), before);
});

test("docker-daemon: explains a missing docker CLI and rejects option-like names", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(openImage("docker-daemon:app:dev", { platform }), /needs the docker CLI on PATH/);
  } finally {
    process.env.PATH = originalPath;
  }
  await assert.rejects(openImage("docker-daemon:--help", { platform }), /invalid image name/);
});
