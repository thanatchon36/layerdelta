// Applies image layers in order, the way a container runtime does, and keeps track of bytes that
// are still shipped in a lower layer but hidden by a later one ("wasted").

/**
 * @typedef {import("./layer.js").LayerEntry} LayerEntry
 * @typedef {{ type: import("./tar.js").EntryType, size: number, layer: number }} FileInfo
 * @typedef {{ info: FileInfo, children: Map<string, Node> | null }} Node
 * @typedef {{ path: string, size: number, addedIn: number, removedIn: number, how: "deleted" | "replaced" }} Wasted
 * @typedef {{ files: Map<string, FileInfo>, wasted: Wasted[], layerSizes: number[] }} Filesystem
 */

const WHITEOUT = ".wh.";
const OPAQUE = ".wh..wh..opq";

/** @param {number} layer @returns {Node} */
function dirNode(layer) {
  return { info: { type: "dir", size: 0, layer }, children: new Map() };
}

/** @param {string} path */
function split(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? ["", path] : [path.slice(0, slash), path.slice(slash + 1)];
}

/** @param {LayerEntry[][]} layers @returns {Filesystem} */
export function buildFilesystem(layers) {
  const root = dirNode(-1);
  /** @type {Wasted[]} */
  const wasted = [];

  /**
   * Records every file under `node` as wasted and forgets it.
   * @param {Node} node @param {string} path @param {number} layer @param {"deleted" | "replaced"} how
   */
  const discard = (node, path, layer, how) => {
    if (node.children) {
      for (const [name, child] of node.children) discard(child, `${path}/${name}`, layer, how);
    } else if (node.info.size > 0) {
      wasted.push({ path, size: node.info.size, addedIn: node.info.layer, removedIn: layer, how });
    }
  };

  /**
   * Finds the directory node for `path`. With a layer index, missing directories are created and
   * non-directories in the way are replaced, as extracting a layer would do.
   * @param {string} path @param {number} [layer] @returns {Node | null}
   */
  const directory = (path, layer) => {
    let node = root;
    if (path === "") return node;
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      const children = /** @type {Map<string, Node>} */ (node.children);
      let next = children.get(part);
      if (!next || !next.children) {
        if (layer === undefined) return null;
        if (next) discard(next, current, layer, "replaced");
        next = dirNode(layer);
        children.set(part, next);
      }
      node = next;
    }
    return node;
  };

  layers.forEach((entries, layer) => {
    // Whiteouts only hide content from lower layers, so apply them before this layer's own files
    // regardless of where they appear in the tar stream.
    for (const { path } of entries) {
      const [parent, name] = split(path);
      if (!name.startsWith(WHITEOUT)) continue;
      const dir = directory(parent);
      if (!dir?.children) continue;
      if (name === OPAQUE) {
        for (const [child, node] of dir.children) discard(node, parent ? `${parent}/${child}` : child, layer, "deleted");
        dir.children.clear();
      } else {
        const target = name.slice(WHITEOUT.length);
        const node = dir.children.get(target);
        if (node) {
          discard(node, parent ? `${parent}/${target}` : target, layer, "deleted");
          dir.children.delete(target);
        }
      }
    }
    for (const entry of entries) {
      const [parent, name] = split(entry.path);
      if (name.startsWith(WHITEOUT)) continue;
      const dir = /** @type {Node} */ (directory(parent, layer));
      const children = /** @type {Map<string, Node>} */ (dir.children);
      const existing = children.get(name);
      if (entry.type === "dir") {
        if (existing?.children) continue;
        if (existing) discard(existing, entry.path, layer, "replaced");
        children.set(name, dirNode(layer));
      } else {
        if (existing) discard(existing, entry.path, layer, "replaced");
        children.set(name, { info: { type: entry.type, size: entry.size, layer }, children: null });
      }
    }
  });

  /** @type {Map<string, FileInfo>} */
  const files = new Map();
  /** @param {Node} node @param {string} path */
  const collect = (node, path) => {
    if (!node.children) {
      files.set(path, node.info);
      return;
    }
    for (const [name, child] of node.children) collect(child, path ? `${path}/${name}` : name);
  };
  collect(root, "");

  const layerSizes = layers.map((entries) => entries.reduce((sum, entry) => sum + entry.size, 0));
  return { files, wasted, layerSizes };
}

/** Directories where package managers and tools leave caches that rarely belong in an image. */
const CACHE_PATTERNS = [
  { pattern: /^var\/cache\/apt\/archives\//, label: "apt package archives" },
  { pattern: /^var\/lib\/apt\/lists\//, label: "apt package lists" },
  { pattern: /^var\/cache\/apk\//, label: "apk cache" },
  { pattern: /^var\/cache\/(yum|dnf)\//, label: "yum/dnf cache" },
  { pattern: /^(root|home\/[^/]+)\/\.cache\/pip\//, label: "pip cache" },
  { pattern: /^(root|home\/[^/]+)\/\.cache\/uv\//, label: "uv cache" },
  { pattern: /^(root|home\/[^/]+)\/\.npm\/_cacache\//, label: "npm cache" },
  { pattern: /^(usr\/local\/share\/\.cache\/yarn|(root|home\/[^/]+)\/\.cache\/yarn)\//, label: "yarn cache" },
  { pattern: /^(root|home\/[^/]+)\/\.cache\/go-build\//, label: "Go build cache" },
  { pattern: /^tmp\//, label: "files in /tmp" },
];

/**
 * Totals the bytes in well-known cache locations.
 * @param {Map<string, FileInfo>} files
 * @returns {{ label: string, path: string, size: number, files: number }[]}
 */
export function findCaches(files) {
  /** @type {Map<string, { label: string, path: string, size: number, files: number }>} */
  const found = new Map();
  for (const [path, info] of files) {
    if (info.type !== "file") continue;
    for (const { pattern, label } of CACHE_PATTERNS) {
      const match = pattern.exec(path);
      if (!match) continue;
      const prefix = match[0].replace(/\/$/, "");
      const key = `${label}\0${prefix}`;
      const item = found.get(key) ?? { label, path: prefix, size: 0, files: 0 };
      item.size += info.size;
      item.files += 1;
      found.set(key, item);
      break;
    }
  }
  return [...found.values()].sort((a, b) => b.size - a.size);
}
