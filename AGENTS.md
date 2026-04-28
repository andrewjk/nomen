# AGENTS.md

This document provides guidelines for agentic coding agents working on the Echo language compiler.

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

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ built-in commands (`vp dev`, `vp build`, `vp test`, etc.) always run the Vite+ built-in tool, not any `package.json` script of the same name. To run a custom script that shares a name with a built-in command, use `vp run <script>`. For example, if you have a custom `dev` script that runs multiple services concurrently, run it with `vp run dev`, not `vp dev` (which always starts Vite's dev server).
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## CI Integration

For GitHub Actions, consider using [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp) to replace separate `actions/setup-node`, package-manager setup, cache, and install steps with a single action.

```yaml
- uses: voidzero-dev/setup-vp@v1
  with:
    cache: true
- run: vp check
- run: vp test
```

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.
<!--VITE PLUS END-->
