# Nomen site

The Nomen website. Right now it is just the REPL: a Nomen program editor that
compiles on the server and runs the emitted JavaScript in a sandboxed Worker.

## Running

Install from the repository root (the site is a pnpm workspace package), then
start the Torpor dev server:

```bash
pnpm install
cd site
pnpm dev
```

The REPL compiles with the compiler in `../src` and reads the System library
from `../core` (override with `NOMEN_CORE=/path/to/core`). Compilation happens
server-side, so the REPL needs a Node host; user programs never run on the
server — the emitted browser script runs in a Worker in the page.

Open the printed URL and press <kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> to run the
program.

To try the production build (it rebuilds first and listens on `$PORT`, default
`7059`):

```bash
pnpm preview
```
