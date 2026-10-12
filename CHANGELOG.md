# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-12

### Added

- Compare two container images and report the size change as a tree of the directories and files
  that carry it, with counts of added, removed, and resized files.
- Image sources: public registries (Docker Hub, GHCR, Quay, and other OCI distribution registries)
  with anonymous tokens, the local Docker daemon (`docker-daemon:`), `docker save` archives, and
  OCI layouts as tar files or directories.
- Wasted bytes: files kept in a layer but deleted or overwritten by a later one, with the layers
  responsible.
- Well-known caches left in the image (apt, apk, yum/dnf, pip, uv, npm, yarn, Go, `/tmp`).
- `--format text|markdown|json`, `--fail-over SIZE|PERCENT` for CI budgets, and `--platform` for
  multi-platform images.
- gzip, zstd, and uncompressed layers; digest verification of every layer read.

[0.1.0]: https://github.com/thanatchon36/layerdelta/releases/tag/v0.1.0
