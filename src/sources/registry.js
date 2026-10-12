// Pulls public images straight from an OCI distribution registry (Docker Hub, GHCR, Quay, ECR
// Public, ...) with anonymous tokens. Layers are streamed and never written to disk.
import { Readable } from "node:stream";
import { diffIds, formatPlatform, layerCommands, selectPlatform } from "../image.js";

/** @typedef {import("../image.js").Image} Image @typedef {import("../image.js").Platform} Platform */

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

/**
 * Splits an image reference the way Docker does: "node" is docker.io/library/node:latest, and
 * the first component is a registry host only if it contains "." or ":" or is "localhost".
 * @param {string} input
 */
export function parseReference(input) {
  const ref = input.replace(/^docker:\/\//, "");
  const at = ref.indexOf("@");
  const digest = at === -1 ? null : ref.slice(at + 1);
  let name = at === -1 ? ref : ref.slice(0, at);
  let tag = null;
  const colon = name.lastIndexOf(":");
  if (colon > name.lastIndexOf("/")) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
  }
  const parts = name.split("/");
  let registry = "docker.io";
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) {
    registry = /** @type {string} */ (parts.shift());
  }
  if (registry === "docker.io" && parts.length === 1) parts.unshift("library");
  const repository = parts.join("/");
  if (!parts.every((part) => PATH_COMPONENT.test(part))) {
    throw new Error(`invalid image reference "${input}": repository names are lowercase, e.g. ghcr.io/owner/app:1.2`);
  }
  if (tag !== null && !/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error(`invalid tag in "${input}"`);
  if (digest !== null && !/^sha(256|512):[a-f0-9]{64,128}$/.test(digest))
    throw new Error(`invalid digest in "${input}"`);
  const host = registry === "docker.io" ? "registry-1.docker.io" : registry;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return {
    registry,
    repository,
    reference: digest ?? tag ?? "latest",
    base: `${local ? "http" : "https"}://${host}/v2/${repository}`,
  };
}

/** @param {string} header */
function parseChallenge(header) {
  const match = /^Bearer\s+(.*)$/i.exec(header);
  if (!match) return null;
  /** @type {Record<string, string>} */
  const params = {};
  for (const [, key, value] of match[1].matchAll(/(\w+)="([^"]*)"/g)) params[key] = value;
  return params.realm ? params : null;
}

class RegistryClient {
  /** @param {ReturnType<typeof parseReference>} ref @param {string} display */
  constructor(ref, display) {
    this.ref = ref;
    this.display = display;
    /** @type {string | null} */
    this.token = null;
  }

  /** @param {string} url @param {Record<string, string>} headers @param {AbortSignal} [signal] */
  async request(url, headers = {}, signal) {
    const send = () =>
      fetch(url, {
        headers: this.token ? { ...headers, authorization: `Bearer ${this.token}` } : headers,
        signal,
      });
    let response = await send();
    if (response.status === 401 && !this.token) {
      const challenge = parseChallenge(response.headers.get("www-authenticate") ?? "");
      await response.body?.cancel();
      if (challenge) {
        this.token = await this.fetchToken(challenge);
        response = await send();
      }
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new Error(
        `${this.display}: the registry requires credentials. layerdelta pulls public images anonymously; ` +
          `for private images run "docker pull ${this.display}" and pass "docker-daemon:${this.display}"`,
      );
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new Error(`${this.display}: not found in ${this.ref.registry}`);
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new Error(`${this.ref.registry} rate limit reached (HTTP 429); try again later`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${this.display}: ${this.ref.registry} answered HTTP ${response.status} for ${url}`);
    }
    return response;
  }

  /** @param {Record<string, string>} challenge */
  async fetchToken(challenge) {
    const url = new URL(challenge.realm);
    if (challenge.service) url.searchParams.set("service", challenge.service);
    url.searchParams.set("scope", challenge.scope ?? `repository:${this.ref.repository}:pull`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${this.display}: could not get an anonymous token from ${url.host} (HTTP ${response.status})`);
    }
    const body = /** @type {{ token?: string, access_token?: string }} */ (await response.json());
    const token = body.token ?? body.access_token;
    if (!token) throw new Error(`${this.display}: token response from ${url.host} has no token`);
    return token;
  }

  /** @param {string} reference */
  async manifest(reference) {
    const response = await this.request(
      `${this.ref.base}/manifests/${reference}`,
      { accept: MANIFEST_TYPES },
      AbortSignal.timeout(30_000),
    );
    return /** @type {any} */ (await response.json());
  }

  /** @param {string} digest */
  async blobJson(digest) {
    const response = await this.request(`${this.ref.base}/blobs/${digest}`, {}, AbortSignal.timeout(60_000));
    return /** @type {any} */ (await response.json());
  }

  /** @param {string} digest @returns {Promise<AsyncIterable<Buffer>>} */
  async blobStream(digest) {
    const response = await this.request(`${this.ref.base}/blobs/${digest}`);
    if (!response.body) throw new Error(`${this.display}: empty response for ${digest}`);
    return Readable.fromWeb(/** @type {import("node:stream/web").ReadableStream<Uint8Array>} */ (response.body));
  }
}

/**
 * @param {string} input
 * @param {{ platform: Platform }} options
 * @returns {Promise<Image>}
 */
export async function openRegistry(input, { platform }) {
  const display = input.replace(/^docker:\/\//, "");
  const client = new RegistryClient(parseReference(input), display);
  let manifest = await client.manifest(client.ref.reference);
  if (Array.isArray(manifest.manifests)) {
    const chosen = selectPlatform(
      /** @type {{ digest: string, platform?: any }[]} */ (manifest.manifests),
      platform,
      display,
    );
    manifest = await client.manifest(chosen.digest);
  }
  if (!manifest.config?.digest || !Array.isArray(manifest.layers)) {
    throw new Error(`${display}: unsupported manifest (schema ${manifest.schemaVersion ?? "?"})`);
  }
  const config = await client.blobJson(manifest.config.digest);
  const layers = /** @type {{ digest: string, size?: number }[]} */ (manifest.layers);
  const ids = diffIds(config);
  const commands = layerCommands(config, layers.length);
  return {
    ref: display,
    source: "registry",
    platform: formatPlatform(config),
    layers: layers.map((layer, i) => ({
      digest: layer.digest,
      diffId: ids[i] ?? null,
      compressedSize: typeof layer.size === "number" ? layer.size : null,
      createdBy: commands[i],
      verify: true,
      open: () => client.blobStream(layer.digest),
    })),
  };
}
