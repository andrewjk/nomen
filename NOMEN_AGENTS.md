# AGENTS.md

This is a [Nomen](https://github.com/andrewjk/nomen) project. This file orients
coding agents working in this codebase.

## Commands

```bash
nomen run                 # build + run src/main.nm
nomen build               # build only (no run); emits build/
nomen check               # parse + type-check only (fastest verification)
nomen test                # discover and run every *.test.nm
nomen format              # reformat every .nm file in place
nomen docs                # generate markdown docs into docs/
```

Flags worth knowing:

- `--in <path>` override the entry file/folder
- `--arch c` emit C instead of AArch64 assembly
- `--platform macos|ios|linux|android|windows|web` target platform
- `--watch` rebuild on change
- `-f <regex>` filter which test files run

## Review Checklist

- [ ] `nomen check` passes (fast; catches parse + type errors)
- [ ] `nomen test` passes
- [ ] `nomen format` produces no diffs (run it, then re-`check`)

## Language Directives

The rules below trip up newcomers and LLMs. Follow them.

### Prefer implicit types

Nomen infers types from initializers and return values. Don't spell them out
unless the inference would be wrong or the annotation materially aids a public
API. This includes generic instantiations — an initializer like
`split_lines(text)` already says `List<Line>`.

```nomen
const x = 5                        // good — inferred int
const int x = 5                    // avoid
const lines = split_lines(text)     // good — inferred List<Line>
const List<Line> lines = split_lines(text)  // avoid
const msg = "hi"                   // good
var items = [1, 2, 3]              // good — int[]
```

Annotate when you need a wider type (`int64` rather than `int`), when there is
no initializer, or on a `pub` API where the type is the contract.

### Loop updates go in the header

`for` and `while` take a post-statement after the condition, C-`for` style.
Don't bury the update as the last statement of the body.

```nomen
while i < n; i += 1 { ... }   // good — update in the header
while i < n { ...; i += 1 }   // avoid
```

Only hoist an update that runs on every iteration — if a `continue` (or early
`return` that isn't meant to advance) must skip it, keep it in the body.

### No `else if` — use `switch`

Nomen forbids `else if` and `else { if { … } }` chains. Consecutive sibling
`if`s on mutually exclusive conditions are the same smell (and a `did_x` flag
set only to gate the next `if` is a giveaway): fold them into a `switch`,
which evaluates cases in order and runs the first true one.

```nomen
switch {
	case moved { ... }
	case is_ins { ... }
	else { ... }
}
```

Independent conditions that can all fire stay as separate `if`s.

### Constraints are compile-time assertions

`name: <bool expr>` after a parameter, field, or variable. Only evaluated when
the value is a compile-time constant; constraints on fields propagate to the
auto-generated `#init` parameters.

```nomen
func div = (int a, int b: b != 0, out int) => a / b
func safe = (string[] s, int i: i >= 0 && i < s.length, out string) {
	return s.at(i)
}
```

### Memory modifiers

| Modifier | Meaning                                        |
| -------- | ---------------------------------------------- |
| `ref T`  | mutable borrow; caller must also write `ref`   |
| `view T` | read-only borrow                               |
| `move T` | transfer ownership; caller writes `move`       |
| `out T`  | output parameter, assigned inside the function |

`const` values cannot be passed to `ref` — rebind the caller as `var` first.

### Return types are `out` at the end

A function's return type is written as a final, unnamed `out T` parameter:

```nomen
func add = (int a, int b, out int) => a + b
func greet = (string name, out void) { Console.write("hi \{name}\n") }
```

`out void` may be omitted.

### Nullable tracking is static

`T?` is nullable. The compiler tracks nullness flow; using a variable that is
currently `null` is a **compile error**, not a runtime one.

```nomen
var int? x = null
const y = x + 1     // Error: 'x' is null
```

### Visibility

`pub` exports. `internal` is visible only within the declaring library/module
(the System library uses it to hide implementation details). Everything else is
private to its declaring scope.

### Imports

```nomen
import System                  // standard library
import System::Test            // submodule
import System::Controls::Geometry // a single module file
```

Import paths must mirror the library's file layout — a typo'd path
(`import System::Contrls`) is a compile error.

Files in the same folder are one module — they already see each other's
declarations, so never import a sibling. Only cross-namespace references
(subfolders, libraries) need an import.

### No exceptions

Failures are signalled via return values — nullable results, status structs,
or boolean + out-parameter pairs. There is no `throw`/`try`/`catch`.

`Result<T, E>` is declared `must_use`: a call returning it must bind or match
the value (`var _ = f.close()` to discard deliberately; a bare `f.close()`
statement is a compile error). Any enum or bitset can opt into this with the
`must_use` modifier.

## Tests

A test is any `pub func <name> = (ref Tester t)` in a `*.test.nm` file.
Use `t.expect(cond, "msg")` for assertions and `t.bench("label", fn)` for
benchmarks.

```nomen
import System
import System::Test

func add = (int a, int b, out int) => a + b

func add_once = () {
	const int r = add(1, 1)
}

pub func test_add = (ref Tester t) {
	t.expect(add(1, 1) == 2, "1 + 1 should be 2")
}

pub func bench_add = (ref Tester t) {
	t.bench("add", add_once)
}
```

## Quick Syntax Reference

### Declarations

```nomen
const x = 5                          // immutable
var int y = 10                       // mutable, explicit type
const int[] nums = [1, 2, 3]
const int[10] buf = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]  // fixed-length
var int? maybe = null                // nullable
ref int ptr                          // reference to an int
```

Keywords (`out`, `in`, `match`, `if`, `of`, `as`, `swap`, …) are reserved and
cannot be used as variable, parameter, field, type, or case names. Function
names are exempt since calls go through `.name(...)` (e.g. `Regex.match`).

### Functions

```nomen
func add = (int a, int b, out int) => a + b   // expression body
func greet = (string name) {                  // block body; out void omitted
	Console.write("hi \{name}\n")
}
pub func main = (Init init) { ... }           // program entry point
```

Special function names: `#init` (constructor), `#destroy` (auto-raii destructor).

### Control flow

```nomen
if cond { ... }
switch x {
	0 { ... }
	1 { ... }
	else { ... }
}
for i of 0 .. 10 { ... }       // exclusive range
for item of array { ... }
while cond { ... }
while cond; update { ... }     // post-statement (e.g. while i < n; i += 1)
```

### Structs and classes

```nomen
pub struct Point {
	pub var int x
	pub var int y
	pub func add = (self, Point other, out Point) {
		Point(self.x + other.x, self.y + other.y)
	}
}

class Node {                   // class = heap-allocated, reference semantics
	var int value
}
```

Construct by calling the type name as a function: `Point(1, 2)`.

### Strings

```nomen
const name = "world"
Console.write("hello \{name}\n")   // interpolation with \{...}
Console.write_line("with newline")
```

### Traits

```nomen
trait Drawable {
	pub func draw = (ref self)
}

pub struct Circle {
	pub var int radius
	pub func draw = (ref self) { /* ... */ }
}
```

### Arrays

```nomen
const nums = [1, 2, 3]
nums.length                    // 3
nums.at(0)                     // 1
nums.set(0, 99)
const typed = Array<int>(1, 2, 3)
for n of nums { Console.write("\{n}\n") }
```

## Reference

- Full language spec: [SPEC.md](https://github.com/andrewjk/nomen/blob/main/SPEC.md)
- Memory model: [MEMORY.md](https://github.com/andrewjk/nomen/blob/main/MEMORY.md)
