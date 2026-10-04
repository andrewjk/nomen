# PROGRESS — STRUCT_PLAN_3 Phase B

Status snapshot for Phase B (unify value types). Tranches mirror Phase N's
pattern: dependency-ordered, each landing with tests on both backends.

## Tranche 1 — B1/B1a: declared ownership (DONE)

- **The spellings**: `owning struct X` / `owning enum X` (bare, and after any
  visibility — `pub owning struct`). Parse arms in parse_statement and
  parse_visibility; `StructNode.is_owning` / `EnumNode.is_owning`.
- **The declared flag wins** (`src/check/utils/ownership.ts`):
  `is_owning_struct_type` and `is_owning_struct_type_requiring_move` return
  true for a declared-`owning` struct unconditionally — a string-only
  `owning struct` is STILL move-only (the declaration says the type owns;
  the compiler no longer second-guesses it). The inferred walk remains for
  undeclared structs during the transition.
- **Move-only bindings**: the declaration copy gate rejects a bare copy of a
  declared-`owning` struct ("cannot copy 'X' by value — it owns heap
  resources; use .copy() or move") and of a declared-`owning` enum ("it is
  an `owning enum`; use move").
- **The Copyable verifier** (declared-flag subset): a bare `struct` with a
  DECLARED-owning field errors with the plan's exact wording ("'Wrapper'
  cannot be Copyable — field 'c' owns heap memory --> mark the struct
  `owning struct Wrapper`, or remove the field"); a bare `enum` with a
  DECLARED-owning payload likewise ("mark it `owning enum Holder`").
  Inferred ownership is deliberately NOT verified during the transition —
  existing code keeps its semantics; declared `owning` is the opted-in
  contract.

## Not yet done (Phase B tranches 2+)

- **B1 full cutover**: the verifier over INFERRED ownership (bare struct
  with a string field → error) — the plan's end state, which migrates every
  existing owning struct to the declared spelling. Sequenced after the
  built-in rewrite (post-B4/R), since the string-only-struct borrow-copy
  semantics are load-bearing in the memory model until then.
- **B2 — `Box<T>`** (cycles + identity): the owning-struct-with-one-pointer-
  field magic type; cycle detection naming the field; null-pointer
  nullable lowering.
- **B4 — trait objects** (the gate for class removal): boxed
  `(vtable, instance)` handles at every trait position on both backends;
  tier-1 demotion; boxing takes ownership (T1–T4).
- **B5/B6**: field-restriction collapse; nullable lowerings (Box? = null
  pointer; inline structs keep the companion flag).

## Known pre-existing gaps surfaced

- **BUGS.md #9** — aarch64: an enum-with-data payload of a value struct
  crashes at the match binding (plain shape, no owning markers needed).
  B1a's owning-enum semantics are therefore proven on C; on aarch64 use a
  class payload (reference payloads transfer by pointer and are unaffected)
  until #9 is fixed.
