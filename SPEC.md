# Echo Language Specification

## Overview

Echo is a statically-typed, compiled language that compiles to C or AArch64 assembly. It supports features from imperative, object-oriented, and functional paradigms.

## Comments

```
// Single-line comment

/* Block comment
   /* nested comments supported */ */
```

## Types

### Basic Types

- **Integers**: `int`, `uint`, `int8`, `int16`, `int32`, `int64`, `uint8`, `uint16`, `uint32`, `uint64`
- **Floating-point**: `float`, `float32`, `float64`
- **String**: `string` (C-style null-terminated string)
- **Character**: `char` (8-bit character)
- **Boolean**: `bool`
- **Void**: `void` (used for functions with no return value)

### Array Types

Arrays are declared as `T[]` where `T` is the element type:

```
const int[] numbers = [1, 2, 3, 4]
const char[] letters = ['a', 'b', 'c']
```

Arrays can optionally specify a fixed length: `T[N]`

```
const int[10] buffer = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
```

Array length can be accessed via `.length`:

```
const len = numbers.length
```

### Range Types

Ranges produce an array of integers from `start` to `end` (exclusive):

```
const range = 0..10     // [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
```

### Struct Types

User-defined types with fields and methods:

```
pub struct Point {
    pub var int x
    pub var int y

    pub func add = (self, Point other, out Point) { ... }
}
```

Structs are constructed by calling the struct name as a function. An `init` function is auto-generated with parameters for all non-private fields that don't have default values:

```
const point = Point(5, 10)
```

### Initializers

Initializer functions must set all properties that don't have default values, and can set const property values.

```
pub struct Point {
    pub int x
    pub int y
    pub int sum

    init (self, int x, int y) {
        self.x = x
        self.y = y
        self.sum = x + y
    }
}
```

### Finalizers

If a struct has one or more `final` functions, one of them must be called before the struct is disposed.

```
pub struct Transaction {
    pub int handle

    init func init = (var self, int handle) {
        self.handle = handle
    }

    final func commit = () {
        // commit the transaction
    }

    final func undo = () {
        // undo the transaction
    }
}
```

### Trait Types

Interfaces that can be implemented by structs:

```
pub trait Addable {
    func add = (self, Self other, out Self)
}
```

Structs implement traits using `:` syntax. Multiple traits are separated by commas:

```
struct Dog : Animal, Named {
    // ...
}
```

Structs implementing a trait can be assigned to trait-typed variables:

```
const Named named = Dog("Rex")
```

Trait functions without bodies are declarations (the implementing struct must provide the body):

```
pub trait Printable {
    func to_string = (self, out string)
}
```

## Declarations

### Variables

```
const string name = "Alice"
var int age = 30
var count = 10  // Type inference
```

Types are inferred from initializers when omitted:

- `true`/`false` → `bool`
- `"..."` → `string`
- `'h'` → `char`
- integers → `int`
- floats → `float`

### Functions

```
pub func greet = (string name) {
    Console.write("Hello, \\{name}.\\n")
}

pub func add = (int a, int b, out int) {
    return a + b
}

// Arrow syntax for single-expression body (implicit return)
pub func double = (int x, out int) => x * 2
```

The first parameter of a struct or trait function named `self` is automatically typed as the parent struct:

```
pub struct Point {
    var int x

    // `self` is automatically typed as `Point`
    pub func get_x = (self, out int) {
        return self.x
    }
}
```

Return types are specified with `out` before the type in the parameter list.

#### Default Parameter Values

Parameters can have default values:

```
func greet = (string name = "world") {
    Console.write("Hello, \\{name}!")
}

greet()        // "Hello, world!"
greet("Alice") // "Hello, Alice!"
```

#### `var` and `cp` Parameters

Parameters are `const` by default. Use `var` for mutable parameters:

```
func increment = (var int x, out int) {
    x = x + 1
    return x
}
```

#### Function-Typed Parameters (Higher-Order Functions)

Parameters can be function types:

```
func apply = (func (int, out int) mapper, int value, out int) {
    return mapper(value)
}
```

#### Anonymous Functions (Lambdas)

```
// Arrow expression (implicit return)
var func (int, int, out int) adder = (a, b, out int) => a + b

// Arrow with block body
var func (int, out int) doubler = (x, out int) => {
    return x * 2
}

// Block without arrow
var func (int, out int) tripler = (x, out int) {
    return x * 3
}
```

#### Nested Functions and Structs

Functions and structs can be defined inside other functions:

```
func process = (int value, out int) {
    struct Wrapper {
        var int inner
    }

    func double = (int x, out int) {
        return x * 2
    }

    const w = Wrapper(value)
    return double(w.inner)
}
```

### Imports

```
import ModuleName
```

### Structs

```
pub struct Console {
    pub func write = (string line) {
        // Inline code for built-in functions
        #arch: c
        printf("%s", line);
        #endarch

        #arch: aarch64
        sub sp, sp, #16
        mov x1, x0
        str x1, [sp]
        adr x0, .Lfmt_console_s
        bl _printf
        add sp, sp, #16
        #endarch
    }
}
```

### Traits

```
pub trait Printable {
    func to_string = (self, out string)
}
```

## Statements

### If/Else

```
if x > 0 {
    Console.write("positive")
} else {
    Console.write("zero")
}
```

### If Expression (with `->` return syntax)

```
const result = if condition -> "yes"
               else -> "no"
```

### Match Statement

Match compares a value against cases:

```
const result = match x {
    case 1 -> "one"
    case 2 -> "two"
    else -> "other"
}
```

Each `case` value is type-checked against the match expression type. Branches can use `->` for expression return or `{ }` for block body. The `else` branch is required when using `match` as an expression value.

### Switch Statement

Switch evaluates independent boolean conditions:

```
switch {
    case x > 100 -> "big"
    case x > 10 -> "medium"
    else -> "small"
}
```

Unlike `match`, each `case` has its own boolean condition. The `else` branch is required when using `switch` as an expression value.

### While Loop

```
while x < 10 {
    Console.write(x)
    x += 1
}

// With update clause
while x < 10; x += 1 {
    Console.write(x)
}
```

### For Loop

For-each over arrays:

```
const int[] items = [1, 2, 3]
for item of items {
    Console.write(item)
}
```

Range iteration:

```
for i of 0..10 {
    Console.write(i)
}
```

With update clause:

```
var total = 0
for item of items; total += item {
    // total accumulates after each iteration
}
```

### Break and Continue

```
while true {
    if should_exit {
        break
    }
    if should_skip {
        continue
    }
    // ...
}
```

### Return

```
return value
```

### Let and Arrow Shorthand

Both `let` and `->` can be used as alternatives to `return` in expression position (e.g. in `if`, `match`, or `switch` branches):

```
const result = if x > 0 -> "yes"
               else -> "no"

const result = if x > 0 let "yes"
               else let "no"
```

### Panic

```
panic "something went wrong"
panic("with parens")
```

Terminates the program with the given message.

### Todo

```
todo "not implemented yet"
todo("with parens")
```

Marks unimplemented code. Prints the message and exits at runtime. Satisfies return requirements so code containing `todo` type-checks correctly.

## Expressions

### Literals

```
// Numbers
const int a = 42
const float b = 3.14
const int c = -5

// Strings (multiline supported - start continuation lines with ")
const string s = "Hello, World!"
const string multi =
    "Line 1
    "Line 2

// Characters
const char c = 'h'

// Booleans
const bool flag = true
```

### Arrays

```
const numbers = [1, 2, 3, 4, 5]
const empty = []

// Array operations
const combined = [1, 2] + [3, 4]    // [1, 2, 3, 4]
const repeated = [1, 2] * 3         // [1, 2, 1, 2, 1, 2]
```

### Ranges

```
const range = 0..5     // [0, 1, 2, 3, 4]
```

### Operators

#### Arithmetic

- `+`, `-`, `*`, `/`, `%` (modulo)
- `+=`, `-=`, `*=`, `/=`, `%=` (compound assignment)

#### Comparison

- `==`, `!=`, `<`, `<=`, `>`, `>=`

#### Logical

- `&&` (AND), `||` (OR), `!` (NOT)

#### Bitwise

- `<<`, `>>` (bit shift)
- `&` (bitwise AND), `|` (bitwise OR), `^` (bitwise XOR)

#### Operator Precedence (lowest to highest)

| Precedence | Operators                         |
| ---------- | --------------------------------- |
| 1          | `=`, `+=`, `-=`, `*=`, `/=`, `%=` |
| 2          | `\|\|`                            |
| 3          | `&&`                              |
| 4          | `\|`                              |
| 5          | `^`                               |
| 6          | `&`                               |
| 7          | `==`, `!=`                        |
| 8          | `<`, `<=`, `>`, `>=`              |
| 9          | `<<`, `>>`                        |
| 10         | `+`, `-`                          |
| 11         | `*`, `/`, `%`                     |
| 12         | `!` (unary NOT)                   |

#### Operator Overloading

Structs can define custom behavior for operators using the `op` keyword:

```
struct Vec2 {
    var int x
    var int y

    op + (self, Vec2 other, out Vec2) {
        return Vec2(self.x + other.x, self.y + other.y)
    }

    op * (self, int scalar, out Vec2) {
        return Vec2(self.x * scalar, self.y * scalar)
    }
}
```

Supported operator mappings: `+` → `add`, `-` → `sub`, `*` → `mul`, `/` → `div`, `%` → `mod`.

### Cast Operator (`as`)

Explicit type conversion using `as`:

```
const int x = 42
const float f = x as float
const int8 b = x as int8
```

Allowed casts:

- `int` ↔ `int` (any sizes)
- `int` ↔ `float`
- `float` ↔ `float`
- `bool` ↔ `int`
- `char` ↔ `int`

#### Custom Struct Casting

Structs can define custom cast behavior with `op as`:

```
struct Dog {
    var int value

    op as (self, out Cat) {
        return Cat(self.value + 1)
    }
}

const dog = Dog(9)
const cat = dog as Cat
```

#### Implicit Casting

Automatic widening is allowed without `as`:

- Smaller int types to larger int types of same signedness
- Unsigned to signed if target is larger

### String Operations

```
const greeting = "Hello, " + name     // Concatenation
const dashes = "-" * 10              // Repetition: "----------"
```

### String Interpolation

Expressions are embedded in strings with `\{...}`. Each expression has `.to_string()` called automatically:

```
Console.write("Hello, \\{name}. You are \\{age} years old.")
Console.write("\\{arr}")             // Arrays stringify element-by-element
```

### Indexing

```
const arr = [10, 20, 30]
const first = arr[0]  // 10

const str = "hello"
const second = str[1]  // 'e' (as char)
```

### Field Access

```
const point = Point(5, 10)
const x = point.x
```

### Method Calls

```
// Instance method
point.add(other)

// Static method
const result = Math.power(2, 10)
```

## Visibility Modifiers

- `pub`: Public (accessible from anywhere)
- `mod`: Module-level (accessible within the same module only — this is the default)
- `priv`: Private (accessible only within the same struct or scope)

## Type Coercion

### Literal Coercion

Numeric literals are coerced if they fit in the target type:

```
const int8 x = 42      // Valid
const uint8 y = 255    // Valid
const int8 z = 256     // Error: value out of range
```

### Type-to-Type Coercion

Integer types can coerce to larger or same-signedness types:

```
const uint8 a = 255
const int b = a        // Valid: uint8 fits in int
const uint c = a       // Valid: uint8 fits in uint
```

Rules:

- Can coerce to larger or same-size type of same signedness
- Unsigned can coerce to signed if target is larger
- Signed cannot coerce to unsigned

## Inline Code

Built-in functions can use architecture-specific inline code:

```
#arch: c
// C code
#endarch

#arch: aarch64
// AArch64 assembly
#endarch
```

Raw code can also be written using backtick blocks or the `raw` keyword:

```
raw "inline code here"
```

## Auto-free

At the end of each scope, the compiler automatically:

- Calls `dispose()` on variables implementing the `Disposable` trait
- Frees non-static strings
- Tracks allocation counts

## Calling Conventions

### C Backend

- Standard C calling convention
- Returns values in registers or via stack for structs

### AArch64 Backend

- Parameters: x0-x7 (static methods start at x0, instance methods at x1)
- Return value: x0
- Static methods: params in x0, x1, x2, ...
- Instance methods: self in x0, params in x1, x2, ...

## Code Style

- Line width: 100 characters
- Imports: parent directories (`^[../]`) first, then local directories (`^[./]`)
- Types/Classes: PascalCase (`FunctionNode`, `Type`)
- Functions/Variables: snake_case (`tokenize`, `parse_statement`)
- Constants: SCREAMING_SNAKE_CASE (`COMPOUND_SYMBOLS`)
