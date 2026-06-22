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
- **Null**: `null` (represents the absence of a value for nullable types)
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

### Nullable Types

Any type can be made nullable by appending `?`:

```
var int? x = null
var string? name = null
```

Nullable variables can hold either a value of the base type or `null`. Assigning `null` to a non-nullable type is a compile error:

```
const int x = null      // Error: cannot assign null to non-nullable int
var int? y = null        // OK
```

The compiler tracks which nullable variables are null. Using a null variable is a compile error:

```
var int? x = null
const y = x + 1          // Error: Variable 'x' is null
```

Nullable variables initialized with a non-null value can be used freely:

```
var int? x = 5
const y = x + 1          // OK, y = 6
```

### Constraints

Constraints are compile-time assertions on parameters, fields, and variables. They use `:` after the name followed by a boolean expression. When the value is a compile-time constant, the constraint is evaluated at compile time and violations produce errors.

#### Parameter Constraints

Function parameters can have constraints that are checked at every call site when the argument is a compile-time constant:

```
func restricted = (int x: x > 5) {
    Console.write("\\{x}")
}

restricted(10)   // OK, 10 > 5
restricted(2)    // Error: Parameter constraint not satisfied: x
```

Constraints can reference other parameters, including array properties like `.length`:

```
func safe_index = (string[] source, int i: i >= 0 && i < source.length) {
    return source.at(i)
}

const items = ["a", "b", "c"]
safe_index(items, 1)   // OK, 1 >= 0 && 1 < 3
safe_index(items, 5)   // Error: Parameter constraint not satisfied: i
```

Constraints also work with `const` variables passed as arguments:

```
func above_zero = (int x: x > 0) { ... }

const int threshold = 10
above_zero(threshold)   // OK, 10 > 0
```

#### Field Constraints

Struct and class fields can have constraints. Fields without default values that have constraints will have those constraints propagated to the auto-generated `#init` parameters:

```
struct Bounded {
    var int x: x > 0
    var int y: x < 100
}

const b = Bounded(5, 50)    // OK
const b = Bounded(-1, 50)   // Error: Parameter constraint not satisfied: x
```

Fields with default values are checked at definition time:

```
struct Config {
    var int retries: retries >= 0 = 3     // OK, 3 >= 0
    var int timeout: timeout > 0 = 0      // Error: Constraint not satisfied: timeout
}
```

#### Variable Constraints

Local variables can have constraints that are checked both at initialization and on reassignment:

```
func process = () {
    var int x: x > 5 = 10     // OK, 10 > 5
    x = 20                    // OK, 20 > 5
    x = 2                     // Error: Constraint not satisfied: x
}
```

#### How Constraints Are Evaluated

Constraints are only checked when the value is a compile-time constant (integer literals, boolean literals, or `const` variables with known values). When the value is not known at compile time (e.g. runtime input, function call results), the constraint is not evaluated and no error is produced.

Constraint expressions support:

- Comparisons: `>`, `<`, `>=`, `<=`, `==`, `!=`
- Logical operators: `&&`, `||`
- Array `.length` property
- References to other parameters/fields by name

### Reference Types

Any type can be made a reference type by prefixing with `ref`:

```
ref int       // reference to an int
ref Character // reference to a Character struct
ref Node?     // nullable reference to a Node
```

A `ref` type holds a pointer to a value rather than the value itself. This allows functions to modify caller variables and structs to link to other structs.

#### Reference Parameters

Functions can accept parameters by reference using `ref`. The caller must also use the `ref` keyword at the call site to make the mutation explicit:

```
func makeFive = (ref int x) {
    x = 5
}

var int num = 1
makeFive(ref num)
// num is now 5
```

Calling without `ref` at the call site is a compile error:

```
makeFive(num)  // Error: Missing 'ref' keyword for ref parameter 'x'
```

Using `ref` for a non-ref parameter is also an error:

```
func print = (int x) { ... }
print(ref 5)   // Error: Unexpected 'ref' keyword for non-ref parameter 'x'
```

#### Reference Struct Fields

Struct fields can be reference types, enabling linked data structures:

```
struct Node {
    var int value
    var ref Node next
}
```

A `ref` field is stored as a pointer (8 bytes), regardless of the underlying type size.

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

Structs are constructed by calling the struct name as a function. A `#init` function is auto-generated with parameters for all non-private fields that don't have default values:

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

    #init = (self, int x, int y) {
        self.x = x
        self.y = y
        self.sum = x + y
    }
}
```

### Destroy Functions

If a struct has a `#destroy` function, it runs automatically when the struct goes out of scope. The destroy function takes no parameters (besides `self`) and cannot be called manually.

```
pub struct Transaction {
    pub int handle

    #init = (self, int handle) {
        self.handle = handle
    }

    func #destroy = () {
        // automatically runs when the Transaction goes out of scope
    }
}
```

### Class Types

Classes are reference types — they are always allocated on the heap and passed by pointer. Assigning a class variable to another creates a shared reference to the same instance, not a copy.

```
class Point {
    var int x
    var int y
}
```

Classes are constructed the same way as structs, by calling the name as a function:

```
var p = Point(1, 2)
```

#### Assignment Semantics

Unlike structs, which are value types copied on assignment, classes share the underlying instance:

```
var p = Point(10, 20)
var q = p
q.x = 99
// p.x is now also 99 — p and q point to the same instance
```

#### Methods

Class methods use `var self` to declare mutable access to the instance:

```
class Counter {
    var int count

    func increment = (var self) {
        self.count = self.count + 1
    }
}
```

Methods are called with dot syntax on the instance:

```
var c = Counter(0)
c.increment()
```

#### Destroy Functions

Like structs, classes support `#destroy` functions that run automatically when the class instance goes out of scope:

```
class Resource {
    var int handle

    func #destroy = () {
        self.handle = -1
    }
}
```

#### Passing to Functions

Classes passed as function parameters share the same heap instance. Modifications inside the function are visible to the caller:

```
func getX = (Point p) {
    return p.x
}
```

### Generic Structs

Structs can declare type parameters using `<T>` syntax. Type parameters are type-erased at the storage level — all values are 8 bytes on aarch64, so `T` is purely for compile-time type checking with no monomorphization.

```
pub struct List<T> {
    var int length = 0
    var int capacity = 0
    var int items = 0

    pub func push = (self, T value) { ... }
    pub func pop = (self, out T) { ... }
}
```

Generic structs are instantiated by providing concrete type arguments in the constructor call:

```
var List<int> numbers = List<int>()
numbers.push(42)
const int top = numbers.pop()
```

Type parameters can be used in:

- Field types
- Parameter types
- Return types (`out T`)

Within the struct body, type parameters match any concrete type during type checking. At the call site, the type argument (`<int>`) ensures the correct types are enforced.

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

## Enums

Enums are used to define a restricted set of options:

```
pub enum Direction {
    case north
    case east
    case south
    case west
}

var direction = Direction.north
```

Enum values can be compared and reassigned:

```
if direction == Direction.north {
    direction = Direction.south
}

const label = if direction == Direction.north -> "N"
              else -> "S"
```

Enum shorthand syntax (`.case_name`) can be used when the type is known from context:

```
var Direction dir = .east
dir = .west

if dir == .north {
    Console.write("north")
}
```

Shorthand is resolved in declarations with explicit type, assignments (inferred from target type), and comparisons (inferred from left operand type). Shorthand is only for simple case access — cases with associated data must use the full form `EnumName.case(args)`.

Enum cases can contain information:

```
pub enum Result {
    case ok
    case error(int code)
}

var result = Result.error(5)
```

Enum cases can have multiple fields:

```
pub enum Shape {
    case circle(int radius)
    case rect(int width, int height)
}

var shape = Shape.rect(10, 20)
```

## Bitsets

Bitsets are used to define a restricted set of options that can be combined using bitwise operators:

```
pub bitset Permissions {
    case read
    case write
    case execute
}

var perms = Permissions.read | Permissions.write
```

Bitset values can be combined, checked, and toggled:

```
var flags = Permissions.read

// Add an option
flags = flags | Permissions.write

// Check if an option is set
const can_write = (flags & Permissions.write) == Permissions.write

// Toggle an option
flags = flags ^ Permissions.execute
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
- `null` → `null` (requires explicit nullable type annotation)

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

#### Variadic Parameters

Functions can accept a variable number of arguments using `...` before the parameter type. Inside the function, the variadic parameter is treated as an array:

```
func sum = (...int numbers, out int) {
    var total = 0
    var i = 0
    while i < numbers.length {
        total = total + numbers.at(i)
        i = i + 1
    }
    return total
}

sum(1, 2, 3)    // 6
sum(42)          // 42
sum()            // 0
```

Variadic parameters can be mixed with regular parameters. The variadic parameter must be the last parameter before any `out` return type:

```
func add_to = (int base, ...int numbers, out int) {
    var total = base
    var i = 0
    while i < numbers.length {
        total = total + numbers.at(i)
        i = i + 1
    }
    return total
}

add_to(10, 1, 2, 3)  // 16
```

Variadic parameters work with any type, including strings:

```
func count = (...string items, out int) => items.length

count("a", "b", "c")  // 3
```

Constraints:

- A variadic parameter must be the last parameter in the parameter list
- Variadic parameters cannot have default values
- The type is required (no inference)

#### `var` and `ref` Parameters

Parameters are `const` by default. Use `var` for mutable local copies, or `ref` for pass-by-reference:

```
func increment = (var int x, out int) {
    x = x + 1
    return x
}

func makeFive = (ref int x) {
    x = 5  // modifies the caller's variable
}
```

`var` creates a mutable copy — changes don't affect the caller. `ref` passes a pointer to the caller's variable — changes are visible to the caller. The `ref` keyword is required at both the definition and call site (see [Reference Types](#reference-types)).

#### Function-Typed Parameters (Higher-Order Functions)

Parameters can be function types:

```
func apply = (func (int, out int) mapper, int value, out int) {
    return mapper(value)
}
```

#### Function Overloading

Multiple struct methods can share the same name if their parameter types differ:

```
struct Vec2 {
    var int x
    var int y

    pub func scale = (self, int s) {
        self.x = self.x * s
        self.y = self.y * s
    }

    pub func scale = (self, Vec2 other) {
        self.x = self.x * other.x
        self.y = self.y * other.y
    }
}

const v = Vec2(2, 3)
v.scale(4)       // calls scale(int) -> (8, 12)
v.scale(v)       // calls scale(Vec2) -> (16, 36)
```

Overload resolution matches by the number and types of non-`self` parameters. Operators can also be overloaded:

```
struct Vec2 {
    var int x
    var int y

    pub func #op_add = (self, Vec2 other, out Vec2) {
        return Vec2(self.x + other.x, self.y + other.y)
    }

    pub func #op_add = (self, int scalar, out Vec2) {
        return Vec2(self.x + scalar, self.y + scalar)
    }
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

Match with enums (using shorthand syntax):

```
enum Direction {
    case north
    case south
    case east
    case west
}

var direction = Direction.north
match direction {
    case .north -> Console.write("north")
    case .south -> Console.write("south")
    case .east -> Console.write("east")
    case .west -> Console.write("west")
}
```

Enum case values can use either shorthand (`.north`) or full form (`Direction.north`). Matches on enums without an `else` branch must be exhaustive — all enum cases must be covered, or a compile error is produced.

Match with bools:

```
match flag {
    case true -> Console.write("yes")
    case false -> Console.write("no")
}
```

Match on `bool` without an `else` branch must cover both `true` and `false`. Match on `int` and other types does not require exhaustiveness — an `else` branch is optional.

Match with enums and associated data:

```
enum Result {
    case ok
    case error(int code)
}
const result = Result.error(10)
const message = match result {
    case .ok -> "it's ok"
    case .error(code) -> "error \{code} encountered"
}
```

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

// Null
var int? nothing = null
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

Structs can define custom behavior for operators using `#`-prefixed function names:

```
struct Vec2 {
    var int x
    var int y

    func #op_add = (self, Vec2 other, out Vec2) {
        return Vec2(self.x + other.x, self.y + other.y)
    }

    func #op_mul = (self, int scalar, out Vec2) {
        return Vec2(self.x * scalar, self.y * scalar)
    }
}
```

Supported operator functions: `#op_add` (+), `#op_sub` (-), `#op_mul` (\*), `#op_div` (/), `#op_mod` (%).

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

Structs can define custom cast behavior with `func #op_as`:

```
struct Dog {
    var int value

    func #op_as = (self, out Cat) {
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

Arrays and strings are accessed via `.at()` and modified via `.set()`:

```
const arr = [10, 20, 30]
const first = arr.at(0)  // 10
arr.set(1, 99)           // arr is now [10, 99, 30]

const str = "hello"
const second = str.at(1)  // 'e' (as char)
```

The `.at()` method has a compile-time bounds check when the index is a constant:

```
const arr = [10, 20, 30]
const x = arr.at(5)  // Error: Parameter constraint not satisfied
```

### Spread

Array literals support a spread syntax (`...`) to flatten an array into individual arguments:

```
const a = [1, 2, 3]
const b = [...a, 4, 5]  // [1, 2, 3, 4, 5]
```

This is used internally by `Array.#init` to copy elements from a variadic parameter list into the array's storage.

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

- `pub`: Public (accessible from the parent scope)
- `private`: Private (accessible only within the same struct or scope)

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

- Calls destroy functions on structs and classes going out of scope
- Frees heap-allocated strings and class instances
- Cleans up all intermediate scopes on `break`, `continue`, and `return`

See [MEMORY.md](MEMORY.md) for the full memory model description.

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
