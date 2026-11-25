# Editor Support

Nomen's editor features come from a Language Server Protocol server built into
the CLI. An installed `nomen` is all an editor needs:

```bash
npm i -g nomen-lang
nomen lsp        # speaks LSP (JSON-RPC) over stdin/stdout
```

`nomen lsp` accepts (and ignores) `--stdio`, which some clients append.

## Features

| Feature                      | LSP method                                            |
| ---------------------------- | ----------------------------------------------------- |
| Errors and lint warnings     | `textDocument/publishDiagnostics`                     |
| Hover (signature + docs)     | `textDocument/hover`                                  |
| Go to definition             | `textDocument/definition` (into `core/` too)          |
| Find references              | `textDocument/references`                             |
| Member completion after `.`  | `textDocument/completion`                             |
| Formatting                   | `textDocument/formatting`                             |
| Quick fixes (field effects)  | `textDocument/codeAction`                             |
| Run / Audit lenses on `main` | `textDocument/codeLens` (opt-in, see below)           |
| Force format                 | `workspace/executeCommand` `nomen.server.forceFormat` |

The System library is found the same way the compiler finds it: a
`package.jsonc` `imports.System` or a `core/` folder at or above the file, the
workspace's `core/`, and finally the copy bundled with the CLI.

## Settings

The server reads the `nomen` settings section — pulled with
`workspace/configuration`, or taken from `initializationOptions` (as
`{ "nomen": { … } }`, `{ "settings": { … } }` or flat) for clients that don't
support it:

| Setting        | Values                                                                                                          | Default    |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| `diagnostics`  | `"onType"`, `"onSave"`, `"off"`                                                                                 | `"onType"` |
| `format.force` | `true` / `false` — format even when the token stream would change (e.g. `a -1`); can change a program's meaning | `false`    |

`initializationOptions.runCommands: true` turns on the Run/Audit code lenses.
Their commands (`nomen.run` / `nomen.audit`, argument: the document URI) are
implemented by the client, so only enable this if yours handles them — the
VS Code extension does.

To force-format from any client, execute `nomen.server.forceFormat` with the
document URI as its only argument; the server replies with a
`workspace/applyEdit`.

## VS Code

Install the **Nomen** extension from the marketplace. It launches `nomen lsp`
(the `nomen.executable` setting picks a different CLI) and adds the Run/Audit
commands, highlighting and settings.

## Neovim

Neovim 0.11+ with the built-in `vim.lsp.config` (nvim-lspconfig is optional —
it has no bundled Nomen config, so you define it yourself either way):

```lua
vim.filetype.add({ extension = { nm = "nomen" } })

vim.lsp.config("nomen", {
	cmd = { "nomen", "lsp" },
	filetypes = { "nomen" },
	root_markers = { "package.jsonc", ".git" },
	settings = {
		nomen = { diagnostics = "onType", format = { force = false } },
	},
})
vim.lsp.enable("nomen")
```

With an older nvim-lspconfig (`require("lspconfig")` style):

```lua
vim.filetype.add({ extension = { nm = "nomen" } })

local configs = require("lspconfig.configs")
if not configs.nomen then
	configs.nomen = {
		default_config = {
			cmd = { "nomen", "lsp" },
			filetypes = { "nomen" },
			root_dir = require("lspconfig.util").root_pattern("package.jsonc", ".git"),
			settings = { nomen = { diagnostics = "onType" } },
		},
	}
end
require("lspconfig").nomen.setup({})
```

Format with `vim.lsp.buf.format()`; force-format with
`vim.lsp.buf.execute_command({ command = "nomen.server.forceFormat", arguments = { vim.uri_from_bufnr(0) } })`.

## Helix

Add to `~/.config/helix/languages.toml` (or a project `.helix/languages.toml`):

```toml
[language-server.nomen]
command = "nomen"
args = ["lsp"]

[language-server.nomen.config.nomen]
diagnostics = "onType"

[[language]]
name = "nomen"
scope = "source.nm"
file-types = ["nm"]
roots = ["package.jsonc"]
language-servers = ["nomen"]
comment-token = "//"
block-comment-tokens = { start = "/*", end = "*/" }
indent = { tab-width = 4, unit = "\t" }
auto-format = false
```

Check it with `hx --health nomen`. Helix highlights with tree-sitter, so syntax
colouring needs the Nomen tree-sitter grammar; the language server works
without it.

## Zed

Zed registers new languages through extensions, so Nomen needs a small dev
extension that points at `nomen lsp`. Create a folder with:

`extension.toml`

```toml
id = "nomen"
name = "Nomen"
version = "0.0.1"
schema_version = 1
description = "Nomen language support"

[language_servers.nomen]
name = "Nomen Language Server"
languages = ["Nomen"]

# Zed highlights with tree-sitter: point this at the Nomen tree-sitter grammar.
[grammars.nomen]
repository = "https://github.com/andrewjk/nomen"
rev = "<commit>"
path = "tree-sitter-nomen"
```

`languages/nomen/config.toml`

```toml
name = "Nomen"
grammar = "nomen"
path_suffixes = ["nm"]
line_comments = ["// "]
block_comment = ["/* ", " */"]
tab_size = 4
hard_tabs = true
```

`Cargo.toml`

```toml
[package]
name = "zed_nomen"
version = "0.0.1"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
zed_extension_api = "0.6"
```

`src/lib.rs`

```rust
use zed_extension_api::{self as zed, LanguageServerId, Result};

struct NomenExtension;

impl zed::Extension for NomenExtension {
    fn new() -> Self {
        NomenExtension
    }

    fn language_server_command(
        &mut self,
        _id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let nomen = worktree
            .which("nomen")
            .ok_or("nomen not found on PATH (npm i -g nomen-lang)")?;
        Ok(zed::Command {
            command: nomen,
            args: vec!["lsp".into()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(NomenExtension);
```

Then run **zed: install dev extension** and pick the folder. Settings go in
Zed's `settings.json`:

```json
{
	"lsp": {
		"nomen": {
			"settings": { "nomen": { "diagnostics": "onType" } }
		}
	}
}
```

## Other editors

Any LSP client works the same way: run `nomen lsp` over stdio for `*.nm`
files, with `package.jsonc` as the root marker. For Sublime Text (with the
LSP package), add a client with `"command": ["nomen", "lsp"]` and a selector
for your Nomen syntax. Editors that read TextMate grammars can highlight with
[`grammars/nomen.tmLanguage.json`](../grammars/nomen.tmLanguage.json) (scope
`source.nm`; Sublime needs it converted to `.sublime-syntax` or plist
`.tmLanguage` first). JetBrains IDEs can import the same grammar as a TextMate
bundle and run `nomen lsp` through an LSP plugin such as LSP4IJ.
