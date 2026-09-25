# Security

## Reporting a vulnerability

Report it privately through **[Security → Report a vulnerability](https://github.com/JakemoCode/task-map/security/advisories/new)** on this repository. Please don't open a public issue for it. Expect a first reply within a week.

## What counts

The page runs entirely in the browser and treats every data file as untrusted, since the hosted viewer loads data from any `?data=` URL. It sends nothing anywhere; in live mode it only asks the local server that served it for data. In scope:

- Anything in a data file that runs script, or changes the page beyond what the format describes, including through `bin/build.mjs`'s output.
- A data file that passes `bin/validate.mjs` but breaks or hangs the page.
- Problems in `bin/` or the build that could affect a machine running them.
- `task-map-serve` answering anyone but the local user: it binds `127.0.0.1` and refuses a request whose `Host` is not `127.0.0.1` or `localhost` on its own port (DNS rebinding) or whose `Sec-Fetch-Site` is `cross-site`, and one carrying an `Origin` other than its own, which stops a page on another local port from forcing adapter runs through `POST /refresh`. It sends no CORS headers. An adapter left running after the server stops is in scope too.

Only the latest commit on `main`, and the GitHub Pages site built from it, is supported.
