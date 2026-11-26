; Raw code blocks (`#raw { … }`) carry C or AArch64 assembly.
;
; - `#raw("c") { … }` (also `#raw("c", "file")`) is always C: the
;   companion-file C the aarch64 backend compiles.
; - An unmarked `#raw { … }` (or `#raw("file")`) is the target's default
;   dialect: C on the C backend, assembly on aarch64. The target comes from
;   the enclosing `#if META.arch == "…"` arm or `#switch` case — the raw
;   block directly in the arm, or inside a function, hook, `unsafe { }` or
;   bare block in it, or in a method of a type declared in it.

((raw_block
  dialect: (string) @_dialect
  body: (raw_body) @injection.content)
  (#eq? @_dialect "\"c\"")
  (#set! injection.language "c"))

; --- unmarked blocks in a `META.arch == "c"` arm ---

(pragma_if
  condition: (_) @_condition
  consequence: (block
    [
      (raw_block !dialect body: (raw_body) @injection.content)
      (block (raw_block !dialect body: (raw_body) @injection.content))
      (unsafe_block body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (struct_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (struct_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (extend_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (extend_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (trait_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (trait_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (enum_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (enum_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
    ])
  (#match? @_condition "META\\.arch *== *\"c\"")
  (#set! injection.language "c"))

(pragma_case
  condition: (_) @_condition
  (block
    [
      (raw_block !dialect body: (raw_body) @injection.content)
      (block (raw_block !dialect body: (raw_body) @injection.content))
      (unsafe_block body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (struct_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (struct_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (extend_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (extend_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (trait_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (trait_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (enum_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (enum_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
    ])
  (#match? @_condition "META\\.arch *== *\"c\"")
  (#set! injection.language "c"))

; --- unmarked blocks in a `META.arch == "aarch64"` arm ---

(pragma_if
  condition: (_) @_condition
  consequence: (block
    [
      (raw_block !dialect body: (raw_body) @injection.content)
      (block (raw_block !dialect body: (raw_body) @injection.content))
      (unsafe_block body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (struct_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (struct_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (extend_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (extend_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (trait_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (trait_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (enum_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (enum_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
    ])
  (#match? @_condition "META\\.arch *== *\"aarch64\"")
  (#set! injection.language "asm"))

(pragma_case
  condition: (_) @_condition
  (block
    [
      (raw_block !dialect body: (raw_body) @injection.content)
      (block (raw_block !dialect body: (raw_body) @injection.content))
      (unsafe_block body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))
      (struct_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (struct_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (extend_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (extend_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (trait_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (trait_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (enum_declaration body: (block (function_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
      (enum_declaration body: (block (hook_declaration body: (block (raw_block !dialect body: (raw_body) @injection.content)))))
    ])
  (#match? @_condition "META\\.arch *== *\"aarch64\"")
  (#set! injection.language "asm"))
