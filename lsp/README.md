# nomen-lsp

The Language Server Protocol server for Nomen. Editors run it through the CLI,
`nomen lsp` (stdio), which bundles this package — see
[docs/EDITORS.md](../docs/EDITORS.md) for editor setup, settings and the
feature list. The VS Code extension (`vscode/`) is a thin client that
launches `nomen lsp`.

## Layout

- `src/server.ts` — `start_server(input, output, options)`: the connection,
  capabilities, settings, document sync and debounced diagnostics.
- `src/features.ts` — each LSP feature (diagnostics, hover, definition,
  references, completion, formatting, code actions, code lenses) as a plain
  function of a `TextDocument`.
- `src/documents.ts` — the per-document parse/analysis cache shared by every
  feature.
- `src/analysis.ts` — definitions, references and member types indexed from
  the compiler's AST (`../src`).
- `src/source_map.ts` — builds the combined source the compiler sees
  (document + sibling modules + inlined System library) and maps offsets back
  to files.
- `src/library.ts`, `src/config.ts` — System library and `package.jsonc`
  resolution.

## Tests

`test/server.test.ts` drives the server over Content-Length framed JSON-RPC
(`test/lsp_client.ts`, no LSP library on the client side);
`cli/test/lsp_command.test.ts` spawns the real `nomen lsp`.

```bash
npx vp test lsp/ cli/test/lsp_command.test.ts
```
