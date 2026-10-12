import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes, formatDelta, parseBudget } from "../src/units.js";

test("formats sizes in decimal units like docker images", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1000), "1.0 kB");
  assert.equal(formatBytes(123_456_789), "123.5 MB");
  assert.equal(formatBytes(-2_500_000_000), "-2.5 GB");
  assert.equal(formatDelta(1500), "+1.5 kB");
  assert.equal(formatDelta(-1500), "-1.5 kB");
  assert.equal(formatDelta(0), "0 B");
});

test("parses budgets", () => {
  assert.deepEqual(parseBudget("50MB"), { bytes: 50_000_000 });
  assert.deepEqual(parseBudget("1.5 GiB"), { bytes: 1_610_612_736 });
  assert.deepEqual(parseBudget("200000"), { bytes: 200_000 });
  assert.deepEqual(parseBudget("10%"), { percent: 10 });
  assert.deepEqual(parseBudget("2kb"), { bytes: 2000 });
  assert.throws(() => parseBudget("-5MB"), /invalid size/);
  assert.throws(() => parseBudget("5 parsecs"), /invalid size/);
});
