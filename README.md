# layerdelta

[![ci](https://github.com/thanatchon36/layerdelta/actions/workflows/ci.yml/badge.svg)](https://github.com/thanatchon36/layerdelta/actions/workflows/ci.yml)

Your image was 126 MB last week and is 301 MB today. `docker history` tells you that the
`pip install` layer is big, but not what is in it. layerdelta compares two container images file
by file and shows which directories and files account for the difference. It also lists the bytes
the image still ships even though a later layer deleted them.

```sh
npx github:thanatchon36/layerdelta node:22-slim node:24-slim
```

That pulls both images straight from Docker Hub, with no Docker daemon needed, and compares them.
For your own images, pass `docker-daemon:myapp:old docker-daemon:myapp:new`, or two
`docker save` archives. You need Node.js 22.15 or newer. layerdelta has no runtime dependencies,
and the only network requests it makes are to the registries of the images you name.

## Example

[`examples/report-service`](examples/report-service) is a small Python service. Version 2 adds
pandas for a CSV export, installs curl, and cleans the pip cache in a separate `RUN`. To reproduce
this output from a clone of this repository (exact sizes change as the base image is updated):

```sh
cd examples/report-service
docker build --platform linux/amd64 -f Dockerfile.v1 -t layerdelta-example:v1 .
docker build --platform linux/amd64 -f Dockerfile.v2 -t layerdelta-example:v2 .
cd ../.. && node bin/layerdelta.js docker-daemon:layerdelta-example:v1 docker-daemon:layerdelta-example:v2
```

```text
before   docker-daemon:layerdelta-example:v1   linux/amd64
after    docker-daemon:layerdelta-example:v2   linux/amd64

           before      after                change
size     126.2 MB   301.5 MB   +175.4 MB (+139.0%)
wasted     3.5 MB    36.3 MB              +32.7 MB
files       5,134     10,890      +5,756 ~10 files
layers          8         10              5 shared

Where the size changed
  +153.8 MB  usr/                                          +5,648 files
  +141.6 MB    local/                                      +5,597 files
  +141.6 MB      lib/python3.13/site-packages/             +5,595 files
   +70.5 MB        pandas/                                 +2,923 files
   +32.3 MB          tests/                                +2,232 files
   +22.5 MB          _libs/                                +91 files
   +10.9 MB          core/                                 +358 files
    +3.3 MB          io/                                   +119 files
   +40.5 MB        numpy/                                  +1,309 files
   +22.9 MB          _core/                                +295 files
    +4.2 MB          random/                               +79 files
    +4.1 MB          lib/                                  +155 files
    +2.0 MB          ma/                                   +36 files
    +7.3 MB          45 more                               +743 files
   +27.5 MB        numpy.libs/                             +3 files
   +24.3 MB          libscipy_openblas64_-f48b354e.so      +1 file
    +2.9 MB          libgfortran-83c28eba-468e71e5.so.5.0.0  +1 file
    +3.1 MB        11 more                                 +1,360 files
   +11.2 MB    lib/x86_64-linux-gnu/                       +25 files
   +21.6 MB  var/                                          +108 ~8 files
   +21.6 MB    lib/                                        +108 ~3 files
   +21.3 MB      apt/                                      +3 ~1 files
   +21.3 MB        lists/                                  +3 files
   +20.8 MB          deb.debian.org_debian_dists_trixie_main_binary-amd64_Packages.lz4  +1 file

Wasted in after: bytes kept in a layer but hidden by a later one
  32.3 MB  root/.cache/pip/  69 files
           added    layer 8  RUN pip install -r requirements.txt
           deleted  layer 9  RUN rm -rf /root/.cache/pip
   3.5 MB  in 8 places inherited from layers shared with before (details in --format json)

Caches left in after
  21.6 MB  var/lib/apt/lists/  apt package lists, was 231.2 kB

Layers in after not shared with before (5 of 10)
   6   34.3 MB  RUN apt-get update && apt-get install -y --no-install-recommends curl
   7      31 B  COPY requirements-v2.txt requirements.txt
   8  185.3 MB  RUN pip install -r requirements.txt
   9       0 B  RUN rm -rf /root/.cache/pip
  10     403 B  COPY app.py .
```

The report shows three fixes at once. pandas ships its own test suite (32.3 MB under
`pandas/tests/`). `RUN rm -rf /root/.cache/pip` in its own layer saves nothing, because the 32.3 MB
cache is still in layer 8; `pip install --no-cache-dir` avoids it. And `apt-get update` left 21.6 MB
of package lists behind.

## Use cases

- **Gate image growth in CI.** `--fail-over 25MB` (or `--fail-over 10%`) exits with status 1 when
  the image grew by more than that. `--format markdown` turns the report into a pull request
  comment or job summary.
- **Review a base image or dependency upgrade.** Compare `python:3.12-slim` with
  `python:3.13-slim`, or your image before and after a lockfile bump, and see which packages
  actually grew.
- **Find wasted bytes.** Files deleted or overwritten in a later layer are still downloaded and
  stored. layerdelta lists them with the layer that added them and the layer that hid them.
- **Script it.** `--format json` gives totals, the tree, the 50 largest file changes, waste, and
  caches in a stable shape.

## In CI

This GitHub Actions job builds the pull request's image, compares it with the image built from
`main`, and writes the report to the job summary. It fails if the image grew by more than 25 MB:

```yaml
name: image size
on: pull_request
permissions:
  contents: read
jobs:
  layerdelta:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - name: Build base and pull request images
        run: |
          git worktree add ../base "origin/$GITHUB_BASE_REF"
          docker build -t app:base ../base
          docker build -t app:pr .
      - name: Compare
        run: |
          npx --yes github:thanatchon36/layerdelta docker-daemon:app:base docker-daemon:app:pr \
            --format markdown --fail-over 25MB >> "$GITHUB_STEP_SUMMARY"
```

This repository runs the same comparison on its own example in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml). If your `main` image is already pushed to
a public registry, you can skip the second build and compare against it directly, e.g.
`ghcr.io/owner/app:main docker-daemon:app:pr`.

## Images you can compare

| Argument | Reads |
| --- | --- |
| `node:22-slim`, `ghcr.io/owner/app:1.2`, `quay.io/org/img@sha256:...` | a public image, pulled from its registry with an anonymous token |
| `docker-daemon:myapp:dev` | an image in the local Docker daemon, exported with `docker image save` |
| `./image.tar`, `/abs/path/image.tar` | a `docker save` archive (classic or Docker 25+) or an OCI layout as a tar file |
| `./oci-layout/`, `oci:path`, `docker-archive:path` | an OCI layout or `docker save` output, as a directory or file |

Arguments that start with `./`, `../`, or `/`, end with `.tar` or `/`, or use the `oci:` or
`docker-archive:` prefix are read from disk. Everything else is an image reference. Multi-platform
images resolve to `linux/amd64` unless you pass `--platform`, e.g. `--platform linux/arm64`.

## Options

```text
Usage: layerdelta [options] <before> <after>

Compare two container images and show which files and directories changed their size.

Images:
  node:22-slim, ghcr.io/owner/app:1.2   public image, pulled from its registry (no Docker needed)
  docker-daemon:myapp:dev               image in the local Docker daemon
  ./image.tar, oci:./layout             docker save archive or OCI layout (file or directory)

Options:
  --platform <os/arch>   platform to pick from multi-platform images (default: linux/amd64)
  --format <format>      text (default), markdown, or json
  --fail-over <size>     exit with status 1 if the size grew by more than this: 50MB, 1GiB, 10%
  -h, --help             show this help
  -v, --version          show the version

Exit status: 0 on success, 1 when --fail-over is exceeded, 2 on errors.
```

## Reading the report

- **size** is the total of regular file sizes in the image's final filesystem, in decimal units
  like `docker images` (1 MB = 1,000,000 bytes).
- **wasted** is bytes stored in a layer but hidden in the final filesystem, because a later layer
  deleted or overwrote them. Waste that both images share (it comes from shared layers) is
  summarized in one line.
- **download** is the compressed size of all layers. It is shown when both images come from a
  registry, because local archives usually store layers uncompressed.
- **files** counts files added (`+`), removed (`-`), and files whose size changed (`~`).
- **Where the size changed** lists directories and files that carry at least 1% of all changed
  bytes, largest first. Only directories that carry at least 10% are expanded, and a chain such as
  `lib/python3.13/site-packages/` is collapsed into one row when nothing else in it changed.
- **Caches left in after** flags well-known cache locations (apt, apk, yum/dnf, pip, uv, npm, yarn,
  Go build cache, `/tmp`) that hold more than 1 MB.
- **Layers in after not shared with before** lists the layers that differ, with the build step
  that created each one.

## How it works

1. Resolve each argument to a manifest and config. For registries this means the OCI distribution
   API with an anonymous bearer token. For the daemon it means `docker image save` into a
   temporary file that is deleted afterwards.
2. Read each distinct layer once. Layers both images share are downloaded and parsed a single
   time. Layers are streamed through gzip or zstd decompression and a tar reader that keeps only
   names, types, and sizes. Nothing is written to disk, and the compressed bytes are checked
   against the layer digest.
3. Apply the layers in order, the way a container runtime does, including whiteouts (`.wh.` files
   and opaque directories), and record every file a later layer hides.
4. Compare the two final filesystems path by path and build the report.

Comparing `node:22` with `node:24` from Docker Hub (1.1 GB each, 8 layers, 4 shared) took 31
seconds of wall time and 11 seconds of CPU, and peaked at 230 MB of memory, on an Apple silicon
MacBook Air. The rest of the time went to downloading.

## Limitations

- Registry access is anonymous, so private images have to go through `docker pull` and
  `docker-daemon:`.
- Only sizes are compared. A file whose contents changed but whose size did not is not reported.
- Wasted bytes are counted from file sizes, not from what compression or the storage driver does
  with them.
- Windows container images are not supported.

## Roadmap

- Registry credentials from `~/.docker/config.json` and credential helpers.
- Group site-packages and node_modules changes by package name and version.
- A `--depth` and `--min-share` to tune the tree.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports with the two image references (or a
`--format json` output) are the most useful.

## License

[MIT](LICENSE)
