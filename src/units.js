// Sizes use decimal units (1 MB = 1,000,000 bytes), matching `docker images`.

const UNITS = ["B", "kB", "MB", "GB", "TB"];

/** @param {number} bytes */
export function formatBytes(bytes) {
  const abs = Math.abs(bytes);
  let unit = 0;
  let value = abs;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const text = unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
  return bytes < 0 ? `-${text}` : text;
}

/** @param {number} bytes */
export function formatDelta(bytes) {
  return bytes > 0 ? `+${formatBytes(bytes)}` : formatBytes(bytes);
}

/** @param {number} value */
export function formatCount(value) {
  return value.toLocaleString("en-US");
}

const MULTIPLIERS = /** @type {Record<string, number>} */ ({
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
});

/**
 * Parses a budget such as "50MB", "1.5 GiB", "200000", or "10%".
 * @param {string} text
 * @returns {{ bytes: number } | { percent: number }}
 */
export function parseBudget(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(%|[kmg]i?b|b)?\s*$/i.exec(text);
  if (!match) throw new Error(`invalid size "${text}": use a number with an optional unit, e.g. 50MB, 1GiB, or 10%`);
  const value = Number(match[1]);
  const unit = (match[2] ?? "b").toLowerCase();
  if (unit === "%") return { percent: value };
  return { bytes: Math.round(value * MULTIPLIERS[unit]) };
}
