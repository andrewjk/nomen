# nomen-grammars

The TextMate grammar for Nomen, `nomen.tmLanguage.json` (scope `source.nm`).
It is the single source of truth for syntax highlighting across the repo:

- **VS Code extension** — `vscode/esbuild.mjs` copies it to
  `vscode/syntaxes/` (git-ignored) on every build, so `vsce package` ships it
  inside the `.vsix`.
- **[`nomen-shiki`](../shiki)** — imports it as
  `nomen-grammars/nomen.tmLanguage.json` (a workspace dependency).
- **Website** — highlights through `nomen-shiki`.

Edit the grammar here, never a copy. Other editors that read TextMate grammars
(Sublime Text, JetBrains via TextMate bundles, Zed extensions) can use this
file directly; language features come from `nomen lsp` (see
[docs/EDITORS.md](../docs/EDITORS.md)).
