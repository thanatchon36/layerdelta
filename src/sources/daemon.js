// Reads an image from the local Docker daemon by exporting it with `docker image save` into a
// temporary file, which is removed when the comparison is done.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "./archive.js";

/** @typedef {import("../image.js").Image} Image @typedef {import("../image.js").Platform} Platform */

/** @param {string[]} args */
function docker(args) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve(undefined);
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return reject(new Error("docker-daemon: needs the docker CLI on PATH"));
      }
      reject(new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || error.message}`));
    });
  });
}

/**
 * @param {string} name image name as Docker knows it, e.g. "myapp:dev"
 * @param {{ platform: Platform }} options
 * @returns {Promise<Image>}
 */
export async function openDaemon(name, { platform }) {
  if (!name || name.startsWith("-")) throw new Error(`invalid image name after docker-daemon: "${name}"`);
  const dir = await mkdtemp(join(tmpdir(), "layerdelta-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const file = join(dir, "image.tar");
    await docker(["image", "save", "--output", file, name]);
    const image = await openArchive(file, { platform, ref: `docker-daemon:${name}`, source: "docker-daemon" });
    return {
      ...image,
      close: async () => {
        await image.close?.();
        await cleanup();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
