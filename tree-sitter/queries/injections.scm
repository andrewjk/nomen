; Raw code blocks (`#raw { … }`) carry C or AArch64 assembly.
;
; - `#raw("c") { … }` / `#raw("c", "file") { … }` is always C (the
;   companion-file C the aarch64 backend compiles).
; - An unmarked `#raw { … }` (or `#raw("file")`) is the target's default
;   dialect: C on the C backend, assembly on aarch64. The target comes from
;   the enclosing `#if META.arch == "…"` arm (or `#switch` case).

((raw_block
  .
  arguments: (string) @_dialect
  body: (raw_body) @injection.content)
  (#eq? @_dialect "\"c\"")
  (#set! injection.language "c"))

; --- unmarked blocks inside `#if META.arch == "c"` ---

(pragma_if
  condition: (_) @_condition
  consequence: (block
    (raw_block
      !arguments
      body: (raw_body) @injection.content))
  (#match? @_condition "META\\.arch *== *\"c\"")
  (#set! injection.language "c"))

(pragma_if
  condition: (_) @_condition
  consequence: (block
    (raw_block
      .
      arguments: (string) @_dialect
      body: (raw_body) @injection.content))
  (#match? @_condition "META\\.arch *== *\"c\"")
  (#eq? @_dialect "\"file\"")
  (#set! injection.language "c"))

(pragma_case
  condition: (_) @_condition
  (block
    (raw_block
      !arguments
      body: (raw_body) @injection.content))
  (#match? @_condition "META\\.arch *== *\"c\"")
  (#set! injection.language "c"))

; --- unmarked blocks inside `#if META.arch == "aarch64"` ---

(pragma_if
  condition: (_) @_condition
  consequence: (block
    (raw_block
      !arguments
      body: (raw_body) @injection.content))
  (#match? @_condition "META\\.arch *== *\"aarch64\"")
  (#set! injection.language "asm"))

(pragma_if
  condition: (_) @_condition
  consequence: (block
    (raw_block
      .
      arguments: (string) @_dialect
      body: (raw_body) @injection.content))
  (#match? @_condition "META\\.arch *== *\"aarch64\"")
  (#eq? @_dialect "\"file\"")
  (#set! injection.language "asm"))

(pragma_case
  condition: (_) @_condition
  (block
    (raw_block
      !arguments
      body: (raw_body) @injection.content))
  (#match? @_condition "META\\.arch *== *\"aarch64\"")
  (#set! injection.language "asm"))
