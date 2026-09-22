# Security

## Reporting a vulnerability

Report it privately through **[Security → Report a vulnerability](https://github.com/JakemoCode/task-map/security/advisories/new)** on this repository. Please don't open a public issue for it. Expect a first reply within a week.

## What counts

The page is static: it runs entirely in the browser, sends nothing anywhere, and treats every data file as untrusted, since the hosted viewer loads data from any `?data=` URL. In scope:

- Anything in a data file that runs script, or changes the page beyond what the format describes, including through `bin/build.mjs`'s output.
- A data file that passes `bin/validate.mjs` but breaks or hangs the page.
- Problems in `bin/` or the build that could affect a machine running them.

Only the latest commit on `main`, and the GitHub Pages site built from it, is supported.
