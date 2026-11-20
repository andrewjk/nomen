# Nomen: compile-time code

This release built out Nomen's compile-time surface — target
selection with `#if`/`#switch`, reflection loops with `#for`, attributes,
`type T` parameters, layout introspection, and the derived-method machinery
the System library itself runs on. Everything resolves during the check
pass: generated code is ordinary AST, and it goes through the same type
checker, ownership analysis and code generation as hand-written code. Here
is the whole picture.

## Selecting code per target: `#if` / `#switch`

Compile-time conditionals select code per compilation target **before any
checking happens**. The single-condition form mirrors the runtime `if`; the
multi-arm form is `#switch`, spelled exactly like the runtime switch
(`else` outside the braces):

```nomen
#if META.arch == "c" {
    Console.write_line("portable path")
} else {
    Console.write_line("not c")
}
```

```nomen
#switch {
    case META.arch == "aarch64" -> Console.write_line("arm")
    case META.arch == "c"       -> Console.write_line("c target")
} else -> Console.write_line("other")
```

`META.arch` is the compilation target (`"c"`, `"aarch64"` or `"js"`);
`META.platform` is `"macos"`, `"linux"` or `"windows"` (or whatever
`--platform` passes). Conditions compose with comparisons, `&&`/`||`/`!`,
int arithmetic and parentheses.

The fold runs first, so **only the selected arm is ever checked** — a dead
arm may reference names that do not exist for this target — and a pragma
with no matching arm and no `else` disappears entirely. Arms hold ordinary
Nomen at three scopes: statements in a body, whole declarations at file
scope, and members in a type body:

```nomen
struct Config {
    var a = 1
    #if META.arch == "c" {
        var c_only = 7
    } else {
        var portable = 9
    }
}
```

Raw blocks ride the same fold: `#if META.arch == "aarch64" { #raw { ... } }`
selects the assembly arm, and a raw-only function whose every arm folds
away is rejected with "no implementation for this target".

## `#error`: compile-time gates

`#error "message"` fails the compile with the message. It is checked like a
statement, so an `#if` arm that folded away never fires — the standard
shape is a target gate:

```nomen
#if META.arch == "js" {
    #error "this module needs a native target"
}
```

## Reflection: `#for` over a struct's fields

`#for field of META.info(T).fields` unrolls its body once per field, at
compile time. The binding exposes the field's `.name` (a comptime string)
and `.type.name` (the declared type), and folds real field access:
`field.get(obj)` reads the field, `field.set(obj, value)` assigns it:

```nomen
mv struct Counter {
    var int n
    var string label
}

func zero_ints = (mv Counter c, mv out Counter) {
    #for field of META.info(Counter).fields {
        if field.type.name == "int" {
            field.set(c, 0)
        }
    }
    return c
}
```

The `if` condition is comptime-constant (`field.type.name` is a literal
after expansion), so it folds to its live arm — per-field-type dispatch
reads naturally and the untaken arm is never checked. `field_count`,
`field.is_struct` and the field type's generic arguments
(`field.type.args[i]`, recursively) round out the surface.

Inside a generic body the loop **defers**: it unrolls when the body is
specialized and `T` is bound. That is what makes one generic function serve
every struct — the deferred loop is how `to_string`, `==` and `hash` can
match the auto-derived versions field for field.

## Generated names: `#{...}` splices

`#for` also runs at struct-body scope, generating a member per reflected
field. Names are templates — `#{field.name}` splices the folded string into
the member's name, with literal text gluing on either side
(`get_#{field.name}`, `#{field.name}_id`); a splice in a declaration's TYPE
position mirrors the source field's type:

```nomen
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

Inside a generated method's body, `#self` binds to the type the method
landed on. Generated fields participate like hand-written ones — the
constructor covers them when they have no default. Enum bodies loop too,
splicing case names and even payloads, so one enum becomes a
payload-preserving mirror of another:

```nomen
mv enum Shape {
    case point(int x, int y)
}

mv enum Mirror {
    #for c of META.info(Shape).cases {
        case #{c.name}(#{c.params[0]}, #{c.params[1]})
    }
}
```

## Ranges, tables, and type sets

Fields and cases are not the only iterables. Comptime ranges (exclusive
end) bind a comptime int — `#i` in expressions, `#{i}` in names:

```nomen
#for i of 0..4 {
    pub func slot_#{i} = (out int) {
        return #i * 100
    }
}
```

String tables bind a comptime string (`#word` / `#{word}`):

```nomen
#for word of ["get", "post"] {
    pub func handle_#{word} = (out string) {
        return "handled " + #word
    }
}
```

And `META.types_with("attr")` iterates every struct carrying an attribute —
a type set to generate from, composing with field reflection:

```nomen
#for t of META.types_with("sql_table") {
    pub func keys_#{t.name} = (out string) {
        var s = ""
        #for f of META.info(#t).fields {
            s = s + f.name + ","
        }
        return s
    }
}
```

## Generating whole declarations

At file scope, a `#for` generates whole declarations — one struct, enum,
trait or function per item — and later code uses them under the generated
name. A file-scope arm can also add members to an existing type:
`extend struct #{t.name} { ... }` merges generated methods into that type
before it is checked, so they behave exactly like methods written in its
body (the target may be declared anywhere in the file):

```nomen
@sql_table("users")
pub struct User {
    pub var int id
}

#for t of META.types_with("sql_table") {
    extend struct #{t.name} {
        pub func kind = (self, out string) {
            return t.name
        }
    }
}

var u = User(1)
Console.write_line(u.kind())   // "User"
```

## Attributes

Attributes attach compile-time metadata to structs and fields — the input
reflection-driven code consumes. Each is `@name` (a flag) or `@name(args)`
with literal arguments, listed above the declaration. The compiler assigns
them **no meaning**; they surface through META for generic code:

```nomen
@sql_table("users")
mv pub struct User {
    @rename("user_name"), @sql_type("VARCHAR")
    var string user_name
    var int age
    @deprecated
    var string old_field
}
```

`META.info(T).attr("sql_table")` / `.has_attr(...)` at the struct level,
`field.attr("rename")` / `field.has_attr(...)` per field. `has_attr` is a
comptime bool, so a guard `if` folds and the untaken branch (which may call
`.attr` on a missing attribute) is never checked:

```nomen
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

## `type T`: types as parameters

A free function can take a **type** as a parameter. The argument is the
bare type name; the parameter exists only at compile time — no runtime
slot, and each specialization's signature omits it entirely:

```nomen
func zero = (type T, out T) {
    var x = T()
    return x
}

const int z = zero(int)
const p = zero(Point)
```

Because `T` is a type, the whole reflection surface composes —
`META.info(T)`, the predicates (`META.is_struct(T)`, `META.is_container(T)`
fold per specialization), and `#for`:

```nomen
func describe = (type T, out string) {
    var s = META.info(T).name + "("
    #for field of META.info(T).fields {
        s = s + field.name + " "
    }
    return s + ")"
}
```

## Layout introspection

`META.size_of(T)`, `META.align_of(T)` and `META.offset_of(T, "field")` fold
to comptime ints from the same layout model the aarch64 backend lays out
with and the C typedef emission mirrors — a comptime size can never drift
from the real one:

```nomen
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

The field argument is a comptime string, so it composes with a `#for` loop
(`META.offset_of(Pair, field.name)`).

## The derived methods are the same machinery

There is no second system: `Stringable`/`Equatable`/`Hashable` derives in
`core/System/` are trait default bodies over `#for` + `META.info(#self)`,
bound per conformer — conformance without a hand-written method clones the
default with `#self` bound and checks it fresh (`@hash_ignore` configures
the hash walk). `Json.encode`/`json_decode_into` are the same story: typed
structs decode and encode through compile-time generated per-field
dispatch — no DOM, no runtime key→field map.

---

## The short version

Three tweets plus a code sample.

**1.**

> Nomen's comptime starts with selection: `#if META.arch == "aarch64" { ... }
else { ... }` folds before type-checking — only the live arm is ever
> checked, so a dead arm may name types that don't exist for the target.
> Arms hold statements, whole declarations, or a type's members. `#error`
> gates a target.

**2.**

> Generation is the other half: `#for field of META.info(T).fields { ... }`
> unrolls real, checked code — `field.get`/`field.set`, `#{field.name}`
> splicing member names, enum cases mirrored payload and all, whole types
> at file scope. Iterables: fields, cases, ranges, string tables, and
> `META.types_with("attr")` type sets.

**3.**

> The glue: `type T` takes a type as a parameter (erased before codegen),
> `@attr("x")` attaches metadata the compiler gives no meaning to and
> generic code reads via `field.attr("x")`, `META.size_of`/`offset_of` fold
> the real layout. The Stringable/Equatable/Hashable derives and Json serde
> are this same `#for` machinery.

**The one code sample:**

```nomen
import System

@sql_table("users")
mv struct User {
    @rename("user_name")
    var string name
    var int age
}

// one function serves every struct: `type T` is a compile-time type
func describe = (type T, out string) {
    var s = META.info(T).name + "("
    #for field of META.info(T).fields {
        s = s + field.name + " "
    }
    return s + ")"
}

// attributes are plain metadata — generic code consumes them
func keys = (type T, out string) {
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

// one attribute-collected type set generates one function per conformer
#for t of META.types_with("sql_table") {
    pub func table_of_#{t.name} = (out string) {
        return "table: " + t.name
    }
}

pub func main = () {
    var u = User("ada", 36)
    Console.write_line(describe(User))  // User(name age )
    Console.write_line(keys(User))      // users: user_name,age,
    Console.write_line(table_of_User()) // table: User
    Console.write_line(u.name)          // ada
}
```
