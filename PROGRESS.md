# PROGRESS — STRUCT_PLAN_3 Phase A (spelled aliases)

Status snapshot for the Phase A work ("spell class aliases"). Phase A closes the
verified hole that `var Box q = p` silently aliases a class instance: the alias
must now be spelled `ref Box q = p`, and `var Box q = p` is a compile error.

**Status: complete.** Checker, both backends, tests, and docs are done. The
aarch64 blocker below turned out not to exist in the final form — see
"Blocker — pre-existing aarch64 class-alias codegen bugs".

## What is implemented

**Parser**

- `ref` is now a local-binding keyword: `ref Box q = p`.
  - `src/parse/parse_statement.ts`, `src/parse/parse_visibility.ts`,
    `src/parse/parse_declaration.ts` accept `"ref"` as a declaration keyword.
  - `DeclarationNode.is_ref_binding` is set by the parser.
  - Destructuring parameter type widened to include `"ref"`.

**Nodes / checker state**

- `DeclarationNode.is_ref_binding` (`src/nodes/DeclarationNode.ts`).
- `StackValue.is_ref_binding` and `StackValue.ref_source`
  (`src/check/StackValue.ts`).

**Checker — `src/check/check_declaration_node.ts`**

- `ref` is normalized: `declaration` stays `"var"` for storage/codegen (this
  reuses the already-tested object-alias codegen path; normalizing to `const`
  broke the aarch64 local-alias read path) while `is_ref_binding` carries the
  alias semantics.
- `'ref' cannot declare a function-typed binding`.
- `ref` requires a reference (class) type — value-struct interior borrows are
  out of Phase A (use `view`).
- `ref` requires an existing binding source (bare variable, field/container
  access, or a borrow-returning method call). Fresh constructors, owned call
  results, `null`, and `move` initializers all error now (the first cut only
  checked bare `value` nodes — see BUGS.md #4).
- `ref_alias_source_name()` helper recognizes the alias source syntactically.
- **The headline rule**: an unspelled class alias now errors:
  `'p' is aliased — use 'ref' to share it, 'move' to transfer it, or '.copy()'
for a deep copy`.
- `class_alias_src` detection now keys on `ref_alias_source_name` and the error
  fires unless `is_ref_keyword`.
- The StackValue records `is_ref_binding` / `ref_source`.
- A `move` through a `ref` in a declaration errors (`§A3.3`).
- **Prefix-`move` declarations now transfer** (`move Box r = p`,
  `move H q = p`): the checker stamps the bare-variable initializer
  `is_moved`, which routes the declaration through the existing transfer
  machinery. Before, the prefix form never marked the source moved — an
  owning-struct source falsely errored "cannot copy … use .copy() or move"
  (the prescribed `move` was written!) and a class source silently ALIASED
  instead of transferring. Pre-existing on `main`; see BUGS.md #1.

**Checker — `src/check/check_assignment_node.ts`**

- `§A3.2` — a `ref` binding is not reassignable (bare rebind):
  `'q' is a ref — reassign the owner, not the alias`.
- `§A3.1` — a field write through a `ref` requires the source to be `var`:
  `cannot mutate through 'q' — source 'p' is not var`.
- `§A3.3` — `move` through a `ref`: `'q' is a ref — move the owner instead`.
- `is_var_binding()` helper.

**Build — aarch64**

- A moved bare class source in a declaration (`var Box r = move p`, or the
  prefix form after the checker fix) classifies as an object alias exactly
  like the C backend (`val_is_class_alias` never consulted `is_moved`
  either). Treating the new binding as an owner made scope exit destroy the
  shared instance TWICE (user `#destroy` ran `DD`; the anchor cannot follow
  the new binding). Pre-existing on `main`; see BUGS.md #3.

**Other**

- `src/check/utils/last_use.ts` declaration union widened to include `"ref"`
  (post-check nodes never carry it — it is normalized).

## Verified behavior

All positive `ref` runtime tests run on BOTH backends (the planned C-only
gating was unnecessary — the aarch64 blocker did not reproduce in the final
form):

- `ref Box q = p; q.v = 5` → `5 5` (C + aarch64, audit clean).
- Root-scope `ref` reads in `main` and at the top level.
- Nested scopes, loop bodies, method calls, two aliases, field-borrow aliases,
  owner-reassignment semantics (alias keeps the old instance).
- All four error rules fire with the intended messages (A3.1/A3.2/A3.3, the
  unspelled-alias error) plus ref-of-func, ref-of-struct, ref-of-fresh-value,
  and ref-of-move.

## Tests

- `test/ref_binding.test.ts` — dedicated suite: 12 positive runtime tests
  (both backends, audit on) + 10 error tests.
- Converted to `ref`: `test/class_move.test.ts` (2 cases),
  `test/memory_double_free.test.ts` (2 cases),
  `test/class_aliasing-gaps.test.ts` (class-alias declarations respelled; the
  three alias-REASSIGNMENT cases became §A3.2 error tests),
  `test/memory_errors.test.ts` (alias test respelled + a new unspelled-alias
  error test), `test/class.test.ts`, `test/borrow-invalidation.test.ts`,
  `test/memory_use_after_free.test.ts`, `test/init_field_assignment.test.ts`
  (2), `test/http.test.ts`, `test/tcp.test.ts` (2), `test/fiber.test.ts`,
  `test/fiber_phase2.test.ts`.
- `test/spec/structs_classes.test.ts` + `SPEC.md` "Assignment Semantics"
  updated together (the spec block now spells the alias `ref` and documents
  the ref/move/copy vocabulary).

## Docs

- `SPEC.md` — Class Types: aliasing spelled `ref`; the ref/move/copy binding
  vocabulary; the §A3 rules.
- `docs/MEMORY.md` — Classes section: `ref` spelling, rules, alias teardown
  contract.
- `NOMEN_AGENTS.md` — declarations + memory modifiers mention the spelled
  alias.
- `BUGS.md` — the pre-existing bugs fixed along the way (rollback insurance).

## Blocker — resolved (was: "pre-existing aarch64 class-alias codegen bugs")

The three repros recorded in FOLLOWUP.md (global alias read SIGBUS, local
alias mutation SIGBUS, root-scope `ref` link error) do NOT reproduce on the
finished tree — or on `main` via any path attempted (test harness with/without
the system-lib split, single-TU, CLI `run`, CLI `test`, installed nomen). They
most likely came from the session's INTERMEDIATE checker state (normalizing
`ref` → `const` — recorded in this file as broken — changes the storage class
the alias machinery sees) and from repro files sharing /tmp (the CLI joins
sibling `.nm` files, which produced confusing unrelated errors).

The investigation DID surface three real pre-existing bugs, all fixed and
covered by tests (see BUGS.md for rollback-grade writeups):

1. Prefix-`move` declarations never transfer (checker gap) — silently aliased
   classes / falsely rejected owning structs.
2. Move-through-a-`ref` fired the wrong message (starved by #1).
3. aarch64 class TRANSFER declarations double-destroyed the shared instance
   (`move Box r = move p` ran `#destroy` twice — likely the real bug behind
   the original SIGBUS reports).
