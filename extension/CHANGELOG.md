# Changelog












## 0.11.0
<sub>2026-11-11</sub>

-  *(minor)* - Compile-time-checked format specs in string interpolation
-  *(minor)* - Grouping and exponential format specs
-  *(minor)* - Custom pattern format specs
-  *(patch)* - Fix displaced free on string reassignment
-  *(patch)* - Anchor inline call-result string args
-  *(patch)* - Isolate string ownership per struct method
-  *(patch)* - Preserve empty braces and comment gaps in formatter
-  *(patch)* - Show declared field sets in signatures

## 0.10.0
<sub>2026-11-10</sub>

-  *(minor)*
  Feat: declared field sets on ref params — `ref x { fields }` declares the fields a `ref` parameter may displace, enabling field-scoped borrow invalidation. Bodies are verified against the set, trait conformers must narrow it, and editor quick fixes add or extend it. Lints name the fields an un-annotated ref displaces, suggest `{}` for refs that displace nothing (so calls keep callers' borrows alive), suggest taking copyable non-mutating refs by value, and suggest bare `self` for un-mutated `ref self` receivers — each with a local quick fix where one exists. Trait method declarations carry the contract, generic-struct templates resolve their own fields, and the bundled System library declares a set on every concrete `ref` parameter, so calls into `core/System` invalidate precisely (trait receivers and primitive mutators stay conservative wildcards).
-  *(minor)*
  View-field staleness is per-field: mutating a view source poisons only the fields it sourced (declared-effects attribution); copies inherit staleness; unattributable merges keep the wholesale fallback
-  *(minor)*
  Place-scoped List element borrows: slot writes (set/set_or_panic) invalidate only the places they displace; i != j guard facts; sibling-slot borrows survive
-  *(minor)*
  Aliasing relaxation: two aliased ref params with disjoint declared field sets are accepted; wildcards and ownership params keep the rejection
-  *(minor)*
  Field-path bounds contracts discharge: guard facts consulted for path receivers (flipped literal + exact name), synthetic-self path keys, dotted-receiver shrink narrowing
-  *(minor)*
  Fix path-fact leak: comparison evaluator consults the base's shared bound arrays only for bare right sides; dotted paths use their path entry
-  *(minor)*
  LinkedList/Tree bounds discharge: Tree gains at_or/at_or_panic; count-keyed exact lengths (fresh=0, add=+1, setters preserve) with .count facts; param/return contracts forward exact lengths
-  *(patch)* - Guard Task result reads on empty handles; drop dead pthread_join fields
-  *(patch)*
  Fix containers zeroing non-owning value-struct arguments — `List.push`, `Buffer`, `Arena`, `Set`, `Map` and `LinkedList` now copy handle-like elements (a legal bare argument to a `mv` parameter) instead of taking and zeroing the caller's copy (`T_TAKES_OWNERSHIP`).
-  *(patch)*
  Fix symbol tokens carrying the preceding word's source offset — a word-adjacent symbol (e.g. the `)` after `nothing`) was anchored one token behind, shifting symbol-anchored error positions and editor offsets.
-  *(patch)*
  Fix the lint pass being suppressed by internal errors on synthesized nodes (`start: -1`) — warnings now run whenever the checker reports no user-addressable errors, so `nomen check` surfaces them for programs with string-field structs and auto-derived `copy` bodies. Also exempts the synthesized `copy` field store from the copy-out-of-a-field rejection (it strdups by design), and adds a `Use 'const'` quick fix to the var-never-changed warning.
-  *(patch)* - Fix first-check string-field copy errors
-  *(patch)* - Reject double start on Thread/Fiber (null-write guard)
-  *(patch)* - Reset the window close-forced latch after a forced close
-  *(patch)* - Copy missing checker stamps in clone_status/clone_node
-  *(patch)* - Maintain BigInt sign through arithmetic; sign-aware cmp
-  *(patch)* - Reconcile branch-local moves into the enclosing scope

## 0.9.0
<sub>2026-11-06</sub>

-  *(minor)* - Add StableList<T>: grow-only list whose element borrows survive push (checker exemption + for-of element iteration)
-  *(minor)*
  Swap JsonTree's raw slab for StableList (unsafe text lifecycle deleted); scope C-backend ref locals per body (JsonTree receipt); StableList raw calloc follows the audit-wrap convention
-  *(minor)*
  In-place construction for container pushes (GOOSE.md [#4](https://github.com/andrewjk/nomen/issues/4)): items.push(parse(x)) constructs the call result directly into the new slot in both backends — List.reserve split out of push, checker-stamped single-use argument, sret-into-slot lowering; no _param_N temp, no slot copy, no temp free.
-  *(minor)*
  Feat: in-place push for constructor arguments — push(Res(...)) constructs directly into the container's fresh slot on both backends; the temp home, the callee-side slot copy and the teardown disappear (shape micro-bench: C -55%, aarch64 -58%)
-  *(minor)*
  Feat: move-on-last-use for structs — a synthesized .copy() whose donor is provably dead rewrites to mv on both backends; the per-field deep copies (strdup per string field, fresh container per List field) and the donor teardown disappear (shape micro-bench, 2M iters: C -20%, aarch64 -29%)
-  *(minor)*
  Map.get_ptr value slot borrow + element-borrow rewrite (ref v = map.get_or_panic(k)); scalar element borrows fixed on both backends
-  *(minor)*
  JsonTree zero-copy ownership paths: take_text takes the builder's buffer (parse store) and get_text_view borrows the text (serialize read); json-serde -22% / -12%
-  *(minor)*
  In-place store for container sets (PERF_PLAN 6): lst.set(i, f(x)) / buf.set / map.set construct the call result straight into the destination slot — Map.set_slot_ptr probe-then-construct primitive, Buffer/ClassBuffer destroy_at displaced reclaim, both backends; no _param_N temp, no deep copy, no temp free
-  *(minor)*
  Enum payload in-place construction (PERF_PLAN 7): Result.ok(f(x)) constructs the payload straight into the payload slot — C Enum_case_init_take claims the produced buffer, aarch64 stores the raw pair or presets sret to the payload address; checker-stamped direct calls only, whole-site for string payloads
-  *(minor)*
  Perf: Regex/String O(n^2) accumulators (PERF_PLAN item 8) - bulk runs in match/replace_all, cursor memcpy array to_string, aarch64 string length-half fixes
-  *(minor)*
  Perf: Map/Set stored hash (PERF_PLAN item 9) - u32 per-slot hash words, hash short-circuit in probes, hash-free rehash, hash-move on backward shift; fixes OOB read in Map/Set copy
-  *(minor)* - Feat: devirtualize trait calls when the conformer is provably known (direct calls on both backends)
-  *(minor)* - Feat: StringBuilder numeric appends + overloads, single-pass int/float to_string and interpolation (PERF_PLAN item 10)
-  *(minor)* - Variable-mode enums: case-qualified types (Enum.case) store a value at its variant's size
-  *(minor)*
  Fix: declaring Map<K, UserStruct> no longer poisons UserStruct(...) ctor calls - the mv-destructure swap synthesizes zero-value constructor arguments, so struct-valued Maps work in-source on both backends
-  *(minor)*
  Fix: pairs-ctor structs with no synthesizable empty value swap in a zeroed slot - Map<K, Struct> declares for TVs whose required params (non-nullable Box/func/array) have no zero literal
-  *(minor)*
  Feat: exact List length facts + inclusive/negated/singleton/alias contract discharge; unguarded at(i) verifies after push/pop; pop narrows stale facts (closes an OOB-admitting hole)
-  *(minor)*
  Element-borrow read positions: for-of loop bindings and expression receiver temps alias the container slot (both backends); fix C slot-load alias emission with hoisted keys
-  *(minor)*
  mv string parameters transfer ownership (D3 argument position): callee owns and frees the pair, a consuming field store takes it raw; set_text takes mv string
-  *(minor)*
  add/alloc siblings: Buffer.store_take moves an owned value into the fresh slot (T_IS_VALUE_STRUCT), eliding the callee deep copy
-  *(minor)* - PERF_PLAN item 15: the aarch64 64-bit arithmetic folds (pooled constants, field forwarding, immediate shifts)
-  *(minor)*
  PERF_PLAN items 10/8: writer-form interpolation — numeric args render into the helper buffer (no per-argument to_string malloc)
-  *(minor)* - Feat: case types over generic enums (Option<int>.some) — mono-of-a-mono materialization + base tags
-  *(minor)* - Feat: case-to-base enum conversions at declaration+assignment sites
-  *(minor)* - checked case cast (r as Res.ok): enum base<->case conversions via as
-  *(minor)* - compound /= %= parse + operator-function dispatch (fixes %= on structs)
-  *(minor)* - integer / and % carry a compile-time divisor contract (zero rejection, guard discharge)
-  *(minor)*
  Tuple concatenation (+), arrays of tuples ([T1, T2][] / Array<[T1, T2]> with non-owning elements), base-spread base-type rejections, nested-raw-array errors, SPEC empty-array example fix
-  *(minor)*
  Nested arrays: int[][] / Array<Array<int>> / inferred [[...]], fixed-size outer of heap rows (scalar inner elements; locals and parameters)
-  *(minor)*
  Owning elements in arrays of tuples: heap-seeded constructor args via .copy(), element teardown ownership, plain-element destructure rejected
-  *(minor)* - Nested arrays: owning rows, 3+ levels, returns and struct fields
-  *(patch)* - Style: reformat Nomen sources across the repo with the current formatter
-  *(patch)* - Fix: audit-rewrite commented allocator calls in raw asm
-  *(patch)* - Fix: nested generics in generic struct bodies monomorphize (mono init params, clone body field retype)
-  *(patch)*
  Fix: close the Buffer_X/BigInt_X core-trust bounds bypass; cap facts record for ClassBuffer receivers; non-nullable references discharge != 0
-  *(patch)* - Fix: T_SIZE substitutes in unsafe-Nomen foreign-call args inside constant-if branches
-  *(patch)* - Fix: interpolate the type name in the box-copy rejection message (an escaped dollar sign emitted the raw template text)
-  *(patch)* - Fix: aarch64 backstops for malformed declare/if nodes; Init-main direct-build regression tests
-  *(patch)*
  Mark the slot-borrow primitives internal (Map.get_ptr, List/Buffer/StableList/ClassBuffer.slot_ptr) - user code reaches them only via the element-borrow rewrite
-  *(patch)*
  Fix: reassignment through ref trait params (boxed-handle slot write-back, displaced reclaim, ref mv-struct destroy deref)
-  *(patch)* - Fix: emit inline trait-conforming methods standalone; splice devirtualized inline calls (PERF_PLAN item 11 tail)
-  *(patch)* - Feat: devirtualize inherited trait default bodies (PERF_PLAN item 11 tail)
-  *(patch)* - Feat: Buffer word-pair slot copies for T_SIZE <= 16 (PERF_PLAN item 14)
-  *(patch)* - Feat: pack struct field layout order (PERF_PLAN item 12)
-  *(patch)* - Fix: List.remove_at_or_panic bulk tail move (Buffer/ClassBuffer move_range)
-  *(patch)* - Fix: StableList tail push stores into the chunk through a Buffer view
-  *(patch)* - Feat: Array.set in-place producer store (item 17c)
-  *(patch)* - Feat: JSON string/number scanners bulk-append runs (item 17d)
-  *(patch)* - Fix: Array<string> literal rows are heap-owned (set and for-ref writeback deep-copy)
-  *(patch)*
  Fix: for ref-of-strings item reassignment transfers the owned pair into the slot (was leaking one allocation per reassigned iteration)
-  *(patch)* - Fix: enum teardown frees struct payloads' heap fields; blob copies deep-copy owning payloads on both backends
-  *(patch)* - Fix: aarch64 leaf emitters terminate their own lines
-  *(patch)* - Fix: test compiles no longer inline stray parent .nm files
-  *(patch)* - Feat: in-place push through self.<field> receivers (PERF_PLAN item 2 remainder)
-  *(patch)* - Feat: complete the in-place push field-path tranche (PERF_PLAN item 2)
-  *(patch)* - Feat: last-use struct moves at transfer sites
-  *(patch)* - Fix: kept-copy struct field-store displaced leak
-  *(patch)* - Fix: synthesized copy seeds ctor args with owned copies
-  *(patch)*
  Feat: move-on-last-use for call args nested in larger expressions; pin Map.set two-argument stores (PERF_PLAN item 3 tail)
-  *(patch)*
  Fix: Map.get slot-borrow classification (carriers/bindings freed aliased strings); aarch64 methods free their mv-struct params' fields
-  *(patch)*
  Fix: aarch64 enum-with-data method-call sret temp undersized (match on call scrutinee SIGSEGV/SIGBUS); VN hoist refuses match-arm-scoped chain terms
-  *(patch)* - Element borrows: invalidate on ref-argument calls and container reassignment
-  *(patch)* - While loop: name the missing update clause when ';' dangles before the body
-  *(patch)* - JsonNode.text seeds null — the per-node seed strdup and its free are gone (PERF_PLAN item 5 remainder)
-  *(patch)*
  Fix: at_or joins the borrow-accessor family (no double free on its string field read); hoisted call args emit before their receiver temp
-  *(patch)* - Fix: Arena<T>.get classified as a slot borrow — value-struct payload test un-skipped
-  *(patch)*
  Fix: stack-balance false positive on a duplicated entry label — entry-candidate labels re-root at delta 0 in the aarch64 balance validator
-  *(patch)* - Fix: int64 constant folding beyond 2^53 — the aarch64 literal-op fold now runs on BigInt and wraps like the machine
-  *(patch)* - Fix: value-struct copy-assignment displaced order (self-assign UAF, displaced-copy leak)
-  *(patch)* - Fix: Map/Set.remove no-shift strand of owning entries
-  *(patch)*
  aarch64: normalize every string-returning function's return paths to heap-owned copies (matches C); fixes rodata freed by tuple/owned-field teardown
-  *(patch)* - Free owning struct/string array literal elements
-  *(patch)* - Keep float literal initializer stores across same-slot reloads
-  *(patch)* - Lower float remainder to fmod on both backends
-  *(patch)* - Fix struct-key operator operands on the C backend
-  *(patch)* - Fix aarch64 struct operator calls with call operands
-  *(patch)* - Accept var mv declarations; fix folded-arm generic decls

## 0.3.0
<sub>2026-10-10</sub>

-  *(minor)* - Breaking: keyword renames — `owning struct/enum` → `mv struct/enum`, keyword `move` → `mv`
-  *(minor)* - Breaking: remove the unused reserved words `in` and `cp`
-  *(minor)* - Breaking: rename the `must_use` modifier to `checked` (`pub checked enum Result<T, E>`)
-  *(minor)* - Breaking: rename the `extern func` FFI modifier to `foreign func` (avoids the `extend` collision)
-  *(minor)*
  Breaking: the `class` keyword retires — `class X { ... }` is now a compile error directing you to `mv struct X` (single-owner, move-only). Share with `ref` aliases and `Box<T>`; guard back-pointers with `WeakHandle<T>`.
-  *(patch)* - Grammar updated to the 0.7.0 language: retired `class` and `in` no longer highlighted; adds `foreign`, `unsafe`, `extend`, `internal` and `readonly`.

## 0.2.6
<sub>2026-09-24</sub>

-  *(patch)* - Fix: triangle bracket matching

## 0.2.5
<sub>2026-09-24</sub>

-  *(patch)* - Fix: async keyword, variables in string interpolation

## 0.2.4
<sub>2026-09-23</sub>

-  *(patch)* - Feat: highlight types and balance angle brackets
-  *(patch)*
  Strip redundant generic constructor annotations (`var keys = Buffer<TK>()`); infer the type instead. Colour generic `<...>` brackets and type parameters in the extension.

## 0.2.3
<sub>2026-09-17</sub>

-  *(patch)* - Add internal visibility modifier; make Buffer internal to the System library
-  *(patch)* - Add readonly fields (read anywhere, assignable only inside the declaring type)
-  *(patch)* - Re-export Buffer with a sound public API; drop the _T suffix from the size-aware primitives
-  *(patch)* - Enforce internal type-name visibility; fix generic struct-field swap codegen

## 0.2.2
<sub>2026-09-14</sub>

-  *(patch)* - Test files follow src module imports transitively; highlight swap keyword

## 0.2.1
<sub>2026-09-10</sub>

-  *(patch)* - Fix namespace imports resolving directories and spaced :: segments

## 0.2.0
<sub>2026-09-10</sub>

-  *(minor)*
  Rename keywords: `mov` → `move` (reads as English like the rest of the keyword set) and `strict` → `must_use` (names the actual rule — values may not be silently discarded — and avoids the one-letter `struct` collision)

## 0.1.0
<sub>2026-09-09</sub>

-  *(minor)* - Replace / namespace separator with :: and add qualified references (Namespace::Name) in code
-  *(patch)*
  Fix: editor loads project-relative imports (subfolder modules) for hover/go-to-definition/diagnostics, refs work on generic type arguments, and import validation only applies to System-rooted paths
