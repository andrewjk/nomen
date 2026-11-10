# Nomen site

The Nomen website. `/` is a placeholder landing page for now; the real feature
is the **playground at `/playground`**, a Nomen program editor that compiles on
the server and runs the emitted JavaScript in a sandboxed Worker.

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
  for the compiler's Node-only code (library loading, `#embed_file`). The
  playground rejects `#embed_file` and uses the embedded library, so neither is
  reached.
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

Open the printed URL at `/playground`; the sample auto-runs there. Press
<kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> to compile and run the editor's program.

## Share links

The **Share** button copies a self-contained link: the whole program is in the
URL (`/s/<base64url(utf8 source)>`, at most 2000 characters). Opening a share
link loads the code into the editor and runs it on demand; nothing is stored
server-side. `src/lib/share.ts` does the encoding, `src/routes/s/[code]` serves
the page.

Every share link gets its own card: `/s/<code>/card.png` renders the actual
code in the Worker with Shiki's token colours, a public-domain 8x8 bitmap font
and a small indexed-colour PNG encoder (`src/lib/card.ts`, `png.ts`,
`font8x8.ts`). No image library, WASM, or canvas API is involved.

The Share button includes the current run output as `?out=<base64url>`, so the
card can show the program and its output underneath without executing anything
on the server. Output is capped at 2000 characters (the card shows at most
eight lines). Because the URL contains the content, the PNG is content-
addressed and cached immutably in the Cache API. If rendering fails the route
redirects to `/og.png`; malformed codes fall back to the sample program and
the generic card. Posting a share link therefore shows an image card of the
code, and clicking it opens the playground with that program loaded.

`/playground/preview?code=…&out=…` renders that card on its own page. The
playground's **Preview share** link points at it, so you can check the image
(and the output lines) before posting the link.

## Social cards

Two card flavours are set up:

- `/playground` serves Open Graph plus a `summary_large_image` Twitter card,
  with `og.png` as the image. This works on every platform.
- `/embed` is a compact, chrome-free playground intended for an X **Player Card**
  (`twitter:card=player`, `twitter:player=/embed`, 640x480, `card.png` poster).
  It sends `Content-Security-Policy: frame-ancestors` for x.com/twitter.com
  (route middleware in `src/routes/embed/+page.server.ts`) and no
  `X-Frame-Options`, so X can frame it. At 640px wide it shows the program and
  output side by side, with inner scrolling and no page header.

X requires a domain to be **manually allowlisted for Player Cards**, and its
policy currently reserves them for linear audio/video content — a playground may
not be approved (or may stop working if it is). Until the domain is approved,
tweet `/playground` (image card); after approval, tweet `/embed` (inline
playground). Change
`twitter:site` in `src/routes/embed/+page.ts` from `@andrewjk` if needed.

Regenerating the images: `og.png` is a 2x screenshot of `/playground` at
1200x630, and `card.png` a 2x screenshot of `/embed` at 640x480.

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
comfortably covers a compile. The built Worker is ~410 kB gzipped (about
1.9 MB including static assets) and has no Node built-ins. The server bundle
only imports the JavaScript backend — `build_js` directly, not the C/AArch64
backends — which is what keeps the compiler small. The card renderer adds a
few kB (bitmap font + PNG encoder) instead of a text-shaping/image stack. The
highlighter adds ~80 kB gzipped of _lazy_ client chunks (loaded after the page
is interactive).
