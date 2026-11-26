# Nomen Language Specification

## Overview

Nomen is a statically-typed, compiled language that compiles to C, AArch64
assembly, or JavaScript. It supports features from imperative,
object-oriented, and functional paradigms.

## Comments

```
// Single-line comment

/* Block comment
   /* nested comments supported */ */
```

A `/** ... */` block comment immediately before a declaration is a **doc
comment**: `nomen docs` attaches it to the following struct, trait, enum,
bitset, or function and renders it into a markdown tree under `<root>/docs/`
(one file per source file, mirroring the source layout). The delimiters and
the conventional leading `*` are stripped, `@tag` lines (e.g. `@param`) are
preserved verbatim, and nested `/* */` inside a doc comment is allowed. A
top-level `pub` item with no doc comment produces a `nomen docs` warning.

```
/**
 * Returns the sum of two ints
 **/
pub func add = (int a, int b, out int) {
    return a + b
}
```

## Reserved Words

The following words are reserved by the language and cannot be used as
variable, parameter, field, type, or enum case names (`class` is retired and
kept only to reserve it — see below):

`as` `async` `bitset` `break` `case` `class` `const` `continue` `else`
`enum` `error` `foreign` `extend` `for` `func` `if` `import` `internal` `let`
`match` `mv` `of` `out` `panic` `private` `pub` `raw` `readonly` `ref`
`return` `struct` `switch` `swap` `todo` `trait` `try` `catch` `unsafe` `var`
`view` `while`

The literals `true`, `false`, and `null`, and `self`, are reserved as well.
Using a reserved word as a name is a compile error:

```
var out = StringBuilder()
// Error: 'out' is a reserved word and cannot be used as a name
```

`class` is retired: writing it produces a dedicated error directing to its
replacement —

```
class Box { var int value }
// Error: 'class' has retired — declare `mv struct` (single-owner, move-only)
//   and spell sharing where it happens (`ref`, `Box<T>`, `Mutex<T>`,
//   `WeakHandle<T>`)
```

Function and method names are exempt: the name after `func` is unambiguous,
and calls always go through `.name(...)` access, so library methods may use
reserved words (e.g. `Text::Regex.match(...)`):

```
const m = Regex.match("[0-9]+", "abc123")
Console.write("\{m}")
```

Type names are exempt the same way: the name after `struct`, `trait`,
`enum`, `bitset`, or `error` is unambiguous, so a GUI module can declare
`struct view`-style types spelled with a reserved word:

```
struct view {
    var int id
}

trait view {
    func draw = (self)
}

var v = view(1)   // constructor calls read the name plainly
```

Enum and bitset case names are exempt too — the name after `case` in a type
body is unambiguous, and every use is dot-prefixed (`.todo`, `Status.todo`,
match arm `case .todo`, `Perm.import`):

```
enum Status {
    case todo
    case done
}

var s = Status.todo
s = .done
```

Case payload parameters stay reserved (they are parameters, like any other),
as do bindings, parameters, and fields. A keyword-spelled type name works
where a bare name is expected (constructor calls, trait conformance,
qualified enum cases) and not in modifier-ambiguous type positions — spell
those forms in PascalCase (`View`), which was never reserved.

## Types

### Basic Types

- **Integers**: `int`, `uint`, `int8`, `int16`, `int32`, `int64`, `uint8`, `uint16`, `uint32`, `uint64`
- **Floating-point**: `float`, `float32`, `float64`
- **String**: `string` (a fat `(ptr, len)` pair pointing at a heap buffer — `.length` is the byte count)
- **Character**: `char` (an 8-bit character; string indexing and `.length` count bytes, not code points)
- **Boolean**: `bool`
- **Null**: `null` (represents the absence of a value for nullable types)
- **Void**: `void` (used for functions with no return value)

Numeric literals coerce into sized numeric types when the value fits. Unsigned
types (`uint*`) reject negative literals:

```
const int16 small = 300
const int doubled = small * 2
const ratio = 0.5
const scaled = ratio * 2.0
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
const Array<string> names = ["a", "b"]

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
used throughout this document wherever a typed array is needed (e.g. tuples
vs. arrays).

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
const y = x + 1          // Error: Variable 'x' may be null
```

Nullable variables initialized with a non-null value can be used freely:

```
var int? x = 5
const y = x + 1          // OK, y = 6
```

### Nullable Chaining

`a?.b` reads a member only when the nullable target holds a value: the result is
the member's type made nullable — null when the target is null, the member
otherwise.

A chain is built from:

- repeated hops — `a?.b?.c`
- a plain `.` after a hop — `a?.b.c` (guarded by the `?.` hop)
- a method call — `a?.m(args)` (runs only on the non-null path)
- a call base — `f()?.x` (the base is evaluated once, into a hidden local)

A nullable chain is a nullable VALUE: it lowers anywhere a nullable value is
consumed, in the language's per-slot carriers (in-band for strings, the
companion `_has` flag for scalars and structs).

```
struct Profile {
    var int score
}

func find = (int id, out Profile?) {
    if id == 1 {
        return Profile(7)
    }
    return null
}

func describe = (int id, out string) {
    var p = find(id)
    if p?.score != null {
        return "found"
    }
    return "missing"
}

func score_or = (int id, out int) {
    var p = find(id)
    return p?.score ?? 0
}

func score_of = (int id, out int?) {
    var p = find(id)
    return p?.score
}

pub func main = () {
    var p = find(1)
    var s = p?.score          // a chain initializes a `int?` local
    Console.write("\{score_of(2) ?? -1}")   // a chain returns through `int?`
}
```

In practice:

- `chain ?? fallback` picks the member or the fallback — evaluated lazily,
  exactly once.
- `chain != null` / `chain == null` test the whole chain — every nullable hop,
  including a final member that is itself a nullable field read with a plain
  `.`, whose own flag joins the tests.
- A plain field read on a nullable struct/scalar BASE coalesces the same way:
  `y.v ?? fb` (`y` a `T?` local or parameter) tests the base's own nullness, so
  it matches the `y?.v ?? fb` spelling.

Edge cases:

- `?.` on a non-nullable value is an error pointing at `.`.
- `??` on a non-nullable LEFT is an error — the fallback could never run.
- A chain whose member path contains a call hoists the base into a hidden
  local, so every hop test reads a pure path (no double evaluation).
- A nullable chain cannot be a `??` FALLBACK (`x ?? a?.b` is rejected —
  coalesce the chain first, `x ?? (a?.b ?? fb)`): the fallback slot has no
  carrier for the chain's nullness.

### Constraints

Constraints are compile-time assertions on parameters, fields, and variables. They use `:` after the name followed by a boolean expression. When the value is a compile-time constant, the constraint is evaluated at compile time and violations produce errors.

#### Parameter Constraints

Function parameters can have constraints that are checked at every call site when the argument is a compile-time constant:

```
func restricted = (int x: x > 5) {
    Console.write("\{x}")
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
func above_zero = (int x: x > 0) {
    Console.write("\{x}")
}

const threshold = 10
above_zero(threshold)   // OK, 10 > 0
```

#### Field Constraints

Struct fields can have constraints. Fields without default values that have constraints will have those constraints propagated to the auto-generated `#init` parameters:

```
struct Bounded {
    var int x: x > 0
    var int y: y < 100
}

const b = Bounded(5, 50)     // OK
const b2 = Bounded(-1, 50)   // Error: Parameter constraint not satisfied: x
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

Constraints are checked at every use. When the value is a compile-time
constant (an integer or boolean literal, or a `const` variable with a known
value), the constraint is evaluated at compile time and a violation is an
error. When the value is only known at runtime (a parameter, a call result),
the compiler must be able to PROVE the constraint from the surrounding flow —
a guard (`if x > 0`), a range-for, or the argument's own initializer. An
unproven runtime argument is rejected with `Parameter constraint cannot be
verified` — spell the proof the compiler should use:

```
func above_zero = (int x: x > 0) {
    Console.write("\{x}")
}

func run = (int n) {
    above_zero(n)        // Error: Parameter constraint cannot be verified

    if n > 0 {
        above_zero(n)    // OK — the guard proves it
    }
}
```

The provable fact set:

- **Guards.** A comparison in an `if` condition holds inside the branch —
  each `&&` conjunct separately. A zero-guard that always exits proves the
  negation for the code after it: `if n == 0 { return 0 }` makes `n != 0`
  a fact for everything that follows (and `if n != 0 { return }` pins `n`
  to `0`).
- **Loop ranges.** `for i of 0..n` proves `i >= 0 && i < n` in the body.
- **Length facts.** A value read from `.length`, `.count`, `.cap`, or
  `.size` is known `>= 0` — so a length snapshot compared against another
  length verifies a whole index contract:

```
func last = (string[] a, string[] b, out string) {
    var n = a.length
    if n < b.length {
        return b.at(n)   // OK — n >= 0 (length fact), n < b.length (guard)
    }
    return ""
}
```

Reassignment drops a variable's facts — the new value knows nothing. For
indices no guard proves, the runtime-checked accessors are the escape
hatch — see [Indexing](#indexing).

Constraint expressions support:

- Comparisons: `>`, `<`, `>=`, `<=`, `==`, `!=`
- Logical operators: `&&`, `||`
- Array `.length` property
- References to other parameters/fields by name

### Reference Types

Any type can be made a reference type by prefixing with `ref`:

```text
ref int       // reference to an int
ref Character // reference to a Character struct
ref Node?     // nullable reference to a Node
```

A `ref` type holds a pointer to a value rather than the value itself. This allows functions to modify caller variables and structs to link to other structs.

#### Reference Parameters

Functions can accept parameters by reference using `ref`. The caller must also use the `ref` keyword at the call site to make the mutation explicit:

```
func make_five = (ref int x) {
    x = 5
}

var num = 1
make_five(ref num)
// num is now 5
```

Calling without `ref` at the call site is a compile error:

```
make_five(num)  // Error: Missing 'ref' keyword for ref parameter 'x'
```

Using `ref` for a non-ref parameter is also an error:

```
func print = (int x) {
    Console.write("\{x}")
}
print(ref 5)   // Error: Unexpected 'ref' keyword for non-ref parameter 'x'
```

A `const` value cannot be passed to a `ref` parameter — a mutable borrow requires
a mutable value. Declare the caller's binding as `var` first:

```
const fixed = 1
make_five(ref fixed)   // Error: Cannot pass const 'fixed' to ref parameter 'x'

var mutable = 1
make_five(ref mutable) // OK — mutable is now 5
```

#### Declared Field Effects

A `ref` parameter may declare the fields of the caller's variable it may
displace, as a brace set after the parameter name. The declaration is the
contract: the compiler verifies the function body against it, and a call
invalidates borrowed values taken through exactly the declared fields —
borrows taken through sibling fields stay live.

```
mv struct Stats {
    var int hits
}

mv struct Item {
    var int weight
    mv Box<Stats> stats
}

func rebalance = (ref Item item { stats }) {
    item.stats = mv Box<Stats>(mv Stats(0))
}

func touch = (ref Item item {}, int by) {
    item.weight = item.weight + by   // value-type fields never need declaring
}

var item = Item(1, mv Box<Stats>(mv Stats(2)))
var s = item.stats        // borrow rooted at item, via stats
touch(ref item, 1)                   // declared: {} — s stays live
rebalance(ref item)                  // declared: { stats }
Console.write("\{s.hits}")          // Error: borrow 's' was invalidated
```

Fields are listed inside the braces (`{ stats, cache }`); the empty set `{}`
declares that no field is displaced — the body may still write value-type
storage. An un-annotated `ref` parameter is a wildcard: it may displace
anything, and every borrow rooted at the argument is invalidated. Bare `self`
is a read-only receiver and has nothing to declare; a `ref self` method may
carry the set exactly like a free `ref` parameter (`ref self { data }`).

The body is verified against the declaration by three local rules:

1. A write through the parameter (`item.stats = ...`) must target a declared
   field — unless the field is pure value storage (an `int`, or any field with
   no heap interior).
2. A mutating method call on a field of the parameter (`item.stats.recount()`)
   requires that field in the declared set.
3. Forwarding the parameter to another `ref` parameter (or calling another
   `ref self` method on the parameter itself) requires the callee's declared
   set to be a subset of the caller's.

```
func bad = (ref Item item {}) {
    item.stats = mv Box<Stats>(mv Stats(0))
}
// Error: 'bad' declares an empty field set, but the body writes item.stats
```

A trait's method declaration carries the set, and calls through the trait type
use it. A conforming method must declare a subset of the trait's set — a
conformer that widens the set is rejected at the declaration.

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

    pub func add = (self, Point other, out Point) {
        return Point(self.x + other.x, self.y + other.y)
    }
}
```

Structs are constructed by calling the struct name as a function. A `#init` function is auto-generated with parameters for every field that has no default value:

```
const point = Point(5, 10)
```

#### Readonly Fields

A `readonly` field is readable wherever the field is visible, but assignable
only from within the declaring struct's own methods (including its
`extend` blocks):

```
struct Counter {
    readonly count = 0

    func bump = (ref self) {
        self.count = self.count + 1
    }
}

var c = Counter()
c.bump()
Console.write("\{c.count}")   // 1
```

Writing a `readonly` field from outside its declaring type is an error:

```
struct Counter {
    readonly count = 0
}

var c = Counter()
c.count = 5
// Error: Cannot assign to readonly field 'count' from outside Counter
```

A `const` field, by contrast, is immutable everywhere — even inside the
declaring type.

### Initializers

Initializer functions must set all properties that don't have default values, and can set const property values. An `#init` is an instance lifecycle method: it declares its receiver like any other method — `ref self` when it writes fields (the usual shape), bare `self` when it doesn't, and a missing receiver is an error.

```
pub struct Point {
    pub var int x
    pub var int y
    pub var int sum

    func #init = (ref self, int x, int y) {
        self.x = x
        self.y = y
        self.sum = x + y
    }
}
```

### Destroy Functions

If a struct has a `#destroy` function, it runs automatically when the struct goes out of scope. The destroy function declares only its receiver (`self`, or `ref self` when it clears fields) and cannot be called manually — like every instance method, the receiver is required.

A struct declaring `#destroy` must be `mv struct` — the type is single-owner.
A destructor on a Copyable struct would run once per copy, and every copy
would release the same resource; the checker rejects the Copyable spelling,
naming the fix.

```
pub mv struct Transaction {
    pub var int handle

    func #init = (ref self, int handle) {
        self.handle = handle
    }

    func #destroy = (self) {
        // automatically runs when the Transaction goes out of scope
    }
}
```

### Owning Structs

An `mv struct` is the single-owner escape hatch from Copyable structs: its
bindings MOVE instead of copy, and the declaration — not a field walk — is the
ownership contract (a `#destroy` member requires the `mv struct` form).
Heap resources (a `Box<T>`, a `List<T>`, an OS handle) live exactly as long
as the binding that owns them, and `#destroy` runs at scope exit.

```
mv struct Config {
    mv string name
}

var c = Config("x")
mv c2 = c        // transfer: c is invalid afterwards
var c3 = c.copy()  // deep copy: c stays valid
var c4 = c         // Error: cannot copy 'Config' by value — use .copy() or mv
```

Construction, methods (`ref self` for mutation), and `#destroy` follow the
struct rules. Function parameters are **read-only by default** for every
type; `ref` is a spelled mutable borrow the caller acknowledges at the call
site; `mv` transfers ownership. A `mv string` parameter takes ownership of
the buffer: the callee frees it at its exit, a `field = mv p` store takes it
without a copy, and the caller's `mv` argument is invalidated afterwards (a
literal or other non-owning donor is materialized into an owned copy at the
call). Constructors' `mv string` params keep the copy convention — they
strdup into their owning fields. Sharing within a scope is spelled at the
binding — for a heap value that means aliasing its `Box`:

```
mv struct Node {
    var int value
}

var p = Box<Node>(Node(10))
ref Box<Node> q = p    // alias: owner defers its free; both names see writes
q.value = 99           // p.value is now also 99 — one instance, two names
```

A `ref` binding is an alias, not an owner: mutation through it requires the
source to be `var`, and ownership cannot be transferred through it (move the
owner instead). Assigning to the alias re-points the alias itself — `q =
Box<Node>(...)` stops the aliasing and adopts the fresh instance into `q` (an
ordinary owning binding from then on); the previously-aliased instance stays
owned by `p`. A plain `var` copy of an alias source is a compile error —
spell what you mean: `ref` to share, `mv` to transfer, `.copy()` for an
independent copy.

See [Move-Only Structs](#move-only-structs) for the field rules, the Copyable
verifier, `Box<T>`, and the nullable lowerings.

### Copies, Moves and Borrows

The model is two rules. **Reads are free**: a bare argument, an element or
field read, a capture from a temporary — none of them demand a decision, and
the source stays valid. **Creating a new owner from an existing value is
spelled**: a binding, an assignment, an owning-field store, or a `mv`
parameter pass spells `mv` to transfer (the source is invalidated — using it
again is a "used after mv" error) or `.copy()` to duplicate it. A fresh
temporary — a constructor call, a literal, a call result, an element read —
moves in implicitly: it exists only to initialize. The table is the per-type
detail of those two rules (which types can copy at all, and what each
operation does); the compiler's error messages name the fix whenever a silent
copy of an owning value is rejected:

| Type                                                | Binding / assignment — creates an owner                                                                            | Argument pass — a read unless the parameter spells `mv`                                            | Lambda capture — taken once, at creation                    | Destructure / element read                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Scalars (`int`, `float`, `bool`, `char`)            | copy                                                                                                               | copy                                                                                               | copied at capture — a later write to the source is not seen | copies out                                                                                          |
| `string`                                            | move only: `mv t = s`, or `t = s.copy()`                                                                           | bare copies; a `mv string` parameter + `mv s` takes ownership                                      | moved — the donor is invalidated                            | needs `mv` / `.copy()` when the source outlives the read; `.at(i)` copies the element out           |
| Copyable `struct` (value-only tuples, anon structs) | copies the fields                                                                                                  | copy                                                                                               | copied at capture                                           | binds views into the source                                                                         |
| `mv struct`, `mv enum`, owning tuple                | move only: `mv`, or `.copy()` where the type has one                                                               | bare is a read-only borrow; `mv` transfers and invalidates the donor                               | moved — the donor is invalidated                            | owning fields need `mv` (or `.copy()` the base first); a temporary right-hand side moves implicitly |
| `Box<T>`                                            | move only: `mv t = b`                                                                                              | no bare form — the parameter itself spells `mv` (transfer) or `ref` (alias)                        | moved — the donor is invalidated                            | — (field access is transparent through the box)                                                     |
| Array (`T[]`)                                       | copy                                                                                                               | passes (the parameter is const — mutation needs `ref`)                                             | banned — arrays are heap-backed                             | `.at(i)` copies the element out                                                                     |
| `ref` (an alias to a heap instance)                 | aliases a `Box<T>`/class held in a `var` — both names see writes; no ownership through it (`mv` the owner instead) | only into a `ref` parameter, `ref` spelled at the call site — writes land in the caller's variable | banned — borrowed references are not owned                  | —                                                                                                   |
| `view` (a borrowed slice)                           | re-binds the borrow                                                                                                | only into a `view T` parameter — `.to_string()` materializes an owned copy for `T`                 | banned — views are borrowed slices                          | —                                                                                                   |
| Closure / func value                                | moves implicitly — the donor is invalidated; no `mv` spelling                                                      | passes (the donor keeps it)                                                                        | moved — the donor is invalidated                            | —                                                                                                   |

- **Bare passes are reads.** A bare argument never changes the caller's
  ownership — the donor stays valid — so the pass column only differs from
  binding where the pass isn't an ownership change. A plain parameter is the
  callee-side `const`: a read-only slot that never takes the caller's value,
  which is why a bare call site has no decision to make. The ownership
  spelling is a binding rule because a `const`/`var` binding declares an
  owner (it frees or replaces its state); `ref`/`view` bindings are the
  borrow spellings, mirroring the parameter forms. That is what keeps reads
  of owning values cheap: `f(config)`, `c.name`, and `xs.at(i)` never copy
  or invalidate. `Box<T>` is the deliberate exception — a bare `Box`
  parameter would be ambiguous about who owns the pointee, so it must spell
  `mv` or `ref`.
- **Destructuring without `mv` binds views** for value fields; owning fields
  must spell `mv` (or read from a `.copy()`) — the same rule for named
  structs, anonymous structs, and tuples (see [Destructuring](#destructuring)
  and [Move Destructuring](#move-destructuring-and-literal-transfers)).
- **Closures capture once, at creation** (see
  [Anonymous Functions (Lambdas)](#anonymous-functions-lambdas)): owning
  values move in and the donor is invalidated; arrays and views cannot be
  captured at all.

### Generic Structs

Structs can declare type parameters using `<T>` syntax. The compiler
monomorphizes: each concrete instantiation becomes its own type
(`List<int>` → `List_int`), and every value occupies a uniform 8-byte slot on
aarch64, so generic code needs no runtime type dispatch. `T` exists for
compile-time type checking.

```
pub struct List<T> {
    var length = 0
    var capacity = 0
    var T elem

    pub func push = (ref self, T value) {
        self.elem = value
    }
    pub func pop = (self, out T) {
        return self.elem
    }
}
```

Generic structs are instantiated by providing concrete type arguments in the constructor call:

```
var numbers = List<int>()
numbers.push(42)
const top = numbers.pop()
```

Type parameters can be used in:

- Field types
- Parameter types
- Return types (`out T`)

Within the struct body, type parameters match any concrete type during type checking. At the call site, the type argument (`<int>`) ensures the correct types are enforced.

Inside a generic body, `T()` **constructs** the bound type. The call defers
at declaration and rewrites at specialization: a struct becomes its default
constructor, a scalar becomes its zero value (`int` → `0`, `float` → `0.0`,
`bool` → `false`, `string` → `""`). It composes with `out T` returns:

```
mv struct Item {
    var n = 0
    mv label = ""
}

func default_of<T> = (T seed, out T) {
    var value = T()
    return value
}

func first_push<T> = (ref StableList<T> list, T seed) {
    var item = T()
    list.push(mv item)
}
```

### Anonymous Structs

An anonymous struct is an inline collection of named fields written `[ field = value, ... ]`. It has no declared name — the compiler generates one, and every literal with the same field names and types shares a single generated type, regardless of the order the fields are written in.

#### As standalone values

Used as a value, an anonymous struct is materialized into a generated struct so its fields can be read and destructured like any struct:

```
const p = [ name = "bob", age = 5 ]
Console.write("\{p.name} \{p.age}")    // bob 5

const box = [ width = 3, height = 4 ]
var [width, height] = box                 // destructure by field name
Console.write("\{width * height}")       // 12
```

The type is inferred from the literal and has no source-level name, so an anonymous struct can only be used where its type can be inferred — a `const`/`var` initializer, a reassignment, or a return value. It is not implicitly coerced to a named struct; to build a named struct, call its constructor.

#### Overriding fields on construction

A struct literal may be seeded from a base expression with `..`, then override fields by name. The base runs first (its required fields are set positionally by the constructor call); each named field must have a declared default and is applied after the base is constructed:

```
struct LayoutParams {
    var grow = 0
    var shrink = 0
}

const LayoutParams DEF = [ .. LayoutParams(), grow = 2, shrink = 3 ]
const LayoutParams ONE = [ .. LayoutParams(), grow = 7 ]
```

The base may be any value-struct expression — a constructor call, a factory function's result, or a plain variable (a copy; a mv struct requires `mv` or `.copy()`):

```
func layout = (int grow, out LayoutParams) {
    return [ .. LayoutParams(), grow = grow, shrink = 3 ]
}

const LayoutParams DEF = [ .. LayoutParams(), grow = 2, shrink = 3 ]
const LayoutParams TWO = [ .. DEF, grow = 2 ]
const LayoutParams THREE = layout(7)
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
const things = [1, "first"]                  // inferred as [int, string]
const triple = [42, "hello", true]           // [int, string, bool]
```

When no explicit type is provided, a bracket-enclosed heterogeneous list is inferred as a tuple. To create a typed array instead, use `Array<T>`:

```
const Array<int> nums = [1, 2, 3]            // typed array, not tuple
const mixed = [1, "hello"]                   // inferred as [int, string] tuple
```

#### Tuple Field Access

Tuple fields are accessed with underscore-prefixed indices:

```
const things = [42, "answer"]
Console.write("\{things._0} \{things._1}")  // "42 answer"
```

#### Destructuring Tuples

Tuples can be destructured into individual variables. See [Destructuring](#destructuring)
for the full set of forms (arrays and structs are also supported):

```
func get_person = (int id, out [string, int]) {
    return ["Andrew", id + 100]
}

var [name, age] = get_person(12)
Console.write("\{name} \{age}")  // "Andrew 112"
```

Destructuring also works with tuple literals:

```
var [a, b] = [11, "hello"]
Console.write("\{a} \{b}")  // "11 hello"
```

#### Tuple Return Types

Functions can return tuples:

```
func make_pair = (int a, int b, out [int, int]) {
    return [a, b]
}

const p = make_pair(10, 20)
Console.write("\{p._0} \{p._1}")  // "10 20"
```

#### Tuples as Struct Fields

Tuples can be used as struct fields:

```
mv struct Container {
    mv [int, string] payload
}

const c = Container([99, "bottles"])
Console.write("\{c.payload._0} \{c.payload._1}")  // "99 bottles"
```

#### Tuple Concatenation

`+` concatenates two tuples. The result is a wider tuple — the left operand's
elements followed by the right operand's:

```
const pair = [1, "a"]
const triple = pair + [2, true]         // [int, string, int, bool]
Console.write("\{triple._2} \{triple._3}")  // "2 true"
```

#### Arrays of Tuples

An array type whose element is a tuple is written `[T1, T2][]`; the
`Array<T>` alias accepts the same spelling:

```
const [int, bool][] flags = [[1, true], [2, false]]
const Array<[int, bool]> same = [[3, true]]
Console.write("\{flags.at(1)._0}")  // "2"
```

A bracket-enclosed literal whose elements are same-shaped tuples infers as
an array of tuples (heterogeneous elements still infer a single tuple).
The same spelling extends to anonymous enums — `[.ok(int), .error][]` is
an array whose elements are matched with the usual `case` forms. Tuple
elements that own heap resources (a `string` or mv-struct field) are
supported: their fields are seeded as heap copies and the array's
teardown frees them exactly once. Read such a field with `.copy()` when
binding it to a local, and bind an element before destructuring it —
`var [a, b] = pairs.at(i)` is rejected (the element copy would share the
array's fields); use `var e = pairs.at(i)` instead.

#### Nested Arrays

An array whose elements are arrays is written `T[][]` (or
`Array<Array<T>>`); deeper chains (`T[][][]`, `Array<Array<Array<T>>>`) are
supported up to five levels. Every level is a heap array with its own
length, so inner rows may differ in length:

```
const int[][] grid = [[1, 2], [3, 4]]
const int[2][] fixed = [[1], [2, 3]]
const int[][][] cube = [[[1], [2, 3]], [[4]]]
Console.write("\{grid.at(1).at(0)} \{grid.at(0).length}")  // "3 2"
Console.write("\{cube.at(0).at(1).at(1)}")                  // "3"
```

A bracket-enclosed literal whose elements are array literals infers a
nested array. Any element type is allowed, including owning ones —
`string[][]`, arrays of `mv` structs — and the scope-exit destroy walks
reclaim every row and its owned slots exactly once. A nested-array value is
a single pointer, so it can be returned from functions, passed as a
parameter, and stored in a struct field; `mv` transfers it between
owners.

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
    case .ok(age) -> Console.write("\{age}")
    case .error(msg) -> Console.write("error \{msg}")
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
- **Struct** — bind by field name

A binding name of `_` discards that position for arrays and tuples (no
variable is introduced):

```
const int[] nums = [1, 2, 3]
var [first, _, last] = nums
Console.write("\{first} \{last}")  // "1 3"
```

#### Array Destructuring

A bracket-enclosed list of names on the left of an array binds each element by
position:

```
const int[] arr = [1, 2, 3]
var [a, b, c] = arr
Console.write("\{a} \{b} \{c}")  // "1 2 3"
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
Console.write("\{a} \{b}")  // "11 hello"
```

Binding more names than the tuple has elements is a compile error:

```
var [a, b, c] = [1, "two"]  // error: cannot destructure index 2 of a tuple with 2 elements
```

#### Struct Destructuring

A struct on the right-hand side is destructured **by field name**. A
bare name binds a field of the same name:

```
struct Point {
    var int x
    var int y
}

const p = Point(3, 4)
var [x, y] = p
Console.write("\{x} \{y}")  // "3 4"
```

To bind a field to a differently named variable, use `[ field = name ]`:

```
const p = Point(3, 4)
var [x = px, y = py] = p
Console.write("\{px} \{py}")  // "3 4"
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
Console.write("\{w} \{d}")  // "2 6"
```

A mv struct destructures identically — use `mv` to take ownership of a
field instead of binding a view (see
[Move Destructuring](#move-destructuring-and-literal-transfers)):

```
mv struct Totals {
    var int count
    var int total
}

var c = Totals(5, 50)
var [count = mv n, total = mv t] = c
Console.write("\{n} \{t}")  // "5 50"
```

Referencing a field that does not exist on the struct is a compile
error. Without `mv`, the destructured bindings are non-mv views into
the right-hand side value, so they are not freed at scope exit (the
right-hand side retains ownership).

#### Move Destructuring and Literal Transfers

A binding prefixed with `mv` takes OWNERSHIP of the destructured field
instead of binding a view. The field's storage is revalidated (replaced with
a fresh default of its type), so the right-hand side's cleanup stays sound:

```
func make = (out [List<string>, List<int>]) {
    var t = List<string>()
    var c = List<int>()
    return [mv t, mv c]
}

var [mv a, mv b] = make()
Console.write("\{a.length} \{b.length}")   // 0 0 — a and b own their lists
```

The explicit `mv` is only needed when the source outlives the binding.
Because a temporary right-hand side (a call or a literal) exists only to
feed the bindings, its fields are transferred WITHOUT `mv`:

```
func make = (out [List<string>, List<int>]) {
    var t = List<string>()
    var c = List<int>()
    return [t, c]        // t and c are at their last use: the literal
}                        // transfers them — no `mv` required

var [a, b] = make()      // the temp dies after the bindings: a and b own
```

The same last-use inference applies to the literal's own elements: `[t, c]`
transfers `t` and `c` when neither is read again afterward; if one is read
later, that element is rejected exactly like the declaration-path copy rule
(`use 'mv t' or 't.copy()'`). Both binding forms accept the prefix —
positional (`[mv a]`) and renamed (`[field = mv name]`). Moved bindings
are ordinary owned values: they are freed at scope exit, and the moved-out
source may not be used again. Arrays cannot be move-destructured (an element
has no field storage to revalidate).

### Trait Types

Interfaces that can be implemented by structs. Every trait method is an
instance method, so its signature declares a `self` (or `ref self`)
receiver — a trait method with no receiver is a compile error:

```
pub trait Addable {
    func add = (self, #self other, out #self)
}
```

`#self` in a type position is the conformer's own type: `add` takes
another instance of the same type and returns one. Inside a trait default
body, `#self` also names the conformer in expression position (e.g.
`META.info(#self)`), which is how the reflection defaults in the standard
library derive methods per conforming struct.

Structs implement traits using `:` syntax. Multiple traits are separated by commas:

```
trait Animal {
    func speak = (self, out string)
}

trait Named {
    func name = (self, out string)
}

struct Dog : Animal, Named {
    func speak = (self, out string) { return "woof" }
    func name = (self, out string) { return "Rex" }
}
```

Structs implementing a trait can be assigned to trait-typed variables:

```
const Named named = Dog()
```

Trait functions without bodies are declarations (the implementing struct must provide the body):

```
pub trait Printable {
    func to_string = (self, out string)
}
```

### Extension Methods

Methods may be added to an existing struct outside its body with an `extend` block. Only methods may be added — fields would change the type's layout, which a value-type language cannot do out of line. Once merged, the methods are indistinguishable from ones declared in the original body: same dispatch, same visibility, same name-overloading rules.

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
const m = p.manhattan()
```

`extend` blocks may appear before or after the type they target, and may target a type from another module (including standard-library types). A method that redeclares an existing method name with the same parameter types is a duplicate error; overloads with differing parameter types are allowed. A method declared `extend` can call an in-body method on the same type, and vice versa.

An `extend` may also make an existing type conform to one or more traits out of line by listing them after `:`. The required trait methods may be supplied in the same extend's body, another extend, or the original body:

```
trait Describable {
    func to_string = (self, out string)
}

struct Circle {
    var int radius
}

extend struct Circle : Describable {
    func to_string = (self, out string) {
        return "Circle"
    }
}

const Describable s = Circle(5)
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

Shorthand is resolved in declarations with explicit type, assignments (inferred from target type), and comparisons (inferred from left operand type). Cases with associated data take their payloads in the shorthand too — `.rect(10, 20)` where `Shape` is the known type — or use the full form `EnumName.case(args)`.

Enum cases can contain information:

```
pub enum Status {
    case ok
    case fail(int code)
}

const result = Status.fail(5)
```

Enum cases can have multiple fields:

```
pub enum Shape {
    case circle(int radius)
    case rect(int width, int height)
}

const shape = Shape.rect(10, 20)
```

### Generic Enums

Enums can declare type parameters. Case payloads may use them; each concrete instantiation gets its own monomorphized type (`Result<int, string>` becomes `Result_int_string`):

```
pub enum Result<T, E> {
    case ok(T value)
    case fail(E err)
}

const Result<int, string> result = .fail("not a number")
match result {
    case .ok(age) -> Console.write("\{age}")
    case .fail(msg) -> Console.write("error \{msg}")
}
```

Shorthand cases resolve against the concrete instantiation, and the full form uses the generic name (type arguments inferred from context, or written explicitly):

```
var Option<int> found = Option.some(4)
found = .none
```

The core library ships two generic enums. `Result` is declared `checked`:

```
pub checked enum Result<T, E> {
    case ok(T value)
    case fail(E err)
}

pub enum Option<T> {
    case some(T value)
    case none
}
```

Because `Result` is checked, a fallible call's value may not be silently discarded — see [Checked Enums](#checked-enums).

### Checked Enums

An enum declared with the `checked` modifier may not have its values silently discarded: a statement-position call whose result is a checked enum value is a compile error. Bind the value or match on it — ignoring is fine, it just has to be deliberate (`_` discards explicitly):

```
pub checked enum Attempt {
    case ok
    case fail(int code)
}

func try_it = (out Attempt) {
    return Attempt.fail(5)
}

var _ = try_it()      // explicit discard
const r = try_it()    // bound: a use
match try_it() {
    case .ok -> Console.write("ok")
    case .fail(code) -> Console.write("error \{code}")
}
```

A bare statement call discards the value and is rejected:

```
try_it()  // error: value of checked enum Attempt is discarded
```

`checked` composes with visibility and generics (`pub checked enum Result<T, E>`), and carries across monomorphized instantiations (`Result<int, string>` stays checked).

## Errors

Fallible functions declare `out T ! E`; callers handle, pass on, or discard at the point of encounter. There is no throwing and no handling "somewhere up the chain" — the semantics are exactly the checked-enum machinery: `T ! E` is the type `Result<T, E>`, and an `error` enum is an always-checked enum.

### Error Enums

The `error` keyword declares an error enum — the third specialized declaration next to `enum` and `bitset`. An error enum IS an enum: cases, payloads, `match`, and `.case` shorthand all work unchanged. The keyword adds two semantics: it is always `checked` (a statement-position discard is a compile error, `var _ =` is the deliberate discard), and it is the only kind of type that may appear after `!`.

```
error FetchError {
    case notfound
}

func fetch = (string url, out Result<int, FetchError>) {
    return .fail(.notfound)
}

var _ = fetch("u")   // deliberate discard
```

A case payload that owns heap memory takes the `mv` spelling, exactly like a plain enum:

```
mv error ParseError {
    case syntax(string message)
}
```

`error` is a reserved word. A plain enum after `!` is a compile error: declare it `error`, or spell `Result<T, Direction>` explicitly.

### The `T ! E` Result Form

In a function's `out` position, `T ! E` is sugar for `Result<T, E>`:

```
error FetchError {
    case notfound
}

func fetch = (string url, out int ! FetchError) {
    if url == "" {
        return .notfound
    }
    return 7
}
```

A function declared with `!` LIFTS bare returns: a value of `T` becomes `Result.ok(value)`, a value or `.case` shorthand of `E` becomes `Result.fail(value)`, and an explicit `Result` value passes through. Resolution order: as-is, then `T`, then `E`. An explicit `out Result<T, E>` keeps today's explicit behavior — only the `!` spelling lifts.

Callers handle the result with the ordinary enum machinery:

```
var result = fetch("u")
match result {
    case .ok(value) -> Console.write("\{value}")
    case .fail(err) {
        match err {
            case .notfound -> Console.write("missing")
        }
    }
}
```

### Unit Results (`out ! E`)

A function that returns nothing but may fail declares `out ! E` — no success type, no new keyword. It desugars to the core `UnitResult<E>` (the `Result` shape with a payload-less `ok`), so checked-discard, matching, and `error`-set composition all apply:

```
error FetchError {
    case notfound
}

func close = (string path, out ! FetchError) {
    if path == "" {
        return .notfound
    }
    // falls through: success
}

func describe = (string path, out string) {
    try close(path) catch {
        case .notfound { return "missing" }
    }
    return "closed"
}
```

Falling off the end and a bare `return` are success; `return .case` or an error value is failure; an explicit `.ok`/`.fail` passes through. A plain value returned from a unit-result function is evaluated and discarded — the natural spelling for propagation:

```
func cleanup = (string path, out ! FetchError) {
    close(path)!        // propagate; success yields nothing
}
```

`var _ = close(path)` is the deliberate discard. `!!` has no success value to coalesce, so it is rejected with the discard forms named.

### The `!!` Result Coalesce

`a !! b` is the result-flavored sibling of `??`: `a` must be a `Result<T, E>`, `b` must be `T`, and the result is `T`. Consuming the `Result` discharges the checked rule by construction:

```
var body = fetch("example.com") !! 0
Console.write("\{body}")
```

A non-result left operand, or a fallback of the wrong type, is a compile error.

### Postfix `!` — Propagate

`expr!` evaluates `expr` (a `Result<T, E>`); on the fail case the enclosing function returns the error — the same early return a `return` emits — and on the ok case the value is `T`:

```
func load = (string path, out int ! FetchError) {
    if path == "" {
        return .notfound
    }
    return 7
}

func load_and_double = (string path, out int ! FetchError) {
    var value = load(path)!
    return value * 2
}

func outer = (string path, out int ! FetchError) {
    return load(path)!
}

var doubled = load_and_double("config.txt") !! 0
Console.write("\{doubled}")
```

The enclosing function must itself be `!`-declared with the same error enum — `'!' propagates to the caller` is the error otherwise. In a composed set, a member error widens through its origin tag (see below).

### Composed Error Sets

The error side may list several error enums, comma-separated — the same shape as a trait list:

```
error LoadError {
    case timeout
    case offline
}

error ParseError {
    case syntax
    case corrupt
}

func load = (string path, out int ! LoadError, ParseError) {
    if path == "/slow" {
        return .timeout
    }
    if path == "/bad" {
        return .syntax
    }
    return 7
}
```

The set composes by origin: the result's error side is one generated enum whose cases carry the whole member enums (generated tags, never spelled in source), so identical sets are identical types regardless of order. A shorthand return resolves through the members — a case declared by several members is the force-specify error (qualify the origin). Postfix `!` widens a member's error into the enclosing set:

```
func load_all = (string path, out int ! LoadError, ParseError) {
    var value = load(path)!
    return value
}

var result = load_all("/slow")
match result {
    case .ok(value) -> Console.write("\{value}")
    case .fail(err) {
        match err {
            case .LoadError(e) {
                match e {
                    case .timeout -> Console.write("timeout")
                    case .offline -> Console.write("offline")
                }
            }
            case .ParseError(e) {
                match e {
                    case .syntax -> Console.write("syntax")
                    case .corrupt -> Console.write("corrupt")
                }
            }
        }
    }
}
```

Only `error` enums may join a set. A heap-owning member (`mv error` with string payloads) transfers its ownership into the set: a bare local donor moves (it is invalid afterwards), a fresh construction is claimed, and a bare field read is rejected — construct fresh or `mv` the field out with a swap.

### Anonymous Error Sets

The error side may be an inline anonymous enum — cases with optional payload TYPES, exactly like the standalone anonymous-enum form:

```
func fetch = (string url, out int ! [.notfound, .offline]) {
    if url == "" {
        return .notfound
    }
    if url == "/offline" {
        return .offline
    }
    return 7
}

var result = fetch("")
match result {
    case .ok(value) -> Console.write("\{value}")
    case .fail(err) {
        match err {
            case .notfound -> Console.write("missing")
            case .offline -> Console.write("offline")
        }
    }
}
```

The generated enum is the error enum itself, so bare returns and `try/catch` arms resolve exactly as they do for a named `error` enum. It cannot join a composed set — name the enum instead. A success-side anonymous enum (`out [.ok, .redirect] ! E`) matches through `.ok(value)` (`.ok` stays the Result's case).

### Handling the Error Side: `try / catch`

A result's error side is handled at the point of encounter with `try expr catch`. The catch arms address the ERROR enum directly — the success side is implicit: the ok value flows through as the expression's value, so no `.ok` arm is written:

```
error FetchError {
    case notfound
    case offline
}

func fetch = (string url, out string ! FetchError) {
    if url == "" {
        return .notfound
    }
    return "content:" + url
}

func describe = (string url, out string) {
    return try fetch(url) catch {
        case .notfound -> "missing"
        case .offline -> "offline"
    }
}
```

The scrutinee is evaluated once, and the chosen arm produces the expression's value (the catch set must be exhaustive). In statement position a unit result (`out ! E`) is handled the same way, minus the value: the ok path falls through, and the arms are block branches or `return`s — `->` value arms are rejected, since there is no success value to produce:

```
error CloseError {
    case notfound
    case denied
}

func close = (string path, out ! CloseError) {
    if path == "" {
        return .notfound
    }
    if path == "/private" {
        return .denied
    }
}

func finish = () {
    try close("scratch/a") catch {
        case .notfound { Console.write("gone") }
        case .denied { Console.write("denied") }
    }
    Console.write("closed")
}
```

An expression-position `try` still requires a `T ! E` result with a success value — propagate a unit result with `!`, discard it with `var _ =`, or match the result explicitly.

In a composed set, arms may name the origin: `LoadError.timeout` is one case of one member, and `LoadError(err)` binds the whole member error (the inner match then resolves its cases):

```
func describe = (string path, out int) {
    return try load(path) catch {
        case LoadError.timeout -> -1
        case LoadError.offline -> -2
        case ParseError.syntax -> -3
        case ParseError.corrupt -> -4
    }
}
```

An unqualified `.timeout` resolves across the set's members when exactly one declares it; several is the force-specify error (spell the origin). The catch arms lower to ordinary matches, so the usual rules apply: the generated per-member matches must be exhaustive (cover every case, or bind the whole member with `case E(err)`), and binding a whole member (`case E(err)`) excludes per-case arms for that member. `.ok` and `.fail` arms are rejected inside `catch` — the success side is implicit.

`match` remains the explicit spelling for inspecting BOTH sides: its arms are the result's own cases (`.ok(value)` / `.fail(err)`), and an error-side case there is an error pointing at `try/catch`.

## Bitsets

Bitsets are used to define a restricted set of options that can be combined using bitwise operators:

```
pub bitset Permissions {
    case read
    case write
    case execute
}

const perms = Permissions.read | Permissions.write
```

Like enums, bitsets can be declared `checked` (`pub checked bitset Flags`), with the same discard rules — see [Checked Enums](#checked-enums).

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
const name = "Alice"
var age = 30
var uint count = 10  // explicit annotation when `int` isn't the wanted type
```

Types are inferred from initializers when omitted:

- `true`/`false` → `bool`
- `"..."` → `string`
- `'h'` → `char`
- integers → `int`
- floats → `float`
- `null` → `null` (requires explicit nullable type annotation)

`view` declares a non-mv borrow binding (a `(ptr, len)` slice). A bare
`view` is an immutable (const) view; `var view` is a mutable view you can
re-point. The element type is inferred. See [Slicing](#slicing).

#### Global Variables

A file-scope `const` or `var` declaration is a global: it is visible to every
function in its file (subject to the visibility modifiers — `pub` exports it
to importers), lives for the whole program, and needs no `main` to exist:

```
var total = 0

func bump = () {
    total += 1
}

pub func main = () {
    bump()
    bump()
    Console.write_line("\{total}")   // 2
}
```

Prefer passing state through parameters — globals are the escape hatch for
process-lifetime values (an app-lifetime `Channel`, a shared registry). The
concurrency rules treat a global as its own lifetime region: a global donor
can cross a task boundary bare, because nothing can ever dangle it (see
[Sendable](#sendable)).

```
const greeting = "hello world"
view hi = greeting.slice(0, 5)       // const view, inferred `view string`
var view cursor = greeting.slice(0, 3)  // mutable, re-pointable
```

### Functions

```
pub func greet = (string name) {
    Console.write("Hello, \{name}.\n")
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
    Console.write("Hello, \{name}!")
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

Parameters are `const` by default. A function that needs a mutable scratch value makes a local `var` copy; use `ref` for pass-by-reference:

```
func increment = (int x, out int) {
    var y = x        // mutable local copy — the caller never sees it
    y = y + 1
    return y
}

func make_five = (ref int x) {
    x = 5  // modifies the caller's variable
}
```

A local `var` copy — changes don't affect the caller. `ref` passes a pointer to the caller's variable — changes are visible to the caller. The `ref` keyword is required at both the definition and call site (see [Reference Types](#reference-types)).

A `ref` parameter may declare the fields it may displace as a brace set after its name (`ref Item item { stats }`), which narrows the invalidation of the caller's borrows to exactly those fields — see [Declared Field Effects](#declared-field-effects).

#### Function-Typed Parameters (Higher-Order Functions)

Parameters can be function types:

```
func apply = (func (int, out int) mapper, int value, out int) {
    return mapper(value)
}

var func (int, out int) doubler = (x) => x * 2
var func (out int) three = () => 3
var func (int) log = func (int x) { Console.write("\{x}") }
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

func make_three = (out func (out int)) {
    return () => 3
}
```

Higher-order signatures nest to arbitrary depth:

```
func run = (func (func (out int), out int) g, func (out int) v, out int) {
    return g(v)
}
```

A func value's signature must match where it is used: an argument against
the parameter's signature, a returned value against a `func`-typed return,
and an initializer or assignment against the declared type. The comparison
covers the parameter count, each parameter type (nested func parameters
included), and the result type.

#### Nullable Function Types

A func type can be made nullable with `?` — `func?` — so
the binding may hold `null`. This is the spelling for optional callbacks:
the callee null-checks before calling.

```
func run = (func? (out int) callback) {
    if callback != null {
        callback()
    } else {
        Console.write("skipped")
    }
}

func five = (out int) {
    return 5
}

run(five)   // calls the callback
run(null)   // prints "skipped"
```

Assigning `null` to a non-nullable func type is a compile error, and the
compiler rejects a call through a binding that may still be null — only a
passed null check (`!= null`) narrows it:

```
var func? (out int) f = null
f()                        // Error: Variable 'f' may be null
if f != null {
    f()                    // OK
}
```

Nullability applies at every func-type position: parameters (including
nested ones), `out` return slots (`out func? (...)`), locals, and
struct fields (`var func? (int) close_node = null`).

#### Foreign Functions

A body-less `foreign func` declaration maps a Nomen function onto a C
library symbol named by the declared function name. Parameters and return
types must be scalars or `string`. A `string` parameter marshals to the
thin C `char*` (the buffer is NUL-terminated), and a `string` return is
re-wrapped as an owned string with its length. Externs are library-only:
declaring one outside the System library is a compile error.

```
// In the System library (core/System/Init.nm):
foreign func atoi = (string s, out int)

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

var v = Vec2(2, 3)
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

- Scalars and non-mv value structs are **copied** (a later write to the
  source is not seen by the lambda).
- Strings are **moved** into the closure: the lambda holds the value at
  capture time, and the donating local is invalidated (using it again is a
  use-after-move error). Capture a copy (`tag.copy()`) to keep using the
  local.
- Owning value structs, trait-typed values (boxed handles, regardless of
  the conformer's kind), and other func-valued closures are **moved** into the
  closure; the donating local is invalidated (using it again is a
  use-after-move error). A capturing closure is move-only: initializing or
  assigning a func-typed binding from one transfers it.
- `ref`/`var` borrows, views, arrays, and raw pointers cannot be captured.

```
pub func main = () {
    const base = 10
    var func (int, out int) add_base = (x, out int) => x + base
    Console.write("\{add_base(1)} \{add_base(2)}")
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
```

An import names a **namespace** — a directory of the library. Module files
(`Controls/Geometry.nm`) are invisible to imports: a file-segment spelling
(`import System::Controls::Geometry`) is a compile error —
`Unknown import path: System::Controls::Geometry` — import the namespace
instead. A path that names nothing (`import System::Contrls`, note the typo)
is the same error: `Unknown import path: System::Contrls`.

Imports must appear at the top level (root scope) — an `import` inside a
function, struct, or other scope is a compile error.

#### Qualified References

Code can reference a library type, free function, or value through its
namespace path with `::`. Qualified references resolve to the same flat names
as their unqualified forms; the path prefix documents (and the compiler
validates) where the name comes from:

```
import System
import System::Text
import System::Controls

const ok = Text::Regex.test("a+b", "aaab")
const size = Controls::Size()
```

A `::` path always names an entity — a type, a free function, or a value.
Member and method access stays with `.` (`Text::Regex.test(...)`, not
`Text::Regex::test(...)`).

Every segment before the last is a NAMESPACE — a directory of the library.
Module files are invisible to the path: `Geometry.nm` does not appear in
`Size`'s spelling (`Controls::Size()`, never `Controls::Geometry::Size()`),
and a file-segment spelling is a compile error —
`Unknown namespace: Controls::Geometry`.

A qualified reference is visible only when the referencing file can reach the
name's namespace — its own namespace, an ancestor of it, or an import
(see [Visibility Modifiers](#visibility-modifiers)). `import System` alone
does not expose `Text` or `Controls` names, however the reference is spelled.
`Control::Button` (note the missing `s`) is a compile error:
`Namespace Control::Button is not imported`.

### Match, Switch and If as Expressions

`match`, `switch`, and `if`/`else` can all be used as expressions (assigned to
a `const`/`var` or returned). When used as an expression, a `case _` arm is
required for `match` (on non-exhaustive types) and `switch`, and the branch
types must be compatible:

```
const label = match x {
    case 1 -> "one"
    case 2 -> "two"
    case _ -> "other"
}
```

```
const size = switch {
    case x > 100 -> "big"
    case x > 10 -> "medium"
    case _ -> "small"
}
```

```
const verdict = if ok -> "yes"
                else -> "no"
```

Exhaustiveness rules (see [Match Statement](#match-statement) and
[Switch Statement](#switch-statement)) apply identically whether the construct
is used as a statement or as an expression. One-line arms introduce their
value with `->`; block arms yield theirs with `let` (see
[Branch Values](#branch-values)).

### Structs

Structs group related data and behavior. Fields are declared with `var` (or
`const` for compile-time-known values) and methods are declared as functions
whose first parameter is `self`. A `#init` function is auto-generated from the
fields that have no default value, so a struct can be constructed by
calling its name as a function:

```
pub struct Point {
    pub var int x
    pub var int y

    pub func translate = (ref self, int dx, int dy) {
        self.x = self.x + dx
        self.y = self.y + dy
    }

    pub func distance_from_origin = (self, out int) {
        return (self.x * self.x + self.y * self.y)
    }
}

var p = Point(3, 4)       // auto-generated #init
p.translate(1, 1)
const d = p.distance_from_origin()   // 3*3 + 4*4 = 25
```

#### Move-Only Structs

`mv struct` declares the type MOVE-ONLY: bindings move
instead of copy, and the declaration — not a field walk — is the ownership
contract. A bare `struct` is Copyable; the checker verifies that claim: a bare
struct with a declared-`mv` field is rejected, naming the fix. A struct
declaring `#destroy` must be declared `mv struct` too — a destructor cannot
be Copyable, and the checker rejects the Copyable spelling.

```
mv struct Config {
    mv string name
}

var c = Config("x")
mv c2 = c        // transfer: c is invalid afterwards
var c3 = c.copy()  // explicit deep copy, c stays valid
var c4 = c         // Error: cannot copy 'Config' by value — use .copy() or mv
```

```
mv struct Config {
    mv string name
}

struct Wrapper {          // Error: 'Wrapper' cannot be Copyable — field 'c'
    var Config c          //   owns heap memory --> mark the struct
}                         //   `mv struct Wrapper` and declare the field
                          //   `mv Config c`, or remove the field
```

The same verifier applies to enums: a bare `enum` with a case payload typed a
declared-`mv` struct must be declared `mv enum`, and bindings of
a declared-`mv` enum move instead of copy.

**Fields: slots that receive moves spell `mv`.** `mv` marks a slot an owned
value can move into — it is the slot's transfer protocol, not its ownership.

- Ownership is the type's business: the field is destroyed with the struct,
  and a re-assignment reclaims the displaced value whether or not `mv` is
  written. That is why a `const` may own and a `view` may borrow, and neither
  spells `mv` — no move ever lands in them.
- Owning scalar slots (`string`, a `Box<T>`, another mv struct, a mv enum, a
  trait handle) DO receive moves — construction and stores transfer (the
  synthesized `#init` parameter is a `mv` param), and borrow stores are
  rejected — so they spell it. `mv` is required on the declaration:
  "implicit with type inference, explicit with memory management".
- A bare `struct` cannot hold these fields — the verifier above rejects it,
  naming the fix.

```
mv struct Dog {
    var int id
}

mv struct Holder {
    mv Dog d        // owned slot: Holder(mv d) transfers, `mv` is the spelling
}
```

A trait-typed field is not supported yet (the concrete type or `Box<Concrete>`
is the fix while the boxed-handle field lowering is pending).

**Nullable lowerings.** `T?` keeps one language-level semantic with two
mechanical lowerings, chosen by shape: `Box<T>?` (and any pointer-shaped
handle) is the null pointer — the natural null slot; an inline struct `T?`
(mv or Copyable) keeps the companion `<slot>_has` flag. Nothing boxes
silently and no presence byte is spent on types with a natural null slot.

#### Box

`Box<T>` is a mv pointer to a heap-allocated value — the cycle-breaking
and stable-address shape. A Box is ONE POINTER at runtime: `Box<T>?` is the
natural null slot, construction moves the value in (boxing takes ownership),
destroy reclaims the pointee, and field/method access THROUGH the box is
transparent — the checker rewrites `box.f` to the pointee's `f`.

```
mv struct Node {
    var int value
    mv Box<Node>? next      // the sanctioned pointer field: breaks the cycle
}

var n = Node(1, null)
var b = Box<Node>(mv n)   // boxing moves: n is invalid after
Console.write_line("\{b.value}")      // 1 — access through the box
Console.write_line("\{b.next == null}")   // true (the pointee's next slot)
```

An inline containment cycle is a compile error naming the fix:

```
mv struct Node {
    var int value
    var Node next     // Error: field 'next' closes an inline containment
                      //   cycle — declare it `Box<Node>`
}
```

Fields without default values that have constraints propagate those
constraints to the generated `#init` parameters (see
[Field Constraints](#field-constraints)). You can also define a custom `#init`
to take full control of construction (see [Initializers](#initializers)). A
bare struct is a value type: assigning it copies the fields. For heap
ownership and shared-in-scope aliasing, use `mv struct` plus `Box<T>` /
`ref` — see [Move-Only Structs](#move-only-structs).

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

pub struct Point: Printable {
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

Conforming to `Stringable`, `Equatable`, or `Hashable` binds the trait's
reflection default — a `#for`-based default body over
`META.info(#self).fields` — when the struct does not supply the method
itself, the same way a struct gets an auto-generated `#init`. A hand-written
method always wins. The default is expanded per conformer (with `#self` as
the conformer's type), so a field that cannot derive — a field type with no
`to_string`, no `==`, and no `hash` for the respective trait — is a
per-field compile error in the generated body, not a silent skip.

```
pub struct Point: Equatable, Stringable {
    pub var int x
    pub var int y
}

const a = Point(1, 2)
const b = Point(1, 2)
const same = a == b                  // true  — derived #op_eq
const diff = a != b                  // false — derived from #op_eq
const s = a.to_string()              // "Point(x=1, y=2)" — derived to_string
```

`Stringable` derives a `to_string` that lists each field as `name=value`.
`Equatable` derives `#op_eq` (and `!=` as its negation) by comparing fields with
`==`. `Hashable` derives a `hash` method (returning `uint`) by combining field
values — scalar fields (int/bool/char) cast to `uint`, other conforming fields
call their own `hash`. Nested structs participate as long as they conform to
the same trait; recursion is ordinary method dispatch on the field's type.

The derivation is library code and attribute-configured: the `Hashable`
default skips fields marked `@hash_ignore` (an identity-only field — a
cache slot, a stamp — does not perturb the hash). Any conformer can write
its own reflection default the same way.

## Statements

### If/Else

The condition must be a `bool`. The `else` branch is optional. Both branches may
be a single expression (introduced with `->`) or a block (`{ }`):

```
if x > 0 {
    Console.write("positive")
} else {
    Console.write("zero")
}
```

An `if` used as an expression requires an `else` — without one there is no
value for the skipped branch:

```
const result = if x > 0 -> "positive"
               else -> "zero"
```

`else if` is **not** supported. Use a `switch` for chained conditions instead:

```
switch {
    case x > 0 -> Console.write("positive")
    case x < 0 -> Console.write("negative")
    case _ -> Console.write("zero")
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
    case _ -> "other"
}
```

Each `case` value is type-checked against the match expression type. Branches can use `->` for expression return or `{ }` for block body. A `case _` arm is required when a match on a non-exhaustive type (`int`, and other types without a fixed case set) is used as an expression value; matches on enums and `bool` are exhaustive without one. The catch-all must be the last arm and appear at most once.

Match with enums (using shorthand syntax):

```
enum Direction {
    case north
    case south
    case east
    case west
}

const direction = Direction.north
match direction {
    case .north -> Console.write("north")
    case .south -> Console.write("south")
    case .east -> Console.write("east")
    case .west -> Console.write("west")
}
```

Enum case values can use either shorthand (`.north`) or full form (`Direction.north`). Matches on enums without a `case _` arm must be exhaustive — all enum cases must be covered, or a compile error is produced.

Match with bools:

```
match flag {
    case true -> Console.write("yes")
    case false -> Console.write("no")
}
```

Match on `bool` without a `case _` arm must cover both `true` and `false`. Match on `int` and other types does not require exhaustiveness — a `case _` arm is optional.

Match with enums and associated data:

```
enum Status {
    case ok
    case fail(int code)
}
const result = Status.fail(10)
const message = match result {
    case .ok -> "it's ok"
    case .fail(code) -> "error \{code} encountered"
}
```

### Switch Statement

Switch evaluates independent boolean conditions:

```
switch {
    case x > 100 {
        Console.write("big")
    }
    case x > 10 {
        Console.write("medium")
    }
    case _ {
        Console.write("small")
    }
}
```

A `->` arm produces the switch's value — bind it (`var label = switch { ... }`) rather than letting a statement-position switch discard it.

Unlike `match`, each `case` has its own boolean condition. A `case _` arm is required when using `switch` as an expression value.

### While Loop

```
while x < 10 {
    Console.write("\{x}")
    x += 1
}

// With update clause
while x < 10; x += 1 {
    Console.write("\{x}")
}
```

### For Loop

For-each over arrays:

```
const int[] items = [1, 2, 3]
for item of items {
    Console.write("\{item}")
}
```

Range iteration:

```
for i of 0..10 {
    Console.write("\{i}")
}
```

Loop iterators are **const by default**. Use `for ref x of arr` to get mutable
element access:

```
var Point[] points = [Point(0, 0), Point(0, 0)]
for ref p of points {
    p.x = 1     // mutates the element in the array
}
```

The loop variable is a **borrow of the element**, not an independent copy:
it binds to the element's slot, so writes land in the array immediately —
visible to later reads of the array (and to any alias) inside the same
iteration, with no write-back step at the iteration's end. Arrays are
fixed-length, so the slot address is stable for the loop's lifetime.

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
var should_exit = false
var should_skip = false
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

### Nested Blocks

A bare `{ ... }` block statement is a plain lexical scope. Declarations inside
it die — and their deterministic destruction runs — at the closing brace: the
one-zero-cost way to release a `mv` value before the enclosing function ends.
A block-local is invisible after the block, and may shadow an outer binding:

```
const shared = "outer"
{
    var temp = "heap value".to_string()
    Console.write(temp)         // "heap value"
}                               // temp's storage is released here
Console.write(shared)           // "outer"
```

A `return` inside a nested block returns from the enclosing function.

### Return

```
return value
```

### Branch Values

One-line branches introduce their value with `->`; a block branch yields its
value with `let` — the block twin of `return` in a lambda body (a bare
expression in a block does not yield):

```
const result = if x > 0 -> "yes"
               else -> "no"

const grade = if score > 90 {
    var bonus = 2
    let "A+\{bonus}"
} else {
    let "B"
}
```

`let` is not an implicit `return`: a function must use an explicit `return`
to produce its value, and a `let` outside a branch (a plain function body or
block) is a compile error.

### Panic

```
panic("something went wrong")
```

Terminates the program with the given message.

### Todo

```
todo("not implemented yet")
```

Marks unimplemented code. Prints the message and exits at runtime. Satisfies return requirements so code containing `todo` type-checks correctly.

## Expressions

### Literals

```
// Numbers
const a = 42
const b = 3.14
const c = -5

// Integer literals in other bases
const hex = 0xFF            // hexadecimal (255)
const oct = 0o377           // octal      (255)
const bin = 0b11111111      // binary     (255)
const group = 0xCAFE_F00D   // underscores are digit separators

// Strings (multiline supported - start continuation lines with ")
const s = "Hello, World!"
const multi =
    "Line 1
    "Line 2

// Characters
const ch = 'h'

// Booleans
const flag = true

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

### Compile-time Embedding

`#embed_file("path")` is a string literal whose value is the contents of the
file at `path`, read once when the program is compiled — no runtime file
access, no path dependence in the built binary. The path resolves against the
package root (the directory containing `package.jsonc`), or the compiled
file's folder when no package root exists:

```
const banner = #embed_file("assets/banner.txt")
Console.write(banner)
```

The literal participates in the type system exactly like a written string
literal (`.length`, slicing, concatenation all work), so it is checked and
built on both backends with no special casing. A path that cannot be read is
a compile error.

### Arrays

```
const numbers = [1, 2, 3, 4, 5]
const int[] empty = []

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

| Precedence | Operators                                                                                |
| ---------- | ---------------------------------------------------------------------------------------- |
| 1          | `=`, `+=`, `-=`, `*=`, `/=`, `%=`                                                        |
| 2          | `??`, `!!`                                                                               |
| 3          | `\|\|`                                                                                   |
| 4          | `&&`                                                                                     |
| 5          | `==`, `!=`                                                                               |
| 6          | `<`, `<=`, `>`, `>=`                                                                     |
| 7          | `\|`                                                                                     |
| 8          | `^`                                                                                      |
| 9          | `&`                                                                                      |
| 10         | `<<`, `>>`                                                                               |
| 11         | `+`, `-`                                                                                 |
| 12         | `*`, `/`, `%`                                                                            |
| 13         | unary `-`, `!` (unary NOT)                                                               |
| 14         | postfix `.` member, `?.`, `()` call, postfix `!` (propagate), `as`, `..`, `[i]` (unsafe) |

Prefix operators bind their operand's full postfix chain (`!a.b.c()` is
`!(a.b.c())`), and postfix operators bind tighter than any binary operator
(`a ?? b.c` is `a ?? (b.c)`). Coalescing (`??`/`!!`) is looser than `&&`:
`a ?? false && false` reads as `a ?? (false && false)`. The bitwise
operators bind **tighter** than the comparisons: `flags & mask == mask`
reads as `(flags & mask) == mask`, with no parentheses required.

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

Supported operator functions: `#op_add` (+), `#op_sub` (-), `#op_mul` (\*), `#op_div` (/), `#op_mod` (%), `#op_eq` (==), `#op_ne` (!=). The `as` cast has its own operator function, `#op_as` (see [Custom Struct Casting](#custom-struct-casting)).

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

    func #op_div = (self, Vec2 other: other.x != 0 && other.y != 0, out Vec2) {
        return Vec2(self.x / other.x, self.y / other.y)
    }

    func #op_mod = (self, Vec2 other: other.x != 0 && other.y != 0, out Vec2) {
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

### Division and Modulo by Zero

Integer `/` and `%` carry a compile-time divisor contract: the right operand is
treated as if declared `int other: other != 0`. A divisor the checker can prove
zero is a compile error, and a runtime divisor that cannot be proven non-zero
must be guarded — the same contract model `.at()` applies to indices:

```
struct Ratio {
    var int value

    func #op_div = (self, int scale: scale != 0, out Ratio) {
        return Ratio(self.value / scale)
    }
}

var r = Ratio(100)
var half = r / 2        // 2 is provably non-zero

var n = 2
var q = 10 / n          // n's initializer proves it non-zero

if n != 0 {
    var third = 10 / n  // the guard discharges the divisor contract
}
```

- `5 / 0` and `5 % 0` are compile errors: `Parameter constraint
not satisfied: divisor`.
- An unverifiable runtime divisor errors with `Parameter constraint
cannot be verified` unless the code is inside the System library;
  discharge it with a guard (`if n != 0`, `if n > 0`, a clamp) or a
  provably non-zero value.
- Float division by zero is unconstrained (IEEE ±inf / NaN).
- The contract is declared as a parameter constraint on the built-in integer
  types' operator functions (`#op_div = (self, int divisor: divisor != 0, out
int)`); scalar arithmetic still lowers natively, so those declarations are
  contract signatures. Any operator function — built-in or user-defined —
  carries its contracts the same way, and the checker applies them at every
  operation site.
- A constraint declared on a user operator function's parameter
  (`#op_div … int scale: scale != 0`) verifies at the operation site — a
  provably violating argument is an error — and its facts discharge the
  function body's own divisions.

### Integer Overflow

Integer arithmetic wraps silently (two's complement) — there is no trap, no
promotion, and no panic:

```
var uint8 a = 200
a += 100
Console.write("\{a}")   // 44 — wrapped

var int8 b = 120
b += 120
Console.write("\{b}")   // -16 — wrapped
```

Only a literal that does not fit its target type is a compile error (see
[Literal Coercion](#literal-coercion)); runtime values wrap. If wrap is not
what you want, widen the type (`int64`, `uint64`) or constrain the operands
before the operation.

### Evaluation Order

Operands are evaluated left to right. Call arguments are evaluated left to
right, and each argument's side effects complete before the next argument
begins. `&&` and `||` short-circuit (the right operand runs only when the
left does not decide the result); `?.` and `??` evaluate the left operand
once and the right only when the left is null; `!!` mirrors `??` for
results.

### Cast Operator (`as`)

Explicit type conversion using `as`:

```
const x = 42
const f = x as float
const b = x as int8
```

Allowed casts:

- `int` ↔ `int` (any sizes)
- `int` ↔ `float`
- `float` ↔ `float`
- `bool` ↔ `int`
- `char` ↔ `int`

#### Enum Case Casts

A base enum value and its case-typed (`Enum.case`) form convert explicitly
through `as`:

```
mv enum Res {
    case err(string message)
    case ok(int count)
}

var r = Res.ok(42)
var Res.ok ok = r as Res.ok
var back = ok as Res
```

- `r as Res.ok` is a **checked cast**: the value's tag is compared at runtime
  and a variant mismatch panics (`base to case conversion: the value carries
a different variant`). The check is opt-in and call-site visible — the same
  philosophy as the `_or_panic` family; an implicit base→case conversion
  does not exist.
- Both directions **copy**: the result is an independent value and the source
  keeps ownership.
- An enum whose payloads cannot be deep-copied (a trait or `mv`-struct
  payload) rejects the cast — use `match` to move the payload.

#### Custom Struct Casting

Structs can define custom cast behavior with `func #op_as`:

```
struct Dog {
    var int value

    func #op_as = (self, out Cat) {
        return Cat(self.value + 1)
    }
}

struct Cat {
    var int value
}

const dog = Dog(9)
const cat = dog as Cat
```

#### Implicit Casting

Automatic widening is allowed without `as` — the rules are exactly
[Type-to-Type Coercion](#type-to-type-coercion) (larger or same-size type of
the same signedness, unsigned to signed if the target is larger, signed never
to unsigned).

### String Operations

```
const greeting = "Hello, " + name     // Concatenation
const dashes = "-" * 10              // Repetition: "----------"
```

### String Interpolation

Expressions are embedded in strings with `\{...}`. Each expression has `.to_string()` called automatically:

```
Console.write("Hello, \{name}. You are \{age} years old.")
const arr = [1, 2, 3]
Console.write("\{arr}")             // Arrays stringify element-by-element
```

A format spec after the expression — `\{expr:spec}` — pads, aligns, or
re-bases the rendering. The spec is checked at compile time: each part is
validated against the expression's type, and an invalid spec or a type
mismatch is an error, never a runtime surprise. The grammar is a fill, a
width, a float precision, and an integer base, in that order, each part
optional:

- `<N` / `>N` — left- or right-align the rendering in a field of N
  characters, padded with spaces. A bare width pads on the left (right-align).
- `0N` — zero-pad to width N, between the sign and the digits. Integers and
  floats only. `0` and `<`/`>` are alternative fills and do not combine.
- `.N` — render a float with N decimal places (fixed notation). A precision
  on a non-float is a compile error.
- `x` / `X` / `b` / `o` — render an integer as hexadecimal (lower/upper),
  binary, or octal. A base on a non-integer is a compile error. A negative
  value renders its magnitude with a leading `-` in every base.
- `n` (or `N`) — render with thousands separators every three digits
  (integers and floats). A float without a precision takes two decimals;
  `.N` sets them. Width and alignment compose; zero-padding does not
  combine with grouping. A grouped 64-bit integer is rendered exactly.
- `e` / `E` — render a float in exponential notation (lower/upper `e`).
  Floats only; a float without a precision takes six decimals, and `.N`
  and width compose as usual.

```
var price = 9.5
var count = 3
var flags = 255
var label = "Go"
var total = price * (count as float)
var audience = 1234567
var speed = 0.00025
Console.write("total \{total:.2}")
Console.write("[\{label:>8}] [\{count:03}] [\{flags:x}]")
Console.write("[\{label:<8}] [\{flags:08X}] [\{flags:b}]")
Console.write("\{audience:n} viewers")
Console.write("\{total:.2n} owed")
Console.write("speed \{speed:.2e} m/s")
```

A spec containing `#` or `,` is a custom pattern instead — a
compile-time-validated mini-language. A pattern may carry a `<N`/`>N`
alignment prefix; everything after it is the pattern:

- `0` — a digit slot that always renders (zero-pads the value out to it).
- `#` — a digit slot that renders only when a digit exists.
- `.` — the decimal point. Fraction slots after it render decimals; slots
  ending in `#` trim trailing zeros (`0.00` is fixed two decimals, `0.##`
  is up to two).
- `,` — the group separator between digit slots. The rightmost comma's run
  sets the group size for every group.
- `%` — scales the value by 100 and emits `%` at its position.
- `'...'` — a quoted literal. Any other character passes through, so
  `$#,##0.00` needs no quotes.
- `;` — at most two sections (`positive;negative`). A negative value
  renders its absolute value through the second section, sign and all —
  `#,##0.00;(#,##0.00)` yields accounting parentheses.

Exponential patterns, the per-mille sign, trailing-comma scaling, and
three-section forms are not in the language (use the `:e` spec for
scientific output). Rounding is to nearest.

```
var audience = 1234567
var total = 1234567.5
var share = 0.125
var debt = -9876
Console.write("\{audience:#,##0} viewers")
Console.write("\{total:#,##0.00} owed")
Console.write("\{share:0.0%} share")
Console.write("\{debt:#,##0.00;(#,##0.00)}")
Console.write("[\{total:>14#,##0.00}]")
```

Anything else in a spec is a compile error — an unknown character, an empty
width after a fill, a precision combined with a base:

```
var n = 5
Console.write("\{n:.2}")
// Error: format spec ':.2': precision requires a float, but the value is int
```

### Indexing

Arrays and strings are accessed via `.at()` and modified via `.set()`:

```
var arr = [10, 20, 30]
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

For indices no guard proves, runtime-checked forms turn the contract into a
plain runtime test instead of a compile error:

```
var arr = [10, 20, 30]
var c = arr.at_or_null(50) ?? 0   // null when out of range → 0
var v = arr.at_or(50, 0)          // the fallback when out of range
```

`at_or_panic(index)` traps on an out-of-range index — for the cases where
out-of-range is a bug, not a branch. The same family exists on `string`
(with `char` elements), `List`, `StableList`, and `LinkedList`.

### Slicing

`slice(start, end)` returns a non-mv `view T` — a `(ptr, len)` borrow of
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
Console.write("\{v.length}")         // 5

const nums = [10, 20, 30, 40, 50]
view s = nums.slice(1, 4)         // `view int`
Console.write("\{s.length}")          // 3
Console.write("\{s.at(0)}")           // 20
Console.write("\{s.at(2)}")           // 40

var list = List<int>()
list.push(1)
list.push(2)
list.push(3)
view t = list.slice(0, 2)         // delegates to the backing Buffer's slice
Console.write("\{t.at(1)}")           // 2
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
pub mv struct UserList: Viewable {
    var length = 0
    mv Buffer<int> items = Buffer<int>()
    pub func slice = (
        self,
        int start: start >= 0,
        int end: end >= start && end <= self.items.cap,
        out view int,
    ) {
        return self.items.slice(start, end)
    }
}
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

var arr = [1, 2, 3]
view v = arr.slice(0, 2)
arr = [9, 9, 9]
Console.write("\{v.length}")  // Error: borrow invalidated by source reassignment
```

#### Views in structs

Structs may declare `view T` fields — a non-mv `(ptr, len)` pair stored by
value, so copying the struct copies the borrow and nothing is freed on destroy.
This is the zero-copy way to keep small records over a buffer owned in the
same scope:

```
pub struct Line {
    var view string text
    var start = 0
    var len = 0
}

var doc = "name other"
var first = Line(doc.slice(0, 4))
first.text.to_string()   // "name" — no heap copy of the slice was made
```

A struct with `view` fields is a **scope-local bundle**: its bytes borrow from
storage in the scope that built it, so it cannot cross a call boundary in any
direction — passing one as an argument (container stores included), returning
one (even self-rooted from a method), and assigning one to an outer scope are
all compile errors. Methods may still be _called on_ one (the receiver is
checked at the call site), and its fields may be read and re-pointed freely
while it lives. To hand a callee a piece of the bundle, pass the field — a
plain `view T` argument, which is a call-scoped borrow:

```
func render = (Line l) {
    // render the line's fields
}

render(first)
// Error: cannot pass a 'Line' as an argument — structs with 'view' fields
//   are scope-local; pass the fields (the views) instead
```

```
func make_line = (out Line) {
    var doc = "hi"
    return Line(doc.slice(0, 2))   // Error: structs with 'view' fields are scope-local
}
```

To keep many records over one long-lived buffer, store `(start, length)`
integers and re-slice on use — the records cannot outlive the source, so the
check is the scope itself. Mutating a source invalidates every bundle borrowing
from it until the field is re-pointed:

```
var doc = "name other"
var first = Line(doc.slice(0, 4))
doc = "other name"
first.text.to_string()
// Error: view field 'text' was invalidated by a mutation of its source
```

### Field Access

```
const point = Point(5, 10)
const x = point.x
```

### Method Calls

A method that declares `self` (or `ref self`) is an **instance method** — it
is called on a value. A method with no receiver is **static** — it is called
on the type, and there is no `static` keyword to spell it otherwise. The
receiver form must match the declaration: calling a static method on an
instance, or an instance method on the type, is a compile error.

```
// Instance method
point.add(other)

// Static method — called on the type
const zeros = Array.with(0, 3)
```

## Visibility Modifiers

- `pub`: Public (reachable wherever its namespace is reachable)
- `internal`: Internal (accessible only within the declaring namespace and
  its descendants)
- an unmarked declaration: the tightest scope — visible only within its own
  namespace

Visibility tracks **namespaces**. A namespace is a `::`-joined directory
path: `System`, `System::Controls` for library files; the entry-relative
directory (`Blah`, `Blah::Sub`) for a program's own folders. Three rules
govern every access:

1. **Reachability.** A name is reachable from code in namespace `A` when the
   name's namespace is `A` itself, an **ancestor** of `A` (parent namespaces
   are accessible without an import), or a namespace `A`'s file **imports**.
   `import System` grants only `System`'s own names — never its
   descendants': reaching `Controls` names requires `import System::Controls`.
2. **`internal` narrows to the namespace tree.** An `internal` declaration is
   callable only from its own namespace and its descendants. A child
   namespace sees its parents' internals (`System::Controls` calling
   `Buffer`'s slab accessors); a sibling or an outside consumer does not,
   even when the namespace is imported. This is what keeps the System
   library's low-level internals reserved for the library while every `pub`
   surface works for consumers.
3. **Unmarked closes the door.** An unmarked top-level declaration is
   visible only within its own namespace — not to ancestors, not through
   imports. It is the spelling for module-private helpers (`fold_pattern` in
   `Text::Regex`, a container's file-local scratch type).

The built-in scalar types — `int`, `uint`, the sized ints, floats, `char`,
`string`, `bool`, `func` — are language surface, not library surface: their
names, their operators, and their members (`to_string`) work in every
namespace. Everything else in `System` (`Console`, `Buffer`, `Size`, ...)
follows the rules above.

Struct, enum and extend members default `pub` — value-record fields are the
language's primary surface, and a trait member is exported with its contract
(an `internal` trait member is rejected). `private` has retired as a keyword
(writing it is a compile error pointing at the unmarked spelling); it
survives only as the internal name of the unmarked visibility.

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

- Calls `#destroy` functions on mv values going out of scope
- Frees heap-allocated strings and owned values
- Cleans up all intermediate scopes on `break`, `continue`, and `return`

Auto-free applies only to types that own heap resources:

- **Structs** with a `#destroy` function (see [Destroy Functions](#destroy-functions))
- **Strings** (heap-allocated character buffers)

Value types with no heap ownership are not cleaned up: **enums**, **bitsets**,
**tuples**, **arrays of value types**, integers, floats, bools, and chars hold
no independently-owned memory, so going out of scope requires no action. An
enum or bitset that wraps a string field still relies on the auto-free of that
field's string value, not on any destroy logic of its own.

See [MEMORY.md](docs/MEMORY.md) for the full memory model description.

## Unsafe Code

`unsafe` is a minimal typed-pointer subset reserved for the **System
library** — it exists so the memory primitives (`Buffer`, `Array` inline
storage, `StringBuilder`, `BigInt` limb access, …) can be written once as
plain Nomen instead of duplicated per-target `#if META.arch` raw-block arms
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
indexing, the per-instantiation constants, **and raw code blocks**
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

## Compile-Time Conditionals

Compile-time conditionals select code per compilation target **before any
checking happens** — the same mechanism that selects a target's raw code
block, operating on ordinary Nomen code with the language's own keywords.
Conditions consult the `META` namespace and
must be compile-time constants. The multi-arm form is `#switch`, spelled
exactly like the runtime switch:

```
#switch {
    case META.arch == "aarch64" -> Console.write_line("arm")
    case META.arch == "c" { Console.write_line("c target") }
} else {
    Console.write_line("other")
}
```

For a single binary choice, `#if` with a bare `else` mirrors the runtime if:

```
#if META.arch == "c" {
    Console.write_line("portable path")
} else {
    Console.write_line("not c")
}
```

`META.arch` is the compilation target — `"c"`, `"aarch64"` or `"js"`. The
raw-block dialect is separate: `#raw` is the target's default (assembly on
aarch64, C on the C backend), and `#raw("c")` marks companion-compiled C
source (see "Unsafe Code"). `META.platform` is the
target platform — `"macos"`, `"linux"` or `"windows"` by default, or
whatever `--platform` passes.
Conditions compose with `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`,
arithmetic (`+ - * / %` — integers only; compile-time division by zero is
an error) and parentheses. `META.arch`/`META.platform` are comptime
strings; int literals are comptime ints. A bare `META` value is an error —
conditions must be bools, so compare:

```
#if META.arch == "c" && 2 + 3 >= 4 {
    Console.write_line("portable path")
}
```

A target-exclusive **raw** arm names its target explicitly — `#if META.arch
== "aarch64" { #raw { ... } }` — rather than using `else`: the `else` arm is
"every other target", which includes `"js"`, and a raw body has no meaning
there (the JS backend ignores raw blocks wholesale, so an explicit arm simply
contributes nothing).

```
#if META.arch { }
// Error: #if condition must be a bool — compare META values with
// == / != (e.g. META.arch == "c")
```

Arms hold ordinary Nomen: statements inside a function body, whole
declarations at file scope, and — struct/trait-body scope — fields and
methods (the selected arm's members distribute into the type's body before
it is checked; a constructor covers selected fields like any other). The
pragma is folded before the checker runs — only the selected arm is checked
(a dead arm may reference names that do not exist for this target), and a
pragma with no matching arm and no `else` disappears entirely:

```
#if META.platform == "macos" {
    struct MacOnly {
        pub func hello = (self, out string) {
            return "mac"
        }
    }
}
```

A type body can gate its own members per target:

```
struct Config {
    var a = 1
    #if META.arch == "c" {
        var c_only = 7
    } else {
        var portable = 9
    }
}
```

A function body may switch implementation per target:

```
func clamp8 = (int v, out int) {
    #if META.arch == "aarch64" {
        return v
    } else {
        if v < 0 { return 0 }
        if v > 255 { return 255 }
        return v
    }
}
```

### Compile-Time Errors (`#error`)

`#error "message"` fails the compile with the message. It is checked like a
statement, so an `#if` arm that folded away never fires — the standard
shape is a target gate:

```
#if META.arch == "js" {
    #error "this module needs a native target"
}
```

A live `#error` always fails, wherever it appears — file scope, a function
body, or inside a selected arm:

```
#error "Feature X requires a license header"
```

The message can also be a comptime interpolated string — `\{...}` parts
fold like any comptime string, which is how reflection loops point at the
member that tripped the rule:

```
#for field of META.info(Point).fields {
    #error "field \{field.name} is not allowed here"
}
```

A message that does not fold to a comptime string (a runtime operand) is
a compile error.

### Compile-Time Reflection (`#for` over `META.info(T).fields`)

`#for` unrolls a body once per field of a struct, at compile time. The
iterable is always `META.info(T).fields`; the loop binding is a comptime
value whose members are erased before codegen:

```
func describe<T> = (T value, out string) {
    var s = META.info(T).name + "("
    #for field of META.info(T).fields {
        s = s + field.name + " "
    }
    s = s + ")"
    return s
}
```

- `field.name` — the field's name as a comptime string (usable in
  expressions; comptime string `+` folds literals eagerly, and string
  interpolation `"tag_\{field.name}"` folds the same way — every `\{...}`
  part must itself be a comptime value, so a runtime operand keeps the
  runtime interpolation and a format spec (`\{i:08x}`) is never folded).
- `META.info(T).field_count` — the number of fields the loop iterates, as
  a comptime int (usable in expressions and comptime conditions).

### Type-Body Loops and Generated Names (`#` splices)

`#for` also runs at struct/trait-body scope, generating a member per
reflected field. A `#`-splice in a member's name position folds a dotted
path over the binding into the member's real name; a splice in a
declaration's TYPE position mirrors the source field's type
(`#{field.type.name}` — an `int` field gives an `int` member, a `string`
field a `string`; the type is spelled by NAME, so a generic container
resolves to its bare name). Inside a generated method's body, `#self`
binds to the conformer the method landed on. Names are templates: a glued
literal prefix (`get_#{field.name}`) and a braced splice with glued text on
either side (`#{field.name}_id` — the braces stop the greedy word scan)
compose into the final name:

```
pub struct Mirror {
    #for field of META.info(Base).fields {
        pub var #{field.name} = 0
        pub var #{field.name}_count = 0
        pub var #{field.type.name} mirrored
        pub func get_#{field.name} = (self, out string) {
            return META.info(#self).name + "." + field.name
        }
    }
}
```

A generated field participates in the struct like a hand-written one —
the constructor covers it when it has no default. A member that is not a
field or a method is an error, and a loop over an unbound type parameter
is an error (struct-scope reflection cannot defer — there is no
specialization to re-check a type body).

A `#for` arm may itself contain a nested `#for` — a member loop inside a
generated type's body, or a body loop inside another loop's arm. The outer
expansion leaves the nested loop's arm for the loop's OWN expansion (its
templates resolve against the inner binding, not the outer one) and folds
only its iterable — which may reference the outer binding
(`META.info(#t).fields`). Inner arms can reference outer bindings too; the
fold resolves each dotted path against the active bindings, innermost
first:

```
struct Base {
    var width = 0
}

#for w of META.info(Base).fields {
    mv struct S_#{w.name} {
        #for f of META.info(Base).fields {
            var #{f.name} = 0
            pub func describe_#{f.name} = (out string) {
                return w.name + "/" + f.name
            }
        }
    }
}
```

Each generated `S_#{w.name}` mirrors `Base`'s fields, and its generated
methods compose the outer and inner bindings (`describe_width` returns
`"width/width"`). The same composition works for enum-body case loops and
for body-scope loops nested in an arm (`#w` and `#i` fold per level).

### Compile-Time Iterables (`#for` over ranges and tables)

Beyond struct fields, `#for` iterates comptime ranges — exclusive end,
matching the runtime range-for. The binding is a comptime VALUE: `#i`
in expressions (folds to the int literal) and `#{i}` in name templates
(folds to the index as text):

```
#for i of 0..4 {
    pub func slot_#{i} = (out int) {
        return #i * 100
    }
}
```

Bounds must be comptime ints. An empty range (`5..5`) generates nothing.

Tables iterate comptime string lists — the binding is a string VALUE
(`#word` in expressions, `#{word}` in name templates):

```
#for word of ["get", "post"] {
    pub func handle_#{word} = (out string) {
        return "handled " + #word
    }
}
```

Table entries must fold to comptime strings.

`META.info(E).cases` iterates an enum's cases — the binding exposes
`.name` (the case name as a comptime string), `.param_count` (the case's
payload arity, as a comptime int) and `.params[i]` — each payload param,
with `.name` and `.type` (`.type.name` for the type's name). The same
iterable works at file/body scope (generate per-case members) and inside
an ENUM body, where the loop's arm holds `case` declarations whose
payload params may splice from the binding — the whole source param
(`#{c.params[0]}`: type and name verbatim), or its slots
(`#{c.params[0].type}` / `#{c.params[0].type.name}` in the type slot,
`#{c.params[0].name}` in the name slot) — so one enum becomes a
payload-preserving alias of another:

```
mv enum Shape {
    case point(int x, int y)
}

mv enum Mirror {
    #for c of META.info(Shape).cases {
        case #{c.name}(#{c.params[0]}, #{c.params[1]})
    }
}

pub func main = () {
    var Mirror.point m = Mirror.point(3, 4)
    match m {
        case .point(px, py) {
            Console.write_line("point \{px},\{py}")
        }
    }
}
```

An index past the case's arity is a compile error naming the case and its
count (`params[2] is out of range`), and payload splices over any other
iterable (struct fields, ranges, tables) are rejected — `.params` is a
case-binding member.

```
pub enum Mirrored {
    #for c of META.info(Shape).cases {
        case #{c.name}
    }
    #if META.arch == "c" {
        case extra
    }
}
```

An `#if`/`#switch` inside an enum body selects cases (a selected case
needs a literal name — a `#{...}` template needs a `#for` binding).
Generated cases append after the pragmas are processed.

`META.types_with("attr")` iterates every non-generic struct carrying the
attribute (`@attr` above the declaration), in registration order. The
binding is a TYPE: `.name` folds to the type name, `#{t.name}` splices
it into generated names, and `META.info(#t)` reflects over the type —
so a type set composes with field reflection:

```
@entity
pub mv struct User {
    pub mv name = ""
    pub var age = 0
}

#for t of META.types_with("entity") {
    pub func keys_#{t.name} = (out string) {
        var s = ""
        #for f of META.info(#t).fields {
            s = s + f.name + ","
        }
        return s
    }
}
```

Reflection through a type binding is `META.info(#t)` — a type binding's
only member is `.name`.

### Comptime Binding Spellings

Inside a `#for` arm the loop binding is an expansion-time substitute, not a
runtime value. Three spellings cover its uses:

- **A member is spelled bare** — `field.name`, `field.get(obj)`,
  `field.set(obj, value)`, `case.name`, `t.name`. The member shape itself
  identifies the binding, and expansion folds it: `.name` becomes a string
  literal, `.get`/`.set` become ordinary field access/assignment, `.type.*`
  reads the declared type. An unknown member is a loud error
  (`field.name_id` names a member called `name_id` — there is no suffix
  gluing in expressions).
- **The binding's whole value needs `#`** — `#i` (a range index), `#word` (a
  table string), `#t` (the type itself, as in `META.info(#t)`). Expansion is
  pre-scope, so it cannot tell a binding use from a local of the same name;
  instead of guessing, the language reserves the binding name inside its arm
  (a bare `word` there is an error) and requires the marker. The marker folds
  the use to its value — `"handled " + #word` becomes `"handled " + "get"`
  (a string literal), `#i` an int literal, `#t` the type-name word.
- **A splice inside an identifier needs `#{...}`** — `#{field.name}`,
  `keys_#{t.name}`, `#{i}`. Names are plain strings on declarations, not
  expressions, so the parser carries the template and expansion folds it.
  Braces are required; every piece glued to a `#{...}` on either side is
  literal template text (`get_#{field.name}`, `#{field.name}_id`).

The split follows the phase contract: expansion happens before checking, so
expression uses resolve structurally (member shape) or by the explicit `#`
marker, while name positions — read by the parser, before any binding exists
— need a parse-time template.

### Declaration Generation

At file scope, a `#for` generates whole declarations: one struct, trait,
function or enum per reflected item, its name spliced from the binding,
used by later code under the generated name. Inside a generated type's body,
`#self` binds to the generated type's own name. Names may carry a literal
prefix (`struct id_#{field.name}` — the prefix glues to the splice):

```
pub struct Config {
    pub var http = 3
    pub var disk = 4
}

#for field of META.info(Config).fields {
    pub mv struct #{field.name}: Stringable {
        pub var int value
        pub func tag = (self, out string) {
            return META.info(#self).name
        }
    }
}

var h = http(7)          // the generated struct, spelled by its known name
Console.write_line(h.tag())   // "http"
```

A file-scope arm can also add members to an existing type:
`extend struct #{t.name} { ... }` merges the generated methods — and any
out-of-line `: Trait` conformance — into that type before it is checked,
so they behave exactly like methods written in its body (`self` /
`ref self`, trait dispatch, emission under the target's name). The target
may be declared anywhere in the file.

An enum declaration splices its name the same way; an `#if` inside its
body still selects cases:

```
#for w of ["get", "post"] {
    pub enum Route_#{w} {
        case known
        case unknown
    }
}

var r = Route_get.known
```

```
@entity
pub struct User {
    pub var int id
}

#for t of META.types_with("entity") {
    extend struct #{t.name} {
        pub func kind = (self, out string) {
            return t.name
        }
    }
}

var u = User(1)
Console.write_line(u.kind())   // "User"
```

Generated declarations compose with everything comptime: generated
members may carry `#if` member arms, derive from the marker traits (the
derivations are reflection defaults), and reference `META.info(#self)`.
Richer `@Type`-style construction (a type built from computed data) is
future work — the iterable surface is the one above
(`META.info(T).fields`, `META.info(E).cases`, ranges, string tables,
`META.types_with(...)`).

- `field.type.name` — the field's type name as a comptime string. An `if`
  whose condition is comptime-constant folds to its live arm, so
  per-field-type dispatch reads naturally:

```
mv struct Tagged {
    var int n
    mv string label
}

func zero_ints = (mv Tagged c, mv out Tagged) {
    #for field of META.info(Tagged).fields {
        if field.type.name == "int" {
            field.set(c, 0)
        }
    }
    return c
}
```

- `field.type.args[i]` — the field type's generic arguments, recursively:
  an indexed argument is itself a type (`args[0].name`, `.arg_count`,
  `.args[i]` work at any depth), and used directly in a comparison it is
  the type's name (`StableList<Feature>` -> `args[0] == "Feature"`,
  `StableList<StableList<int>>` -> `args[0].args[0] == "int"`). With
  `field.type.arg_count` this drives container dispatch, folded per
  instantiation — source structs and mono instantiations alike.
- `field.is_struct` — a comptime bool: the field is a non-builtin,
  non-container struct (the recursive-decode predicate).
- `field.get(obj)` — reads the field, at its concrete type.
- `field.set(obj, value)` — assigns it; a statement, not an expression.

Inside a generic body (`T` unbound), the loop **defers**: it unrolls when
the body is specialized and the parameter is bound, producing ordinary
checked code per instantiation. That is what makes one generic function
serve every struct — a reflection-driven `to_string`, `==` or `hash`
matches the auto-derived versions field for field. `META` exists only in
these compile-time positions; it is not a runtime value. Errors — an
unknown type, a generic type (reflect over a concrete instantiation), a
binding used without `.name`/`.get`/`.set` — are reported at the loop:

```
#for field of META.info(Nope).fields {
    var x = 1
}
// Error: META.info: unknown type 'Nope' — reflection is over struct types
```

### Layout Introspection (`META.size_of` / `META.align_of` / `META.offset_of`)

Sizes and offsets fold to comptime ints from the same layout the backends
emit: every struct value starts with an 8-byte vtable word, fields follow
in packed (alignment-descending) order at their natural alignment, and the
total is tail-padded to 8:

```
struct Pair {
    var int64 a
    var int32 b
}

const PAIR_BYTES = META.size_of(Pair)

func probe = () {
    if META.offset_of(Pair, "b") == 16 {
        Console.write_line("b follows a")
    }
}
```

`META.size_of(T)` is the byte size (a `string` is the 16-byte fat pair, an
enum the tag word plus its widest payload, a `Box<T>` the heap pointer);
`META.align_of(T)` is the natural alignment (`bool` 1, `int32` 4, every
composite 8); `META.offset_of(T, "field")` is the field's byte offset from
the value's first byte, vtable word included. Scalars and built-ins work
like structs — `META.size_of(int)` is 8, `META.size_of(bool)` is 1.

`T` is a bare type name, or a `type T` parameter (folded per
specialization, like the predicates). The field argument is a comptime
string, so reflection composes:

```
func dump = () {
    #for field of META.info(Pair).fields {
        if META.offset_of(Pair, field.name) >= 8 {
            Console.write_line(field.name)
        }
    }
}
```

Sizes answer for the compile target: the one native/C divergence is a
fixed-size stack-array field (`uint64[4] slots`) — a length header plus
elements on the native backend, an inline C array on the C target — and
`META.size_of` follows the target being checked. Errors point at the
spelling that works: a generic spelling has no layout, and a missing field
names the type:

```
func probe = () {
    var a = META.offset_of(Point, "z")
}
// Error: META.offset_of: type 'Point' has no field 'z'
```

### Type Parameters (`type T`)

A free function can take a **type** as a parameter. Spell it `type T` (the
ordinary `Type name` order); the argument at the call site is
the bare type name. The parameter exists only at compile time — it has no
runtime slot, and each specialization's signature omits it entirely:

```
struct Point {
    var x = 0
    var y = 0
}

func zero = (type T, out T) {
    var x = T()
    return x
}

const int z = zero(int)
const p = zero(Point)
```

Inside the body, `T` is usable wherever a type goes — declarations (`var x
= T()`, or an initializer-less `var T x`), construction (`T()` — the
struct constructor, the builtin's zero value, or — when the struct's
fields lack defaults — a zero-constructed value built field by field,
recursively), and return types. Because
`T` is a type, the whole reflection surface composes: `META.info(T)`,
the comptime predicates, and `#for` all work against it, so one function
serves every struct:

```
mv struct Sample {
    var count = 0
    mv label = ""
}

func describe = (type T, out string) {
    var s = META.info(T).name + "("
    #for field of META.info(T).fields {
        s = s + field.name + " "
    }
    return s + ")"
}

const names = describe(Sample)
```

Comptime predicates over the bound type (`META.is_struct(T)`,
`META.is_container(T)`) fold per specialization, so dispatch inside the
function eliminates its dead arms before they are ever checked. A generic
function may forward its own parameter as a `type` argument (`inner(T)`),
binding at the outer specialization.

A `type` argument is a bare name denoting a concrete struct or builtin
type, or a generic instantiation — `List<int>` names the monomorphized
struct directly (materialized on the spot if no other use site exists
yet). Enums, traits, bitsets, and bare generic names are rejected, as is
anything that is not a type name at all:

```
func f = (type T, out int) {
    return 0
}
const int bad = f("Point")
// Error: a 'type' parameter takes a bare type name — f(type T)
```

An instantiation argument flattens to the mono name, so it composes with
reflection like any concrete type:

```
func name_of = (type T, out string) {
    return META.info(T).name
}

const s = name_of(List<int>)
```

`type` parameters are free-function only (methods cannot declare them —
there are no generic methods), and take no declaration keyword, constraint,
or default value.

### Attributes

Attributes attach compile-time metadata to structs and fields — the input
to reflection-driven code. Each is `@name` (a flag) or `@name(args)` with
comptime literal arguments (string, int, float, bool); a comma-separated
list sits on the line(s) above the declaration. One value per attribute,
and names are snake_case: they are lookup keys for `attr` / `has_attr`,
not symbols — nothing resolves them as types or functions.

```
@sql_table("users")
pub mv struct User {
    @rename("user_name"), @sql_type("VARCHAR")
    mv string user_name
    var int age
    @deprecated
    mv string old_field
}
```

The compiler assigns no meaning to attribute names — they surface through
META for generic code to consume: `META.info(T).attr("sql_table")` /
`.has_attr("sql_table")` at the struct level, `field.attr("rename")` /
`field.has_attr("rename")` per field. `has_attr` is a comptime bool, so an
`if` over it folds and the untaken branch is never checked:

```
func keys<T> = (T value, out string) {
    var s = META.info(T).attr("sql_table") + ": "
    #for field of META.info(T).fields {
        if field.has_attr("rename") {
            s = s + field.attr("rename")
        } else {
            s = s + field.name
        }
        s = s + ","
    }
    return s
}
```

`attr` errors when the attribute is absent — gate with `has_attr`. A
missing attribute read is a compile error, never a silent empty string,
and one attribute carries one value (repeat the attribute — not the
arguments — if you ever find yourself packing several). Attribute names
are ordinary identifiers but never symbols: one that matches a library
type's name does not link that type — the library type-link scan skips
attribute-name tokens, so `@Table("users")` does not drag
`Controls::Table` into the program.

## Programs

A program's entry point is `pub func main`. It takes either no parameters or
a single `Init` — the argument count, the argument list, and whether stdout
is a terminal:

```
import System

pub func main = (Init init) {
    Console.write_line("\\{init.argc} arguments")
}
```

A normal return exits the program with status 0. `panic("message")` prints
the message and terminates the program with a non-zero status; `todo("...")`
behaves the same way. A test file (below) needs no `main` — the harness
supplies one.

## Testing

A test is any `pub func <name> = (ref Tester t)` in a `*.test.nm` file. `nomen
test` discovers every such file under the current folder, generates a harness
that calls each test function in order, and reports pass/fail per test:

```
import System
import System::Test

func add = (int a, int b, out int) => a + b

pub func test_add = (ref Tester t) {
    t.expect(add(1, 1) == 2, "1 + 1 should be 2")
}
```

- `t.expect(condition, "message")` — records a pass, or a failure with the message.
- `t.fail("message")` — fails the test unconditionally.
- `t.assert(nullable, "message")` — fails when the nullable value is null
  (overloads for `int?`, `uint?`, `int64?`, `uint64?`).
- `t.bench("label", fn)` — benchmarks `fn` (a zero-argument function);
  `t.bench_n("label", fn, n)` pins the sample count. Run with `--release`
  for numbers worth comparing.

See [TESTING.md](docs/TESTING.md) for the harness design. `-f <regex>`
filters which test files run, and anything a test prints is shown beneath
the file when it fails.

## Standard Library

The `System` library (in `core/System/`) is imported with `import System`. The
most useful entry points are documented below; the rest of the library is a
collection of small, focused modules — one line each, with a link to the
source (the source files carry doc comments, so `nomen docs` renders the full
reference):

| Item                                          | Description                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| [List](core/System/List.nm)                   | growable, ordered list of values (`push`/`pop`/`at`)                    |
| [Map](core/System/Map.nm)                     | ordered key-value map; keys must be `Hashable` + `Equatable`            |
| [Set](core/System/Set.nm)                     | ordered set of unique values; elements `Hashable` + `Equatable`         |
| [StableList](core/System/StableList.nm)       | grow-only list whose element addresses survive `push`                   |
| [StringBuilder](core/System/StringBuilder.nm) | growable byte buffer for building strings incrementally                 |
| [Option](core/System/Option.nm)               | `Option<T>` — `some(T)` or `none`                                       |
| [Result](core/System/Result.nm)               | `Result<T, E>` — the checked `ok`/`fail` enum behind `T ! E`            |
| [Math](core/System/Math.nm)                   | math helpers (`power`, `sqrt`, `log`, …) — `import System::Math`        |
| [Time](core/System/Time.nm)                   | wall-clock time and sleeping (static members)                           |
| [Random](core/System/Random.nm)               | fast splitmix64 pseudo-random generator                                 |
| [Arena](core/System/Arena.nm)                 | generational arena — one owner, cheap copyable `ArenaRef<T>` handles    |
| [LinkedList](core/System/LinkedList.nm)       | arena-backed doubly-linked list (stable int node ids)                   |
| [Tree](core/System/Tree.nm)                   | arena-backed binary tree (stable int node ids)                          |
| [Graph](core/System/Graph.nm)                 | arena-backed directed graph (stable int node/edge ids)                  |
| [BigInt](core/System/BigInt.nm)               | arbitrary-precision integer (sign-magnitude)                            |
| [Text::Regex](core/System/Text/Regex.nm)      | regular-expression `test`/`match`/`replace_all` — `import System::Text` |
| [Text::Json](core/System/Text/Json.nm)        | the `json_decode_into` / `json_encode` implementation                   |
| [Buffer](core/System/Buffer.nm)               | internal growable slab — the backing store containers delegate to       |
| [File](core/System/Stream/File.nm)            | file handle for reading and writing, plus static one-shot helpers       |
| [Directory](core/System/Stream/Directory.nm)  | helpers for working with filesystem directories                         |
| [Tcp](core/System/Stream/Tcp.nm)              | non-blocking sockets that park fibers while they wait                   |
| [Http](core/System/Stream/Http.nm)            | minimal HTTP/1.1 client built on `Tcp`                                  |

Names in nested folders (`Math`, `Text`, `Controls`, `Stream`) need their
namespace imported: `import System::Math`, `import System::Text`, and so on —
`import System` grants only `System`'s own names (see
[Visibility Modifiers](#visibility-modifiers)).

### Console

Output and input on `stdin` / `stdout`:

```
Console.write("no newline")           // write a string
Console.write_line("with newline")    // write a string followed by '\n'

const line = Console.read_line()   // read a line from stdin (no trailing '\n')
const c     = Console.read_char()    // read a single character from stdin
const p   = Console.platform()     // current target platform, e.g. "macos"
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

### Json (compile-time serde)

`json_decode_into` and `json_encode` decode/encode **typed structs directly**
— the per-field dispatch is generated by compile-time reflection (see
"Compile-Time Reflection"), so there is no DOM and no runtime key→field map.
String, int, float and bool fields are supported, plus nested value structs
and `StableList<T>` containers — of scalars, structs, strings, or further
`StableList`s, all decoded recursively — with the matching object/array
shapes on encode. Field keys default to the field name; `@rename` maps a
different JSON key and `@skip` omits a field from both directions. Missing
keys keep their defaults; unknown keys are skipped. Decoding is single-pass
and builds no intermediate tree.

```
mv struct Account {
    @rename("user")
    mv id = ""
    var active = true
    @skip
    mv cache = ""
}

func round_trip = (string text, out string) {
    var a = Account()
    json_decode_into(text, ref a)
    return json_encode(ref a)
}
```

`json_decode_into(text, ref value)` infers the struct type from the `ref`
argument — the value is filled in through the pointer; `json_encode(ref value)`
infers it from the value. `@rename` and `@skip` are read from FIELDS — a struct-level
attribute with those names has no effect on the JSON shape.

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

`is_done()` is the non-blocking poll: it returns whether the task has
finished without waiting, so an event loop can notice completion without
parking the caller (`demos/async` uses it). `result()` and `result_uint64()`
block and move the value out — call them once, after the task is done.

### Mutex

pthread-backed lock for shared mutable state. The default stance in Nomen is
"no shared mutable state" — communicate by moving Sendable values (directly
or via `Channel`). `Mutex` exists for when you genuinely need shared
mutability:

```
var mu = Mutex()

func worker = (Mutex m) {
    m.lock()
    // critical section
    m.unlock()
}

async {
    Thread(worker(mu)).start()
}
```

`Mutex` is an **mv struct**:
its single field is an opaque handle, the value moves, and `#destroy`
releases the pthread resource automatically at scope exit. Sharing one
across tasks rides the checked region borrows — the example above passes
`mu` bare inside the `async` block (the join bounds the borrow), and
`lock`/`unlock` mutate the kernel object the handle names, never the
binding.

### Channel

Thread-safe unbounded FIFO queue for passing values between tasks. Blocking
receive — `receive()` blocks the caller until a value is available. Inside a
`Fiber` an empty `receive()` **parks** instead (freeing its worker); `send`
wakes the parked receivers, and a receiver cancelled while waiting returns
the zero value (the task observes `Task.current_cancelled()` itself).

```
var ch = Channel()

func producer = (Channel c) {
    c.send(101)
    c.send(202)
}

async {
    Thread(producer(ch)).start()
}

var v = ch.receive()   // blocks until ready
```

`Channel` is an **mv struct**:
every field is an opaque handle/counter word, the value moves, and
`#destroy` drains the queue and releases the mutex/condvar. Sharing one
across tasks rides the checked region borrows — the example passes `ch` bare
inside the `async` block (the join bounds the borrow; an app-lifetime
channel is a global). A transfer (`mv ch`) hands the whole queue to the
receiver.

`Channel` stores `uint64` values (Nomen values are pointer-sized on every
target we care about). Fat strings ride through `send_string` /
`receive_string`: the payload is copied into the queue node on send (the
sender keeps its string) and moved out to the receiver as an owned value, so
the message survives the sender's scope exit with its true length intact.

```
var ch = Channel()

func producer = (Channel c) {
    c.send_string("hello")
}

async {
    Thread(producer(ch)).start()
}

var s = ch.receive_string()   // blocks until ready
```

## Concurrency

Nomen's concurrency model is **structured concurrency via nurseries**: every
concurrent split must rejoin before its lexical scope exits. See
[ASYNC.md](docs/ASYNC.md) for the full design and rationale.

### Sendable

Marker trait for types whose values are safe to move across a task boundary:

```
pub trait Sendable {
}
```

- Primitives (`int`, `uint`, `float`, `bool`, `char`, `string`, etc.) are
  always Sendable.
- Structs are Sendable if all their fields are Sendable (auto-derive,
  recursive), or if explicitly marked `: Sendable`.

```
pub struct Point {          // auto-Sendable: two int fields
    var int x
    var int y
}

pub struct Stamp : Sendable {   // explicit marker
    var int x
}
```

What crosses a task boundary:

- **Moved** arguments — a `mv T` capture or argument takes exclusive
  ownership; a mv struct moves and the donor is invalidated (the caller
  gives up its access). Ownership crossings are always spelled `mv`, like
  every transfer.
- **Copied** arguments — the default flavor for value types: primitives,
  strings, and plain-data (non-mv) structs passed bare are copied at the
  boundary, so the task and the caller hold independent values. (A `mv s`
  argument to a `mv string` parameter transfers instead.)
- **Borrowed** arguments — the default flavor for owning types, the same
  read-only borrow an ordinary call takes: a mv struct passed bare inside
  an `async` block, or a `view`-typed argument, aliases the donor, and
  the lifetime rules below bound the alias. What is task-specific is not
  the spelling but the region — the join bounds the alias, and the donor
  is frozen (read-only) until the block exits; a write that conflicts
  names the spawn that lent it.
- **Trait handles cannot cross.** A trait-typed value is not Sendable — move
  the concrete struct instead, or mediate the share through `Mutex` /
  `Channel` / `Atomic<T>`.

The same rules gate a lambda's captures (every capture is an eager argument).

Four lifetime rules apply on top of Sendable (which gates what may cross, not
how long an alias stays valid):

- **Inside an `async` block, a borrowed argument must outlive the join.**
  Two argument shapes BORROW: a mv struct passed bare (the env takes
  the donor's pointer — no deep copy), and a `view`-typed argument. Their
  ROOT variable must be declared in the block's own scope or outside it — a
  local declared in a nested block (an `if` body, a loop iteration) dies
  before the join and dangles the task's alias. A fresh temporary (a call
  result) must be constructed in the block's own scope. Moved and copied
  arguments are exempt — ownership has no region.
- **Outside a nursery, a mv struct cannot cross bare.** There is no
  join to bound a borrow, and the env cannot deep-copy mv state soundly,
  so the bare-mv shape is a compile error — spawn inside an `async`
  block (a borrowed read), or move it in. Exemption: a process-lifetime
  GLOBAL donor is its own region proof (nothing can dangle because nothing
  ever ends) — the app-lifetime `Channel`/`Mutex` share rides it.
- **The freeze: a borrowed root is const until the block exits.** From the
  construction to the `async` block's closing brace, the donor cannot be
  written, moved out, mutable-passed, or mutated through a `ref self`
  method — the task is reading it. `Task` handles are exempt: sharing a
  handle and then cancelling it is the coordination protocol.
- **Detach owns its captures.** A detached daemon has no join anywhere, so
  `.detach()` rejects every shared (non-`mv`) capture. App-lifetime state
  is shared by declaring it at the root scope (globals are exempt: process
  lifetime).

Moved and copied arguments (scalars, strings, `mv T`) are exempt from the
freeze — ownership has no region.

### WeakHandle

`WeakHandle<T>` is a checked handle to a possibly-gone object — the sanctioned
child→parent / OS-retained / delegate shape (back-pointers that would
otherwise be mv cycles). No refcounts: one process-wide
(pointer, generation) slot table; the tracked type's `#destroy` invalidates
every slot holding the pointer; `get` compares generations and returns the
live pointer or `null`.

```
mv struct Widget {
    var int id
}

var child = Box<Widget>(Widget(2))
var h = WeakHandle<Box<Widget>>(child)

var Box<Widget>? live = h.get()
if live != null {
    Console.write_line("still here")
}
```

- **The creation is the marker**: `WeakHandle<T>(obj)` registers `obj` in the
  registry — nothing aliases without one. The tracked type must be a
  heap-resident instance (`Box<T>`, or any `mv struct`), and the object must
  be owned ELSEWHERE (a fresh temporary is rejected — a handle owns nothing,
  so the instance needs a real owner).
- **A handle binds once, at its declaration** — it is not re-pointed (the
  same const-pointer discipline as `ref`).
- **`.get()` forces the nil check at the use site**: the race is inherently
  dynamic (the owner may have torn the object down), so the runtime check is
  the only truthful one. Bind to `T?` and nil-check.
- Handles are move-safe by construction: they own nothing, so moves never
  invalidate them.

### Atomic

`Atomic<T>` is a lock-free protected slot for 64-bit integer state shared
across tasks. A type may be mutated through a cross-worker borrowed capture
iff the mutated slot is protected — an `Atomic<T>` field is the lock-free
protected slot, and the Atomic's methods are the sanctioned mutation path
(the freeze on borrowed roots deliberately exempts them).

```
var counter = Atomic<int>()

func work = (ref Atomic<int> c) {
    c.fetch_add(1)
}

async {
    var t = Thread(work(ref counter)).start()
    t.wait()
}
Console.write_line("\{counter.load()}")
```

- `load()`, `store(v)`, `fetch_add(v)` (returns the previous value),
  `swap(v)` — all sequentially consistent.
- `T` must be a 64-bit integer type — the slot is one machine word.
- A `ref Atomic<T>` argument inside an `async` block is a region-checked
  mutable borrow: the task's mutations reach the donor, and the donor cannot
  REPLACE the atomic while it is borrowed (the freeze).

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

The construction is a **special form keyed on the type's `#spawn` member** —
a lifecycle marker, like `#init`/`#destroy`, that declares the type's
construction hook.

- `Thread` and `Fiber` declare `#spawn`; the compiler treats `X(...)` on a
  `#spawn`-bearing type as the deferred-call construction, and a type that
  merely shares the name does not gain it.
- `Thread` and `Fiber` are **mv structs**: every field is an opaque handle
  (uint64/bool), so the construction yields an inline value that moves, and
  `#destroy` enforces must-start.
- Any mv struct declaring `#spawn` constructs through the same special form:
  the construction yields the inline value, with the handle fields written
  directly.
- A `#spawn` constructor's single argument is either a deferred call or a
  zero-arg function value; anything else is an error anchored at the
  argument.

Because the construction is a real value, it can be stored and started later —
the arguments are bound at construction, the call happens at `start()`:

```
var job = Thread(bg(0))
// ...anything may happen here...
job.start()
```

A construction can also take a zero-argument FUNCTION VALUE — a lambda whose
CAPTURES are the eager arguments (every capture must be Sendable, and mv
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
at the call site — primitives by value, pointers by pointer.

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
    const uint64 r = f.result()        // parks, not blocks
    Console.write_line("\{r}")
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
    var ch = Channel()
    async {
        var a = Fiber(step(ch, 1)).start()
        var b = Fiber(step(ch, 2)).start()
        a.wait()
        b.wait()
    }
    Fiber.yield()                       // no-op on the main thread
    if Fiber.is_fiber() {
        Console.write_line("in a fiber")
    }
}
```

The spawns ride the `async` nursery: `ch` crosses as a checked region
borrow (the join at the closing brace bounds it), and the block joins
both fibers before `main` continues.

`start_on(buf)` requires a fixed-size array buffer of at least 16 KB (the
fixed-array shape and the size minimum are checked at compile time). The
buffer is **not used**: the call lowers to a plain `Fiber.start` and the
argument is dropped, so the fiber runs on a heap stack either way. The
caller-provided-stack path is unimplemented — it needs storage for a no-init
`T[N]` declaration and a compile-time byte size for the parameter:

```
import System

func work = (uint64 n) {
    Console.write_line("ran")
}

pub func main = () {
    var uint64[2048] stack_buf
    var f = Fiber(work(0)).start_on(stack_buf)
    f.wait()
}
```

`stack_buf` is advisory: the declaration only satisfies the validation (the
no-init `T[N]` form does not materialize storage today), and the fiber never
sees it.

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
    const uint64 r = t.result_uint64()
    Console.write("\{r}")
}

pub func main = () {
    async pool {
        spawn_one(41, ref pool)
    }
}
```

The name is arbitrary — pick whatever reads best:

```text
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

### The Task Handle

The handle returned by `Thread(...).start()`. Generic — `T` is inferred from
the spawned function's return type. An **mv struct** whose
fields are opaque handles — it moves, and its `#destroy` releases the future
reference it holds:

```
pub mv struct Task<T> : Awaitable {
    func wait = (self)
    func result = (ref self, mv out T)
    func result_uint64 = (ref self, out uint64)
    func cancel = (ref self)
    func current_cancelled = (out bool)   // static
}
```

- `wait()` blocks until the task finishes. Idempotent.
- `result()` blocks, then moves the spawned function's return value out as
  `T`. The value transfers to the caller (`mv out`) — call it once; a
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
    var i = 0
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

- Parameters: x0-x7 (instance methods pass `self` in x0, parameters start at x1)
- Return value: x0
- Static methods: params in x0, x1, x2, ...
- Instance methods: self in x0, params in x1, x2, ...

## Code Style

`nomen format` rewrites source to the canonical style: tab indentation, a
100-character line width, imports sorted (parent directories first, then
local), trailing commas, and redundant type annotations removed — prefer
inference (`const p = Point(2, 3)`, not `const Point p = Point(2, 3)`).
