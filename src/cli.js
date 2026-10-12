import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { compare } from "./diff.js";
import { DEFAULT_PLATFORM } from "./image.js";
import { loadPair } from "./load.js";
import { COLOR, renderJson, renderMarkdown, renderText } from "./report.js";
import { formatBytes, parseBudget } from "./units.js";

const HELP = `Usage: layerdelta [options] <before> <after>

Compare two container images and show which files and directories changed their size.

Images:
  node:22-slim, ghcr.io/owner/app:1.2   public image, pulled from its registry (no Docker needed)
  docker-daemon:myapp:dev               image in the local Docker daemon
  ./image.tar, oci:./layout             docker save archive or OCI layout (file or directory)

Options:
  --platform <os/arch>   platform to pick from multi-platform images (default: ${DEFAULT_PLATFORM})
  --format <format>      text (default), markdown, or json
  --fail-over <size>     exit with status 1 if the size grew by more than this: 50MB, 1GiB, 10%
  -h, --help             show this help
  -v, --version          show the version

Exit status: 0 on success, 1 when --fail-over is exceeded, 2 on errors.
`;

/**
 * @param {string[]} argv
 * @param {{ stdout: NodeJS.WritableStream & { isTTY?: boolean }, stderr: NodeJS.WritableStream & { isTTY?: boolean }, env: NodeJS.ProcessEnv }} io
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { stdout, stderr, env }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        platform: { type: "string", default: DEFAULT_PLATFORM },
        format: { type: "string", default: "text" },
        "fail-over": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    stderr.write(`layerdelta: ${/** @type {Error} */ (error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (positionals.length !== 2) {
    stderr.write(`layerdelta: expected two images, got ${positionals.length}\n\n${HELP}`);
    return 2;
  }
  if (!["text", "markdown", "json"].includes(values.format)) {
    stderr.write(`layerdelta: --format must be text, markdown, or json (got "${values.format}")\n`);
    return 2;
  }

  try {
    const budget = values["fail-over"] === undefined ? null : parseBudget(values["fail-over"]);
    const progress = stderr.isTTY
      ? (/** @type {number} */ done, /** @type {number} */ total) =>
          stderr.write(`\rreading layers ${done}/${total}${done === total ? "\r\x1b[K" : ""}`)
      : undefined;
    const pair = await loadPair(positionals[0], positionals[1], { platform: values.platform, onProgress: progress });
    const result = compare(pair.before, pair.after);

    let budgetResult = null;
    if (budget) {
      const limit = "bytes" in budget ? budget.bytes : (result.before.size * budget.percent) / 100;
      budgetResult = {
        limit: "bytes" in budget ? formatBytes(budget.bytes) : `${budget.percent}% (${formatBytes(limit)})`,
        exceeded: result.delta.size > limit,
      };
    }
    const useColor = Boolean(stdout.isTTY) && !env.NO_COLOR;
    const output =
      values.format === "json"
        ? renderJson(result, budgetResult)
        : values.format === "markdown"
          ? renderMarkdown(result, budgetResult)
          : renderText(result, budgetResult, useColor ? COLOR : undefined);
    stdout.write(output);
    return budgetResult?.exceeded ? 1 : 0;
  } catch (error) {
    stderr.write(`layerdelta: ${/** @type {Error} */ (error).message}\n`);
    return 2;
  }
}
