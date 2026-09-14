# Changelog






## 0.3.0
<sub>2026-09-14</sub>

-  *(minor)* - string replace_first/replace_all with view needle/replacement
-  *(minor)* - System::string query methods: index_of, contains, prefix/suffix, char_code_at, substring, trim, case mapping
-  *(minor)* - StringBuilder.append_string_view and seed: memcpy views without to_string copies
-  *(minor)* - char classification: is_digit, is_alpha, is_alphanumeric, is_ascii_space
-  *(minor)* - Regex.captures: capture group extraction into List<string>
-  *(minor)* - Regex.find + RegexMatch: mvzr-style match positions
-  *(minor)* - Regex lazy quantifiers: *? +? ??
-  *(minor)* - Regex case-insensitive matching: *_ci wrappers via pattern folding
-  *(minor)* - Regex backreferences: \1-\9 incl. quantified and lazy forms
-  *(minor)* - Regex \s \d \w shorthands with \S \D \W complements
-  *(minor)*
  Add `unsafe` (library-only): ptr T values, pointer indexing, pointer casts, and generic T_SIZE/T_NEEDS_STRDUP/T_FAT constants; rewrite core memory primitives (Buffer alloc/grow/zero/destroy, StringBuilder ensure/append/seed/destroy, Array at/first/at_end/set, String at/set) as unsafe Nomen with memory externs
-  *(minor)* - Base-seeded struct literals: [ .. base, field = value ] replaces the T() + [ ... ] override syntax
-  *(minor)* - string.char_code_at is bounds-constrained; add char_code_at_or / char_code_at_or_panic
-  *(minor)* - nomen check/build on a project file anchors to the package.jsonc entry
-  *(minor)* - Joiner walks the import graph cycle-safely; self-import and unresolvable-import diagnostics
-  *(minor)*
  Two-tier rule for value-struct trait conformers: cross-conformer reassignment, trait-array elements, and call-boundary passes of value-struct-backed trait locals are now check-time rejections; the inline local form is documented as tier 1 (docs/TRAITS.md)
-  *(minor)*
  Reject passing a view string where an owned string parameter is expected — call .to_string() to materialize (was: silent alias on aarch64, clang error on C)
-  *(minor)*
  Add System.Arena<T> + ArenaRef<T>: a generational arena (one owner, copyable generation-checked handles) for the single-ownership parent/child-reference pattern (allmark PORT)
-  *(minor)*
  Allow move on trait-typed parameters (checker + both backends reclaim via the trait <Trait>_destroy shim), unblocking add(move Renderer r) style APIs
-  *(minor)*
  Func-typed struct/class fields: declare, assign, and call s.f(args) via an indirect call (allmark BlockRule object shape)
-  *(patch)*
  Scope trait_class_locals per function body so a trait-typed local in one monomorphized body cannot poison later bodies' auto-free
-  *(patch)* - Verify Map rehash auto-free is fixed by trait_class_locals scoping; add regression test
-  *(patch)* - aarch64 custom init: spill fat string params as (ptr,len) register pairs so following scalars read the right registers
-  *(patch)* - C init: dup class string field literal defaults so reassignment/destroy never frees rodata
-  *(patch)*
  C return/cast: lower return 0 with a struct out type to a zero-initialized compound literal so Map<string, Struct> compiles
-  *(patch)* - Verify explicit List<Trait> annotations check clean (regression test)
-  *(patch)* - Reject func-typed struct/class fields with trait guidance; fix func-type field parse
-  *(patch)* - Allow methods to return class borrows rooted at self (accessor pattern); non-self borrows still rejected
-  *(patch)* - Constraint verifier: literal-length facts, same-base offset algebra, dotted-path offset args
-  *(patch)* - Tokenize escape pairs left-to-right; decode char-literal escapes in both backends
-  *(patch)* - Materialize rvalue trait receivers once; reclaim owned receivers on both backends
-  *(patch)* - aarch64 trait dispatch: free owned string results when all conformers return owned heap
-  *(patch)* - Checker: synthesize func-value calls for any signature (incl. out returns) and signature-check reassignment
-  *(patch)* - Map() + set() works for class/trait values; variadic pairs gate refined
-  *(patch)* - System.Text UTF-8 helpers (Utf8, Chars, CharIndex)
-  *(patch)* - Fix string-literal byte hazards (fold, lengths, NUL)
-  *(patch)* - Remove stale tuple bug report, already fixed
-  *(patch)* - aarch64: strdup a heap-local string stored into a ref-param struct field (store used to dangle)
-  *(patch)*
  aarch64 backend: constant rematerialization — float literal-pool loads become fmov immediates (hoisted out of hot loops), movz-range literal-pool loads become mov immediates
-  *(patch)*
  aarch64 backend: stack-staging elision — push/pop staging pairs around computed indexes become direct register reads (mov-form rename verdict-gated on exact liveness; bare pairs deleted as identities)
-  *(patch)*
  aarch64 backend: pointer-walk strength reduction — single-access loop addressing becomes post-index walked pointers (`ldr [w], #stride`), killing the index arithmetic from the memory op
-  *(patch)*
  aarch64 backend: auto method inline mechanism for small unmarked methods (ensure/clear-shaped) — lands kill-switch-only (default OFF) pending the JsonTree splice crash root-cause
-  *(patch)*
  aarch64 backend: ×2 unrolling of validated straight-line loop cycles (pre-guard hoist + body/guard duplication, exact for every trip count)
-  *(patch)*
  aarch64 backend: auto method inline unlocked (default ON) — small unmarked methods splice at call sites; bodies calling T-generic Buffer methods (load_T/store_T) take the real call (JsonTree crash class gated out)
-  *(patch)*
  aarch64 backend: naked inline expansion for allocation-free leaf bodies — BigInt limb accessors, ClassBuffer alloc/grow and JsonTree slab primitives converted from raw asm to plain Nomen (single-sourced across backends); List.at now takes a real call (generic-nested splice gate)
-  *(patch)* - Fix C-backend trait-typed local poisoning invalid C
-  *(patch)* - Scope aarch64 trait-class bindings per local
-  *(patch)* - Close C value-struct conformer dispatch gap
-  *(patch)* - Fix nullable string initialized to null emitting invalid C on the backend
-  *(patch)* - null into string? params and aarch64 defaulted nullable-string fields now lower to the zero pair
-  *(patch)*
  Trait-typed local copies of value-struct slots now build on C (concrete-struct declaration); class-backed trait-slot copies and value-struct stores into class-backed slots are check-time rejections; borrow-slot reassignment no longer destroys the shared instance on C
-  *(patch)*
  Reject storing a borrowed class value into an owning (move) class field — the borrowed shape double-freed on both backends; the move-param mutator idiom stays legal
-  *(patch)*
  Fix trait dispatch through container elements: C no longer takes the address of a class-typed receiver expression (container element), and aarch64 no longer frees a borrowed trait slot's container-owned element on reassignment
-  *(patch)*
  Plain func_call resolution must not resolve to a struct/trait method (a method named like a free function, e.g. Arena.free vs the extern free, stole the call)
-  *(patch)* - Fix lambda arguments and func-typed values on aarch64; reject func signature mismatches

## 0.2.3
<sub>2026-09-10</sub>

-  *(patch)* - Fix namespace imports resolving directories and spaced :: segments
-  *(patch)* - Desugar for x of List to element iteration

## 0.2.2
<sub>2026-09-10</sub>

-  *(patch)* - Fix: unify bound namespaces and chain inclusive bounds
-  *(patch)* - Fix: view to owned transfers materialize

## 0.2.1
<sub>2026-09-10</sub>

-  *(patch)* - Fix: honor --out as the linked binary path
-  *(patch)* - Fix: view receivers and view structs in Lists

## 0.2.0
<sub>2026-09-10</sub>

-  *(minor)*
  Rename keywords: `mov` → `move` (reads as English like the rest of the keyword set) and `strict` → `must_use` (names the actual rule — values may not be silently discarded — and avoids the one-letter `struct` collision)
-  *(patch)*
  Fix: C backend alias-own flags leak across functions (undeclared _alias_owns_X compile error when a later function reuses a variable name that a borrow was bound to in an earlier one)
-  *(patch)*
  Fix: C backend string-ownership sets (string_borrow_vars, moved_string_vars, heap_strings, owned_string_vars, moved) leak across functions like the alias maps did — a borrow-only local name in one function suppressed the scope-exit free of an unrelated owned same-named variable in a later one (leak visible under --audit)
-  *(patch)* - Add --audit/--audit-runtime support to the test command
-  *(patch)*
  Fix: element type of a cross-file generic return resolved order-independently — the mono instantiation is flowed at call time and materialized on demand at member access, so implicit-typed results (const diffs = combined(a, b)) no longer degrade to the bare type param in entry-first merge order
-  *(patch)*
  Fix: owned-string expression temps never freed on aarch64 — string comparisons (==/!=) now spill-and-free owned heap-temp operands (the result-type gate missed bool-yielding comparisons), grouped operands like ("a" + "b") + "c" classify as owned temps, nested-in-function callees resolve through their emission label, and the C backend's spill-and-free path no longer drops the != inversion
-  *(patch)* - Fix aarch64 ref-deref arg clobbering arg 0

## 0.1.0
<sub>2026-09-09</sub>

-  *(minor)* - Replace / namespace separator with :: and add qualified references (Namespace::Name) in code
-  *(minor)*
  Convert Http to the error-enum pattern: Http.get/post now return Result<string, HttpError> (new core/System/Stream/HttpError.nm) instead of a plain string with a 0 status sentinel
-  *(minor)*
  Add a `strict` enum modifier: values of a strict enum (core `Result`) can no longer be silently discarded in statement position — bind (`var _ = f.close()`) or match deliberately. Also fixes latent aarch64 pair-store range bugs the new discard locals exposed.
-  *(patch)*
  check/build: walk switch/match case subtrees in every generic AST scan via the shared child_nodes helper (warnings, ownership, last_use, string mutation scan, objc/NEON/inline/heap-return scans)
-  *(patch)* - Fix: keywords can't be used as variable, parameter, field, type, or case names
-  *(patch)* - Fix: validate imports
-  *(patch)*
  Fix: editor loads project-relative imports (subfolder modules) for hover/go-to-definition/diagnostics, refs work on generic type arguments, and import validation only applies to System-rooted paths
-  *(patch)* - aarch64: registerize loop inductions in region brackets
-  *(patch)* - Fix call-free scan missing struct operator calls
-  *(patch)* - Fix asm validator rejection of numeric local labels
-  *(patch)*
  Plain string assignment now restores value semantics (s = t strdups an owned copy) with move-on-last-use transfer for provably dead sources; fixes cross-scope dangle, return-escape, and ref-mutation aliasing UAFs on both backends
-  *(patch)* - aarch64: scratch-pool receiver hoists in region brackets
-  *(patch)*
  Close the plain string assignment residuals: borrow-initialized assignees now take an ownership restart (borrow receptions strdup'd on both backends, sound under untaken restart branches), explicit s = mov t actually transfers (was a C double free), and the C move gate accepts bare-variable-initializer sources
-  *(patch)*
  Convert core raw #arch blocks to plain Nomen (Math.power, primitive hashes, String.hash, Regex.find_next_byte); fix C-backend primitive-method self deref and add sxtb/sxth/sxtw to aarch64 asm validator
-  *(patch)* - Add extern func C-FFI declarations; convert atoi and strdup raw blocks to it
-  *(patch)* - Fix free library function resolution from parameterless main
-  *(patch)* - Fix checker name resolution shadowing core bodies
-  *(patch)* - aarch64: reload raw `#arch: aarch64` block params after control flow
-  *(patch)* - extern Math.log, method extern labels
-  *(patch)* - Fix: SLP pairs only form in call-free scopes (extern-sqrt nbody miscompile)
