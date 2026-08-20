# AGENTS.md

This document provides guidelines for agentic coding agents working on the Nomen programming language compiler.

> **Working on Nomen _code_** (not the compiler itself)? Read
> [`NOMEN_AGENTS.md`](./NOMEN_AGENTS.md) instead — it's a tight, agent-focused
> reference covering commands, language directives, and a compressed spec.
> `nomen init <name>` copies it into new projects as `AGENTS.md`.

## The Nomen Language

The language's syntax and capabilites are documented in SPEC.md.

The memory model is documented in MEMORY.md.

## Build, Lint, and Test Commands

### Primary Commands

- `npm run build` - Build the project using tsup
- `npm run dev` - Watch mode for development (runs tsup --watch)
- `npm run check` - Run TypeScript type checking (tsc --noEmit)
- `npm test` - Run all tests using Vitest
- `npm run format` - Format code using Prettier

### Running Single Tests

Use Vitest's filtering to run specific tests:

```bash
# Run tests matching a pattern
npm test -- -t "test name"

# Run a specific test file
npm test tests/function/build.test.ts

# Run tests in a directory
npm test tests/function/
```

### Alternative Test Framework

The project also has uvu configured:

- `npm run test:uvu` - Run tests using uvu
- `npm run test:uvu:cover` - Run tests with coverage using c8

## Code Style Guidelines

### Formatting

- Line width: 100 characters
- Use Prettier with automatic import sorting
- Imports sorted: parent directories (`^[../]`) first, then local directories (`^[./]`)
- Import specifiers sorted alphabetically within each import statement

### TypeScript Configuration

- Target: ESNext
- Module system: CommonJS
- Strict mode enabled
- Use explicit type annotations for function parameters and return types
- Type assertions only when necessary

### Naming Conventions

- **Classes**: PascalCase (e.g., `FunctionNode`, `BaseNode`, `Type`)
- **Functions/Variables**: snake_case (e.g., `tokenize`, `parse_statement`, `check_node`)
- **Constants**: SCREAMING_SNAKE_CASE for compile-time constants (e.g., `COMPOUND_SYMBOLS`)
- **Interfaces/Types**: PascalCase (e.g., `CompileError`, `ParseResult`, `Token`)
- **Node Types**: lowercase strings in union types (e.g., `"func"`, `"struct"`, `"if"`, `"return"`)
- **Files**:
  - Class files: PascalCase (e.g., `FunctionNode.ts`, `BaseNode.ts`)
  - Module files: lowercase (e.g., `tokenize.ts`, `parse.ts`, `check.ts`)
  - Type files: PascalCase in appropriate directories (e.g., `types/CompileError.ts`)

### Imports

- Use `import type` for type-only imports
- Import local modules with relative paths (`./` or `../`)
- Keep imports grouped: standard library first, then third-party, then local
- Example:
  ```typescript
  import build_node from "./build/build_node.ts";
  import BaseNode from "./nodes/BaseNode.ts";
  import type Token from "./types/Token";
  ```

### Types and Interfaces

- Define types in `src/types/` directory for shared types
- Use `default export` for types and interfaces
- Use `class` for objects with methods, `interface` for data structures
- Example:

  ```typescript
  export default interface ParseResult {
  	ok: boolean;
  	root: RootNode;
  	errors: CompileError[];
  }

  export default class Type {
  	name: string;
  	is_static?: boolean;
  	// ...
  }
  ```

### Error Handling

- Use the `CompileError` interface for all compilation errors
- Errors are collected in arrays on status objects, not thrown
- Helper function `add_error(status, message, start)` for adding errors
- Error objects include `message`, `start`, `line`, and `column` properties
- Always check `status.errors.length` before proceeding in multi-pass processes

### Node Architecture

- All nodes extend `BaseNode` with `node_type` and `start` properties
- Node types are defined in `src/nodes/NodeType.ts` as a union type
- Each node type has corresponding check/build functions
- Pattern: `check_<node_type>_node(node, status)` and `build_<node_type>_node(node, status)`

### Status Objects

Status objects track compilation state across passes:

- `ParseStatus`: tokens, index, stack, namespace, errors
- `CheckStatus`: stack, values, types, structs, traits, functions, allocations, errors
- `BuildStatus`: root, structs, traits, headers, code, scoped_declarations

### Testing Patterns

- Use Vitest: `import { expect, test } from "vitest";`
- Test functions use simple, descriptive names
- Helper functions available:
  - `test_error(source, message, line, column)` - Creates expected CompileError objects
  - `trim_test_build(code)` - Normalizes build output for comparison
- Common test structure:
  ```typescript
  test("test name", () => {
  	const input = `nomen code`;
  	const parsed = parse(input);
  	const result = build(parsed.root);
  	expect(parsed.errors).toEqual([]);
  	expect(trim_test_build(result.code)).toEqual(expected);
  });
  ```

### Project Structure

```
src/
  nodes/          - AST node definitions
  types/          - Shared type definitions (Result types, Error types)
  check/          - Type checking functions
  parse/          - Parsing functions
  build/          - Code generation functions
  tokenize.ts     - Lexical analysis
  parse.ts        - Main parse entry point
  check.ts        - Main type check entry point
  build.ts        - Main build entry point
tests/
  <feature>/      - Organized by language feature
    build.test.ts - Build/output tests
    errors.test.ts - Error handling tests
    parse.test.ts - Parsing tests
```

### SPEC Coverage Tests (`test/spec/`)

`test/spec/` holds one test file per SPEC.md section, with a test for (almost)
every fenced code block in `SPEC.md`. These encode the language contract: each
valid example must compile with **no errors**, and each error example must
produce its documented error.

- **Keep these in sync with `SPEC.md`.** Whenever a code block in `SPEC.md` is
  added, changed, or removed, update the corresponding test in `test/spec/`
  (add/modify/delete the test) so the suite continues to reflect the spec.
- **Known SPEC/impl gaps** (features the spec documents but the compiler does
  not yet implement) are written as _negative_ tests that currently **fail**:
  they assert `errors` is empty and carry a `// TODO: enabled once ... (SPEC
gap)` comment. When the feature lands, the test turns green automatically —
  do not delete or loosen it. Treat a newly-passing `test/spec/` test as a
  signal that the gap was closed.
- Run them with `npm test test/spec/` (or `npx vp test test/spec/`).

### README Coverage Tests (`test/readme/`)

`test/readme/` holds one test file per README.md section, with a test for (almost)
every fenced code block in `README.md`. These encode the language contract: each
valid example must compile with **no errors**.

- **Keep these in sync with `README.md`.** Whenever a code block in `README.md` is
  added, changed, or removed, update the corresponding test in `test/readme/`
  (add/modify/delete the test) so the suite continues to reflect the spec.
- Run them with `npm test test/readme/` (or `npx vp test test/readme/`).

### Inline code blocks (`#arch:` directives)

Raw code blocks let a function bypass the Nomen codegen and emit assembly or C
directly. Use the directive that matches the backend:

- `#arch: c` — C source, used by the C backend (`build_c`).
- `#arch: aarch64` — raw AArch64 assembly, emitted inline by the aarch64
  backend. This is the mechanism to use for performance-critical primitives
  (e.g. `umulh`, `get`/`set` limb accessors). The build links with `clang`, so
  compiler-rt builtins are available — a `bl ___udivti3` (or similar) call
  resolves at link time.
- `#arch: aarch64_use_c` — C source compiled via the companion file. **This is
  reserved for interfacing with UI/AppKit/UIKit code only** (see
  `core/System/Controls/`). Do **not** use `aarch64_use_c` to optimize
  non-UI hot paths — use `#arch: aarch64` raw asm (or a `bl` to a builtin)
  instead.

### When Making Changes

#### Language Conventions

- Nomen does **not** support `else if`. When writing Nomen code, use a `switch`
  instead of `"else if"` or an `"else { if { ... } }"` chain. Nested `else`
  blocks containing another `if` (`else { if … { } }`) are also forbidden —
  pull the inner condition out into its own top-level `if` (when the
  conditions are independent) or fold the whole chain into a single `switch`.

1. Always run `npm run check` after changes to verify type correctness
2. Run `npm test` to ensure all tests pass
3. Run `npm run format` before committing
4. If adding a new language feature, follow the pattern:
   - Create node type in `NodeType.ts`
   - Create node class in `src/nodes/`
   - Create parse function in `src/parse/`
   - Create check function in `src/check/`
   - Create build function in `src/build/`
   - Add tests in `tests/<feature>/`

#### Follow-Ups

- When you decide **not** to fix a bug or issue inline (e.g. it's out of scope
  for the current task), record it for later by adding a section to
  `FOLLOWUP.md` describing the issue (what you saw, where, and any relevant
  context). Create the file if it does not yet exist.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
