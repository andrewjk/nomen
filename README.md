# The Nomen Programming Language

Nomen is a statically-typed, memory managed language that compiles to C and AArch64 assembly (macOS only for now).

It's intended to make memory safe programming easier than it has traditionally been while maintaining a relatively small surface area.

Most types of memory corruption (use before initialization, use after free, double free) should be caught at compile time and there's a simple constraints system to ensure that array bounds are checked before their items are accessed.

## Features

- **Typed Values** - bools, ints, strings and so forth
- **Structs & Classes** — value-type structs and reference-type classes
- **Automatic Memory Management** — `#init` functions to allocate resources, `#destroy` functions to clear them at scope exit
- **Ownership** — `mov` instances to a new owner, or share instances by `ref`
- **Borrowed Slices** — `view` instances are non-owning, zero-copy slices that can't outlive their source
- **Traits** — interface-based polymorphism
- **Enums & Bitsets** — sum types with associated data, plus composable bit flags
- **Operator Overloading** — custom behavior for arithmetic operators
- **Generics** — type-safe generic structs and classes with compile-time checking
- **Constraints** — compile-time assertions on parameters, fields, and variables
- **Higher-Order Functions** — first-class functions, lambdas, and closures
- **Structured Concurrency** — run concurrent tasks via OS threads
- **Core System Library** - small but growing, with data structures that remove the need for you to fight with the borrow checker
- **GUI System** - a top-down/bottom-up layout system and a few different native controls (WIP)
- **VS Code Extension** - with syntax highlighting for `.nm` files

## Quick Start

### Installation

Install the Nomen CLI using npm (or your preferred package manager):

```bash
npm i -g nomen-lang
```

There is also a VS Code extension that you can install by searching for `Nomen`.

### Run a Program

```bash
nomen --in path/to/program.nm
```

Target a specific backend:

```bash
nomen --in path/to/program.nm --arch c         # emit C
nomen --in path/to/program.nm --arch aarch64   # emit AArch64 assembly (default)
```

### Hello, World!

```nomen
import System

pub func main = () {
    Console.write_line("Hello, World!")
}
```

## Command-Line Interface

The `nomen` CLI has five commands: `run`, `build`, `check`, `format`, and `docs`. Top-level options:

| Option              | Alias | Description                                                                |
| ------------------- | ----- | -------------------------------------------------------------------------- |
| `--in <path>`       | `-i`  | Input `.nm` file or folder (auto-discovered if omitted).                   |
| `--out <path>`      | `-o`  | Declared but currently unused; output goes to `<root>/build/`.             |
| `--config <path>`   | `-c`  | Path to a JSON build config file.                                          |
| `--watch`           | `-w`  | Re-run the pipeline on file changes.                                       |
| `--arch <a>`        | `-a`  | Backend: `aarch64` (default) or `c`.                                       |
| `--platform <p>`    | `-p`  | Target: `macos`, `ios`, `linux`, `android`, `windows`, `web` (host-derived default). |
| `--lib <path>`      | `-l`  | Path to the `System` library directory.                                    |
| `--audit`           |       | Enable memory auditing of the generated program.                           |
| `--audit-runtime`   |       | Path to `audit_runtime.c` (used with `--audit`).                           |
| `--check`           |       | `format` dry-run: report changes without writing.                          |

See [CLI.md](CLI.md) for the full reference (commands, input resolution, build output, config files, and examples).

## Language Overview

See [SPEC.md](SPEC.md) for the full language specification.

### Value Types

```nomen
bool
int     // and int8, int16, int32 and int64
uint    // and uint8, uint16, uint32 and uint64
float   // and float32 and float64
string
char
null
```

### Variables

Variables can be `const` or `var`, and variable types can be nullable:

```nomen
const name = "Alice"
var age = 30
var uint count = 10
var int? maybe = null
```

### Strings

```nomen
const greeting = "Hello, " + name
const dashes = "-" * 10
Console.write("You are \{age} years old.")

const multiline =
    "Multiline strings start
    "with a double quote
    "on each line

// slice(start, end) returns a non-owning view string over [start, end)
if greeting.length >= 5 {
    var view string hi = greeting.slice(0, 5)
    Console.write(hi.to_string())   // "Hello"
}
```

### Functions

Note the `out` syntax for return types, which can be omitted when using the arrow form:

```nomen
func add = (int a, int b, out int) {
    return a + b
}

pub func double = (int x) => x * 2
```

Default parameters are supported:

```nomen
func greet = (string name = "world") {
    Console.write("Hello, \{name}!")
}
greet()         // "Hello, world!"
greet("Alice")  // "Hello, Alice!"
```

As are variadic parameters:

```nomen
func sum = (...int numbers, out int) {
    var total = 0
    while i < numbers.length; i += 1 {
        total = total + numbers.at(i)
    }
    return total
}
sum(1, 2, 3)    //
```

### Control Flow

`if` and `else`:

```nomen
var x = 5
if x > 0 {
    Console.write("positive")
} else {
    Console.write("zero")
}
```

There is no `else if`, use a `switch` instead:

```nomen
const x = 5
switch {
    case x > 100 {
        Console.write("big")
    }
    case x > 10 {
        Console.write("medium")
    }
    else {
        Console.write("small")
    }
}
```

`while` loops run while a condition is true and can take a post-condition that is run at the end of each loop:

```nomen
var x = 0
while x < 10 {
    Console.write("\{x}")
}

var y = 0
while y < 10; y += 1 {
    Console.write("\{y}")
}
```

`for` loops run over a set of items and can also take a post-condition:

```nomen
const numbers = [1, 2, 3]

for num of numbers {
    Console.write("\{num}")
}

var i = 1
for num of numbers; i += 1 {
    Console.write("\{i}: \{num}")
}
```

Inside a loop, `break` can be used to stop the loop and `continue` can be used to move to the next loop iteration.

You can use `let` or `->` to return a value from any control flow statement (analogous to `return` or `=>`):

```nomen
const x = 12

const y = if x > 100 -> "big"
          else -> "small"

const z = switch {
    case x > 100 -> "big"
    case x > 10 -> "medium"
    else -> "small"
}
```

There is also a `match` statement that we'll see a bit further down.

### Structs

Structs are value types — assignment copies the fields. Construction calls a
struct's auto-generated `#init`:

```nomen
pub struct Point {
    pub var int x
    pub var int y

    pub func translate = (ref self, int dx, int dy) {
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

### Classes

Classes are reference types — always heap-allocated and shared on assignment.
Methods use `ref self` for mutable access:

```nomen
class Counter {
    var int count = 0

    func increment = (ref self) {
        self.count = self.count + 1
    }
}

var c = Counter()
c.increment()
```

### Enums

Enums are sum types. Cases can carry associated data, and shorthand `.case`
syntax works where the type is known:

```nomen
pub enum Direction {
    case north
    case south
    case east
    case west
}

var Direction dir = .east

pub enum Shape {
    case circle(int radius)
    case rect(int width, int height)
}

const shape = Shape.rect(10, 20)
```

### Pattern Matching

`match` compares a value against cases and can bind the data a case carries. A
match on an enum is checked for exhaustiveness — cover every case, or add an
`else`:

```nomen
const message = match shape {
    case .circle(r) -> "radius \{r}"
    case .rect(w, h) -> "\{w}x\{h}"
}
```

### Bitsets

A `bitset` defines flags meant to be combined with bitwise operators:

```nomen
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

```nomen
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

```nomen
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

```nomen
func restricted = (int x: x > 5) {
    Console.write("\{x}")
}

restricted(10)   // OK
restricted(2)    // Error: Parameter constraint not satisfied
```

Indexes within a range are considered safe:

```nomen
func sum = (...int nums) {
    // not ok, because we don't know how many items are in nums:
    const first = nums.at(0)

    // ok, because we make sure we are in bounds:
    const second = if nums.length > 2 -> nums.at(1)
                   else -> -1

    // ok, because we know we are in bounds in each iteration:
    var result = 0
    for i in 0 .. nums.length {
        result += nums.at(i)
    }
}
```

### Strings

```nomen
const greeting = "Hello, " + name
const dashes = "-" * 10
Console.write("You are \{age} years old.")
```

### Arrays

```nomen
var numbers = [1, 2, 3, 4, 5]
const first = numbers.at(0)
numbers.set(1, 99)

const combined = [1, 2] + [3, 4]
const repeated = [1, 2] * 3
```

### Tuples

Tuples are anonymous structs with positional fields `_0`, `_1`, etc and that support
destructuring:

```nomen
var things = [1, "first"]
Console.write("\{things._0} \{things._1}")

func get_person = (int id, out [string, int]) {
    return ["Andrew", id + 100]
}

var [name2, age2] = get_person(12)
```

### Anonymous Structs

An inline `[ field = value ]` literal can be used rather than creating a new struct, and can be passed wherever a struct is
expected:

```nomen
struct Circle {
    var string name
    var int center_x
    var int center_y
    var int radius
}

func print_circle = (Circle c) {
    Console.write("\{c.center_x},\{c.center_y},\{c.radius}")
}

const c1 = [ name = "C", center_x = 25, center_y = 70, radius = 15 ]

print_circle(c1)
```

All fields must be provided, by name.

### Destructuring

The `var [ ... ] = expr` form binds names by pulling values out of the
right-hand side. Tuples, arrays, structs, and classes are all supported — the
kind of value determines how the brackets are read:

```nomen
// Tuples — bind positionally
func get_person = (int id, out [string, int]) {
    return ["Andrew", id + 100]
}
var [pname, page] = get_person(12)
var [a, b] = [11, "hello"]

// Arrays — bind positionally by index
const nums = [1, 2, 3]
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

## Standard Library

The `System` library (in `core/System/`) is imported with `import System`.

### Console

```nomen
Console.write("no newline")
Console.write_line("with newline")

const string line = Console.read_line()
const char c = Console.read_char()
const string p = Console.platform()
```

## Concurrency

Nomen uses **structured concurrency via nurseries**: every concurrent split
rejoins before its lexical scope exits.

```nomen
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

```nomen
func compute = (uint64 n) => n + 1

pub func main = () {
    async nursery {
        var t = nursery.spawn(compute(41))
        t.wait()
        var r = t.result_uint64()
    }
}
```

See [ASYNC.md](ASYNC.md) for the full design.

## Memory Management

Nomen cleans up automatically at scope exit — no garbage collector, no reference
counting. The compiler inserts the frees for you. Two hooks let types
participate:

```nomen
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

- `#init` customizes construction (an auto-generated one exists otherwise)
- `#destroy` runs at scope exit for structs and classes that own resources
- Heap strings and class instances are freed automatically

See [MEMORY.md](MEMORY.md) for the full model.

## Ownership & Borrows

Class instances are heap-allocated and, by default, shared on assignment. To
express single ownership, Nomen borrows a few ideas from move semantics:

```nomen
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
- `ref` passes a value by reference so the callee can mutate it; the caller must
  write `ref` at the call site, and a `const` value can't be borrowed mutably.
- Plain parameters are read-only — take them by value and make a local `var`
  copy if you need a mutable scratch value the caller never sees.
- `swap` atomically moves a value out and replaces it with a fresh one

The same borrow machinery backs **non-owning slices**. `string.slice(start, end)`
returns a `view string` — an O(1) `(ptr, len)` borrow of the source's buffer.
The checker guarantees a view can't outlive its source and is invalidated once
the source is reassigned (which frees the buffer it points into):

```nomen
var string s = "hello world"
var view string v = s.slice(0, 5)   // borrows from s
Console.write(v.to_string())        // "hello" — materializes an owned copy
s = "changed"                       // frees s's old buffer → v dangles
Console.write("\{v.length}")        // Error: borrow invalidated
```

See [BORROW.md](BORROW.md) for the rules and the borrow-invalidation checks.

## GUI

Nomen ships a native UI layer in `core/System/Controls/`: windows, text,
buttons, checkboxes, and a layout engine + compositor. The example app in
`app/` is a small todo-list GUI built with it.

```nomen
import System
import System/Controls

pub func main = () {
    var Window win = Window("Nomen", 400, 300)
    var Text title = Text(win)
    title.set_text("Hello")
    win.show()
}
```

The layout engine is constraints-down, sizes-up (like Flutter/SwiftUI): parents
hand each child a size range, children report their intrinsic size, and the
engine resolves it into pixel frames. See [GUI.md](GUI.md) for the full
layout and compositor design.

## Questions

**Why create a new language?** I'm hoping to find the sweet spot between the ease of use of garbage collected languages and the power of manual memory allocated languages, which I don't think anyone has found yet.

**Was AI used in the development of this programming language?** Yes, at the start of 2026 this was a much smaller hand-developed language with a half implemented C backend. Since then it has gained a fully implemented C backend, fully implemented AArch64 backend, and many features, all produced by AI under human guidance.

## Benchmarks

Adapted from [Programming Language Benchmarks](https://github.com/hanabi1224/Programming-Language-Benchmarks). Run on my laptop. Any errors in adaptation are my fault.

### Run times (single-size)

| Benchmark   | Nomen/A | Nomen/C |   Go |  Zig | Rust |  Compare |
| ----------- | ------: | ------: | ---: | ---: | ---: | -------: |
| helloworld  |     3ms |     3ms |  3ms |  3ms |  3ms | 1.0-1.0x |
| knucleotide |    12ms |    12ms | 19ms |  6ms | 10ms | 0.6-2.0x |
| regex-redux |    56ms |    40ms | 16ms | 18ms |  6ms | 3.1-9.3x |

### Run times (small)

| Benchmark      | Nomen/A | Nomen/C |    Go |   Zig |  Rust |   Compare |
| -------------- | ------: | ------: | ----: | ----: | ----: | --------: |
| pidigits       |   105ms |   232ms |  11ms |  33ms |  20ms |  3.2-9.5x |
| fannkuch-redux |   232ms |   274ms |  32ms | 201ms | 120ms |  1.2-7.2x |
| binarytrees    |   163ms |   142ms | 143ms | 125ms | 100ms |  1.1-1.6x |
| merkletrees    |   192ms |   174ms | 271ms | 125ms | 133ms |  0.7-1.5x |
| nsieve         |    70ms |    75ms |  FAIL |  40ms |  41ms |  1.7-1.8x |
| lru            |    10ms |    10ms |   7ms |   5ms |   7ms |  1.4-2.0x |
| json-serde     |    33ms |    29ms |   4ms |   9ms |  11ms |  3.0-8.2x |
| nbody          |   133ms |    83ms |  36ms |  20ms |  14ms |  3.7-9.5x |
| spectral-norm  |    44ms |    55ms |  12ms |  12ms |  10ms |  3.7-4.4x |
| mandelbrot     |   142ms |   194ms |  97ms |  14ms |  14ms | 1.5-10.1x |
| edigits        |     4ms |     5ms |   4ms |   4ms |   4ms |  1.0-1.0x |

### Run times (large)

| Benchmark      | Nomen/A | Nomen/C |     Go |    Zig |   Rust |   Compare |
| -------------- | ------: | ------: | -----: | -----: | -----: | --------: |
| pidigits       |  1908ms |  4005ms |  128ms |  560ms |  303ms | 3.4-14.9x |
| fannkuch-redux |  2869ms |  3379ms |  346ms | 2398ms | 1437ms |  1.2-8.3x |
| binarytrees    |  1724ms |  1517ms | 1766ms | 1329ms | 1068ms |  1.0-1.6x |
| merkletrees    |   901ms |   810ms | 1370ms |  568ms |  618ms |  0.7-1.6x |
| nsieve         |   280ms |   307ms |   FAIL |  283ms |  277ms |  1.0-1.0x |
| lru            |    29ms |    28ms |   17ms |    7ms |   13ms |  1.7-4.1x |
| json-serde     |   152ms |   136ms |    4ms |   27ms |   37ms | 4.1-38.0x |
| nbody          |  1305ms |   814ms |  329ms |  178ms |  125ms | 4.0-10.4x |
| spectral-norm  |   371ms |   483ms |   82ms |   82ms |   59ms |  4.5-6.3x |
| mandelbrot     |   562ms |   774ms |  371ms |   47ms |   47ms | 1.5-12.0x |
| edigits        |     8ms |    11ms |    3ms |    4ms |    3ms |  2.0-2.7x |

### Compile times

| Benchmark      | Nomen/A | Nomen/C |    Go |    Zig |   Rust |  Compare |
| -------------- | ------: | ------: | ----: | -----: | -----: | -------: |
| pidigits       |   614ms |   326ms | 207ms | 5254ms | 2943ms | 0.1-3.0x |
| helloworld     |   263ms |   266ms |  89ms | 4635ms | 1913ms | 0.1-3.0x |
| fannkuch-redux |   277ms |   280ms |  47ms | 4691ms | 1934ms | 0.1-5.9x |
| binarytrees    |   278ms |   274ms |  44ms | 4711ms | 1909ms | 0.1-6.3x |
| merkletrees    |   328ms |   276ms |  44ms | 4720ms | 1921ms | 0.1-7.5x |
| nsieve         |   281ms |   278ms |  FAIL | 4614ms | 1910ms | 0.1-0.1x |
| lru            |   304ms |   292ms |  69ms | 4733ms | 2091ms | 0.1-4.4x |
| knucleotide    |   307ms |   292ms |  70ms | 5353ms | 2307ms | 0.1-4.4x |
| json-serde     |   352ms |   311ms |  54ms | 5829ms | 2447ms | 0.1-6.5x |
| regex-redux    |   333ms |   300ms |  45ms | 5435ms | 6713ms | 0.0-7.4x |
| nbody          |   381ms |   300ms | 186ms | 4775ms | 2035ms | 0.1-2.0x |
| spectral-norm  |   283ms |   281ms |  45ms | 4775ms | 2194ms | 0.1-6.3x |
| mandelbrot     |   274ms |   274ms |  57ms | 4744ms | 2020ms | 0.1-4.8x |
| edigits        |   387ms |   323ms |  49ms | 5119ms | 2878ms | 0.1-7.9x |
