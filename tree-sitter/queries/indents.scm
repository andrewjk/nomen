; Indentation (nvim-treesitter conventions).

[
  (block)
  (match_body)
  (field_set)
  (argument_list)
  (parameter_list)
  (lambda_parameters)
  (array_literal)
  (struct_literal)
  (destructuring_pattern)
  (type_arguments)
] @indent.begin

(block "}" @indent.branch @indent.end)
(match_body "}" @indent.branch @indent.end)
(field_set "}" @indent.branch @indent.end)

[
  ")"
  "]"
] @indent.branch @indent.end

; An `if … ->` / `else ->` arm continued on the next line.
(arrow_branch) @indent.begin

; Raw bodies and strings keep their own layout.
[
  (raw_body)
  (string)
] @indent.ignore

[
  (line_comment)
  (block_comment)
] @indent.auto
