# Nomen Language CLI

This is the CLI for the [Nomen](https://github.com/andrewjk/nomen) programming language.

## Installation

Use npm (or your preferred package manager) to install it globally:

```bash
npm i -g noman-lang
```

### Run a Program

```bash
nomen --in path/to/program.nm
```

Target a specific backend:

```bash
nomen --in path/to/program.nm --arch c         # emit C
nomen --in path/to/program.nm --arch aarch64   # emit AArch64 assembly (default)
```

### Editor Support

`nomen lsp` starts a Language Server Protocol server over stdio — diagnostics,
hover, go to definition, references, completion, formatting and quick fixes for
any LSP editor. See
[docs/EDITORS.md](https://github.com/andrewjk/nomen/blob/main/docs/EDITORS.md)
for Neovim, Helix and Zed setup.
