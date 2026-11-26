(function_declaration
  (modifier)* @context
  "func" @context
  name: (_) @name) @item

(hook_declaration
  name: (_) @name) @item

(struct_declaration
  (modifier)* @context
  ["struct" "class"] @context
  name: (_) @name) @item

(enum_declaration
  (modifier)* @context
  ["enum" "error" "bitset"] @context
  name: (_) @name) @item

(trait_declaration
  (modifier)* @context
  "trait" @context
  name: (_) @name) @item

(extend_declaration
  "extend" @context
  name: (_) @name) @item

(enum_case
  "case" @context
  name: (_) @name) @item
