# Nomen Language Specification

## Overview

Nomen is a statically-typed, compiled language that compiles to C or AArch64 assembly. It supports features from imperative, object-oriented, and functional paradigms.

## Comments

```
// Single-line comment

/* Block comment
   /* nested comments supported */ */
```

## Reserved Words

The following words are reserved by the language and cannot be used as
variable, parameter, field, type, or enum case names:

`as` `async` `bitset` `break` `case` `class` `const` `continue` `cp` `else`
`enum` `extern` `extend` `for` `func` `if` `import` `in` `internal` `let`
`match` `move` `of` `out` `panic` `private` `pub` `raw` `readonly` `ref`
`return` `struct` `switch` `swap` `todo` `trait` `unsafe` `var` `view`
`while`

The literals `true`, `false`, and `null`, and `self`, are reserved as well.
Using a reserved word as a name is a compile error:

```
var out = StringBuilder()
// Error: 'out' is a reserved word and cannot be used as a name
```

Function and method names are exempt: the name after `func` is unambiguous,
and calls always go through `.name(...)` access, so library methods may use
reserved words (e.g. `Text::Regex.match(...)`):

```
const string m = Regex.match("[0-9]+", "abc123")
Console.write("\{m}")
```

## Types

### Basic Types

- **Integers**: `int`, `uint`, `int8`, `int16`, `int32`, `int64`, `uint8`, `uint16`, `uint32`, `uint64`
- **Floating-point**: `float`, `ufloat`, `float32`, `ufloat32`, `float64`, `ufloat64` (the `u` variants are unsigned)
- **String**: `string` (C-style null-terminated string)
- **Character**: `char` (8-bit character)
- **Boolean**: `bool`
- **Null**: `null` (represents the absence of a value for nullable types)
- **Void**: `void` (used for functions with no return value)

Numeric literals coerce into sized numeric types when the value fits. Unsigned
types (`uint*`, `ufloat*`) reject negative literals:

```
var int16 small = 300
var int doubled = small * 2
var ufloat ratio = 0.5
var ufloat scaled = ratio * 2.0
Console.write("\{doubled} \{scaled}\n")
```

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

### `Array<T>` Type

`Array<T>` is a generic alias for the array type `T[]`. It provides the same
storage and operations as `T[]` but makes the element type explicit, which is
useful for type inference and for passing arrays through generic boundaries:

```
const ints = Array<int>(1, 2, 3)   // equivalent to [1, 2, 3] as int[]
var Array<string> names = ["a", "b"]

// Type args can be supplied at the constructor for clarity
const nums = Array<int>(0, 1, 2)
```

`Array<T>` supports static methods such as `Array.with(...)` to build an array
from repeated or variadic elements. When the type argument is omitted, `T` is
inferred from the first argument:

```
const zeros = Array.with(0, 3)      // Array<int> of [0, 0, 0] (inferred int)
const strs = Array<string>.with("x", 2)  // Array<string> of ["x", "x"]
```

Internally `Array<T>` is identical to `T[]`; casts, indexing (`.at`/`.set`),
and `.length` behave the same. `Array<T>` is the canonical spelled-out form
used throughout this document wherever a typed array is needed (e.g. tuples vs.
arrays at line 422).

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
func safe_index = (string[] source, int i: i >= 0 && i < source.length, out string) {
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

A `const` value cannot be passed to a `ref` parameter — a mutable borrow requires
a mutable value. Declare the caller's binding as `var` first:

```
const int fixed = 1
makeFive(ref fixed)   // Error: Cannot pass const 'fixed' to ref parameter 'x'

var int mutable = 1
makeFive(ref mutable) // OK — mutable is now 5
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

Structs are constructed by calling the struct name as a function. A `#init` function is auto-generated with parameters for all non-private fields that don't have default values:

```
const point = Point(5, 10)
```

#### Readonly Fields

A `readonly` field is readable wherever the field is visible, but assignable
only from within the declaring struct or class's own methods (including its
`extend` blocks):

```
struct Counter {
    readonly count = 0

    func bump = (ref self) {
        self.count = self.count + 1
    }
}

var Counter c = Counter()
c.bump()
Console.write("\\{c.count}")   // 1
```

Writing a `readonly` field from outside its declaring type is an error:

```
struct Counter {
    readonly count = 0
}

var Counter c = Counter()
c.count = 5
// Error: Cannot assign to readonly field 'count' from outside Counter
```

A `const` field, by contrast, is immutable everywhere — even inside the
declaring type.

### Initializers

Initializer functions must set all properties that don't have default values, and can set const property values.

```
pub struct Point {
    pub int x
    pub int y
    pub int sum

    func #init = (ref self, int x, int y) {
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

    func #init = (ref self, int handle) {
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

Class methods use `ref self` to declare mutable access to the instance:

```
class Counter {
    var int count

    func increment = (ref self) {
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

    func #destroy = (ref self) {
        self.handle = -1
    }
}
```

#### Passing to Functions

Function parameters are **read-only by default**: a plain `(Point p)` parameter
cannot be mutated inside the body. This holds for both structs (an immutable
copy) and classes (a shared instance you may read but not write):

```
func getX = (Point p) {
    return p.x
}
```

To mutate a parameter's value, declare it with `ref` (a mutable borrow the
caller must acknowledge at the call site). See [Reference Parameters](#reference-parameters).

For a mutable scratch value that the caller never observes, take the parameter
read-only and make a local `var` copy inside the body:

```
func add_five = (int x, out int) {
    var int y = x      // mutable local copy
    y = y + 5
    return y
}
```

`var`/`cp` parameters are not supported — mutation that the caller observes must
go through `ref`, and mutation that only the callee needs uses a local `var`.

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

### Anonymous Structs

An anonymous struct is an inline collection of named fields written `[ field = value, ... ]`. It has no declared name — the compiler generates one, and every literal with the same field names and types shares a single generated type, regardless of the order the fields are written in.

#### As standalone values

Used as a value, an anonymous struct is materialized into a generated struct so its fields can be read and destructured like any struct:

```
const p = [ name = "bob", age = 5 ]
Console.write("\\{p.name} \\{p.age}")    // bob 5

var [name, age] = p                       // destructure by field name
```

The type is inferred from the literal and has no source-level name, so an anonymous struct can only be used where its type can be inferred — a `const`/`var` initializer, a reassignment, or a return value. It is not implicitly coerced to a named struct; to build a named struct, call its constructor.

#### Overriding fields on construction

A struct literal may be seeded from a base expression with `..`, then override fields by name. The base runs first (its required fields are set positionally by the constructor call); each named field must have a declared default and is applied after the base is constructed:

```
struct LayoutParams {
    var int grow = 0
    var int shrink = 0
}

const LayoutParams DEF = [ .. LayoutParams(), grow = 2, shrink = 3 ]
const LayoutParams ONE = [ .. LayoutParams(), grow = 7 ]
```

The base may be any value-struct expression — a constructor call, a factory function's result, or a plain variable (a copy; an owning struct requires `move` or `.copy()`):

```
func layout = (int grow, out LayoutParams) {
    return [ .. LayoutParams(), grow = grow, shrink = 3 ]
}

const LayoutParams DEF = [ .. LayoutParams(), grow = 2, shrink = 3 ]
const LayoutParams TWO = [ .. DEF, grow = 2 ]
```

`[ .. <base>, ... ]` is an ordinary expression and works in declarations, assignments, return values, and call arguments. Overrides may only target fields with a declared default; required fields are set positionally by the constructor call.

### Tuple Types

Tuples are anonymous struct types with positional fields named `_0`, `_1`, `_2`, etc. They allow grouping heterogeneous values without defining a named struct.

#### Tuple Type Declaration

```
var [int, string] things
var [int, string, bool] triple
```

#### Tuple Values

```
var things = [1, "first"]                    // inferred as [int, string]
var triple = [42, "hello", true]             // [int, string, bool]
```

When no explicit type is provided, a bracket-enclosed heterogeneous list is inferred as a tuple. To create a typed array instead, use `Array<T>`:

```
var Array<int> nums = [1, 2, 3]             // typed array, not tuple
var mixed = [1, "hello"]                     // inferred as [int, string] tuple
```

#### Field Access

Tuple fields are accessed with underscore-prefixed indices:

```
var [int, string] things = [42, "answer"]
Console.write("\\{things._0} \\{things._1}")  // "42 answer"
```

#### Destructuring

Tuples can be destructured into individual variables. See [Destructuring](#destructuring)
for the full set of forms (arrays, structs, and classes are also supported):

```
func get_person = (int id, out [string, int]) {
    return ["Andrew", id + 100]
}

var [name, age] = get_person(12)
Console.write("\\{name} \\{age}")  // "Andrew 112"
```

Destructuring also works with tuple literals:

```
var [a, b] = [11, "hello"]
Console.write("\\{a} \\{b}")  // "11 hello"
```

#### Tuple Return Types

Functions can return tuples:

```
func make_pair = (int a, int b, out [int, int]) {
    return [a, b]
}

const p = make_pair(10, 20)
Console.write("\\{p._0} \\{p._1}")  // "10 20"
```

#### Tuples as Struct Fields

Tuples can be used as struct fields:

```
struct Container {
    var [int, string] payload
}

const c = Container([99, "bottles"])
Console.write("\\{c.payload._0} \\{c.payload._1}")  // "99 bottles"
```

#### Variadic Tuple Parameters

Functions can accept variable numbers of tuple arguments using `...` before a tuple type:

```
func sum_pairs = (...[int, int] pairs, out int) {
    var total = 0
    var i = 0
    while i < pairs.length {
        total = total + pairs.at(i)._0 + pairs.at(i)._1
        i = i + 1
    }
    return total
}

sum_pairs([1, 2], [3, 4])  // 10 (1+2 + 3+4)
sum_pairs()                 // 0
```

Variadic tuples can be mixed with regular parameters:

```
func sum_with_base = (int base, ...[int, int] pairs, out int) {
    var total = base
    var i = 0
    while i < pairs.length {
        total = total + pairs.at(i)._0 + pairs.at(i)._1
        i = i + 1
    }
    return total
}

sum_with_base(100, [1, 2], [3, 4])  // 110
```

Variadic tuples work with mixed types:

```
func first_parts = (...[string, int] pairs, out string) {
    var result = ">"
    var i = 0
    while i < pairs.length {
        result = result + pairs.at(i)._0
        i = i + 1
    }
    return result
}

first_parts(["count", 1], ["sum", 2])  // ">countsum"
```

### Anonymous Enums

An anonymous enum is an inline sum type written `[.case, .case(Type, ...), ...]`. It has no declared name — the compiler generates one, and every annotation with the same case names and payload types shares a single generated type, regardless of the order the cases are written in.

Unlike an anonymous struct (a value whose type is inferred), an anonymous enum is written as a _type_: a single-case literal like `.error("bad")` cannot imply the full case set, so the bracketed form appears in annotations and values use the existing `.case` shorthand, resolved against the context type.

```
func parse_age = (string s, out [.ok(int), .error(string)]) {
    return .error("not a number")
}

var [.ok(int), .error(string)] result = .ok(42)
match result {
    case .ok(age) -> Console.write("\\{age}")
    case .error(msg) -> Console.write("error \\{msg}")
}
```

Cases may carry no payload, and the type can be used anywhere a named enum can — parameter types, return types, and declarations:

```
func describe = ([.some(int), .none] opt, out string) {
    return match opt {
        case .some(v) -> "some"
        case .none -> "none"
    }
}

Console.write(describe(.none))  // "none"
```

Like anonymous structs, anonymous enums are not implicitly coerced to or from named enums.

### Destructuring

The `var [ ... ] = expr` (or `const [ ... ] = expr`) form binds one or more
names by pulling values out of the right-hand side. The kind of value on the
right determines how the brackets are interpreted — no extra syntax is needed
to distinguish them:

- **Tuple** — bind positionally via `_0`, `_1`, ... (see [Tuple Types](#tuple-types))
- **Array** — bind positionally by index (`.at(i)`)
- **Struct / class** — bind by field name

A binding name of `_` discards that position for arrays and tuples (no
variable is introduced):

```
const int[] nums = [1, 2, 3]
var [first, _, last] = nums
Console.write("\\{first} \\{last}")  // "1 3"
```

#### Array Destructuring

A bracket-enclosed list of names on the left of an array binds each element by
position:

```
const int[] arr = [1, 2, 3]
var [a, b, c] = arr
Console.write("\\{a} \\{b} \\{c}")  // "1 2 3"
```

Array destructuring is positional — the first name binds to index 0, the
second to index 1, and so on. Renaming (`[0 = first]`) is not supported for
arrays.

Because each position is a compile-time constant, arrays may only be
destructured when their length is **known at compile time** (literals, constant
ranges, `Array.with`, etc.). Destructuring more values than the array holds is a
compile error:

```
var [a, b, c] = [1, 2]  // error: cannot destructure index 2 of an array with length 2
```

Destructuring an array whose length is not statically known (for example a
function parameter typed `int[]`) is also a compile error.

#### Tuple Destructuring

A tuple on the right-hand side is bound positionally — the first name binds to
`_0`, the second to `_1`, and so on:

```
var [a, b] = [11, "hello"]
Console.write("\\{a} \\{b}")  // "11 hello"
```

Binding more names than the tuple has elements is a compile error:

```
var [a, b, c] = [1, "two"]  // error: cannot destructure index 2 of a tuple with 2 elements
```

#### Struct and Class Destructuring

A struct or class on the right-hand side is destructured **by field name**. A
bare name binds a field of the same name:

```
struct Point {
    var int x
    var int y
}

const p = Point(3, 4)
var [x, y] = p
Console.write("\\{x} \\{y}")  // "3 4"
```

To bind a field to a differently named variable, use `[ field = name ]`:

```
const p = Point(3, 4)
var [x = px, y = py] = p
Console.write("\\{px} \\{py}")  // "3 4"
```

Fields can be destructured partially — only the named fields are bound, in any
order:

```
struct Box {
    var int width
    var int height
    var int depth
}

const b = Box(2, 4, 6)
var [width = w, depth = d] = b
Console.write("\\{w} \\{d}")  // "2 6"
```

Classes work identically (the right-hand side is a class instance):

```
class Counter {
    var int count
    var int total
}

var c = Counter(5, 50)
var [count = n, total = t] = c
Console.write("\\{n} \\{t}")  // "5 50"
```

Referencing a field that does not exist on the struct or class is a compile
error. The destructured bindings are non-owning views into the right-hand
side value, so they are not freed at scope exit (the right-hand side retains
ownership).

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

### Extension Methods

Methods may be added to an existing struct or class outside its body with an `extend` block. `extend struct Name` adds to a struct, `extend class Name` to a class (the keyword must match the type). Only methods may be added — fields would change the type's layout, which a value-type language cannot do out of line. Once merged, the methods are indistinguishable from ones declared in the original body: same dispatch, same visibility, same name-overloading rules.

```
struct Point {
    var int x
    var int y
}

extend struct Point {
    pub func manhattan = (self, out int) {
        return self.x + self.y
    }
}

const p = Point(3, 4)
const int m = p.manhattan()
```

`extend` blocks may appear before or after the type they target, and may target a type from another module (including standard-library types). A method that redeclares an existing method name with the same parameter types is a duplicate error; overloads with differing parameter types are allowed. A method declared `extend` can call an in-body method on the same type, and vice versa.

An `extend` may also make an existing type conform to one or more traits out of line by listing them after `:`. The required trait methods may be supplied in the same extend's body, another extend, or the original body:

```
trait Stringable {
    func to_string = (out string)
}

struct Circle {
    var int radius
}

extend struct Circle : Stringable {
    func to_string = (out string) {
        return "Circle"
    }
}

const Stringable s = Circle(5)
```

A trait the target already conforms to (from its body or a prior `extend`) is a duplicate error. Out-of-line conformance is indistinguishable from body-declared conformance: same vtable dispatch, same generic-trait argument handling, same auto-derived methods.

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

### Generic Enums

Enums can declare type parameters. Case payloads may use them; each concrete instantiation gets its own monomorphized type (`Result<int, string>` becomes `Result_int_string`):

```
pub enum Result<T, E> {
    case ok(T value)
    case error(E error)
}

var Result<int, string> result = .error("not a number")
match result {
    case .ok(age) -> Console.write("\\{age}")
    case .error(msg) -> Console.write("error \\{msg}")
}
```

Shorthand cases resolve against the concrete instantiation, and the full form uses the generic name with explicit type arguments:

```
var Option<int> found = Option.some(4)
found = .none
```

The core library ships two generic enums. `Result` is declared `must_use`:

```
pub must_use enum Result<T, E> {
    case ok(T value)
    case error(E error)
}

pub enum Option<T> {
    case some(T value)
    case none
}
```

Because `Result` is must_use, a fallible call's value may not be silently discarded — see [Strict Enums](#must_use-enums).

### must_use Enums

An enum declared with the `must_use` modifier may not have its values silently discarded: a statement-position call whose result is a must_use enum value is a compile error. Bind the value or match on it — ignoring is fine, it just has to be deliberate (`_` discards explicitly):

```
pub must_use enum Attempt {
    case ok
    case error(int code)
}

func try_it = (out Attempt) {
    return Attempt.error(5)
}

var _ = try_it()      // explicit discard
const r = try_it()    // bound: a use
match try_it() {
    case .ok -> Console.write("ok")
    case .error(code) -> Console.write("error \{code}")
}
```

A bare statement call discards the value and is rejected:

```
try_it()  // error: value of must_use enum Attempt is discarded
```

`must_use` composes with visibility and generics (`pub must_use enum Result<T, E>`), and carries across monomorphized instantiations (`Result<int, string>` stays must_use).

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

Like enums, bitsets can be declared `must_use` (`pub must_use bitset Flags`), with the same discard rules — see [Strict Enums](#must_use-enums).

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

`view` declares a non-owning borrow binding (a `(ptr, len)` slice). A bare
`view` is an immutable (const) view; `var view` is a mutable view you can
re-point. The element type is inferred. See [Slicing](#slicing).

```
view hi = greeting.slice(0, 5)       // const view, inferred `view string`
var view cursor = greeting.slice(0, 3)  // mutable, re-pointable
```

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

A func type can also be spelled `Func<...>` — every type argument but the
last is a parameter type, and the last is the result. `void` in the result
slot means the function returns nothing:

```
func apply = (Func<int, int> mapper, int value, out int) {
    return mapper(value)
}

var Func<int, int> doubler = (x) => x * 2
var Func<int> three = () => 3
var Func<int, void> log = func (int x) { Console.write("\\{x}") }
```

A `func` type may itself appear inside another signature — as a parameter
type or in the return slot. A `func`-typed return (`out func (...)`) makes
the function a closure factory: the returned closure is OWNED by the
caller (a capturing one is move-only, like any capturing value).

```
func twice = (func (out int) f, out int) { return f() + f() }

func make_adder = (int n, out func (out int)) {
    return () => n
}

func make_three = (out Func<int>) {
    return () => 3
}
```

Higher-order signatures nest to arbitrary depth, mixing both spellings:

```
func run = (func (func (out int), out int) g, func (out int) v, out int) {
    return g(v)
}

func run_alias = (Func<Func<int, int>, int> h, Func<int, int> f, out int) {
    return h(f)
}
```

A func value's signature must match where it is used: an argument against
the parameter's signature, a returned value against a `func`-typed return,
and an initializer or assignment against the declared type. The comparison
covers the parameter count, each parameter type (nested func parameters
included), and the result type.

#### Extern Functions

A body-less `extern func` declaration maps a Nomen function onto a C
library symbol named by the declared function name. Parameters and return
types must be scalars or `string`. A `string` parameter marshals to the
thin C `char*` (the buffer is NUL-terminated), and a `string` return is
re-wrapped as an owned string with its length. Externs are library-only:
declaring one outside the System library is a compile error.

```
// In the System library (core/System/Init.nm):
extern func atoi = (string s, out int)

pub func parse_int = (string s, out int) {
    return atoi(s)
}
```

#### Function Overloading

Multiple struct methods can share the same name if their parameter types differ:

```
struct Vec2 {
    var int x
    var int y

    pub func scale = (ref self, int s) {
        self.x = self.x * s
        self.y = self.y * s
    }

    pub func scale = (ref self, Vec2 other) {
        self.x = self.x * other.x
        self.y = self.y * other.y
    }
}

const v = Vec2(2, 3)
v.scale(4)       // calls scale(int) -> (8, 12)
v.scale(v)       // calls scale(Vec2) -> (16, 36)
```

Constructors (`#init`) overload the same way — the call's arguments select the overload:

```
struct Point {
    var int x
    var int y

    pub func #init = (ref self, int x, int y) {
        self.x = x
        self.y = y
    }

    pub func #init = (ref self, int x) {
        self.x = x
        self.y = 0
    }
}

const a = Point(2, 3)   // calls #init(int, int)
const b = Point(5)      // calls #init(int)
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

// Keyword form (block body, explicit return)
var func (int, out int) quadrupler = func (x, out int) {
    return x * 4
}
```

`=>` is always followed by a single expression, which the lambda returns
implicitly; a block body requires the `func` keyword and explicit `return`
statements (`(x, out int) => { ... }` and the bare `(x, out int) { ... }`
block are syntax errors).

A lambda may capture locals and parameters of the enclosing function. The
capture is taken once, when the lambda value is created:

- Scalars and non-owning value structs are **copied** (a later write to the
  source is not seen by the lambda).
- Strings are **deep-copied**.
- Owning value structs, class instances, class-backed trait references, and
  other func-valued closures are **moved** into the closure; the donating local
  is invalidated (using it again is a use-after-move error). A capturing
  closure is move-only: initializing or assigning a func-typed binding from one
  transfers it.
- `ref`/`var` borrows, views, arrays, raw pointers, value-struct trait slots,
  and borrowed or aliased class references cannot be captured.

```
pub func main = () {
    var int base = 10
    var func (int, out int) add_base = (x, out int) => x + base
    Console.write("\\{add_base(1)} \\{add_base(2)}")
}
```

Both shapes also work INLINE as call arguments, where no target signature
is available for inference: an arrow expression infers its return from the
body (`apply(() => a + b)`), while a self-typed keyword block must declare
its return (`apply(func (out int) { return a + b })`) — a block body that
returns a value without a declared `out T` is rejected.

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

Imports can also specify a namespace path using `::` to pull in a sub-namespace
of a module:

```
import System::Controls   // imports the Controls namespace from System
import System::Controls::Geometry   // imports a single module file
```

An import path must mirror the library's file layout — a namespace directory
or a module file. A path that names nothing (`import System::Contrls`, note
the typo) is a compile error: `Unknown import path: System::Contrls`.

Imports must appear at the top level (root scope) — an `import` inside a
function, struct, or other scope is a compile error.

#### Qualified References

Code can reference a library type, free function, or value through its
namespace path with `::`. Qualified references resolve to the same flat names
as their unqualified forms; the path prefix documents (and the compiler
validates) where the name comes from:

```
import System

const ok = Text::Regex.test("a+b", "aaab")
const size = System::Controls::Geometry::Size()
```

A `::` path always names an entity — a type, a free function, or a value.
Member and method access stays with `.` (`Text::Regex.test(...)`, not
`Text::Regex::test(...)`).

Every segment before the last must be a namespace of an imported library (or
the path must start with `System`); `Control::Button` (note the missing `s`)
is a compile error: `Unknown namespace: Control`.

### Method/Function Calls as Expressions

`match`, `switch`, and `if`/`else` can all be used as expressions (assigned to
a `const`/`var` or returned). When used as an expression, the `else` branch is
required for `match` (on non-exhaustive types) and `switch`, and the branch
types must be compatible:

```
const label = match x {
    case 1 -> "one"
    case 2 -> "two"
    else -> "other"
}

const size = switch {
    case x > 100 -> "big"
    case x > 10 -> "medium"
    else -> "small"
}

const verdict = if ok -> "yes"
                else -> "no"
```

Exhaustiveness rules (see [Match Statement](#match-statement) and
[Switch Statement](#switch-statement)) apply identically whether the construct
is used as a statement or as an expression. `let` and `->` are interchangeable
for the branch value (see [Let and Arrow Shorthand](#let-and-arrow-shorthand)).

### Structs

Structs group related data and behavior. Fields are declared with `var` (or
`const` for compile-time-known values) and methods are declared as functions
whose first parameter is `self`. A `#init` function is auto-generated from the
non-private fields that have no default value, so a struct can be constructed by
calling its name as a function:

```
pub struct Point {
    pub var int x
    pub var int y

    pub func translate = (ref self, int dx, int dy) {
        self.x = self.x + dx
        self.y = self.y + dy
    }

    pub func distance_from_origin = (ref self, out int) {
        return (self.x * self.x + self.y * self.y)
    }
}

const p = Point(3, 4)     // auto-generated #init
p.translate(1, 1)
const d = p.distance_from_origin()   // 3*3 + 4*4 = 25
```

Fields without default values that have constraints propagate those
constraints to the generated `#init` parameters (see
[Field Constraints](#field-constraints)). You can also define a custom `#init`
to take full control of construction (see [Initializers](#initializers)). A
struct is a value type: assigning it copies the fields. For shared-reference
semantics, use a [Class](#class-types).

### Traits

Traits declare a set of method signatures that implementing structs must
provide. A trait method listed without a body is a declaration — the struct that
implements the trait supplies the implementation. Traits enable polymorphic
behavior: a value of a concrete struct can be assigned to a variable typed as
the trait.

```
pub trait Printable {
    func to_string = (self, out string)
}

pub struct Point {
    pub var int x
    pub var int y

    // Implements Printable.to_string
    pub func to_string = (self, out string) {
        return "Point(\{self.x}, \{self.y})"
    }
}

// Assign a concrete struct to a trait-typed variable
const Printable p = Point(1, 2)
const s = p.to_string()   // "Point(1, 2)"
```

A struct implements one or more traits with `:` syntax, separating multiple
traits by commas (see [Trait Types](#trait-types)). Trait-typed variables can
only call methods declared by the trait; fields and non-trait methods of the
underlying struct are not accessible through the trait reference.

### Auto-Derived Methods

Conforming to `Stringable`, `Equatable`, or `Hashable` auto-generates the
matching method when the struct does not supply it itself — the same way a
struct gets an auto-generated `#init`. A hand-written method always wins. The
derivation only fires when every field is itself derivable (a primitive or a
conforming struct); otherwise the struct must provide the method by hand.

```
pub struct Point: Equatable, Stringable {
    pub var int x
    pub var int y
}

const a = Point(1, 2)
const b = Point(1, 2)
const bool same = a == b            // true  — derived #op_eq
const bool diff = a != b            // false — derived from #op_eq
const string s = a.to_string()      // "Point(x=1, y=2)" — derived to_string
```

`Stringable` derives a `to_string` that lists each field as `name=value`.
`Equatable` derives `#op_eq` (and `!=` as its negation) by comparing fields with
`==`. `Hashable` derives a `hash` method (returning `uint`) by combining field
values. Nested structs participate as long as they conform to the same trait.

## Statements

### If/Else

The condition must be a `bool`. The `else` branch is optional. Both branches may
be a single expression (using `->` or `let`) or a block (`{ }`):

```
if x > 0 {
    Console.write("positive")
} else {
    Console.write("zero")
}
```

An `if`/`else` with no `else` used as an expression yields `void` when taken and
`null`-like when skipped, so an `else` is required for a non-`void` result:

```
const result = if x > 0 -> "positive"
               else -> "zero"
```

`else if` is **not** supported. Use a `switch` for chained conditions instead:

```
switch {
    case x > 0 -> Console.write("positive")
    case x < 0 -> Console.write("negative")
    else -> Console.write("zero")
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

Loop iterators are **const by default**. Use `for ref x of arr` to get mutable
element access — the loop variable is a mutable copy whose fields you can
change, and each element is written back to the array at the end of the
iteration (including before `break`/`continue`):

```
var Point[] points = [Point(0, 0), Point(0, 0)]
for ref p of points {
    p.x = 1     // mutates the element in the array
}
```

`for ref` requires a `var` array (a `const` array is rejected) and is only
valid for arrays, not ranges or Enumerable types.

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

### `let` vs `->` Outside Expressions

`let` and `->` are interchangeable in expression position (if/match/switch
branches, see [Let and Arrow Shorthand](#let-and-arrow-shorthand)). `let` is
**not** an implicit `return`: a function must use an explicit `return` to
produce its value:

```
func build = (int x, out string) {
    return "value is \{x}"
}
```

A standalone `let` statement outside of expression position (e.g. at the top
level of a function body, not as an `if`/`match`/`switch` branch) is a compile
error. `let` in a non-returning scope (e.g. the top level or a plain block) is
also a compile error, since there is no enclosing expression to bind it to.

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

// Integer literals in other bases
const int hex = 0xFF            // hexadecimal (255)
const int oct = 0o377           // octal      (255)
const int bin = 0b11111111      // binary     (255)
const int group = 0xCAFE_F00D   // underscores are digit separators

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

Integer literals may be written in four bases. Hexadecimal literals use a `0x`
prefix, octal a `0o` prefix, and binary a `0b` prefix; all are case-insensitive
and type-inferred as `int`:

```
const int mask = 0xFF00FF00
const int perms = 0o755
const int flags = 0b101010
```

Underscores may be used as digit separators in any base (`1_000`, `0xCAFE_F00D`,
`0b1010_1010`); they are ignored. Non-decimal literals coerce to any integer
type whose range fits, just like decimal literals (see [Type Coercion](#type-coercion)):

```
const uint8 byte = 0xFF         // Valid: 255 fits in uint8
const uint8 overflow = 0x100    // Error: 256 out of range
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

Supported operator functions: `#op_add` (+), `#op_sub` (-), `#op_mul` (\*), `#op_div` (/), `#op_mod` (%), `#op_eq` (==), `#op_ne` (!=).

`#op_eq` and `#op_ne` are duals: defining either one gives you both `==` and
`!=`. A struct with `#op_eq` but no `#op_ne` gets `!=` as the logical negation
of `==` (and vice versa):

```
struct Vec2 {
    var int x
    var int y

    func #op_eq = (self, Vec2 other, out bool) {
        return self.x == other.x && self.y == other.y
    }
}

const a = Vec2(1, 2)
const b = Vec2(1, 2)
const bool same = a == b   // true
const bool diff = a != b   // false
```

Each maps to the corresponding infix operator and compound-assignment form:

```
struct Vec2 {
    var int x
    var int y

    func #op_add = (self, Vec2 other, out Vec2) {
        return Vec2(self.x + other.x, self.y + other.y)
    }

    func #op_sub = (self, Vec2 other, out Vec2) {
        return Vec2(self.x - other.x, self.y - other.y)
    }

    func #op_mul = (self, Vec2 other, out Vec2) {
        return Vec2(self.x * other.x, self.y * other.y)
    }

    func #op_div = (self, Vec2 other, out Vec2) {
        return Vec2(self.x / other.x, self.y / other.y)
    }

    func #op_mod = (self, Vec2 other, out Vec2) {
        return Vec2(self.x % other.x, self.y % other.y)
    }
}

const a = Vec2(4, 6)
const b = Vec2(1, 2)
const sum = a + b   // Vec2(5, 8)
const diff = a - b  // Vec2(3, 4)
const prod = a * b  // Vec2(4, 12)
const quot = a / b  // Vec2(4, 3)
const rem = a % b   // Vec2(0, 0)
```

Compound assignment (`+=`, `-=`, `*=`, `/=`, `%=`) routes to the same operator
functions when the left operand is a struct with the matching `#op_*` defined.

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

### Slicing

`slice(start, end)` returns a non-owning `view T` — a `(ptr, len)` borrow of
the half-open range `[start, end)` into the source's buffer. It is O(1): no
elements are copied. The element type `T` is the container's element (`char`
for `string`, `T` for `Array<T>` / `List<T>`). Use `.at(i)` / `.length` to read
the slice in place, and `.to_string()` (string views only) to materialize an
owned copy.

A view binding must be declared with the `view` keyword so the borrow
semantics are visible at the declaration site. `view` alone is an immutable
(const) view; `var view` is a mutable view you can re-point at another slice.
The element type and `view` modifier are inferred, so you rarely write them:

```
const str = "hello world"
view v = str.slice(0, 5)          // const view, type inferred as `view string`
Console.write(v.to_string())      // "hello"
Console.write("\\{v.length}")         // 5

const int[] nums = [10, 20, 30, 40, 50]
view s = nums.slice(1, 4)         // `view int`
Console.write("\\{s.length}")          // 3
Console.write("\\{s.at(0)}")           // 20
Console.write("\\{s.at(2)}")           // 40

var List<int> list = List<int>()
list.push(1); list.push(2); list.push(3)
view t = list.slice(0, 2)         // delegates to the backing Buffer's slice
Console.write("\\{t.at(1)}")           // 2
```

Binding a view without `view` is an error:

```
var v = str.slice(0, 5)   // Error: binding a view requires the 'view' keyword
```

The explicit type forms are equivalent to the inferred ones — `view string v`
and `const view string v` are both const views, `var view string v` is a
mutable view:

```
var view string greeting = "hello world"
var view hi = greeting.slice(0, 5)   // mutable view, re-pointable
hi = greeting.slice(6, 11)
```

#### User-defined sliceable containers

Slicing is a **convention**, not a builtin. Any struct can expose `slice` by
conforming to the `Viewable` trait and implementing a `slice(start, end, out
view T)` method. In practice a container just delegates to its backing
`Buffer`'s `slice` — pure Nomen, no inline architecture code:

```
pub struct UserList: Viewable {
    var int length = 0
    var Buffer<User> items = Buffer<User>()
    pub func slice = (
        self,
        int start: start >= 0,
        int end: end >= start && end <= self.items.cap,
        out view User,
    ) {
        return self.items.slice(start, end)
    }
}
view sub = users.slice(10, 20)   // borrows from `users`
sub.at(3)        // a User
sub.length       // 10
```

`Buffer.slice` borrows a `view` over its slab, so its `end` constraint is
`end <= cap` — a wrapper that delegates must carry (or prove) a bound no larger
than the backing capacity.

A `view` borrows from its source, so the borrow checker enforces two rules:

- **Non-escaping.** A view may not be assigned to a variable in an outer scope —
  it must not outlive its source. A view may be _returned_ only when it borrows
  from `self` (the receiver): that is exactly how a `slice` method hands its
  result back to the caller, where it is re-rooted at the call-site receiver.
  Returning a view that borrows from a plain parameter is rejected.
- **Invalidation.** Reassigning the source (`nums = [...]`) frees the buffer the
  view points into, so the view is invalidated; reading it afterwards is a
  compile error. Re-fetch the slice after the source changes.

```
func bad = (int[] a: a.length >= 2, out view int) {
    return a.slice(0, 2)   // Error: cannot return a view borrowing from a parameter
}

var int[] arr = [1, 2, 3]
view v = arr.slice(0, 2)
arr = [9, 9, 9]
Console.write("\\{v.length}")  // Error: borrow invalidated by source reassignment
```

#### Views in structs

Structs may declare `view T` fields — a non-owning `(ptr, len)` pair stored by
value, so copying the struct copies the borrow and nothing is freed on destroy.
This is the zero-copy way to keep many small records over one long-lived buffer:

```
pub struct Line {
    var view string text
    var start = 0
    var len = 0
}

var string doc = "name other"
var Line first = Line(doc.slice(0, 4))
first.text.to_string()   // "name" — no heap copy of the slice was made
```

The same two rules apply to the whole instance: a struct whose view fields
borrow from this scope may not be returned (`its 'view' field(s) borrow from
this scope`) unless every field borrows from `self`, and mutating a source
invalidates every instance borrowing from it until the field is re-pointed:

```
func make_line = (out Line) {
    var string doc = "hi"
    return Line(doc.slice(0, 2))   // Error: 'view' field(s) borrow from this scope
}
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

- `pub`: Public (accessible from the parent scope)
- `internal`: Internal (accessible only within the declaring module/library)
- `private`: Private (accessible only within the same struct or scope)

`readonly` is a separate field-write modifier, not a visibility: it leaves the
field readable at its declared visibility but restricts assignment to the
declaring type's own methods. See [Readonly Fields](#readonly-fields).

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

## Auto-free

At the end of each scope, the compiler automatically:

- Calls `#destroy` functions on structs and classes going out of scope
- Frees heap-allocated strings and class instances
- Cleans up all intermediate scopes on `break`, `continue`, and `return`

Auto-free applies only to types that own heap resources:

- **Structs** with a `#destroy` function (see [Destroy Functions](#destroy-functions))
- **Classes** (always heap-allocated; `#destroy` runs if defined — see
  [Destroy Functions](#destroy-functions-1))
- **Strings** (heap-allocated character buffers)

Value types with no heap ownership are not cleaned up: **enums**, **bitsets**,
**tuples**, **arrays of value types**, integers, floats, bools, and chars hold
no independently-owned memory, so going out of scope requires no action. An
enum or bitset that wraps a string field still relies on the auto-free of that
field's string value, not on any destroy logic of its own.

See [MEMORY.md](MEMORY.md) for the full memory model description.

## Unsafe Code

`unsafe` is a minimal typed-pointer subset reserved for the **System
library** — it exists so the memory primitives (`Buffer`, `Array` inline
storage, `StringBuilder`, `BigInt` limb access, …) can be written once as
plain Nomen instead of duplicated `#arch: c` + `#arch: aarch64` raw blocks
(see [CORE_RAW.md](docs/CORE_RAW.md)). Using it in user code is a compile
error:

```
unsafe {
    var p = 0
}
// Error: 'unsafe' is reserved for the System library — raw pointer
// manipulation is not available to user code
```

The lockdown is airtight by construction: `unsafe` declarations/blocks,
`ptr` types (locals, fields, parameters, return types), pointer casts and
indexing, the per-instantiation constants, **and raw `#arch:` code blocks**
(which subsume everything `unsafe` offers) are all reserved for the System
library source. There is no user-reachable expression whose type is a
pointer, so user code cannot hold — let alone dereference — one.

An `unsafe func` declaration makes the whole body an unsafe context; an
`unsafe { ... }` block scopes it to a region:

```
// In the System library:
unsafe func decode = (ref self, int i, out char) {
    return (self as ptr char)[i]
}
```

The two forms are interchangeable; prefer the block form. The System
library itself uses `func` with an `unsafe { ... }` block rather than
`unsafe func`, so unsafe-ness stays an implementation detail of the
library's internals — callers see an ordinary function that has already
been vetted.

Inside an unsafe context, three extra operations are available:

- **`ptr T` values** — a bare machine word holding the address of a `T`.
  Declared like any other type (`var ptr uint64 p = ...`), passed as a
  scalar, and treated as an 8-byte word by both backends.
- **Indexing** — `p[i]` loads a `T` from `p + i * sizeof(T)`; as an
  assignment target (`p[i] = v`) it stores. `T` may be a scalar, a `string`
  (the fat pair), or a value struct. Indexing a heap `Array<T>` receiver
  addresses its inline element storage.
- **Pointer casts** — integer ↔ `ptr T` (bit-reinterpretation), `string →
ptr char` (the fat value's backing bytes), and a struct pointer →
  `uint64` (e.g. `self as uint64` to reach a header word).

Everything else is identical: bounds constraints on parameters are still
compile-time verified, auto-free still applies to named string/struct
locals, and the checker still rejects any pointer operation outside an
unsafe context.

Per-instantiation constants are available inside generic bodies as plain
expressions: `T_SIZE` (the element's byte size), `T_NEEDS_STRDUP` and
`T_FAT` (bools, true when `T` is `string`). The monomorphizer substitutes
them with literals and folds the dead arm of any `if` they guard.

## Standard Library

The `System` library (in `core/System/`) is imported with `import System`. The
most useful entry points are:

### Console

Output and input on `stdin` / `stdout`:

```
Console.write("no newline")           // write a string
Console.write_line("with newline")    // write a string followed by '\n'

const string line = Console.read_line()   // read a line from stdin (no trailing '\n')
const char c     = Console.read_char()    // read a single character from stdin
const string p   = Console.platform()     // current target platform, e.g. "macos"
```

### Ansi

ANSI escape helpers for styling terminal output. Each function wraps a string
with the relevant SGR sequence and a trailing reset (`ESC[0m`), so styles never
leak past the wrapped text:

```
Console.write("\{Ansi.bg_red("ERROR")}: it didn't work")
Console.write_line(Ansi.bold(Ansi.green("success")))
```

Foreground colours: `black`, `red`, `green`, `yellow`, `blue`, `magenta`,
`cyan`, `white`, plus `bright_*` variants. Background colours: `bg_*` for each
foreground colour. Styles: `bold`, `dim`, `italic`, `underline`, `blink`,
`reverse`, `hidden`, `strikethrough`.

### Task

A handle to a spawned unit of work running on a separate thread. `Task` is
generic — `Thread(...).start()` infers the type parameter from the function's
return type:

```
var t = Thread(compute(42)).start()
var uint64 r = t.result()
```

`wait()` blocks the caller until the task finishes. Idempotent — calling twice
is safe. No-op if the task was never spawned or already joined.

```
var t = Thread(compute(42)).start()
t.wait()
```

### Mutex

pthread-backed lock for shared mutable state. The default stance in Nomen is
"no shared mutable state" — communicate by moving Sendable values (directly
or via `Channel`). `Mutex` exists for when you genuinely need shared
mutability:

```
var Mutex mu = Mutex()

func worker = (Mutex m) {
    m.lock()
    // critical section
    m.unlock()
}

async {
    Thread(worker(mu)).start()
}
```

`Mutex` is a class with `#destroy` that releases the pthread resource
automatically at scope exit.

### Channel

Thread-safe unbounded FIFO queue for passing values between tasks. Blocking
receive — `receive()` blocks the caller until a value is available. Inside a
`Fiber` an empty `receive()` **parks** instead (freeing its worker); `send`
wakes the parked receivers, and a receiver cancelled while waiting returns
the zero value (the task observes `Task.current_cancelled()` itself).

```
var Channel ch = Channel()

func producer = (Channel c) {
    c.send(101)
    c.send(202)
}

async {
    Thread(producer(ch)).start()
}

var v = ch.receive()   // blocks until ready
```

`Channel` stores `uint64` values (Nomen values are pointer-sized on every
target we care about). Fat strings ride through `send_string` /
`receive_string`: the payload is copied into the queue node on send (the
sender keeps its string) and moved out to the receiver as an owned value, so
the message survives the sender's scope exit with its true length intact.

```
var Channel ch = Channel()

func producer = (Channel c) {
    c.send_string("hello")
}

async {
    Thread(producer(ch)).start()
}

var string s = ch.receive_string()   // blocks until ready
```

## Concurrency

Nomen's concurrency model is **structured concurrency via nurseries**: every
concurrent split must rejoin before its lexical scope exits. See
[ASYNC.md](ASYNC.md) for the full design and rationale.

### Sendable

Marker trait for types whose values are safe to move across a task boundary:

```
pub trait Sendable {
}
```

- Primitives (`int`, `uint`, `float`, `bool`, `char`, `string`, etc.) are
  always Sendable.
- Structs are Sendable if explicitly marked `: Sendable` OR all their fields
  are Sendable (auto-derive).
- Classes must explicitly declare `: Sendable` (they're mutable shared
  references — auto-derive would be unsafe by default).

```
pub struct Point {          // auto-Sendable: two int fields
    var int x
    var int y
}

pub class Counter {        // NOT Sendable: classes must opt in
    var int count = 0
}

pub class SafeCounter : Sendable {   // Sendable: explicitly marked
    var int count = 0
}
```

Every value passed to `Thread(...)` must be Sendable — with one exception: a
non-Sendable CLASS argument may be passed inside a nursery (`async { }`),
where it is a **borrow capture** — the task aliases the instance, and the
join at block exit provably bounds the borrow by the donors' lifetimes. The
borrowed argument must be a named local or parameter (a temporary would die
before the task runs), and `.detach()` never accepts one (a daemon outlives
every scope and must own its arguments).

### Thread

`Thread(fn(args))` constructs a deferred call: the arguments are evaluated
eagerly and packed into the task. `.start()` runs it on a separate thread. It
can be used as a statement (fire-and-forget) or an expression (capture the
resulting `Task`):

```
func bg = (uint64 arg) {
    Console.write_line("from task")
}

Thread(bg(0)).start()                 // statement form

var t = Thread(bg(0)).start()         // expression form
t.wait()
```

Because the construction is a real value, it can be stored and started later —
the arguments are bound at construction, the call happens at `start()`:

```
var job = Thread(bg(0))
// ...anything may happen here...
job.start()
```

A construction can also take a zero-argument FUNCTION VALUE — a lambda whose
CAPTURES are the eager arguments (every capture must be Sendable, and owning
captures move into the task). A func-typed binding handed to a construction
is moved: the task owns and frees the closure, and using the binding
afterwards is a use-after-move error. `.detach()` and a nursery's
`.start(...)` accept the form too:

```
var base = 20
var t = Thread(() => bg(base)).start()
t.wait()
```

**Must-start**: a `Thread` (or `Fiber`) value that is destroyed without ever
being started is a programming error — its `#destroy` reports it and aborts.
Every construction must reach `.start()`, `.detach()`, or a nursery's
`.start(...)`.

The `start()` call yields a `Task` handle. The handle is usable whether or not
the spawn happened inside a nursery: waiting is idempotent (join-once), and
the nursery's implicit join at block exit shares the same underlying future.
So a Task captured inside an `async` block can be waited on explicitly, and
the nursery's join at block exit simply observes the task is already done:

```
async {
    var t = Thread(fetch(1)).start()   // usable handle, even inside a nursery
    t.wait()                           // explicit join
    // nursery joins t again at block exit — a no-op
}
```

The nursery's join runs before block-scoped locals are destroyed, so a
running task can safely hold pointers to values declared in the nursery
(e.g. a `Channel`).

Arguments to a spawned call must be `Sendable`. The spawned function's
arguments are type-erased to `uint64` for the thread boundary, then cast back
at the call site — primitives by value, classes/traits by pointer.

### User-defined async primitives

The construction sugar is not reserved for `Thread` and `Fiber`. Any user
class that conforms to the core `Awaitable` trait and carries the spawn-field
contract — four `uint64` instance fields named `task`, `result_slot`,
`cancel_flag`, and `future` — can be constructed the same way. An optional
`started` field receives the must-start flag (declare it if the class wants
must-start semantics; omit it otherwise):

```
import System

class Job : Awaitable {
    pub var uint64 task = 0
    pub var uint64 result_slot = 0
    pub var uint64 cancel_flag = 0
    pub var uint64 future = 0
    pub var started = false

    // Launch: hold the wait-side future ref, submit the packed task.
    pub func start = (ref self) {
        Task.future_set_refs(self.future, 2)
        Task.pool_submit(self.task)
        self.started = true
    }

    // Join: park on the future, drop the handle's ref, clear the fields.
    pub func wait = (ref self) {
        if self.future != 0 {
            Task.future_wait(self.future)
            Task.future_release(self.future)
            self.future = 0
            self.result_slot = 0
            self.cancel_flag = 0
        }
    }
}

func ping = (uint64 id) {
    Console.write_line("job \\{id}")
}

pub func main = () {
    var job = Job(ping(1))
    job.start()
    job.wait()
}
```

`Job(ping(1))` evaluates and packs the arguments eagerly, allocates the
result slot, cancel flag, and future, and yields a heap instance with the
handles stored in the contract fields — exactly what `Thread(...)` does,
minus the launch. Launching is the class's own business: ordinary methods
that drive the packed-task machinery through the library seam —
`Task.pool_submit`, `Task.future_wait`, `Task.future_result_uint64`,
`Task.future_set_refs`, `Task.future_release` — the same runtime calls the
generated `Thread`/`Fiber` launch code makes, so a user primitive parks
fibers, participates in deadlock detection, and frees exactly like a library
spawn. The construction is a full citizen of the trait system — a user
primitive flows into `ref Awaitable` and its `wait` dispatches through the
vtable — and a generic class `Job<T>` is monomorphized with `T` the wrapped
call's return type (`uint64` for `void`), so `result`-style methods can
return `T`.

The rules:

- The type must be a class (the construction heap-allocates), conform to
  `Awaitable`, and declare the four contract fields as `uint64`. A missing or
  mistyped field is a dedicated compile error, not a failed method lookup.
- Field initializers and `#init` do not run: the construction zero-builds the
  instance and writes the handles. Keep field defaults zero-valid, as the
  library spawn classes do.
- `Sendable` is enforced on every packed argument (and on a function-value
  form's captures), exactly as for `Thread`.
- Must-start is not imposed: whether an unstarted construction aborts at
  `#destroy` is the class's own contract.

### Fiber

`Fiber(fn(args)).start()` is the lightweight sibling of `Thread(...).start()`:
same call shape, same `Task<T>` handle, but the wrapped call runs on a
_stackful coroutine_ — a heap-allocated stack (~64 KB) multiplexed over the
worker pool. A fiber that waits (`Task.result`, `Task.wait`, `Channel.receive`)
**parks**: it frees its worker to run other fibers instead of blocking the
thread. Thousands of waiting fiber tasks therefore cost stacks, not threads.
Like `Thread`, the construction is a storable value — and an unstarted one
aborts at destroy (must-start).

```
import System

func compute = (uint64 n, out uint64) {
    return n + 1
}

pub func main = () {
    var f = Fiber(compute(41)).start()
    var uint64 r = f.result()          // parks, not blocks
    Console.write_line("\\{r}")
}
```

`Fiber.yield()` cooperatively hands the worker to the next runnable fiber.
`Fiber.is_fiber()` reports whether the calling code is running inside a fiber:

```
import System

func step = (Channel ch, uint64 id) {
    ch.send(id)
    Fiber.yield()
    ch.send(id)
}

pub func main = () {
    var Channel ch = Channel()
    var a = Fiber(step(ch, 1)).start()
    var b = Fiber(step(ch, 2)).start()
    a.wait()
    b.wait()
    Fiber.yield()                       // no-op on the main thread
    if Fiber.is_fiber() {
        Console.write_line("in a fiber")
    }
}
```

`start_on(buf)` runs the fiber on a caller-provided fixed-size array stack
(at least 16 KB) instead of a heap stack:

```
import System

func work = (uint64 n) {
    Console.write_line("static stack")
}

pub func main = () {
    var uint64[2048] stack_buf
    var f = Fiber(work(0)).start_on(stack_buf)
    f.wait()
}
```

`Fiber.set_cooperative(true)` (before the first fiber spawn) runs fibers on
the calling thread and never starts worker threads: fibers execute when the
main thread would block on a task (or at process exit). This is the
single-threaded/bare-metal mode; a fiber parked on an event only another
thread could fire will never resume:

```
import System

func background = (uint64 n) {
    Console.write_line("ran")
}

pub func main = () {
    Fiber.set_cooperative(true)
    Fiber(background(0)).start()
    // runs at the next would-block wait, or at process exit
}
```

Like a spawned call, every argument to `Fiber(...)` must be `Sendable`, and a
`Fiber` used inside an `async` block is joined at block exit.

### async block (nursery)

`async { ... }` defines a nursery: a scope that bounds the tasks started
within it. The block cannot exit until all tasks spawned within it have
finished (implicit join at scope exit). This is the structured-concurrency
primitive.

```
func fetch = (uint64 id) {
    // ...
}

async {
    Thread(fetch(1)).start()
    Thread(fetch(2)).start()
    Thread(fetch(3)).start()
    // block does not exit until all three fetches finish
}
```

Because the join is unconditional, one rule applies: code after the closing
brace of an `async` block cannot help a task inside it finish. A task that
waits on a channel message, a lock release, or a task result that only code
after the block would provide results in a deadlock and should instead be
received inside the block, or the consumer passed in.

A nursery can have a timeout: `async(timeout: N) { ... }` where `N` is the
timeout in milliseconds. The deadline is computed before the nursery body
runs. When the deadline expires, remaining tasks are cancelled cooperatively
(their `cancel_flag` is set), and the nursery waits briefly for them to observe
the cancellation before joining.

```
async(timeout: 500) {
    Thread(long_running(0)).start()
    // if long_running doesn't finish within 500ms, it is cancelled
}
```

A nursery can also run in race mode: `async(mode: race) { ... }`. The nursery
exits as soon as the _first_ spawned task completes (or the timeout fires);
the remaining tasks are cancelled cooperatively and joined before the block
exits. The default mode is `all`, which waits for every task. Options may be
combined: `async(mode: race, timeout: 500)`.

```
async(mode: race) {
    Thread(fetch_from_cache(key)).start()
    Thread(fetch_from_db(key)).start()
    // exits as soon as either task completes; the loser is cancelled
}
```

### Nursery (escape hatch)

A spawn normally targets its lexically enclosing `async` block. A function that
needs to spawn into its _caller's_ nursery takes the nursery explicitly — the
Trio escape hatch. This is a _capability_, not a required parameter: most
functions just `return`/compute and never need it.

An `async` block may name its nursery. The name binds a `Nursery`-typed variable
in the block's scope, which can be passed to functions (with `ref`) and used as
the receiver of `.start`:

```
func handle_connection = (uint64 conn, ref Nursery pool) {
    pool.start(Thread(parse(conn)))
    pool.start(Thread(respond(conn)))
}

async pool {
    handle_connection(conn, ref pool)
    // block does not exit until parse and respond finish
}
```

`name.start(Thread(fn(args)))` spawns `fn(args)` into the referenced nursery —
the same `Thread(...)` construction a bare spawn takes. The arguments must be
`Sendable`, exactly like a direct spawn. It may be used as a statement
(fire-and-forget) or as an expression yielding a `Task<T>`:

```
func compute = (uint64 n) => n + 1

func spawn_one = (uint64 n, ref Nursery pool) {
    var t = pool.start(Thread(compute(n)))
    var uint64 r = t.result_uint64()
}
```

The name is arbitrary — pick whatever reads best:

```
async nursery { … }
async pool { … }
```

A named nursery may be configured (timeout, race mode) with `= Nursery(...)`:

```
async pool = Nursery(timeout: 2000, mode: race) {
    pool.start(Thread(fetch_from_cache(key)))
    pool.start(Thread(fetch_from_db(key)))
}
```

`Nursery` is a `Sendable` struct wrapping the nursery's per-invocation tracking
state. It is only valid for the lifetime of its enclosing `async` block — the
block cannot exit until every task spawned through a passed `Nursery` has
finished, so a running task can safely hold the `Nursery` (and pointers into
nursery-local values).

An unnamed `async { }` block supports only lexical `Thread(...).start()`
(no escape hatch) — naming the nursery is what makes it referenceable.

### Task

The handle returned by `Thread(...).start()`. Generic — `T` is inferred from
the spawned function's return type (`Task<uint64>` for uint64-returning
functions, `Task<uint64>` for void functions):

```
pub class Task<T> : Sendable {
    func wait = (ref self)
    func result = (ref self, move out T)
    func result_uint64 = (ref self, out uint64)
    func cancel = (ref self)
    func current_cancelled = (out bool)   // static
}
```

- `wait()` blocks until the task finishes. Idempotent.
- `result()` blocks, then moves the spawned function's return value out as
  `T`. The value transfers to the caller (`move out`) — call it once; a
  second call observes the zero value. The result slot is sized to the full
  type, so a fat `string` result arrives intact, and an unconsumed result
  is freed when the handle's `#destroy` runs.
- `result_uint64()` blocks, then returns the spawned function's return value
  cast to `uint64`. Convenience for the common case.
- `cancel()` requests cooperative cancellation — sets a flag the task
  observes at its own checkpoints.
- `current_cancelled()` (static) returns whether the currently-running task
  has been asked to cancel. Returns `false` when called from outside any
  spawned task (e.g. the main thread).

Cancellation is cooperative — the runtime never preempts. Long-running tasks
poll `current_cancelled()` at their own checkpoints:

```
func long_running = (uint64 arg) {
    var int i = 0
    while i < 1000000 {
        if Task.current_cancelled() {
            return
        }
        i = i + 1
    }
}

var t = Thread(long_running(0)).start()
t.cancel()
t.wait()
```

### Worker pool

Spawned tasks run on a fixed-size thread pool (default: 4 workers). The pool
grows on demand when every worker is busy — a worker blocked joining its own
spawned children can't starve the queue, because the pool starts an extra
worker up to a cap of 64. This prevents deadlocks from nested spawns.

```
Task.set_pool_size(8)  // must be called before the first Thread(...).start()
```

The pool shuts down automatically at process exit: every queued task is
drained and joined before the process exits. `Task.shutdown_pool()` does
this explicitly — after it returns every outstanding fire-and-forget task
has completed. The pool re-initializes on the next spawn.

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
