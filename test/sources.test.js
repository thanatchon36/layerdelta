import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readLayer } from "../src/layer.js";
import { openImage } from "../src/load.js";
import { parseReference } from "../src/sources/registry.js";
import { buildImage, ociManifest, sha256, tempDir, writeDockerArchive } from "./helpers.js";

const amd64 = { os: "linux", architecture: "amd64" };
const image = buildImage({
  layers: [[{ name: "etc/os-release", size: 100 }], [{ name: "app/main.js", size: 2000 }]],
  history: ["ADD rootfs.tar /", "COPY . /app"],
});
const arm = buildImage({ layers: [[{ name: "arm", size: 1 }]], architecture: "arm64" });

/** @param {import("../src/image.js").Image} img */
async function entries(img) {
  const out = [];
  for (const layer of img.layers)
    out.push(await readLayer(await layer.open(), layer.verify ? layer.digest : undefined));
  return out;
}

test("parseReference follows Docker's naming rules", () => {
  assert.deepEqual(parseReference("node"), {
    registry: "docker.io",
    repository: "library/node",
    reference: "latest",
    base: "https://registry-1.docker.io/v2/library/node",
  });
  assert.equal(parseReference("bitnami/redis:7").base, "https://registry-1.docker.io/v2/bitnami/redis");
  assert.equal(parseReference("ghcr.io/owner/app:1.2").base, "https://ghcr.io/v2/owner/app");
  assert.equal(parseReference("localhost:5000/app").base, "http://localhost:5000/v2/app");
  assert.equal(parseReference(`node@sha256:${"a".repeat(64)}`).reference, `sha256:${"a".repeat(64)}`);
  assert.equal(parseReference("docker://alpine:3").reference, "3");
  assert.throws(() => parseReference("Owner/App"), /lowercase/);
  assert.throws(() => parseReference("node:bad tag"), /invalid tag/);
});

test("reads a classic docker save archive", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const file = join(dir, "image.tar");
    await writeDockerArchive(image, file);
    const img = await openImage(file, { platform: amd64 });
    assert.equal(img.platform, "linux/amd64");
    assert.equal(img.source, "archive");
    assert.deepEqual(
      img.layers.map((l) => [l.diffId, l.createdBy]),
      [
        [image.layers[0].diffId, "ADD rootfs.tar /"],
        [image.layers[1].diffId, "COPY . /app"],
      ],
    );
    assert.deepEqual((await entries(img))[1], [{ path: "app/main.js", type: "file", size: 2000 }]);
    await img.close?.();
  } finally {
    await cleanup();
  }
});

/** Writes an OCI image layout directory holding a two-platform index. */
async function writeLayout(/** @type {string} */ dir) {
  await mkdir(join(dir, "blobs", "sha256"), { recursive: true });
  /** @param {Buffer} buf */
  const put = (buf) => writeFile(join(dir, "blobs", "sha256", sha256(buf).slice(7)), buf);
  const manifests = [];
  for (const [img, architecture] of /** @type {const} */ ([
    [image, "amd64"],
    [arm, "arm64"],
  ])) {
    const manifest = ociManifest(img);
    await Promise.all([put(manifest), put(img.config), ...img.layers.map((l) => put(l.blob))]);
    manifests.push({ digest: sha256(manifest), size: manifest.length, platform: { os: "linux", architecture } });
  }
  await writeFile(join(dir, "index.json"), JSON.stringify({ schemaVersion: 2, manifests }));
}

test("reads an OCI layout directory and picks the platform", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await writeLayout(dir);
    const img = await openImage(`oci:${dir}`, { platform: { os: "linux", architecture: "arm64" } });
    assert.equal(img.platform, "linux/arm64");
    assert.deepEqual((await entries(img))[0], [{ path: "arm", type: "file", size: 1 }]);
    await assert.rejects(
      openImage(`oci:${dir}`, { platform: { os: "linux", architecture: "s390x" } }),
      /available: linux\/amd64, linux\/arm64/,
    );
  } finally {
    await cleanup();
  }
});

test("explains what is wrong with paths that are not images", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    await assert.rejects(openImage(join(dir, "missing.tar"), { platform: amd64 }), /no such file/);
    await writeFile(join(dir, "junk.tar"), Buffer.alloc(2048, 1));
    await assert.rejects(openImage(join(dir, "junk.tar"), { platform: amd64 }), /not a tar archive/);
    await assert.rejects(openImage(`${dir}/`, { platform: amd64 }), /neither a docker save archive/);
  } finally {
    await cleanup();
  }
});

/** A tiny OCI distribution registry with Docker Hub-style anonymous bearer tokens. */
let server;
let registry = "";
const requests = /** @type {string[]} */ ([]);
before(async () => {
  const blobs = new Map();
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: /** @type {any[]} */ ([]),
  };
  for (const [img, architecture] of /** @type {const} */ ([
    [image, "amd64"],
    [arm, "arm64"],
  ])) {
    const manifest = ociManifest(img);
    blobs.set(sha256(manifest), manifest);
    blobs.set(img.configDigest, img.config);
    for (const layer of img.layers) blobs.set(layer.digest, layer.blob);
    index.manifests.push({ digest: sha256(manifest), size: manifest.length, platform: { os: "linux", architecture } });
  }
  index.manifests.push({ digest: "sha256:attestation", platform: { os: "unknown", architecture: "unknown" } });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(url.pathname);
    if (url.pathname === "/token") {
      res.end(
        JSON.stringify({ token: url.searchParams.get("scope") === "repository:team/app:pull" ? "anon" : "other" }),
      );
      return;
    }
    if (req.headers.authorization !== "Bearer anon") {
      res.writeHead(401, {
        "www-authenticate": `Bearer realm="http://${registry}/token",service="test",scope="repository:team/app:pull"`,
      });
      res.end();
      return;
    }
    const manifest = /^\/v2\/team\/app\/manifests\/(.+)$/.exec(url.pathname);
    if (manifest) {
      const body = manifest[1] === "v1" ? Buffer.from(JSON.stringify(index)) : blobs.get(manifest[1]);
      if (!body) return void res.writeHead(404).end();
      res.end(body);
      return;
    }
    const blob = /^\/v2\/team\/app\/blobs\/(.+)$/.exec(url.pathname);
    const body = blob && blobs.get(blob[1]);
    if (!body) return void res.writeHead(404).end();
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  registry = `127.0.0.1:${address.port}`;
});
after(() => server.close());

test("pulls from a registry with an anonymous token, selecting the platform from the index", async () => {
  const img = await openImage(`${registry}/team/app:v1`, { platform: amd64 });
  assert.equal(img.source, "registry");
  assert.equal(img.platform, "linux/amd64");
  assert.deepEqual(
    img.layers.map((l) => l.compressedSize),
    image.layers.map((l) => l.blob.length),
  );
  const [, app] = await entries(img);
  assert.deepEqual(app, [{ path: "app/main.js", type: "file", size: 2000 }]);
  assert.ok(requests.includes("/token"));
});

test("registry errors are specific", async () => {
  await assert.rejects(openImage(`${registry}/team/app:nope`, { platform: amd64 }), /not found/);
  await assert.rejects(
    openImage(`${registry}/team/app:v1`, { platform: { os: "linux", architecture: "riscv64" } }),
    /available: linux\/amd64, linux\/arm64\); use --platform/,
  );
});
