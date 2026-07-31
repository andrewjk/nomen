# Nomen CLI Reference

The `nomen` command-line interface parses, type-checks, builds, links, and (optionally) runs Nomen programs. It can also reformat source and generate markdown documentation.

- **Binary:** `nomen-lang` package (`bin`: `nomen`)
- **Entry point:** [`bin/src/index.ts`](bin/src/index.ts)
- **Backend toolchain:** links with `clang`, so a working `clang` on `PATH` is required for `run` and `build`.

## Synopsis

```
nomen <command> [options]
nomen <command> --in <file|folder> [options]
```

When no `--in` is given, the CLI discovers what to compile from the current working folder (see [Input Resolution](#input-resolution)).

## Commands

| Command    | Description                                                              |
| ---------- | ----------------------------------------------------------------------- |
| `run`      | Parse, check, build, link, **and execute** the program.                  |
| `build`    | Parse, check, build, **and link** the executable, but do not run it.     |
| `check`    | **Parse and check only** — no code generation, linking, or execution.   |
| `format`   | Reformat every `.nm` file under `--in` (or the current folder).          |
| `docs`     | Generate markdown documentation into a `docs/` folder.                   |

An unknown or missing command prints the help text and exits with code `1`.

### `run`

```bash
nomen run --in app/main.nm
```

Full pipeline: parse → check → build → link with `clang` → execute the resulting binary. The program's stdout/stderr are inherited by the terminal, and a `Completed in <ms>` line is printed afterwards.

### `build`

```bash
nomen build --in app/main.nm --arch c
```

Same as `run` but stops after linking. The executable is written to the build folder (see [Build Output](#build-output)) and a `Built <path> in <ms>` line is printed. The program is **not** executed.

### `check`

```bash
nomen check --in app/main.nm
```

Runs parsing and type-checking only. Useful for fast feedback in editors and CI: no code is emitted, nothing is linked, nothing runs. Prints `Checked in <ms>` on success.

### `format`

```bash
nomen format                       # rewrite every .nm file under cwd
nomen format --in src              # rewrite every .nm file under src/
nomen format --check               # report what *would* change, write nothing
```

Re-indents and tidies every `.nm` file under the target folder. Formatting options are read from the nearest `package.jsonc`'s `format` block (see [Format Options](#format-options)). A file is **skipped** (left untouched) when formatting it would be considered unsafe — the skip reason is logged. Add `--check` for a dry-run: files are reported as changed but never written.

### `docs`

```bash
nomen docs --in app/main.nm
nomen docs                         # document the current package
```

Parses every `.nm` file in scope and writes one markdown file per source file into `<root>/docs/`, mirroring the source tree. For each top-level `pub` item (struct, class, trait, enum, bitset, function) it emits its doc comment and a list of `pub` members; undocumented `pub` items produce warnings.

The set of files documented depends on the target:

- A `package.jsonc` with an `exports` map → a **library**: every exported file is documented, using that package's resolved library.
- Otherwise → an **app / single-file**: the `.nm` files alongside the resolved input (or in the target folder) are documented together with their module siblings.

## Options

All options are global and accepted by every command (though only a subset are meaningful for each one).

### `--in`, `-i`

- **Type:** string
- **Applies to:** `run`, `build`, `check`, `format`, `docs`
- **Description:** The input `.nm` file **or** a folder of `.nm` files to process. If omitted, the CLI tries to discover the entry from the current folder (see [Input Resolution](#input-resolution)). Only `.nm` files are processed; other extensions are skipped with an "Unsupported file type" notice.

### `--out`, `-o`

- **Type:** string
- **Applies to:** (declared but currently unused)
- **Description:** Declared in the option parser but **not read** by the current implementation. Build artifacts are always written under `<build_root>/build/` (see [Build Output](#build-output)). Do not rely on this flag.

### `--config`, `-c`

- **Type:** string
- **Applies to:** `run`, `build`, `check`
- **Description:** Path to a JSON config file. If the file exists, its fields seed the build config before CLI flags override them. See [Config File](#config-file).

### `--watch`, `-w`

- **Type:** boolean
- **Applies to:** `run`, `build`, `check`
- **Description:** Watch the `--in` path for changes and re-run the pipeline on every file event. Only meaningful when `--in` points at a file or folder (it has no effect in discovery mode). Uses `chokidar`.

### `--arch`, `-a`

- **Type:** string
- **Default:** `aarch64`
- **Applies to:** `run`, `build`
- **Choices:** `aarch64` | `c`
- **Description:** Target backend.
  - `aarch64` — emit AArch64 assembly (a `.s` file). **Default.** See [AARCH64.md](AARCH64.md).
  - `c` — emit C source. On macOS/iOS the generated file uses an `.m` extension (Objective-C runtime); elsewhere `.c`.

### `--platform`, `-p`

- **Type:** string
- **Default:** derived from the host OS (`darwin` → `macos`, `linux` → `linux`, `win32` → `windows`)
- **Applies to:** `run`, `build`
- **Choices:** `macos`, `ios`, `linux`, `android`, `windows`, `web`
- **Description:** Target platform. Selecting `macos` or `ios` adds Apple framework link flags (`-framework CoreGraphics -framework Foundation -framework AppKit -lobjc`) and forces the C-backend file extension to `.m`.

### `--lib`, `-l`

- **Type:** string
- **Applies to:** `run`, `build`, `check`
- **Description:** Path to the `System` library directory (the one containing a `package.jsonc`). If omitted, the CLI walks parent folders looking for either a `package.jsonc` with an `imports.System` entry or a `core/` subfolder containing a `package.jsonc`.

### `--audit`

- **Type:** boolean
- **Applies to:** `run`, `build`
- **Description:** Enable memory auditing of the generated program. When set, the audit runtime (`audit_runtime.c`) is compiled to an object file and linked into the binary. Requires a resolvable audit runtime (see `--audit-runtime`).

### `--audit-runtime`

- **Type:** string
- **Applies to:** `run`, `build` (only when `--audit` is set)
- **Description:** Explicit path to `audit_runtime.c`. If not supplied, the CLI searches each ancestor folder for `src/audit_runtime.c`. When `--audit` is set and no runtime can be resolved, the build fails with an error.

### `--check`

- **Type:** boolean
- **Applies to:** `format`
- **Description:** Dry-run formatter mode. Files are scanned and any that *would* be reformatted are reported as changed, but **no files are written**. (Note: this is a separate flag from the `check` *command*.)

### Help

`-h` / `--help` prints the full usage text (command list + options). Passing no recognized command also prints help and exits `1`.

## Input Resolution

When `--in` is **not** supplied, `run`, `build`, and `check` resolve an entry from the current working folder in this order:

1. **`package.jsonc` `entry`** — if `./package.jsonc` parses and contains an `entry` field, that file is used (resolved relative to the package root). The build root is the package folder.
2. **A single `.nm` file in the cwd** — if exactly one `.nm` file sits directly in the working folder, it is used. The build root is the cwd.
3. **Multiple `.nm` files** — the CLI lists them and asks you to pick one with `--in`, then exits.
4. **Nothing found** — prints `"Nothing to compile..."` guidance and exits.

When `--in` **is** supplied, the build root is that path (the folder itself, or the file's parent folder).

## Build Output

All generated artifacts are written to `<build_root>/build/` (created if missing), regardless of `--out`:

| Artifact                         | When emitted                                            |
| -------------------------------- | ------------------------------------------------------- |
| `main.h`                         | Always (for `run` / `build`).                           |
| `<basename>.s`                   | `--arch aarch64` (the default).                         |
| `<basename>.m`                   | `--arch c` on `macos` / `ios`.                          |
| `<basename>.c`                   | `--arch c` on other platforms.                          |
| `<basename>`                     | The linked executable (`run` / `build`).                |
| `<basename>_companion.m` / `.c`  | Only when the backend emits a companion file (UI interop). |
| `audit_runtime.o`                | When `--audit` is set.                                  |

`<basename>` is the `--in` filename without its `.nm` extension.

## Config File

`--config` points to a JSON file whose fields seed the build config before CLI flags are applied. Recognized fields:

```json
{
	"arch": "c",
	"platform": "macos",
	"lib": "../core",
	"audit": false,
	"audit_runtime": "../src/audit_runtime.c"
}
```

CLI flags (`--arch`, `--platform`, `--lib`, `--audit`, `--audit-runtime`) override any corresponding config-file value. If a field is absent everywhere, its built-in default applies (`arch = aarch64`, `platform = host-derived`).

## `package.jsonc`

Several behaviors key off a JSON-with-comments `package.jsonc` discovered by walking up from the input file (or cwd):

| Field              | Used by                                   | Meaning                                                                 |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------------- |
| `entry`            | input resolution (`run`/`build`/`check`)  | Path to the project's main `.nm` file.                                  |
| `imports.System`   | library resolution                        | Path to the `System` library folder.                                    |
| `exports`          | `docs`, library detection                 | Map of name → glob pattern; a package with `exports` is treated as a library. |
| `format`           | `format` command                          | A [Format Options](#format-options) block.                              |

### Format Options

The `format` block (also readable from a `core/package.jsonc`) controls `nomen format`. Any omitted field falls back to the built-in default:

| Field                  | Type    | Default | Description                                                          |
| ---------------------- | ------- | ------- | -------------------------------------------------------------------- |
| `print_width`          | number  | `100`   | Column to wrap argument lists at.                                    |
| `sort_imports`         | boolean | `true`  | Sort each run of `import` lines alphabetically.                      |
| `use_tabs`             | boolean | `true`  | Indent with tabs rather than spaces.                                 |
| `trailing_comma`       | boolean | `true`  | Keep a trailing comma on multi-line array literals.                  |
| `strip_redundant_types`| boolean | `true`  | Drop declared types the value already states (e.g. `var Text t = Text(w)`). |
| `tab_width`            | number  | `4`     | How wide a tab is, when measuring against `print_width`.             |

Example:

```jsonc
{
	"format": {
		"print_width": 120,
		"use_tabs": true
	}
}
```

## Examples

Run the default backend (AArch64) and execute:

```bash
nomen run --in app/main.nm
```

Build for the C backend on macOS without running:

```bash
nomen build --in app/main.nm --arch c --platform macos
```

Type-check only, watching for changes:

```bash
nomen check --in app/main.nm --watch
```

Reformat a folder (dry-run first):

```bash
nomen format --in src --check
nomen format --in src
```

Generate documentation for a library:

```bash
nomen docs --in core/System
```

Run with memory auditing enabled:

```bash
nomen run --in app/main.nm --audit --audit-runtime ../src/audit_runtime.c
```

Let the CLI discover the entry from `package.jsonc`:

```bash
nomen run
```

## Exit Codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| `0`  | Success (`docs`/`format` complete, or pipeline ok). |
| `1`  | Unknown/missing command, or no input discovered.    |

Compile/check errors do **not** set a non-zero exit code — they are rendered to the console and the file is skipped, but the process still exits `0`. Treat the presence of rendered errors in the output as the failure signal in CI.
