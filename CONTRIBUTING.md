# Contributing

Thanks for helping. Bug reports, confusing output, and images that layerdelta reads wrongly are
all welcome.

## Reporting a problem

The most useful report contains the two image references you compared (or, for private images,
the `--format json` output), the command you ran, what layerdelta printed, and what you expected.
If a public image fails to load, include the full error message: it names the registry and the
HTTP status.

## Development

You need Node.js 22.15 or newer (the repository pins 22 in `.nvmrc`). Docker is optional; the
tests use a stand-in `docker` executable and a local registry server.

```sh
npm ci          # install exact dev dependency versions from package-lock.json
npm test        # node:test, runs in about a second
npm run lint    # Biome (lint + format check) and TypeScript checking of the JSDoc types
node bin/layerdelta.js node:22-slim node:24-slim   # try it against Docker Hub
```

`npx biome format --write .` fixes formatting. There is no build step: the published code is the
code in `bin/` and `src/`, written as plain ES modules with JSDoc types. layerdelta has no runtime
dependencies, and new ones need a strong reason.

Tests build real tar archives, gzip layers, `docker save` archives, and OCI layouts in a
temporary directory (see `test/helpers.js`) instead of checking in binary fixtures.

## Layout

| File | What it does |
| --- | --- |
| `src/tar.js` | Streaming tar reader (ustar, pax, GNU long names) that skips file contents |
| `src/layer.js` | Detects gzip/zstd/plain layers, verifies digests, lists entries |
| `src/filesystem.js` | Applies layers in order with whiteouts; records wasted bytes; finds caches |
| `src/sources/registry.js` | OCI distribution client with anonymous bearer tokens |
| `src/sources/archive.js` | `docker save` archives and OCI layouts, as tar files or directories |
| `src/sources/daemon.js` | `docker-daemon:` via `docker image save` |
| `src/load.js` | Picks a source per argument and reads each distinct layer once |
| `src/diff.js` | Compares two filesystems and selects the rows of the tree |
| `src/report.js` | Text, Markdown, and JSON output |
| `src/cli.js` | Argument parsing and exit codes |

## Pull requests

Keep changes focused, add a test that fails without the change, and run `npm test` and
`npm run lint` before pushing. Output changes should update the README example by rerunning it.
By contributing you agree that your contributions are licensed under the MIT license.
