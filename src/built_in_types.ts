const built_in_types = [
  // True or false
  "bool",
  // Alias to 32 bit int
  "int",
  "uint",
  // Sized ints
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "int64",
  "uint64",
  // Alias to 32 bit float
  "float",
  "ufloat",
  // Sized floats
  "float32",
  "ufloat32",
  "float64",
  "ufloat64",
  // Char -- a unicode point
  "char",
  // String -- type depends on how it's defined
  // E.g. const string = "hello" is static
  //      const string = "hello, \{name}" is fixed size and on the stack
  //      var string = "hello" is on the heap
  "string",
];

export default built_in_types;
