import { formatBytes, formatCount, formatDelta } from "./units.js";

/**
 * @typedef {import("./diff.js").Comparison} Comparison
 * @typedef {{ limit: string, exceeded: boolean } | null} Budget
 * @typedef {{ green: (s: string) => string, red: (s: string) => string, dim: (s: string) => string, bold: (s: string) => string }} Style
 */

const PLAIN = { green: String, red: String, dim: String, bold: String };
/** @param {number} code */
const ansi = (code) => (/** @type {string} */ s) => `\x1b[${code}m${s}\x1b[0m`;
export const COLOR = { green: ansi(32), red: ansi(31), dim: ansi(2), bold: ansi(1) };

/** @param {number} before @param {number} delta */
function percent(before, delta) {
  if (before === 0) return "";
  const value = (delta / before) * 100;
  const text = Math.abs(value) < 0.05 ? "0.0" : value.toFixed(1);
  return ` (${value > 0 ? "+" : ""}${text}%)`;
}

/** @param {{ added: number, removed: number, resized: number }} counts */
function countText({ added, removed, resized }) {
  const parts = [];
  if (added) parts.push(`+${formatCount(added)}`);
  if (removed) parts.push(`-${formatCount(removed)}`);
  if (resized) parts.push(`~${formatCount(resized)}`);
  const total = added + removed + resized;
  return parts.length ? `${parts.join(" ")} ${total === 1 ? "file" : "files"}` : "";
}

/** @param {string[][]} rows @param {("l" | "r")[]} align */
function table(rows, align) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows.map((row) =>
    row
      .map((cell, col) => (align[col] === "r" ? cell.padStart(widths[col]) : cell.padEnd(widths[col])))
      .join("   ")
      .trimEnd(),
  );
}

/** @param {Comparison} c @returns {string[][]} */
function summaryRows(c) {
  const { before: b, after: a, delta: d } = c;
  const rows = [
    ["", "before", "after", "change"],
    ["size", formatBytes(b.size), formatBytes(a.size), `${formatDelta(d.size)}${percent(b.size, d.size)}`],
    ["wasted", formatBytes(b.wasted), formatBytes(a.wasted), formatDelta(d.wasted)],
  ];
  if (d.compressedSize !== null && b.compressedSize !== null && a.compressedSize !== null) {
    rows.push([
      "download",
      formatBytes(b.compressedSize),
      formatBytes(a.compressedSize),
      formatDelta(d.compressedSize),
    ]);
  }
  rows.push(
    ["files", formatCount(b.files), formatCount(a.files), countText(d) || "no change"],
    ["layers", String(b.layers.length), String(a.layers.length), `${c.sharedLayers} shared`],
  );
  return rows;
}

/** @param {Comparison} c @param {Style} style */
function treeLines(c, style) {
  if (c.tree.length === 0) return ["  No file sizes changed."];
  const deltas = c.tree.map((row) => formatDelta(row.delta));
  const width = Math.max(...deltas.map((d) => d.length));
  const names = c.tree.map((row) => `${"  ".repeat(row.depth)}${row.name}`);
  const nameWidth = Math.min(64, Math.max(...names.map((n) => n.length)));
  return c.tree.map((row, i) => {
    const delta = deltas[i].padStart(width);
    const colored = row.delta > 0 ? style.red(delta) : row.delta < 0 ? style.green(delta) : delta;
    const name = row.kind === "more" ? style.dim(names[i].padEnd(nameWidth)) : names[i].padEnd(nameWidth);
    return `  ${colored}  ${name}  ${style.dim(countText(row))}`.trimEnd();
  });
}

/** @param {string | null} command */
function shortCommand(command) {
  if (!command) return "(no history)";
  return command.length > 90 ? `${command.slice(0, 87)}...` : command;
}

/** @param {Comparison} c @param {number} index */
function layerCommand(c, index) {
  return shortCommand(c.after.layers[index - 1]?.createdBy ?? null);
}

/** Wasted groups and caches smaller than this are noise (package databases, small config rewrites). */
const MIN_WASTED = 1_000_000;
const MIN_CACHE = 1_000_000;

/** @param {Comparison} c @param {Budget} budget @param {Style} [style] */
export function renderText(c, budget, style = PLAIN) {
  const out = [];
  out.push(
    ...table(
      [
        ["before", c.before.ref, c.before.platform],
        ["after", c.after.ref, c.after.platform],
      ],
      ["l", "l", "l"],
    ),
    "",
  );
  out.push(...table(summaryRows(c), ["l", "r", "r", "r"]), "");
  out.push(style.bold("Where the size changed"), ...treeLines(c, style));

  const wasted = c.wasted.filter((w) => w.size >= MIN_WASTED).slice(0, 8);
  if (wasted.length) {
    out.push("", style.bold("Wasted in after: bytes kept in a layer but hidden by a later one"));
    const width = Math.max(...wasted.map((w) => formatBytes(w.size).length));
    for (const w of wasted) {
      const files = w.files === 1 ? "1 file" : `${formatCount(w.files)} files`;
      out.push(
        `  ${formatBytes(w.size).padStart(width)}  ${w.files === 1 ? w.path : `${w.path}/`}  ${style.dim(files)}`,
        style.dim(`  ${" ".repeat(width)}  ${"added".padEnd(8)} layer ${w.addedIn}  ${layerCommand(c, w.addedIn)}`),
        style.dim(`  ${" ".repeat(width)}  ${w.how.padEnd(8)} layer ${w.removedIn}  ${layerCommand(c, w.removedIn)}`),
      );
    }
  }

  const caches = c.caches.filter((cache) => cache.size >= MIN_CACHE);
  if (caches.length) {
    out.push("", style.bold("Caches left in after"));
    const width = Math.max(...caches.map((cache) => formatBytes(cache.size).length));
    for (const cache of caches) {
      const was = cache.before ? `was ${formatBytes(cache.before)}` : "new";
      out.push(`  ${formatBytes(cache.size).padStart(width)}  ${cache.path}/  ${style.dim(`${cache.label}, ${was}`)}`);
    }
  }

  const fresh = c.after.layers.filter((layer) => !layer.shared);
  if (fresh.length) {
    out.push("", style.bold(`Layers in after not shared with before (${fresh.length} of ${c.after.layers.length})`));
    const sizes = fresh.map((layer) => formatBytes(layer.size));
    const width = Math.max(...sizes.map((s) => s.length));
    const numberWidth = String(c.after.layers.length).length;
    fresh.forEach((layer, i) => {
      out.push(
        `  ${String(layer.index).padStart(numberWidth)}  ${sizes[i].padStart(width)}  ${shortCommand(layer.createdBy)}`,
      );
    });
  }

  if (budget) {
    out.push(
      "",
      budget.exceeded
        ? style.red(`Over budget: size grew by ${formatDelta(c.delta.size)}, more than ${budget.limit}.`)
        : `Within budget: size change ${formatDelta(c.delta.size)} is not more than ${budget.limit}.`,
    );
  }
  return `${out.join("\n")}\n`;
}

/** @param {string} text */
function code(text) {
  return `\`${text.replace(/`/g, "")}\``;
}

/** @param {Comparison} c @param {Budget} budget */
export function renderMarkdown(c, budget) {
  const out = [`### layerdelta: ${code(c.before.ref)} → ${code(c.after.ref)}`, ""];
  if (budget) {
    out.push(
      budget.exceeded
        ? `**Over budget:** size grew by ${formatDelta(c.delta.size)}, more than ${budget.limit}.`
        : `Within budget: size change ${formatDelta(c.delta.size)} is not more than ${budget.limit}.`,
      "",
    );
  }
  const rows = summaryRows(c);
  out.push(`| | ${rows[0].slice(1).join(" | ")} |`, "|---|---:|---:|---:|");
  for (const row of rows.slice(1)) out.push(`| ${row.join(" | ")} |`);
  out.push("", "**Where the size changed**", "", "```text", ...treeLines(c, PLAIN), "```");

  const wasted = c.wasted.filter((w) => w.size >= MIN_WASTED).slice(0, 8);
  if (wasted.length) {
    out.push("", "**Wasted in after** (bytes kept in a layer but hidden by a later one)", "");
    for (const w of wasted) {
      out.push(
        `- ${formatBytes(w.size)} in ${code(w.files === 1 ? w.path : `${w.path}/`)} (${w.files === 1 ? "1 file" : `${formatCount(w.files)} files`}): added by layer ${w.addedIn} (${code(layerCommand(c, w.addedIn))}), ${w.how} by layer ${w.removedIn} (${code(layerCommand(c, w.removedIn))})`,
      );
    }
  }
  const caches = c.caches.filter((cache) => cache.size >= MIN_CACHE);
  if (caches.length) {
    out.push("", "**Caches left in after**", "");
    for (const cache of caches) {
      const was = cache.before ? `was ${formatBytes(cache.before)}` : "new";
      out.push(`- ${formatBytes(cache.size)} in ${code(`${cache.path}/`)} (${cache.label}, ${was})`);
    }
  }
  out.push(
    "",
    `<sub>${c.after.platform} · ${c.sharedLayers} of ${c.after.layers.length} layers shared · sizes are file bytes in the final filesystem</sub>`,
  );
  return `${out.join("\n")}\n`;
}

/** @param {Comparison} c @param {Budget} budget */
export function renderJson(c, budget) {
  return `${JSON.stringify({ ...c, budget }, null, 2)}\n`;
}
