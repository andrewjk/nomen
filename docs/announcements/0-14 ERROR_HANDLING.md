# Nomen: errors and `try`/`catch`

This release completed the error-handling system: `error` enums,
fallible function signatures, `try`/`catch` (now with a statement form for
unit results), composed error sets, payload yields out of arms, and the
backend work that keeps all of it memory-sound. Here is the whole picture.

## The `error` declaration

Errors are enums — exhaustive and verified like any enum, but always
`checked` (a result carrying one must be consumed):

```nomen
error FetchError {
    case notfound
    case offline
}
```

Payloads work like enum payloads. A payload that owns heap memory (a
`string`, a container) makes the error a `mv error` — owning, transferred,
never copied:

```nomen
mv error FetchError {
    case notfound
    case io(string msg)
}
```

The error side can also be written inline — an anonymous set, no
declaration needed:

```nomen
func fetch = (string url, out int ! [.notfound, .offline]) {
    if url == "" {
        return .notfound
    }
    if url == "/offline" {
        return .offline
    }
    return 7
}
```

## Fallible functions: `out T ! E`

A `!` in the return type makes the function fallible. Falling off the end
or a bare `return` is success; `return .case` (or any error value) is
failure; an explicit `.ok(...)` / `.fail(...)` passes through as-is:

```nomen
func load = (string path, out int ! FetchError) {
    if path == "" {
        return .notfound
    }
    return 7
}
```

## `try`/`catch`: expression form

The scrutinee is evaluated once. On success its value is the expression's
value; on failure the exhaustive arms handle the error enum directly — no
`.ok` arm, no unwrap:

```nomen
func describe = (string path, out string) {
    return try fetch(path) catch {
        case .notfound -> "missing"
        case .offline  -> "offline"
    }
}
```

## `try`/`catch`: statement form for unit results

`out ! E` functions have no success value, so `try` also runs as a
statement: the ok path falls through, the arms are block branches or
`return`s, and a `return .case` inside an arm propagates to the caller:

```nomen
func report = (string path, out ! FetchError) {
    try fetch(path) catch {
        case .notfound {
            Console.write("missing\n")
            return .notfound
        }
        case .offline { Console.write("offline\n") }
    }
    Console.write("done\n")
}
```

## Composed error sets

The error side may list several error enums. Arms address the origins
directly — per-case with the origin qualifier, a whole member bound for
further matching, or unqualified when the case is unique across the set:

```nomen
func describe = (string path, out string) {
    return try load(path) catch {
        case LoadError.timeout  -> "timeout"
        case LoadError.offline  -> "offline"
        case ParseError.syntax  -> "syntax"
        case ParseError.corrupt -> "corrupt"
    }
}
```

```nomen
return try load(path) catch {
    case LoadError.timeout -> "timeout"
    case LoadError.offline -> "offline"
    case ParseError(err) { match err { case .syntax { ... } case .corrupt { ... } } }
}
```

`'!'` propagates a member error through its origin tag, so composition
composes: a function whose arms widen into a set can itself be handled
with one catch.

## Payload yields out of arms

An arm can yield a value rooted at its payload binding, and the value
survives the match — at every consumer position (`return`, `var`
bindings, interpolation), through nested matches, and for `mv`-struct
fields:

```nomen
func describe = (string path, out string) {
    return try fetch(path) catch {
        case .notfound -> "missing"
        case .io(msg)  -> msg
    }
}
```

## The rest of the toolbox

- **`expr!`** — propagate the error to the caller (the enclosing function
  must declare the same error enum):

  ```nomen
  func load_and_double = (string path, out int ! FetchError) {
      var value = load(path)!
      return value * 2
  }
  ```

- **`expr !! fallback`** — coalesce: the success value, or the fallback:

  ```nomen
  var body = fetch("example.com") !! 0
  ```

- **`var _ = expr`** — discard a result deliberately. Results cannot be
  silently ignored.

- **`match`** — inspect both sides explicitly (`.ok(value)` /
  `.fail(err)`), with `else` outside the case braces:

  ```nomen
  match fetch(url) {
      case .ok(body) -> Console.write("\{body}\n")
      case .fail(_)  -> Console.write("failed\n")
  } else -> Console.write("?\n")
  ```

---

## The short version

Three tweets plus a code sample.

**1.**

> Nomen's error handling in one shape: fallible functions declare
> `out T ! E`; a bare return is success, `return .case` is failure. Handle
> it where it happens — try/catch: the success value flows through,
> exhaustive arms cover the error enum.

**2.**

> Unit results get a statement form: `try close(path) catch { ... }` — the
> ok path falls through, arms are blocks or `return`s, and `return .case`
> inside an arm propagates to the caller. Arms can also yield their payload
> out: `case .io(msg) -> msg`.

**3.**

> The rest of the toolbox: `expr!` propagates, `expr !! fallback`
> coalesces, `var _ =` discards, `match` inspects both sides. Error sets
> compose (`out int ! LoadError, ParseError`) with origin-qualified arms.
> Reclaim-exact on both backends.

**The one code sample:**

```nomen
mv error FetchError {
    case notfound
    case io(string msg)
}

func save = (string path, out ! FetchError) {
    if path == "" {
        return .notfound
    }
    if path == "/bad" {
        return .io("disk on fire")
    }
}

// statement try: handle here — or propagate from an arm
func report = (string path, out ! FetchError) {
    try save(path) catch {
        case .notfound { return .notfound }
        case .io(msg)  { Console.write("\{msg}\n") }
    }
    Console.write("saved\n")
}

// expression try: the success value flows through, arms yield payloads
func fetch = (string path, out string ! FetchError) {
    if path == "/bad" {
        return .io("disk on fire")
    }
    if path == "" {
        return .notfound
    }
    return "body"
}

func describe = (string path, out string) {
    return try fetch(path) catch {
        case .notfound -> "missing"
        case .io(msg)  -> msg
    }
}

pub func main = () {
    var _ = report("notes.txt")                 // writes: saved
    Console.write("\{describe("notes.txt")}\n") // writes: body
    Console.write("\{describe("/bad")}\n")      // writes: disk on fire
    Console.write("\{describe("")}\n")          // writes: missing
}
```
