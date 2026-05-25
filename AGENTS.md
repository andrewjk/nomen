# AGENTS.md

This document provides guidelines for agentic coding agents working on the Echo programming language compiler.

## The Echo Language

The language's syntax and capabilites are documented in SPEC.md.

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
  	const input = `echo code`;
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

### When Making Changes

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

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
