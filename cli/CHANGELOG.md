# Changelog









## 0.6.0
<sub>2026-09-23</sub>

-  *(minor)* - Thread.start/detach and Fiber.start become real library methods with lexical nursery capture (ASYNC_PLAN phase 1)
-  *(minor)* - Spawnable<T> trait; Thread/Fiber conform; mono clones carry substituted trait args (ASYNC_PLAN phase 2)
-  *(minor)* - #spawn construction marker; special form keyed on the member, not the name (ASYNC_PLAN phase 3)
-  *(minor)* - Drop generalized Awaitable construction sugar; #spawn is the only construction hook (ASYNC_PLAN phase 4)
-  *(minor)* - Shrink Sendable to shared class/trait refs; exempt moved and copied values; retire nursery borrows (ASYNC_PLAN phase 5)
-  *(minor)* - Runtime dependency keyed on library body content; declared Task deps replace token scan (ASYNC_PLAN phase 6)
-  *(minor)* - Add Random (splitmix64) to the System library
-  *(minor)* - Add Task.is_done; fix aarch64 Channel.send_string fiber wake
-  *(patch)* - Fix aarch64 large immediate expansion
-  *(patch)* - Fix aarch64 class ctor stack imbalance
-  *(patch)* - Fix aarch64 trait dispatch receiver marshalling
-  *(patch)* - Fix aarch64 class field ctor default
-  *(patch)* - Fix aarch64 value-struct ctor dest in return buffer
-  *(patch)* - Fix aarch64 class-field chain receiver
-  *(patch)* - Fix aarch64 moved-param destroy base
-  *(patch)* - Fix aarch64 adr and literal-pool range
-  *(patch)* - Fix aarch64 null string return strdup
-  *(patch)* - Fix aarch64 if/else branch scope frames
-  *(patch)* - Fix aarch64 to_string force-heap init
-  *(patch)* - Fix aarch64 fold of reassigned string vars
-  *(patch)* - Fix: no space before paren in `panic(`, `move(`, etc
-  *(patch)*
  Strip redundant generic constructor annotations (`var keys = Buffer<TK>()`); infer the type instead. Colour generic `<...>` brackets and type parameters in the extension.
-  *(patch)* - Add demos/async GUI demo app; record async-loop FOLLOWUP notes
-  *(patch)* - Fix owned-return receiver leak (chained Task handles)
-  *(patch)* - Fix aarch64 fn-value spawn rodata result crash
-  *(patch)* - Fix aarch64 zero-arg spawn ctor signature
-  *(patch)* - Return inside async block joins the nursery
-  *(patch)* - Fix aarch64 string accumulation in a loop inside async
-  *(patch)* - Fix aarch64 spawn ctor arg types conflicting across sites
-  *(patch)* - Free unconsumed string task results at future release

## 0.5.0
<sub>2026-09-21</sub>

-  *(minor)*
  Replace the spawn keyword with the Thread class: spawn fn(args) becomes Thread(fn(args)).start(), and the nursery escape hatch name.spawn(fn(args)) becomes name.start(Thread(fn(args))); spawn leaves the reserved-words list (Phase 0 of ASYNC_PLAN.md)
-  *(minor)*
  Add Fiber: stackful coroutine tasks over the worker pool. Fiber(fn(args)).start() yields a Task<T> like Thread, but a waiting fiber parks (freeing its worker) instead of blocking; Fiber.yield/is_fiber, Fiber.start_on(buffer) on a caller-provided stack (C backend), and Fiber.set_cooperative for no-thread single-threaded runs
-  *(minor)*
  Park-aware Channel: an empty receive from a fiber parks on the channel wait list instead of blocking its worker, send wakes parked receivers, and a cancelled waiter returns instead of waiting forever; cancellation now reaches parked fibers (Task.cancel/nursery timeout schedule the owning fiber and restore its task-local cancel flag on resume); fix __nomen_future_timedwait to use a real absolute deadline
-  *(minor)*
  Add the async I/O netpoller (kqueue/epoll) with __nomen_io_wait parking fibers on socket readiness, and a non-blocking Tcp stdlib (listen/accept/connect/send/recv/recv_all/close); concurrent-connection scale validation and the Http port are still pending
-  *(minor)* - Closure descriptor ABI: func values carry { code, env, owned } (Phase 1 of docs/CLOSURE_PLAN.md)
-  *(minor)* - Closure captures phase 2a: lambdas capture outer scalars by copy (heap env + owned descriptor, freed at scope exit)
-  *(minor)* - Closure captures phase 2b: lambdas capture outer strings (deep-copied into the env with a per-lambda destructor)
-  *(minor)* - Closure captures phase 2c: lambdas capture non-owning value structs by copy
-  *(minor)*
  Closure captures phase 2c part 2: lambdas move-capture owning value structs, class instances, and nested capturing closures (donor-local invalidation, env destruction)
-  *(minor)*
  Closure captures follow-ups: move-captured move parameters, class-backed trait references, and move-only capturing values (func-field ownership, value-struct field rejection)
-  *(minor)*
  Make Thread(fn(args)) / Fiber(fn(args)) real storable library classes: eager argument binding, start-later, and must-start enforced by #destroy (destroying an unstarted value aborts with an explanation)
-  *(minor)*
  Accept zero-argument function values in the spawn construction — Thread(() => work(base)) with the lambda's captures as the eager arguments — including through the nursery escape hatch
-  *(minor)*
  Own the spawn env's packed arguments (deep-copied strings, copied-and-destroyed owning structs) so tasks cannot dangle their donors' buffers; allow non-Sendable class arguments inside nurseries as join-bounded borrows (detach still requires owned args); add the Awaitable trait (Task<T> conforms); and make cancellation observable to channel-waiting thread tasks with the nursery join waiting for done after cancel
-  *(minor)*
  The Awaitable construction sugar generalizes beyond Thread/Fiber: any user class conforming to Awaitable with the spawn-field contract (uint64 task/result_slot/cancel_flag/future, optional started) takes the same eagerly-packed construction, launches through the new Task.pool_submit / Task.future_* library seam, dispatches through the Awaitable vtable, and monomorphizes as C<T>; a contract-missing class gets a dedicated compile error
-  *(minor)*
  Anonymous functions gain the keyword form inline (func (out int) { ... }, func (x) => x * 2) and the block-without-arrow form parses inline too; passing a func-typed binding as a call argument no longer false-mismatches ('int (expected func)') or resolves to the static descriptor over the local's heap closure
-  *(minor)* - Add #init field-completeness checker diagnostic
-  *(minor)* - Remove block-body lambda forms: '=>' now takes a single expression only; block bodies require the func keyword
-  *(minor)* - Missing return now fires for signature-merged lambdas (declaration annotation, func-typed arg, func-typed field)
-  *(minor)* - Add nested func types and closure factories
-  *(minor)* - Add Func<> function types
-  *(patch)*
  Fix the nursery futures list overflowing at 64 concurrent spawns (fixed stack array -> heap list on the C backend, pointer slot on aarch64); un-skips and passes the concurrent Tcp echo test at 256 connections on both backends
-  *(patch)* - Fix: Channel #destroy frees only owned-string payloads
-  *(patch)* - Fix: aarch64 frame offsets past the imm12 limit
-  *(patch)* - Fix: Mutex.lock parks in the threaded model
-  *(patch)* - Fix: one shared concurrency runtime per process in C system_lib builds
-  *(patch)* - Fix: aarch64 system companion carries library aarch64_use_c bodies
-  *(patch)* - Fix: finish async Phase 3 — Http over Tcp, growable nursery lists, module-level statements
-  *(patch)* - Fix: scope aarch64 status.moved per struct method body
-  *(patch)* - Runtime deadlock detector: abort with a wait-graph dump instead of hanging silently
-  *(patch)* - Thread(fn(args)).detach(): daemon tasks on a dedicated detached pthread that never block nursery join or process exit
-  *(patch)* - Fix aarch64 closure captures read through address-taking paths (method receivers)
-  *(patch)*
  Lower the spawn runtime onto the closure descriptor ABI (the pool, fiber scheduler, and daemon launcher take a single task closure) and fix the daemon form's double-free of its args struct
-  *(patch)*
  C backend: string methods on view string receivers alias the view into the callee's pair (test/view_string_methods.test.ts)
-  *(patch)*
  C backend: switch case-condition statement hoister no longer shreds statement expressions (splits at top-level semicolons only)
-  *(patch)* - Custom #init first field write no longer destroys uninitialized garbage (C + aarch64)
-  *(patch)* - Re-assigning a borrowed class alias from another borrow keeps it non-owning (C backend)
-  *(patch)*
  While-loop condition temporaries re-evaluate every iteration (C + aarch64); hoisted call args no longer freeze the condition
-  *(patch)* - field = move local into a value-struct field transfers ownership (splices the source) instead of dangling it
-  *(patch)* - C trait dispatch: ref args rooted at class locals now pass &slot (address-of was dropped)
-  *(patch)* - nomen format: hyphenated import names survive formatting (intra-name hyphens bind tight)
-  *(patch)*
  nomen test: *.test.nm entries no longer inline their folder's sibling test files (quadratic build weight OOMed the suite)
-  *(patch)*
  fix quadratic string volume in the C emitter (scratch-buffer speculative emission + node-driven statement tails); 4MB-code builds no longer OOM
-  *(patch)*
  aarch64 emitter: chunked code buffer + per-function bodies kill the quadratic string-volume cost (endsWith peeks, whole-file peephole scans, peephole spread overflow)
-  *(patch)* - Fix: aarch64 trait dispatch ref class-local arg marshal
-  *(patch)* - Fix: dispose inline capturing lambda descriptors at direct call sites
-  *(patch)* - Fix: dispose inline capturing lambda descriptors at method and trait-dispatch call sites
-  *(patch)* - Fix: aarch64 closure direct-call inlining
-  *(patch)* - Fix: check func value signatures at use sites
-  *(patch)* - Fix: nested function absorbs enclosing hoisted temporaries

## 0.4.0
<sub>2026-09-17</sub>

-  *(minor)*
  Constructor overloading: multiple #init functions with differing parameter types; constructor calls resolve the overload by argument count and types on both backends
-  *(minor)* - replace BigInt.new with an int #init overload
-  *(minor)*
  Buffer/ClassBuffer modify_T: sound in-place slot mutation (the load-modify-store dance) on both backends; generic func (T, out T) params monomorphize correctly; C func-pointer signatures use tag forms; aarch64 func-param calls pass fat-string pairs
-  *(patch)*
  move-param leak fix: a method call on a moved class param no longer disables the callee's epilogue reclaim unless the method can retain its receiver
-  *(patch)*
  fix monomorphization of generic-enum returns from generic-struct methods (signature, locals, deferred case constructions)
-  *(patch)*
  base-seeded literals: scalar override values are evaluated into temporaries before the base copy/init, so an override reading the destination sees the pre-assignment value
-  *(patch)* - fix aarch64 variadic-pairs Map constructor (value-struct TV tuple packing passed the first word instead of the address)
-  *(patch)*
  fix generic enums with class/trait payloads: mono case payload rides as a struct Tag pointer on C, payload ownership enforced at check time, payload destroy+free at scope exit on both backends
-  *(patch)* - Fix: residual string hazards
-  *(patch)* - Fix: bitset immediates, self rewrite, array scoping
-  *(patch)* - Fix: modify_T-corpus aarch64 ownership bugs (store_T move, mono string fields, ctor clobber)
-  *(patch)* - Fix: match-expression result lowering (aarch64 fat-pair join, C reassign switch)
-  *(patch)* - Fix: field-override destination reads, move-reassign ownership
-  *(patch)*
  Fix enum-with-string-payload ownership in value structs (field stores, destroy walk, sret field-read returns) on both backends
-  *(patch)* - Fix aarch64 inline splices: isolate body locals so nested generic splices (List.at, JsonTree) compile correctly
-  *(patch)* - Scope-label same-named nested types so the build's flat type table can't be poisoned (struct/class/enum/bitset)
-  *(patch)* - Enums with string payloads as container elements: owning Buffer/List deep-copy on both backends
-  *(patch)* - Add internal visibility modifier; make Buffer internal to the System library
-  *(patch)* - Add readonly fields (read anywhere, assignable only inside the declaring type)
-  *(patch)* - Re-export Buffer with a sound public API; drop the _T suffix from the size-aware primitives
-  *(patch)* - Enforce internal type-name visibility; fix generic struct-field swap codegen
-  *(patch)* - Remove dead Buffer address pipeline (ASM_PLAN_3 tranche K) and its BuildStatus fields
-  *(patch)*
  Fix folded store addressing on aarch64: the region-bracket base-fold's bare-induction register was dropped when the tranche-K hoist block was removed, so store_int through a folded base indexed with a stale staging register (edigits segfault, pidigits wrong digits)

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
