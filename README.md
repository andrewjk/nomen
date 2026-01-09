# The Echo Programming Language

## Syntax

Designed with an emphasis on ease of keyboard use and reading aloud.

### Comments

One-line comments start with `//` and extend until the end of the line.

```
// This is a one-line comment
```

Multi-line comments start with `/*` and end with `*/`. Comments may be nested.

```
/*
This is a multiline comment
/* This is a nested comment */
The comment ends below
*/

```

### Declarations

Declarations can be variable or constant:

```
var can_be_changed = true
const is_immutable = 5
```

Types are inferred where possible, but can also be set explicitly:

```
var number_of_things: Float = 5
// or
var number_of_things = 5 as Float
```

### Built-In Types

```
Bool
Int (defaults to the length of the system)
Int8
Int16
Int32
Int64
Float (defaults to the length of the system)
Float16
Float32
Float64
String
etc
```

### Functions

Functions are defined like so:

```
func sum(a: Int, b: Int) -> Int {
  return a + b
}

func sum(a: Int, b: Int) -> Int {
  return a + b
}
```

If a function is simple it can be defined in one line. Note also that the type of the function can be inferred:

```
func sum(a: Int, b: Int) => a + b
```

TODO: Optional parameters, named parameters, inferred array parameters

### If Statements

If statements can be used to perform certain actions based on different conditions, and take the following form:

```
if x > 10 {
  print("high")
} else {
  print("low")
}
```

They can be used inline, without braces:

```
if x > 10 print("high") else print("low")
```

### Guard Statements

Guard statements can be used to ensure a condition is true and take some action if it is not:

```
guard x > 5 else {
  // Do something here, maybe some cleanup
  return
}
// or
guard x > 5 else return
```

### For Statements

For statements are used to loop through a collection:

```
for x in 0..5 {
  print("\{x}")
}
// or
for x in 0..5 print("\{x}")
```

You can also include the index when looping:

```
for x, i in list, 0.. then print("\{i}: \{x}")
```

// TODO: break, continue

### While Statements

// TODO

### If Expressions

If expressions are a more complicated type of if statement, that can be used to handle many branches, or to return a value:

```
if {
  case x > 10:
    print("high")
  case x > 5:
    print("medium")
  else:
    print("low")
}

const x = if {
  case x > 10: "high"
  case x > 5: "medium"
  else: "low"
}
```

### Match Expressions

Match statements are used to pattern-match against a variable.

```
match x {
  case Some(y) && y > 10:
    print("big y: \{y}")
  case Some(y):
    print("small y: \{y}")
  else:
    print("something else")
}
```

They can be used as an expression to return a value:

```
const z = match x {
  case Some(y) && y > 10: 10
  case Some(y): 15
  else: 20
}
```

Match statements must be exhaustive.

### Collections

// TODO: Array, List, Range etc

### Custom Types

```
type Person
  // Variables
  var name: String
  var address: String
  // Put `inner` in front of variables that shouldn't be accessed outside of the type
  // This isn't a very good example...
  inner var id: String

  // Automatically generate initializers at compile time?
  @comp init()

  // Custom inits
  func init(name: String) {
    return Person.init(name, "Unknown address")
  }

  func greet() {
    print("Hi, \{name}")
  }

  // Put `final` in front of one or more finalizer functions that must be called before an object created from this type goes out of scope
  final func farewell() {
    print("Goodbye, \{name}")
  }
;

// Create an object from the type
const andrew = Person.init("Andrew", "1 Main St")
```

### Traits / Protocols

// TODO
