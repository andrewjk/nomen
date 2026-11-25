; Highlights for Nomen.
;
; Capture names follow the nvim-treesitter conventions, which Helix and Zed
; themes also resolve (each falls back along the dotted name, so
; `@keyword.conditional` still colours as `@keyword`). Patterns are written
; to be disjoint wherever possible; where two do overlap, the more specific
; one comes LAST (Neovim and Zed let later patterns win).

; ---------------------------------------------------------------------------
; Comments
; ---------------------------------------------------------------------------

(line_comment) @comment @spell

((block_comment) @comment @spell
  (#not-match? @comment "^/\\*\\*[^/]"))

((block_comment) @comment.documentation @spell
  (#match? @comment.documentation "^/\\*\\*[^/]"))

; ---------------------------------------------------------------------------
; Identifiers (general roles first; specific roles below override)
; ---------------------------------------------------------------------------

((identifier) @type
  (#match? @type "^[A-Z]")
  (#not-match? @type "^[A-Z][A-Z0-9_]*$"))

; SCREAMING_CASE constants (`PAIR_BYTES`, `T_SIZE`); `META` is the comptime
; namespace.
((identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]*$")
  (#not-eq? @constant "META"))

((identifier) @constant.builtin
  (#eq? @constant.builtin "META"))

(self) @variable.builtin

((hash_identifier) @variable.builtin
  (#eq? @variable.builtin "#self"))

; `#i`, `#word`, `#t` — comptime loop bindings
((hash_identifier) @constant.macro
  (#not-eq? @constant.macro "#self"))

; ---------------------------------------------------------------------------
; Types
; ---------------------------------------------------------------------------

((type_identifier) @type
  (#not-any-of? @type
    "int" "uint" "int8" "int16" "int32" "int64" "uint8" "uint16" "uint32" "uint64"
    "float" "float16" "float32" "float64" "string" "char" "bool" "void"))

((type_identifier) @type.builtin
  (#any-of? @type.builtin
    "int" "uint" "int8" "int16" "int32" "int64" "uint8" "uint16" "uint32" "uint64"
    "float" "float16" "float32" "float64" "string" "char" "bool" "void"))

; builtin type names used as values: `zero(int)`, `int.max()`
((identifier) @type.builtin
  (#any-of? @type.builtin
    "int" "uint" "int8" "int16" "int32" "int64" "uint8" "uint16" "uint32" "uint64"
    "float" "float16" "float32" "float64" "string" "char" "bool" "void"))

(type_parameter_declaration
  name: (identifier) @type)

(scoped_type
  case: (identifier) @constant)

; ---------------------------------------------------------------------------
; Declarations
; ---------------------------------------------------------------------------

(function_declaration
  name: [(identifier) (hash_identifier)] @function)

(function_declaration
  name: (template_name (template_text) @function))

(hook_declaration
  name: (hash_identifier) @function)

(parameter
  name: (identifier) @variable.parameter)

(variadic_parameter
  name: (identifier) @variable.parameter)

(lambda_parameter
  name: (identifier) @variable.parameter)

(named_argument
  name: (identifier) @variable.parameter)

(field_set (identifier) @property)

(field_initializer
  name: (identifier) @property)

(destructuring_element
  field: (identifier) @property)

(enum_case
  name: (identifier) @constant)

(enum_shorthand
  name: (identifier) @constant)

(enum_variant
  name: (identifier) @constant)

(attribute
  "@" @attribute
  name: (identifier) @attribute)

(import_path (identifier) @module)

(qualified_identifier
  (identifier) @module
  .
  "::")

(qualified_type
  (identifier) @module
  .
  "::")

; ---------------------------------------------------------------------------
; Members and calls
; ---------------------------------------------------------------------------

(field_identifier) @property

(call_expression
  function: (identifier) @function.call
  (#match? @function.call "^[a-z_]"))

(call_expression
  function: (identifier) @constructor
  (#match? @constructor "^[A-Z]"))

(call_expression
  function: (generic_name
    name: (identifier) @constructor))

(call_expression
  function: (member_expression
    property: (field_identifier) @function.method.call))

; `#embed_file("…")`
(call_expression
  function: (hash_identifier) @function.builtin)

(panic_expression
  keyword: _ @function.builtin)

; ---------------------------------------------------------------------------
; Literals
; ---------------------------------------------------------------------------

(string) @string

(string_continuation) @string

(escape_sequence) @string.escape

(format_spec) @string.special

(interpolation
  "\\{" @punctuation.special
  "}" @punctuation.special)

(splice
  "#{" @punctuation.special
  "}" @punctuation.special)

(template_name (template_text) @variable)

(char) @character

(number) @number

(boolean) @boolean

(null) @constant.builtin

; ---------------------------------------------------------------------------
; Keywords
; ---------------------------------------------------------------------------

"import" @keyword.import

"func" @keyword.function

[
  "struct"
  "class"
  "enum"
  "error"
  "bitset"
  "trait"
  "extend"
  "type"
] @keyword.type

[
  "var"
  "const"
  "let"
] @keyword

[
  "mv"
  "ref"
  "view"
  "readonly"
  "out"
  "ptr"
] @keyword.modifier

(modifier) @keyword.modifier

"return" @keyword.return

[
  "if"
  "else"
  "switch"
  "match"
  "case"
] @keyword.conditional

[
  "while"
  "for"
  "of"
] @keyword.repeat

(break_statement) @keyword.repeat

(continue_statement) @keyword.repeat

[
  "try"
  "catch"
] @keyword.exception

"async" @keyword.coroutine

"unsafe" @keyword.modifier

[
  "as"
  "swap"
] @keyword.operator

[
  "#if"
  "#switch"
  "#for"
  "#error"
  "#raw"
] @keyword.directive

; ---------------------------------------------------------------------------
; Operators and punctuation
; ---------------------------------------------------------------------------

[
  "="
  "+="
  "-="
  "*="
  "/="
  "%="
  "+"
  "-"
  "*"
  "/"
  "%"
  "=="
  "!="
  "<"
  "<="
  ">"
  ">="
  "&&"
  "||"
  "!"
  "~"
  "&"
  "|"
  "^"
  "<<"
  ">>"
  "??"
  "!!"
  "?"
  "?."
  ".."
  "..."
  "->"
  "=>"
] @operator

(type_arguments
  ">" @punctuation.bracket)

(type_parameters
  ">" @punctuation.bracket)

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  ","
  "."
  ":"
  "::"
  ";"
] @punctuation.delimiter
