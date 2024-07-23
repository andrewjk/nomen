# Language

Need to come up with a good name.

## Syntax

C-like but without braces.

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
var canBeChanged = true
const isImmutable = 5
```

Types are inferred where possible, but can also be set explicitly:

```
var numberOfThings: Float = 5
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
func sum: Int = (a: Int, b: Int)
  return a + b
;

// TODO: We need to be able to pass around funcs...
const sum = (a: Int, b: Int): Int
  return a + b
;
```

If a function is simple it can be defined in one line. Note also that

- The type of the function can be inferred
- `~` can be used in place of return
- the final semicolon can be omitted with one-line functions

```
func sum = (a: Int, b: Int) ~ a + b
```

TODO: Optional parameters, named parameters, inferred array parameters

### If Statements

If statements can be used to perform certain actions based on different conditions, and take the following form:

```
if x > 10 then
  print("high")
else if x > 5 then
  print("medium")
else
  print("low")
;
```

They can be used inline:

```
if x > 10 then print("high") else print("low")
```

And can be used as expressions to return a value:

```
const high = if x > 10 then ~ true else ~ false
// or
const label = if x > 10 then ~ "high"
              else if x > 5 then ~ "medium"
              else ~ "low"
```

### Guard Statements

Guard statements can be used to ensure a condition is true and take some action if it is not:

```
guard x > 5 else
  // Do something here, maybe some cleanup
  return
;
// or
guard x > 5 else return
```

### For Statements

For statements are used to loop through a collection:

```
for x in 0..5 then
  print("\{x}")
;
// or
for x in 0..5 then print("\{x}")
```

You can also include the index when looping:

```
for x, i in 0..5 then print("\{i}: \{x}")
```

// TODO: break, continue

### While Statements

// TODO

### Match statements

Match statements are used to pattern-match against a variable.

```
match x
  when Some(y) && y > 10 then
    print("big y: \{y}")
  when Some(y) then
    print("small y: \{y}")
  else
    print("something else")
;
```

They can be used inline:

```
match x when true then print("true") else print("false")
```

And can be used as an expression to return a value:

```
const z = match x
          when Some(y) && y > 10 then ~ 10
          when Some(y) then ~ 15
          else ~ 20
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
  // Put `sec` in front of variables that shouldn't be accessed outside of the type
  // This isn't a very good example...
  sec var id: String

  // Automatically generate initializers at compile time?
  @comp init()

  // Custom inits
  func init = (name: String)
    return Person.init(name, "Unknown address")
  ;

  func greet = ()
    print("Hi, \{name}")
  ;

  // Put `final` in front of one or more finalizer functions that must be called before an object created from this type goes out of scope
  final func farewell = ()
    print("Goodbye, \{name}")
  ;
;

// Create an object from the type
const andrew = Person.init("Andrew", "1 Main St")
```

### Traits / Protocols

// TODO
