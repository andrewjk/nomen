# The Echo Programming Language

**Statically typed. Compiled to native. Memory-safe by default.**

Echo is a statically-typed, compiled language that targets C and AArch64 assembly. It
draws from imperative, object-oriented, and functional paradigms, and ships with
structured concurrency and deterministic memory management.

## Features

- ✅ **Strict Typing** — Every variable has a type (inferred from literals when omitted)
- ✅ **Compiled** — Native code via the C or AArch64 backends
- ✅ **Memory Safe** — Auto-free at scope exit, `#destroy` functions, tracked nullable state
- ✅ **Ownership** — `mov` single-ownership and `ref` borrows for class instances
- ✅ **Structs & Classes** — Value-type structs and reference-type classes
- ✅ **Generics** — Type-safe generic structs with compile-time checking
- ✅ **Traits** — Interface-based polymorphism
- ✅ **Enums & Bitsets** — Sum types with associated data, plus composable bit flags
- ✅ **Operator Overloading** — Custom behavior for arithmetic operators
- ✅ **Constraints** — Compile-time assertions on parameters, fields, and variables
- ✅ **Tuples** — Anonymous positional structs with destructuring
- ✅ **Destructuring** — Tuple, array, struct, and class destructuring in one form
- ✅ **Higher-Order Functions** — First-class functions, lambdas, and closures
- ✅ **Structured Concurrency** — Nurseries, `spawn`, `Task`, `Channel`, `Mutex`
- ✅ **Sendable** — Marker trait for safe cross-task value movement

## Quick Start

### Hello, World!

```echo
import System

pub func main = () {
    Console.write_line("Hello, World!")
}
```

### Run a Program

```bash
lang --in path/to/program.echo
```

Target a specific backend:

```bash
lang --in path/to/program.echo --arch c         # emit C
lang --in path/to/program.echo --arch aarch64   # emit AArch64 assembly (default)
```

## Language Overview

### Data Types

```echo
const int i = 1
const uint u = 2
const int8 small = 3
const float f = 3.0
const string s = "hello"
const char c = 'h'
const bool ready = true
const int[] arr = [1, 2, 3]
var int? maybe = null
```

### Variables

```echo
const string name = "Alice"
var int age = 30
var count = 10  // Type inference
```

### Functions

```echo
func add = (int a, int b, out int) {
    return a + b
}

// Arrow syntax for a single-expression body (implicit return)
pub func double = (int x, out int) => x * 2

// Default parameter values
func greet = (string name = "world") {
    Console.write("Hello, \{name}!")
}

greet()
greet("Alice")

// Variadic parameters
func sum = (...int numbers, out int) {
    var total = 0
    var i = 0
    while i < numbers.length {
        total = total + numbers.at(i)
        i = i + 1
    }
    return total
}

sum(1, 2, 3)
```

### Control Flow

Echo has **no `else if`** — use a `switch` for chained conditions:

```echo
enum Direction {
    case north
    case south
    case east
    case west
}

var int x = 5
var Direction direction = Direction.north
const int[] items = [1, 2, 3]

if x > 0 {
    Console.write("positive")
} else {
    Console.write("zero")
}

switch {
    case x > 100 -> Console.write("big")
    case x > 10 -> Console.write("medium")
    else -> Console.write("small")
}

const label = match direction {
    case .north -> "N"
    case .south -> "S"
    else -> "?"
}

while x < 10; x += 1 {
    Console.write("\{x}")
}

for item of items {
    Console.write("\{item}")
}
```

### Structs

Structs are value types — assignment copies the fields. Construction calls a
struct's auto-generated `#init`:

```echo
pub struct Point {
    pub var int x
    pub var int y

    pub func translate = (var self, int dx, int dy) {
        self.x = self.x + dx
        self.y = self.y + dy
    }

    pub func distance_from_origin = (self, out int) {
        return self.x * self.x + self.y * self.y
    }
}

const p = Point(3, 4)
p.translate(1, 1)
const d = p.distance_from_origin()
```

### Anonymous Structs

An inline `[ field = value ]` literal can be passed wherever a struct is
expected — handy for calls without spelling out the type:

```echo
struct Circle {
    var string name
    var int center_x
    var int center_y
    var int radius
}

func print_circle = (Circle c) {
    Console.write("\{c.center_x},\{c.center_y},\{c.radius}")
}

print_circle([ name = "C", center_x = 25, center_y = 70, radius = 15 ])
```

All fields must be provided, by name.

### Classes

Classes are reference types — always heap-allocated and shared on assignment.
Methods use `var self` for mutable access:

```echo
class Counter {
    var int count = 0

    func increment = (var self) {
        self.count = self.count + 1
    }
}

var c = Counter()
c.increment()
```

### Enums

Enums are sum types. Cases can carry associated data, and shorthand `.case`
syntax works where the type is known:

```echo
pub enum Direction {
    case north
    case south
    case east
    case west
}

pub enum Shape {
    case circle(int radius)
    case rect(int width, int height)
}

var Direction dir = .east
const shape = Shape.rect(10, 20)
```

### Pattern Matching

`match` compares a value against cases and can bind the data a case carries. A
match on an enum is checked for exhaustiveness — cover every case, or add an
`else`:

```echo
const message = match shape {
    case .circle(r) -> "radius \{r}"
    case .rect(w, h) -> "\{w}x\{h}"
}
```

### Bitsets

A `bitset` defines flags meant to be combined with bitwise operators:

```echo
pub bitset Permissions {
    case read
    case write
    case execute
}

var flags = Permissions.read | Permissions.write
const can_write = (flags & Permissions.write) == Permissions.write
flags = flags ^ Permissions.execute
```

### Traits

Traits declare method signatures that implementing structs provide. A concrete
struct assigned to a trait-typed variable is callable through the trait's interface:

```echo
pub trait Printable {
    func to_string = (self, out string)
}

pub struct Point : Printable {
    pub var int x
    pub var int y

    pub func to_string = (self, out string) {
        return "Point(\{self.x}, \{self.y})"
    }
}

const Printable p = Point(1, 2)
const s = p.to_string()
```

### Operator Overloading

Structs define custom operator behavior with `#`-prefixed function names:

```echo
struct Vec2 {
    var int x
    var int y

    func #op_add = (self, Vec2 other, out Vec2) {
        return Vec2(self.x + other.x, self.y + other.y)
    }
}

const sum = Vec2(1, 2) + Vec2(3, 4)
```

### Constraints

Constraints are compile-time assertions on parameters, fields, and variables.
They are checked whenever the value is a compile-time constant:

```echo
func restricted = (int x: x > 5) {
    Console.write("\{x}")
}

restricted(10)   // OK
restricted(2)    // Error: Parameter constraint not satisfied
```

### Strings

```echo
const greeting = "Hello, " + name
const dashes = "-" * 10
Console.write("You are \{age} years old.")
```

### Arrays

```echo
var numbers = [1, 2, 3, 4, 5]
const first = numbers.at(0)
numbers.set(1, 99)

const combined = [1, 2] + [3, 4]
const repeated = [1, 2] * 3
```

### Tuples

Tuples are anonymous structs with positional fields `_0`, `_1`, ... and support
destructuring:

```echo
var things = [1, "first"]
Console.write("\{things._0} \{things._1}")

func get_person = (int id, out [string, int]) {
    return ["Andrew", id + 100]
}

var [name2, age2] = get_person(12)
```

### Destructuring

The `var [ ... ] = expr` form binds names by pulling values out of the
right-hand side. Tuples, arrays, structs, and classes are all supported — the
kind of value determines how the brackets are read:

```echo
// Tuples — bind positionally
func get_person = (int id, out [string, int]) {
    return ["Andrew", id + 100]
}
var [pname, page] = get_person(12)
var [a, b] = [11, "hello"]

// Arrays — bind positionally by index
const int[] nums = [1, 2, 3]
var [first, second, third] = nums

// Structs and classes — bind by field name (bare name or `field = name`)
struct Point {
    var int x
    var int y
}
const p = Point(3, 4)
var [x, y] = p
var [x = px, y = py] = p
```

Struct fields can be renamed with `[ field = name ]` and bound partially (only
the named fields, in any order). See [SPEC.md](SPEC.md#destructuring) for
details.

## Standard Library

The `System` library (in `core/System/`) is imported with `import System`.

### Console

```echo
Console.write("no newline")
Console.write_line("with newline")

const string line = Console.read_line()
const char c = Console.read_char()
const string p = Console.platform()
```

### Ansi

ANSI escape helpers for styling terminal output. Each helper wraps a string with
the relevant SGR sequence and a trailing reset:

```echo
Console.write("\{Ansi.bg_red("ERROR")}: it didn't work")
Console.write_line(Ansi.bold(Ansi.green("success")))
```

## Concurrency

Echo uses **structured concurrency via nurseries**: every concurrent split
rejoins before its lexical scope exits. See [ASYNC.md](ASYNC.md) for the full
design.

```echo
func fetch = (uint64 id) {
    Console.write_line("ok")
}

pub func main = () {
    async nursery {
        nursery.spawn(fetch(1))
        nursery.spawn(fetch(2))
        nursery.spawn(fetch(3))
        // block does not exit until all three fetches finish
    }
}
```

A `Task` handle lets you wait on or cancel a spawned call:

```echo
func compute = (uint64 n) => n + 1

pub func main = () {
    async nursery {
        var t = nursery.spawn(compute(41))
        t.wait()
        var uint64 r = t.result_uint64()
    }
}
```

## Memory Management

Echo cleans up automatically at scope exit — no garbage collector, no reference
counting. The compiler inserts the frees for you. Two hooks let types
participate:

```echo
struct Transaction {
    var int handle

    func #init = (self, int handle) {
        self.handle = handle
    }

    func #destroy = () {
        // runs automatically when a Transaction goes out of scope
    }
}
```

- `#init` customizes construction (an auto-generated one exists otherwise).
- `#destroy` runs at scope exit for structs and classes that own resources.
- Heap strings and class instances are freed automatically.

See [MEMORY.md](MEMORY.md) for the full model.

## Ownership & Borrows

Class instances are heap-allocated and, by default, shared on assignment. To
express single ownership, Echo borrows a few ideas from move semantics:

```echo
class Box {
    var int value
}

// an owning field — only classes can hold classes, and only via mov
class Holder {
    mov Box content
}

// an owning parameter — the caller gives up access with `mov`
func take = (mov Box b) {
    Console.write("\{b.value}")
}

var h = Holder(mov Box(7))
var b = Box(42)
take(mov b)   // b is invalid after this
```

- `mov` marks a class-typed field or parameter as owned (moved in).
- `ref` passes a value by reference (the caller must also write `ref` at the
  call site) — see "Reference Types" in [SPEC.md](SPEC.md).
- `swap` atomically moves a value out and replaces it with a fresh one.

See [BORROW.md](BORROW.md) for the rules and the borrow-invalidation checks.

## GUI

Echo ships a native UI layer in `core/System/Controls/`: windows, text,
buttons, checkboxes, and a layout engine + compositor. The example app in
`app/` is a small todo-list GUI built with it.

```echo
import System
import System/Controls

pub func main = () {
    var Window win = Window.create("Echo", 400, 300)
    var Text title = Text.create(win)
    title.set_text("Hello")
    win.show()
}
```

The layout engine is constraints-down, sizes-up (like Flutter/SwiftUI): parents
hand each child a size range, children report their intrinsic size, and the
engine resolves it into pixel frames. See [GUI.md](GUI.md) for the full
layout and compositor design.

## Language Notes

### Things to know

- **No `else if`** — use a `switch` for chained conditions.
- **`return` is mandatory** — a non-`void` function must `return` on every path.
- **`out` marks the return type** in the parameter list: `func f = (int a, out int)`.
- **Parameters are `const` by default** — use `var` for a mutable local copy, or
  `ref` for pass-by-reference. `ref` is required at both the definition and call
  site.
- **Logical operators** `&&`, `||`, `!` short-circuit; `&`, `|`, `^` are bitwise.
- **`break` / `continue`** work in `while` and `for` loops.
- **Structs are value types** (copied on assignment); **classes are reference
  types** (shared, unless moved with `mov`).
- **Memory is managed automatically** — at scope exit the compiler calls
  `#destroy` functions and frees heap strings and class instances.
- **`mov` marks single ownership** of a class — see [BORROW.md](BORROW.md).

## Project Structure

```
src/        — Compiler: tokenizer, parser, checker, builder
core/       — Standard library written in Echo (the System module)
bin/        — CLI entry point (the `lang` command)
app/        — Example GUI application
bench/      — Benchmarks (Echo alongside Go, Rust, Zig)
test/       — Test suite
test/spec/  — SPEC.md coverage tests
test/readme — README.md coverage tests
```

## Documentation

- [SPEC.md](SPEC.md) — Full language specification
- [MEMORY.md](MEMORY.md) — Memory model
- [BORROW.md](BORROW.md) — Ownership and borrow checking
- [ASYNC.md](ASYNC.md) — Concurrency design
- [AARCH64.md](AARCH64.md) — AArch64 backend details
- [GUI.md](GUI.md) — Layout engine and compositor

## License

ISC — see [package.json](package.json).
