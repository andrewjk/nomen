; Scopes

[
  (source_file)
  (block)
  (function_declaration)
  (hook_declaration)
  (function_literal)
  (lambda_expression)
  (for_statement)
  (pragma_for)
  (match_arm)
] @local.scope

; Definitions

(function_declaration
  name: (identifier) @local.definition.function)

(parameter
  name: (identifier) @local.definition.parameter)

(variadic_parameter
  name: (identifier) @local.definition.parameter)

(lambda_parameter
  name: (identifier) @local.definition.parameter)

(type_parameter_declaration
  name: (identifier) @local.definition.type)

(variable_declaration
  name: (identifier) @local.definition.var)

(destructuring_element
  name: (identifier) @local.definition.var)

(for_statement
  binding: (identifier) @local.definition.var)

(pragma_for
  binding: (identifier) @local.definition.var)

(async_block
  name: (identifier) @local.definition.var)

(struct_declaration
  name: (type_identifier) @local.definition.type)

(enum_declaration
  name: (type_identifier) @local.definition.type)

(trait_declaration
  name: (type_identifier) @local.definition.type)

; References

(identifier) @local.reference
