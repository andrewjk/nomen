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
