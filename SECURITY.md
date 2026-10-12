# Security policy

layerdelta reads container images; it never runs them. Depending on the arguments it:

- makes HTTPS requests to the registries of the images you name (plain HTTP only for
  `localhost`, `127.0.0.1`, and `[::1]`), using anonymous tokens. It never reads or sends
  credentials.
- runs `docker image save` for `docker-daemon:` arguments, writing the export to a temporary
  directory that is removed when the comparison finishes.
- reads `docker save` archives and OCI layouts you point it at.

Layer contents are streamed and discarded. Only names, types, and sizes are kept, and each
layer's compressed bytes are checked against its digest. layerdelta collects no telemetry.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the **Security** tab of this
repository and choose **Report a vulnerability**. Do not open a public issue.

You can expect an acknowledgement within a week. Fixes are released as a new patch version and
noted in [CHANGELOG.md](CHANGELOG.md).

## Supported versions

Only the latest release receives fixes.
