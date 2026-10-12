// Turns two layered filesystems into the numbers and the short tree that explain the change.
import { findCaches } from "./filesystem.js";

/**
 * @typedef {import("./image.js").Image} Image
 * @typedef {import("./filesystem.js").Filesystem} Filesystem
 * @typedef {{ name: string, file: boolean, net: number, churn: number, added: number, removed: number,
 *   resized: number, children: Map<string, TreeNode> }} TreeNode
 * @typedef {{ depth: number, path: string, name: string, kind: "dir" | "file" | "more", delta: number,
 *   added: number, removed: number, resized: number }} TreeRow
 */

const TREE = { maxChildren: 5, maxDepth: 5, maxRows: 30, minShare: 0.01, expandShare: 0.1 };

/** @param {string} name @param {boolean} file @returns {TreeNode} */
function node(name, file) {
  return { name, file, net: 0, churn: 0, added: 0, removed: 0, resized: 0, children: new Map() };
}

/**
 * Picks the rows worth showing: children that carry at least 1% of all changed bytes, biggest
 * first; only directories carrying 10% are expanded further. Chains like
 * usr/local/lib/python3.12 collapse into one row when nothing else under them changed.
 * @param {TreeNode} root
 * @returns {TreeRow[]}
 */
export function selectRows(root) {
  /** @type {TreeRow[]} */
  const rows = [];
  const threshold = Math.max(1, root.churn * TREE.minShare);
  const expand = Math.max(1, root.churn * TREE.expandShare);
  /** @param {TreeNode} parent @param {string} parentPath @param {number} depth */
  const walk = (parent, parentPath, depth) => {
    const children = [...parent.children.values()].sort((a, b) => b.churn - a.churn || (a.name < b.name ? -1 : 1));
    const shown = children.filter((child) => child.churn >= threshold).slice(0, TREE.maxChildren);
    for (const child of shown) {
      if (rows.length >= TREE.maxRows) return;
      let current = child;
      let name = child.name;
      while (!current.file) {
        const changed = [...current.children.values()].filter((c) => c.churn > 0);
        if (changed.length !== 1 || changed[0].churn !== current.churn) break;
        current = changed[0];
        name = `${name}/${current.name}`;
      }
      const path = parentPath ? `${parentPath}/${name}` : name;
      rows.push({
        depth,
        path,
        name: current.file ? name : `${name}/`,
        kind: current.file ? "file" : "dir",
        delta: current.net,
        added: current.added,
        removed: current.removed,
        resized: current.resized,
      });
      if (!current.file && current.churn >= expand && depth + 1 < TREE.maxDepth) walk(current, path, depth + 1);
    }
    const rest = children.slice(shown.length).filter((child) => child.churn > 0);
    const restChurn = rest.reduce((total, child) => total + child.churn, 0);
    if (rest.length && restChurn >= threshold && rows.length < TREE.maxRows) {
      const sum = (/** @type {"net" | "added" | "removed" | "resized"} */ key) =>
        rest.reduce((total, child) => total + child[key], 0);
      rows.push({
        depth,
        path: parentPath,
        name: `${rest.length} more`,
        kind: "more",
        delta: sum("net"),
        added: sum("added"),
        removed: sum("removed"),
        resized: sum("resized"),
      });
    }
  };
  walk(root, "", 0);
  return rows;
}

/** @param {string[]} paths */
function commonDirectory(paths) {
  let common = paths[0].split("/").slice(0, -1);
  for (const path of paths.slice(1)) {
    const parts = path.split("/");
    let i = 0;
    while (i < common.length && i < parts.length - 1 && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common.join("/");
}

/**
 * Groups hidden bytes by the pair of layers involved and the top two path components, so one
 * `RUN rm -rf` that cleans two places shows up as two readable lines.
 * @param {Filesystem} fs
 */
function groupWasted(fs) {
  /** @type {Map<string, { paths: string[], size: number, addedIn: number, removedIn: number, how: string }>} */
  const groups = new Map();
  for (const item of fs.wasted) {
    const top = item.path.split("/").slice(0, 2).join("/");
    const key = `${item.addedIn}\0${item.removedIn}\0${item.how}\0${top}`;
    const group = groups.get(key) ?? {
      paths: [],
      size: 0,
      addedIn: item.addedIn,
      removedIn: item.removedIn,
      how: item.how,
    };
    group.paths.push(item.path);
    group.size += item.size;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ paths, ...rest }) => ({
      path: paths.length === 1 ? paths[0] : commonDirectory(paths) || "/",
      files: paths.length,
      ...rest,
    }))
    .sort((a, b) => b.size - a.size);
}

/** @param {Image["layers"][number]} layer */
function layerKey(layer) {
  return layer.diffId ?? layer.digest;
}

/** @param {Image} image @param {Filesystem} fs @param {number} shared */
function summarize(image, fs, shared) {
  let size = 0;
  let files = 0;
  for (const info of fs.files.values()) {
    if (info.type !== "file") continue;
    size += info.size;
    files += 1;
  }
  const compressed = image.layers.map((layer) => layer.compressedSize);
  return {
    ref: image.ref,
    source: image.source,
    platform: image.platform,
    size,
    files,
    wasted: fs.wasted.reduce((sum, item) => sum + item.size, 0),
    compressedSize: compressed.every((value) => value !== null) ? compressed.reduce((a, b) => a + (b ?? 0), 0) : null,
    layers: image.layers.map((layer, index) => ({
      index: index + 1,
      digest: layer.digest,
      size: fs.layerSizes[index],
      compressedSize: layer.compressedSize,
      createdBy: layer.createdBy,
      shared: index < shared,
    })),
  };
}

/**
 * @param {{ image: Image, fs: Filesystem }} before
 * @param {{ image: Image, fs: Filesystem }} after
 */
export function compare(before, after) {
  let shared = 0;
  while (
    shared < before.image.layers.length &&
    shared < after.image.layers.length &&
    layerKey(before.image.layers[shared]) === layerKey(after.image.layers[shared])
  ) {
    shared++;
  }

  const root = node("", false);
  /** @type {{ path: string, before: number | null, after: number | null, delta: number }[]} */
  const changed = [];
  /** @param {string} path @param {number | null} a @param {number | null} b */
  const record = (path, a, b) => {
    const delta = (b ?? 0) - (a ?? 0);
    const kind = a === null ? "added" : b === null ? "removed" : delta !== 0 ? "resized" : null;
    if (!kind) return;
    changed.push({ path, before: a, after: b, delta });
    let current = root;
    const parts = path.split("/");
    const apply = (/** @type {TreeNode} */ target) => {
      target.net += delta;
      target.churn += Math.abs(delta);
      target[kind] += 1;
    };
    apply(root);
    parts.forEach((part, i) => {
      let next = current.children.get(part);
      if (!next) {
        next = node(part, i === parts.length - 1);
        current.children.set(part, next);
      }
      // A path can be a file in one image and a directory in the other.
      if (i < parts.length - 1) next.file = false;
      apply(next);
      current = next;
    });
  };
  /** @param {Filesystem} fs */
  const regularFiles = (fs) => {
    /** @type {Map<string, number>} */
    const out = new Map();
    for (const [path, info] of fs.files) if (info.type === "file") out.set(path, info.size);
    return out;
  };
  const a = regularFiles(before.fs);
  const b = regularFiles(after.fs);
  for (const [path, size] of a) record(path, size, b.get(path) ?? null);
  for (const [path, size] of b) if (!a.has(path)) record(path, null, size);

  const beforeSummary = summarize(before.image, before.fs, shared);
  const afterSummary = summarize(after.image, after.fs, shared);
  const beforeCaches = new Map(findCaches(before.fs.files).map((c) => [c.path, c.size]));
  return {
    before: beforeSummary,
    after: afterSummary,
    sharedLayers: shared,
    delta: {
      size: afterSummary.size - beforeSummary.size,
      wasted: afterSummary.wasted - beforeSummary.wasted,
      compressedSize:
        afterSummary.compressedSize !== null && beforeSummary.compressedSize !== null
          ? afterSummary.compressedSize - beforeSummary.compressedSize
          : null,
      added: root.added,
      removed: root.removed,
      resized: root.resized,
    },
    tree: selectRows(root),
    files: changed.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || (x.path < y.path ? -1 : 1)).slice(0, 50),
    wasted: groupWasted(after.fs).map((group) => ({
      ...group,
      addedIn: group.addedIn + 1,
      removedIn: group.removedIn + 1,
      // Both layers are shared, so before ships the same hidden bytes.
      inherited: group.removedIn < shared,
    })),
    caches: findCaches(after.fs.files).map((cache) => ({ ...cache, before: beforeCaches.get(cache.path) ?? 0 })),
  };
}

/** @typedef {ReturnType<typeof compare>} Comparison */
