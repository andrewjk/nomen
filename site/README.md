# Nomen site

The Nomen website. Right now it is just the REPL: a Nomen program editor that
compiles on the server and runs the emitted JavaScript in a sandboxed Worker.

It is a [Torpor](https://torpor.dev) site deployed to **Cloudflare Workers**
(with static assets). Compilation happens inside the Worker; the System library
is embedded at build time, so the Worker needs no filesystem and no Node
built-ins:

- `site/scripts/bundle-core.ts` serializes `../core`'s type map into
  `src/lib/core-library.generated.ts` (`pnpm bundle:core`; `dev`/`build` run it
  automatically). GUI namespaces (`System::Controls`, native AppKit) are
  excluded — they cannot run in a browser and are half the library's source, so
  referencing one is a compile-time "unknown type".
- `src/lib/fs-stub.ts` / `src/lib/path-shim.ts` replace `node:fs` / `node:path`
  for the compiler's Node-only code (library loading, `#embed_file`). The REPL
  rejects `#embed_file` and uses the embedded library, so neither is reached.
- `site.config.ts` wires those aliases and neutralizes `process.env` (compiler
  debug switches) via Vite.
- Editor highlighting comes from [`nomen-shiki`](../shiki), a workspace package
  around Shiki using the VS Code extension's TextMate grammar. It is loaded
  lazily on the client (Shiki's JavaScript regex engine, no WASM), so it never
  enters the Worker bundle.

User programs never run on the server: the compiled browser script runs in the
page's Worker, so a runaway loop is terminated by the page's 5s watchdog.

## Running

```bash
pnpm install        # from the repository root
cd site
pnpm dev            # Torpor dev server on workerd (Cloudflare's local runtime)
```

Opening the printed URL auto-runs the sample. Press <kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd>
to compile and run the editor's program.

## Build, preview, deploy

```bash
pnpm build          # regenerates the embedded library, builds dist/cloudflare
pnpm preview        # builds, then serves the worker with `wrangler dev`
pnpm deploy         # builds, then `wrangler deploy`
```

`wrangler.jsonc` points Cloudflare at `dist/cloudflare/_worker.js`, with
`dist/cloudflare` as the static-assets directory. Change `name` there to deploy
under a different Worker name.

Compiling is CPU-bound (roughly 10–40 ms per run locally; the first request is
slower because the Worker starts cold), so pick a Workers plan whose CPU limit
comfortably covers a compile. The built Worker is ~300 kB gzipped (about 1.4 MB
including static assets) and has no Node built-ins. The server bundle only
imports the JavaScript backend — `build_js` directly, not the C/AArch64
backends — which is what keeps it small. The highlighter adds ~80 kB gzipped of
_lazy_ client chunks (loaded after the page is interactive).
