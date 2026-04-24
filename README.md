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

All built-in types can be lower-cased.

```
bool
int
int8
...
```

### Declarations

Declarations can be variable or constant:

```
var can_be_changed = true
const IS_IMMUTABLE = true
```

Types are inferred where possible, but can also be set explicitly:

```
var float number_of_things
```

### Functions

Functions are defined like so:

```
func sum = (int a, int b, out int) -> {
  return a + b
}
```

If a function is simple it can be defined in one line. TODO: Note also that the type of the function can be inferred in this case:

```
func sum = (int a, int b, out int) -> (a + b)
```

The function examples above are implicitly `const` declarations, but functions can be `var` too:

```
var func (int a, int b, out int) sum

// or

var func sum = (int a, int b, out int) -> (a + b)
```

A function is called with its name and parameters:

```
var x = sum(5, 2)
```

TODO: Optional parameters, named parameters, inferred array parameters (just arrays?)

### If Statements

If statements can be used to perform certain actions based on different conditions, and take the following form:

```
if x > 10 {
  print("high")
} else {
  print("low")
}
```

They can be used to set values with the `let` keyword:

```
var limit = if x > 5 { let 3 } else { let 12 }
```

And with simple one-liners:

```
var limit = if x > 5 -> (3) else -> (12)
```

### Blocks

```
const print_high = {
  print("high")
}

const print_low = {
  print("low")
}

if x > 5 print_high else print_low
```

### Guard Statements

Guard statements can be used to ensure a condition is true and take some action if it is not:

```
guard x > 5 else {
  // Do something here, maybe some cleanup
  return
}
```

Or, for simple returns:

```
guard x > 5 else return
```

### For Statements

For statements are used to loop through a collection:

```
for x in 0..5 {
  print("\{x}")
}
```

You can also include the index when looping with a range:

```
for x, i in list, 0.. {
  print("\{i}: \{x}")
}
```

// TODO: break, continue

### While Statements

// TODO: ??

### Switch Statements

Switch statements are a more complicated type of if statement that can be used to handle many branches:

```
switch {
  case x > 10 {
    print("high")
  }
  case x > 5 {
    print("medium")
  }
  else {
    print("low")
  }
}

const x = switch {
  case x > 10 -> "high"
  case x > 5 -> "medium"
  else -> "low"
}
```

### Match Statements

Match statements are used to pattern-match against a variable.

```
match x {
  case Some(y) && y > 10 {
    print("big y: \{y}")
  }
  case Some(y) {
    print("small y: \{y}")
  }
  else {
    print("something else")
  }
}
```

They can be used as an expression to return a value:

```
const z = match x {
  case Some(y) && y > 10 -> 10
  case Some(y) -> 15
  else -> 20
}
```

Match statements must be exhaustive.

### Collections

// TODO: Array, List, Range etc

### Anonymous Types

```
const person = {
  name: "Andrew",
  address: "1 Main St"
}
```

### Custom Types

```
type Person
  // Variables
  var string name
  var string address
  // Put `internal` in front of variables that shouldn't be accessed outside of the type
  // This isn't a very good example...
  internal var string id

  // Automatically generate initializers at compile time?
  @comp init

  // Custom inits
  func init (string name) = {
    return Person.init(name, "Unknown address")
  }

  func greet = () -> {
    print("Hi, \{name}")
  }

  // Put `final` in front of one or more finalizer functions that must be called before an object created from this type goes out of scope
  final func farewell = () -> {
    print("Goodbye, \{name}")
  }
;

// Create an object from the type
const andrew = Person.init("Andrew", "1 Main St")
```

### Enums

An enum can have one value set:

```
enum Options = {
  case trim
  case verbose
}

const options = Options.trim | Options.verbose
```

### Flags

A flag can have one or more values set:

```
flag Options = {
  case trim
  case verbose
}

const options = Options.trim | Options.verbose
```

TODO: Need a better name for this -- not flags, but similar.

### Unions

A union can have one value set, with extra information:

```
enum Result = {
  case ok
  case error(string message)
}

return Result.error("uh oh!")
```

### Traits / Protocols

// TODO:

### Generics

// TODO:

### Casting

// TODO:

### Import

// TODO:

### Export

// TODO:
