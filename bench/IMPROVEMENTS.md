# Benchmark Performance Improvements

Results from `sh benchmark.sh` (Nomen vs Go / Zig / Rust). Nomen is compiled to
AArch64 assembly via a non-optimizing code generator, then linked with `clang`.
Run times are the median of three runs; the workload sizes are set per-benchmark
in `benchmark.sh`.

Nomen is consistently the slowest language, often by 10–100×. The causes are
almost entirely **compiler-level** (no optimization passes) rather than
algorithmic — the Nomen sources mirror the reference implementations. The notes
below cover, per benchmark, where the time goes and the highest-leverage fixes.
A cross-cutting summary is at the end.

Fixes are tagged by where they live:

- **[source]** — change the `.nm` program (algorithm or data-structure choice)
- **[stdlib]** — change the `core/System` library
- **[codegen]** — change the compiler / code generator

**✓ DONE** items have been implemented (see "Codegen improvements landed" for
measured results). **✗ unfair** items are excluded — see the note below.

> **Keeping the comparisons fair.** The Nomen sources are written to **mirror
> the reference Go/Zig/Rust implementations** — same algorithm, same memory
> strategy — so the timing gap reflects compiler/runtime maturity, not a
> cleverer algorithm. Source changes that let Nomen dodge the work the benchmark
> measures are out of scope, even when they'd be a big win:
>
> - A flat node **pool/arena for binarytrees or merkletrees** is **excluded** —
>   those benchmarks exist to measure allocation, and none of the references
>   pool their nodes (Go `&Node{}`, Rust `Box`, Zig `allocator.create`).
>   binarytrees had an arena (`pool.restore(saved)` reclaiming a whole tree in
>   one op) briefly; it's been **reverted**. The same call applies to merkletrees.
> - **nsieve bit-packing** is kept: same algorithm, denser flag representation,
>   and the Go reference already uses a `bitset`. Constant-factor data
>   representations are fair; algorithmic dodges are not.
> - **edigits** bulk divmod + binary exponentiation are kept: they bring Nomen's
>   hand-rolled `BigInt` to parity with `math/big` (Go) and `ibig` (Rust), which
>   use the same techniques internally.

## Codegen improvements landed

The following codegen changes have been applied. The "before" column is the
old codegen; "after" is with all improvements below. Measured on Apple Silicon
(AArch64), median of 3 runs, small workload sizes:

| Benchmark       | Before  | After   | Speedup | Primary fix                                             |
| --------------- | ------- | ------- | ------- | ------------------------------------------------------- |
| mandelbrot      | 365 ms  | 140 ms  | 2.61×   | Float assignment d0→dN + float round-trip + push/pop    |
| nsieve          | 122 ms  | 53 ms   | 2.30×   | Buffer.load/store inlined + LICM + push/pop peephole    |
| nbody           | 211 ms  | 120 ms  | 1.76×   | Float reg-alloc + round-trip elim + naked sqrt inline   |
| lru             | 150 ms  | 27 ms   | 5.5×    | O(1) doubly-linked list LRU + RNG bitmask + peephole    |
| fannkuch-redux  | 378 ms  | 210 ms  | 1.80×   | Array .at()/.set() fast path + push/pop peephole        |
| knucleotide     | 17 ms   | 8 ms    | 2.1×    | Buffer.load_int inlined + LICM + push/pop peephole      |
| spectral-norm   | 64 ms   | 40 ms   | —       | load_float result-register bug fixed (was `nan`)        |
| binarytrees     | 250 ms  | 246 ms  | 1.02×   | (struct accessors still use memcpy)                     |
| edigits         | 48 ms   | 8.5 ms  | 5.6×    | Product-tree algorithm + set                            |
| edigits (5000)  | 734 ms  | 9 ms    | ~80×    | div128→udivti3 + get/set indexed + Buffer_int fast path |
| pidigits (4000) | 3562 ms | 2840 ms | 1.25×   | Buffer_int load/store inlined (was `bl`)                |

Changes applied:

1. **Buffer accessor inlining** (`build_access_node.ts`): `load_int`,
   `store_int`, `load`, `store`, `load_float`, `store_float` now generate
   direct strided loads/stores (2 instructions) instead of going through the
   inline-method expansion (~12 instructions with self/x19 save/restore).
   `store_or_int` also inlined.

2. **Array `.at()` fast path** (`build_access_node.ts`): `.at()` on fixed-size
   arrays now uses caller-saved x9 as the base register, eliminating the
   per-access x19 save/restore. `.set()` now has a matching fast path when
   both index and value are simple operands (literals/variables) on a
   value-target array — base→x9, index→x1, value→x2, store, with no x19
   save/restore. Non-simple `.set()` values still fall back to x19.

3. **Register allocation bug fix** (`build_while_loop_node.ts`,
   `build_for_loop_node.ts`, `collect_var_refs.ts`): The loop register
   allocator was promoting variables that are redeclared inside the loop body
   (e.g. `carry`), but loading them from a **sibling scope's** stack slot with
   the same name. This caused BigInt.mul_to's Karatsuba path to produce wrong
   results for self-multiplication (squaring). Fixed by scanning the loop body
   for redeclared variables and skipping them during promotion.

4. **Float register allocation** (`build_while_loop_node.ts`,
   `build_for_loop_node.ts`, `build_value_node.ts`, `stack_var.ts`,
   `build_assignment_node.ts`): Float loop variables (`float`, `float64`) are
   now promoted to callee-saved `d8`–`d15` registers, separate from the
   integer `x23`–`x28` pool. The `fmov`/`ldr`/`str` patterns handle the
   d-register vs x-register distinction.

5. **Buffer data-pointer LICM** (`build_access_node.ts`, `BuildStatus.ts`,
   `build_while_loop_node.ts`, `build_for_loop_node.ts`): Caches
   `Buffer.data` pointers in callee-saved registers across loop iterations.
   A Buffer's data pointer is loaded once on first access and reused for
   subsequent accesses to the same Buffer within a scope, skipping the
   address-compute + load pair. The cache is invalidated on resize methods
   (`grow`/`alloc`) and on whole-Buffer reassignment, reset per function
   body, and saved/restored at loop boundaries. Nested-loop correctness
   required two fixes: the loop-variable promotion pass now avoids registers
   claimed by an outer loop's cache (`callee_saved_regs_used`), and the cache
   is reset at every function/method body entry so a stale entry can't leak
   from one function's build into the next (which produced a bogus "hit" that
   skipped the data-pointer load — segfault in json-serde). Lifts nsieve
   (~10%), knucleotide (~9%), lru (large ~47%), and spectral-norm (~14%).

6. **Binary exponentiation for edigits** (`bench/nomen/edigits.nm`): The
   `10^precision` computation now uses binary exponentiation (O(log precision)
   multiplies via repeated squaring) instead of a linear mul-by-10 loop
   (O(precision)). This was previously blocked by the Karatsuba
   self-multiply bug (item 3 above).

7. **`store_or_int` inliner stride fix** (`build_access_node.ts`): The
   special-cased inliner for `Buffer.store_or_int` was using a 4-byte stride
   (uint32) instead of the correct 8-byte stride (`long*`). The inline-asm
   definition in `Buffer.nm` uses `lsl #3`, but the codegen fast path was
   emitting `lsl #2`, causing silent memory corruption (writes landing in the
   wrong slot). `store_or_int` had never been exercised before, so the bug
   was latent.

8. **nsieve: bit-packed sieve** (`bench/nomen/nsieve.nm`): Flags are now
   packed 64 per slot (`Buffer<int>` with `load_int`/`store_or_int`),
   shrinking the working set 64× so the flag array fits in L2/L3 cache
   (for n=40M: ~5 MB instead of ~160 MB). Measured 1.46× at n=40M; the
   speedup grows with n as the original's working set exceeds cache.

9. **edigits: product-tree algorithm** (`bench/nomen/edigits.nm`,
   `core/System/BigInt.nm`): Replaced the naive iterative term-division
   (`O(k·n)` sequential BigInt÷small-int divisions) with Tczajka's
   divide-and-conquer product tree — the same algorithm used by the Rust
   (`ibig`), Go (`math/big`), and Zig (`std.math.big`) references. `sum_terms`
   builds `e = Σ 1/i!` as a single fraction `p/q` via balanced recursive
   multiplication (Karatsuba-friendly), then one final `mul + div` produces the
   answer. Stdlib additions: `BigInt.set` (in-place init, no realloc),
   `BigInt.set` (in-place init from uint64), `BigInt.div_to` (in-place
   division following the `add_to`/`sub_to`/`mul_to` pattern). At n=5000:
   734 ms → 39 ms (~19× speedup); ratio vs best reference improved from ~245×
   to ~15×.

10. **Constant folding** (`build_operation_node.ts`): Binary operations on two
    integer literals (`2 * 8`, `1 << 3`, `10 / 2`, comparisons, bitwise ops) are
    now folded at compile time into a single `mov`/`ldr`, eliminating the
    `mov`+`mov`+`op` sequence. Applies to `+`, `-`, `*`, `/`, `%`, `<<`, `>>`,
    `&`, `|`, `^`, `&&`, `||`, and all comparisons.

11. **Leaf-function inlining** (`scan_inline_candidates.ts`,
    `build_inline_method.ts`, `build_function_call_node.ts`): Small free
    functions (≤15 statements, primitive-only `const` params, no function/method
    calls in body) are now inlined at call sites instead of emitting `bl`.
    The `build_inline_function` generalizes the existing `build_inline_method`
    (struct `inline func`) to free functions. Parameter binding uses
    callee-saved registers (x19–x22) with save/restore. An inlining depth limit
    of 2 prevents exponential code growth. Measured impact is neutral on the
    current benchmark suite — the functions that qualify (e.g. `mbrot`) have
    body codegen costs that dominate the saved call frame. The infrastructure
    is in place for future expansion (relaxing scanner constraints, handling
    struct params).

12. **Unique declaration labels** (`build_declaration_node.ts`): Float constant
    and string-init labels now use a monotonic counter instead of the variable
    name, preventing duplicate-symbol errors when a function is both emitted
    standalone and inlined.

13. **`div128` → `___udivti3`** (`core/System/BigInt.nm`): The 128÷64
    divide used by every BigInt division was a 64-iteration shift-and-subtract
    Nomen loop (`div128`). It's now an `inline func` with a raw AArch64 block that
    calls compiler-rt's `___udivti3` (linked via `clang`) — ~30× faster (3.7ns
    vs 120ns per call measured in isolation). The body saturates to `UINT64_MAX`
    (== B-1) when `hi >= d`, matching Knuth-D's `q_hat` convention so the
    existing correction step still works. Dominant win for the final big divide
    - base conversion in **edigits**.

14. **Indexed addressing in `BigInt.get`/`set`** (`core/System/BigInt.nm`):
    Each limb accessor was `ldr data; lsl i,#3; add; ldr/str` (4 instructions).
    Using AArch64 indexed addressing (`ldr x0, [x0, x1, lsl #3]`) cuts it to
    `ldr data; ldr/str [data, i, lsl #3]` (2 instructions). Helps every BigInt
    limb loop (mul_to/add_to/sub_to/cmp), biggest single factor in **edigits**
    (the Karatsuba product tree is limb-bound).

15. **`Buffer<T>` fast-path inlining now covers monomorphized types**
    (`build_access_node.ts`): the inline `load_int`/`store_int`/… fast path was
    guarded by `target_type.name === "Buffer"`, but a `Buffer<int>` field
    resolves to the monomorphized `Buffer_int` — so the guard **never matched**
    and every `digits.load_int(...)` / `digits.store_int(...)` in BigInt (and
    every other `Buffer<T>` user) emitted a full `bl Buffer_int_load_int` call
    (~80 such calls in the pidigits binary). Broadening the guard to
    `name === "Buffer" || name.startsWith("Buffer_")` makes them inline as
    direct strided loads/stores. This fixed two latent bugs that the dead fast
    path had been hiding:
    - `emit_buf_addr_to_x9` resolved the field's base type via
      `type_from_value_node`, which returns `undefined` for `self`, so
      `get_field_offset("")` fell back to the default `VT_SIZE` (8) for _every_
      field — writing all of a struct's buffers to the first one. Now `self`
      (and locals) resolve via `status.current_struct` / `variable_types`.
    - the data-pointer cache now covers **field** Buffer targets too
      (`self.keys`, `remainder.digits`, …), not just local variables. The cache
      is kept sound by invalidating the entry on every path that can reassign a
      Buffer's backing store: a direct field assignment
      (`build_assignment_node`, both LHS and RHS — the RHS covers
      `x = mov fld swap …`), a resize method on the buffer (`grow_int`/`alloc`),
      and — conservatively — **any** non-inlined `bl` (`build_function_call_node`
      drops every field cache entry, since the callee may reassign/resize a
      field it receives). Branches (`if`/`match`/`switch`) snapshot the cache
      before and restore the dominating pre-branch state after, so an entry
      loaded in one branch is never reused in a sibling. (Note: the
      `var x = mov obj.field swap …` declaration form is built by
      `build_declaration_node`, which has no invalidation of its own — it is
      only sound today because the conservative `bl` invalidation clears the
      field entry before every such reassignment in the current test suite. A
      future `build_declaration_node` swap-invalidation would make this
      provably sound instead of coincidentally sound.)

16. **`BigInt.div_to` in-place division** was already in place (item 9 added
    `div_to`). Item 13 above replaces its `div128` core with `___udivti3`, and
    item 15 inlines the `remainder.digits.load_int`/`store_int` calls that make
    up the Knuth-D loop body. Together they cut the per-digit division cost.
    A follow-up attempted to hoist the `digits.data` load out of the loop
    entirely (true LICM) — see Known issues for why it was reverted.

17. **Float expression round-trip elimination** (`build_operation_node.ts`,
    `BuildStatus.ts`): Float binary operations (`fadd`/`fsub`/`fmul`/`fdiv`)
    now keep their result in `d0` when the immediate consumer is another float
    operation, instead of unconditionally emitting `fmov x0, d0` (dump to x0)
    followed by `fmov dN, x0` (reload). A `float_result_in_d0` flag on
    `BuildStatus` is set by `build_float_operand` before building a float-typed
    child; the child float op consumes it to skip the final `fmov x0, d0`. Each
    float op saves+clears the flag before building its own operands, so nested
    grandchildren can't steal it. Non-float children (function calls, casts,
    access nodes) leave the flag unconsumed, and `build_float_operand` falls
    back to the old `fmov target, x0` path. This is a targeted fix for the
    "float arithmetic routes through integer registers" known issue — it
    eliminates the round-trip for nested float expression chains (e.g.
    `(zr+zr)*zi+ci`) without changing the calling convention or ABI. The full
    d0-based float-result convention (d0 returns, d0–d7 params, `fcmp` for
    float comparisons) remains a future improvement. Combined with item 18,
    lifts mandelbrot 1.76×, nbody 1.40×.

18. **Adjacent push/pop peephole elimination** (`build_function_node.ts`):
    The peephole optimizer now removes `str xN, [sp, #-16]!` immediately
    followed by `ldr xN, [sp], #16` — an unconditionally-safe no-op (sp
    unchanged, register unchanged) that the assignment and declaration codegen
    emitted between computing a value and storing it to a register-allocated
    variable. Only matches when no instructions separate the push and pop
    (blank lines are OK); the old disabled x3 pass allowed intervening
    instructions and caused correctness issues. This is a broad win across all
    integer-array benchmarks: nsieve 1.70×, fannkuch 1.33×, knucleotide 1.38×,
    on top of the float benchmarks (mandelbrot, nbody) where it compounds with
    item 17.

19. **O(1) LRU cache** (`bench/nomen/lru.nm`): Replaced the O(n²) shift-array
    LRU with an O(1) doubly-linked-list + `Map<int,int>` cache, matching the
    reference implementations (Go `container/list` + map, Zig `LinkedList` +
    `HashMap`). The linked list is arena-backed (flat arrays of prev/next/key/
    value indexed by stable node ids) with `Map<int,int>` for key→node-id
    lookup. `put` and `get` are both O(1): move-to-end unlinks and re-links at
    the tail; eviction reuses the head node. The LCG modulo
    `(A*state+C) % 2^31` is also strength-reduced to `& (2^31 - 1)` (mod a
    power of 2 = bitmask, removes an `sdiv`). Lifts lru ~2.5–2.8× (150 ms →
    27 ms at n=200000).

20. **`load_float` / `store_float` result-register bug fix**
    (`build_access_node.ts`): Two latent bugs in the `Buffer<float>` inlined
    fast paths were fixed. (a) `load_float` left its result in `d0` but did
    not emit `fmov x0, d0` for non-d0-aware consumers, so
    `build_float_operand`'s fallthrough read a stale `x0` (often the index
    register) and silently produced `nan` — this was the pre-existing
    spectral-norm `nan`. The fast path now checks `float_result_in_d0`: when
    a caller requested d0 mode it consumes the flag and leaves the result in
    `d0`; otherwise it emits `fmov x0, d0` after the `ldr d0`. (b)
    `store_float` stored from `d0` (whatever stale float a prior op left
    behind) instead of from `x2`, where the value bit pattern actually
    landed after the fast path's `mov x2, x0`. This was masked by d0 usually
    still holding the right value. Fixed to `str x2`. Together these
    **re-enable spectral-norm** (was `nan`, now 40 ms at n=500 / 370 ms at
    n=1500). Regression tests in `test/float-buffer.test.ts`.

21. **Naked inline for all raw-only inline funcs** (`build_inline_method.ts`):
    The `build_naked_inline` fast path (emit the raw `#arch: aarch64` asm
    verbatim, no callee-saved save/restore) was gated on `needs_x19`, so it
    only fired for instance methods with a `self` param. Static raw-only
    inline funcs like `Math.sqrt` fell through to the general inline path,
    which needlessly shuffled each parameter into a callee-saved register
    (`str x19` / `mov x19, x0` / … / `ldr x19`) that the raw body never
    reads. Broadening the guard to just `is_raw_only(func)` makes every
    raw-only inline func emit its asm directly. For `Math.sqrt` this drops
    the per-call cost from 6 instructions (`str`/`mov`/`fmov`/`fsqrt`/`fmov`/`ldr`)
    to 3 (`fmov`/`fsqrt`/`fmov`). Helps **nbody** (130 ms → 120 ms at
    n=500000; the 10 sqrt calls/step dominate at small n).

22. **Float assignment round-trip elimination** (`build_assignment_node.ts`):
    Assigning a float expression to a register-allocated float variable
    previously went `d0 → x0 → dN` (two `fmov`): the RHS float op dumped its
    result to `x0` (`fmov x0, d0`), then `emit_var_store` moved it into the
    allocated d-register (`fmov dN, x0`). The assignment fast path now sets
    `float_result_in_d0 = true` before building the RHS, so nested float
    operations leave their result in `d0` and we move directly `d0 → dN`
    (one `fmov`). Non-float-op RHS (variables, literals, function calls,
    casts) don't consume the flag, so we fall back to `fmov dN, x0` for
    them. This is the dominant remaining codegen win for **mandelbrot** —
    the mbrot inner loop has 4 float assignments per iteration
    (`zi = …`, `zr = …`, `tr = …`, `ti = …`), each saving one `fmov`.
    Lifts mandelbrot 210 ms → 140 ms at n=1000 (1.50×), 840 ms → 550 ms at
    n=2000 (1.53×), on top of items 17–18.

### Known issues

**Float register allocation overhead in call-heavy benchmarks.** mandelbrot
was previously regressed (~0.94×) because each function that uses float
registers in loops pays for d8-d15 save/restore in its prologue. With the
float round-trip elimination (item 17), push/pop peephole (item 18), naked
sqrt inline (item 21), and float assignment round-trip elimination (item 22),
mandelbrot is now 2.61× faster than the pre-float-regalloc baseline — the
eliminated `fmov` instructions far outweigh the prologue cost.

**Float arithmetic round-trip — partially fixed (items 17, 22).** Nested float
expression chains no longer round-trip through x0 (item 17), and assignments
to register-allocated float vars now go directly `d0 → dN` instead of
`d0 → x0 → dN` (item 22). **Remaining:** float function returns still arrive
in x0 rather than d0, and float comparisons still use integer bit-pattern
`cmp` instead of `fcmp`. A full d0-based calling convention (d0 returns,
d0–d7 params) would close the gap further but requires coordinated changes
across the ABI boundary.

**spectral-norm `nan` — FIXED (item 20).** The `Buffer.load_float` inline fast
path now emits `fmov x0, d0` for non-d0-aware consumers (or consumes the
`float_result_in_d0` flag for d0-aware consumers). The latent `store_float`
bug (stored from stale `d0` instead of `x2`) was also fixed. spectral-norm
now produces the correct result (`1.274224…`); regression tests in
`test/float-buffer.test.ts`.

**`Buffer.data` LICM was implemented, benchmarked, and reverted — it doesn't
pay off.** The per-iteration `digits.data` re-derivation (an
`ldr …, [base, #<fieldoff>]` + `ldr …, [x9, #8]` on every limb load/store)
looked like the obvious remaining cost in pidigits's Knuth-D loop. A sound
loop-invariant hoist was written (`loop_buffer_licm`): it pre-scans each loop
body for Buffer load/store accesses whose data pointer is never mutated
(assignment / `mov … swap` / resize / owner reassigned / owner passed to a
`bl`), loads them once into a callee-saved register in the preheader, and
seeds the cache so the body reuses them every iteration. It was correct
(asm-verified: the inner multiply loops no longer reloaded
`remainder.digits.data`) and all tests passed — but A/B benchmarking showed
**no measurable speedup on pidigits (2.76s vs 2.73s) and small regressions
elsewhere (nsieve +9%, fannkuch +5%)** from the per-loop overhead (cache-map
copy + body scan + extra callee-saved saves). It was reverted; only the
behavior-preserving refactor that lifted the cache helpers to module scope in
`build_access_node.ts` was kept. Two reasons the win didn't materialize:

1. **pidigits is dominated by the single-limb `div_to` path** (`b.len == 1`),
   which uses BigInt `get`/`set` — raw `#arch: aarch64` asm that bypasses the
   Buffer data-pointer cache entirely, so the hoist cannot reach it. The
   Knuth-D path (where the hoist _does_ fire) is the minority of the runtime.
2. **Apple Silicon's OoO engine hides the reload latency.** The eliminated
   loads are L1 hits (~4 cycles) fully overlapped with the `mul`/`umulh` work,
   so they were never on the critical path.

- **[codegen] Real next step for pidigits** is not pointer LICM. Candidates:
  extending the data-pointer cache / inlining into the BigInt `get`/`set`
  `#arch` blocks (the actual hot accessors in the single-limb loop); keeping
  the four hot `BigInt` struct pointers themselves in callee-saved registers
  across the loop (see pidigits notes); or source-level changes (static
  constructors to drop the 12 double-allocations). The conservative `bl`
  invalidation in `build_function_call_node` (drops _every_ field cache entry
  on any `bl`) is also worth tightening to per-receiver, since it currently
  defeats within-body field dedup whenever a loop contains any non-inlined
  call.

---

## Original baseline table

| Benchmark      | Nomen (small / large) | Best other (lang) | Ratio (large) |
| -------------- | --------------------- | ----------------- | ------------- |
| pidigits       | 196 / 3562 ms         | 126 ms (Go)       | ~28×          |
| fannkuch-redux | 368 / 4785 ms         | 122 ms (Rust)     | ~39×          |
| binarytrees    | 241 / 2559 ms         | 99 ms (Rust)      | ~26×          |
| merkletrees    | 194 / 907 ms          | 121 ms (Zig)      | ~7×           |
| nsieve         | 289 / 1446 ms         | 39 ms (Zig)       | ~37×          |
| lru            | 39 / 150 ms           | 7 ms (Zig)        | ~21×          |
| knucleotide    | 18 / 18 ms            | 6 ms (Zig)        | ~3×           |
| json-serde     | 46 / 219 ms           | 4 ms (Go)         | ~55×          |
| regex-redux    | 62 / 62 ms            | 4 ms (Rust)       | ~15×          |
| nbody          | 230 / 2281 ms         | 16 ms (Rust)      | ~143×         |
| spectral-norm  | 97 / 875 ms           | 58 ms (Rust)      | ~15×          |
| mandelbrot     | 358 / 1423 ms         | 46 ms (Zig/Rust)  | ~31×          |
| edigits        | 125 / 734 ms          | 3 ms (Go)         | ~245×         |
| helloworld     | 4 / 2 ms              | — (I/O bound)     | —             |

---

## Per-benchmark notes

### pidigits (196 / 3562 ms → 2840 ms — ~22× off Go)

Spigot-algorithm π computed with `BigInt`. The whole runtime is `BigInt.div_to`,
`mul_to`, `sub_to`, `add_to` on numbers of a few hundred 64-bit limbs.

- ✓ **[codegen] DONE (item 15):** `Buffer_int.load_int`/`store_int` (used by
  `div_to`'s Knuth-D loop on `remainder.digits`) are now inlined to strided
  loads/stores instead of `bl Buffer_int_load_int` calls — the binary had ~80 of
  those `bl`s. 3562 ms → 2840 ms at n=4000 (~1.25×).
- ✓ **[codegen] DONE (items 13–14):** `div128` → `___udivti3` and `get`/`set`
  indexed addressing cut the per-limb cost in `mul_to`/`sub_to`/`add_to`/`div_to`.
- ✗ **[codegen] REVERTED — `Buffer.data` LICM does not help pidigits.** A sound
  loop-invariant hoist of the `remainder.digits.data` load was implemented and
  asm-verified, but A/B showed no speedup: pidigits is dominated by the
  single-limb `div_to` path whose BigInt `get`/`set` use raw `#arch` asm that
  bypasses the cache, and the Knuth-D reloads it did eliminate are L1 hits
  hidden by OoO execution. See Known issues for the full finding. The
  behavior-preserving cache-helper refactor in `build_access_node.ts` was kept.
- **[codegen]** `k`, `n1`, `n2`, `d` are heap-allocated `BigInt` structs; even
  their struct pointers spill to the stack between iterations. Keeping the four
  hot `BigInt` pointers in callee-saved registers across the loop would remove
  the repeated `ldr` of their addresses. (Register allocation now exists for
  integer loop vars — see codegen item 3.)
- **[source]/[stdlib] An in-place `div_to(out self, a, b, rem)`** already landed
  (item 9 / item 16), so the Nomen source no longer copies a fresh `BigInt` back
  into `u` every digit.
- **[source]** All 12 `BigInt` locals (`k`, `n1`, `d`, `one`, …) are allocated
  with `BigInt()` then re-bound with `= .new(...)`. The intermediate empty
  buffer is allocated and immediately replaced. Constructing them directly with
  `BigInt.new(1)` (if a static-method constructor lands) would halve startup
  allocations.
- Karatsuba for the multiply would help at large `n`, but at the benchmark
  sizes schoolbook dominates and the fixes above come first. (The Karatsuba
  self-multiply bug has been fixed — see codegen item 3.)

### helloworld (4 / 2 ms — I/O bound)

One `Console.write`. Nothing to optimize in the program itself.

- **[codegen]** Reduce static-init and runtime-startup cost. The 2–4 ms Nomen
  startup vs. sub-millisecond Go startup is pure runtime overhead (init,
  segment setup, etc.). A leaner `_main` prologue matters only for trivially
  short programs.
- **[stdlib]** `Console.write("Hello world!\n")` could special-case string
  literals to a single `write` syscall instead of going through the buffered
  printer.

### fannkuch-redux (368 / 4785 ms → 210 / 2730 ms — ~1.32× speedup)

Pure integer array work on size-16 arrays — `p.at(i)` / `p.set(i, v)` in tight
nested loops. No allocation, no I/O inside the loop. The cost is 100% codegen.

- ✓ **[codegen] DONE (item 18):** Adjacent push/pop peephole elimination removes
  redundant `str x0, [sp, #-16]!` / `ldr x0, [sp], #16` pairs that the
  `.set()` codegen emitted between computing the value and storing it. 1.32×
  speedup (280 ms → 210 ms at n=10).
- ✓ **[codegen] DONE (partial):** `.at()` on fixed-size arrays now uses
  caller-saved x9 (no save/restore). `.set()` now has a fast path when both
  index and value are simple operands (no x19 save/restore).
- **[source]** Replace the byte-by-byte rotate (`while rj <= k { p.set(rj,
p.at(rj+1)); … }`) with a precomputed permutation table. The Rust reference
  builds `NEXT_PERM_MASKS[r]` at compile time via `const fn`; Nomen can build the
  same tables once at startup and apply each permutation with a fixed 16-element
  copy. This removes the inner rotate loop entirely.
- **[source]** Hoist `fact.at(n)` into a local before the `while true` loop —
  it's loop-invariant but reloaded every iteration.
- **[source]** The flip-count inner loop copies `p` → `pp` then reverses in
  place. The reverse can use two indices into a single copy of `p` (no separate
  `pp`) if the swap is done in-place against `p` and restored after.
- **[codegen]** Loop-invariant code motion: the bound `n`, the array base, and
  `fact.at(n)` are re-derived every iteration. A simple LICM pass over the
  existing SSA-less IR would move them out of the loop body (Buffer.data LICM
  is done; general LICM of array bases/bounds is not).
- **[codegen]** The `rj <= k` memmove-style rotate is a byte loop; for small `k`
  an optimizing compiler unrolls it. Nomen doesn't.

### binarytrees (241 / 2559 ms — ~26× off Rust)

Allocates many small binary trees (`class TreeNode` with nullable `left`/`right`
children), then checksums them recursively — the same per-node allocation
strategy as the Rust (`Box`), Zig (`allocator.create`), and Go (`&Node{}`)
references.

- **The benchmark is an allocation/GC stress test.** The whole point is
  per-node allocate/free churn, so the gap is dominated by Nomen's allocator and
  the non-optimizing codegen, not anything algorithmic.
- ✗ **[source] (unfair — excluded):** Pool the nodes in a flat `Buffer` and
  reclaim them with a counter reset (`pool.restore(saved)`) instead of freeing.
  It's a big speedup, but binarytrees is an allocation benchmark — pooling only
  Nomen removes exactly the work it measures, and no reference does it. (Tried
  and reverted.)
- **[codegen]** Inline the `create_tree` / `check_tree` recursion, or use a
  lighter calling convention. Each node currently pays a full
  `stp x29,x30; sub sp,…` prologue + epilogue frame; the optimized references
  tighten this away.
- **[codegen]** `node.left` / `node.right` field reads each dereference the
  class pointer, plus the `node.left != null` check. Field-access CSE (keep the
  child pointer in a local across the check + read) cuts the pointer chases.
- **[codegen]** `create_tree` returns `TreeNode` by value; the caller copies it
  field-by-field into the parent's `left`/`right`. A first-class struct return
  (or direct pointer assignment) removes the per-node copy that the reference
  languages avoid.
- **[stdlib]** Make `Buffer.load_T`/`store_T` use word-pair loads for
  `T_SIZE ≤ 16` instead of `memcpy`. N/A for binarytrees now that it uses direct
  node objects, but still needed for **json-serde**.

### merkletrees (194 / 907 ms — ~7× off Zig)

Like binarytrees but uses heap-allocated `class MerkleNode` with nullable
`left`/`right` children, and hashes up the tree.

- **`make_merkle` allocates every node with a separate `malloc`** — 130k+ at
  depth 17, which is the main reason merkletrees is only ~7× off rather than
  30×: work per node is tiny so allocation dominates. The honest lever is a
  faster allocator and codegen, not dodging the allocation.
- ✗ **[source] (unfair — excluded):** Replace `class MerkleNode` + per-node
  malloc with a flat `Buffer<MerkleNode>` pool. It would eliminate ~130k mallocs
  at depth 17, but merkletrees is an allocation benchmark and none of the
  references pool their nodes — same call as binarytrees.
- **[source]** `cal_hash(node)` dereferences `node.left` and `node.right` twice
  each (once for the recursive call, once for the `.hash` read). Cache them in
  locals once: `left = node.left; right = node.right;` then use them throughout.
  (The source already does `left_hash = node.left.hash` after the check, but
  `cal_hash(node.left)` re-dereferences — finish the job.)
- **[source]** `make_merkle(depth-1)` is called twice per node and the two
  subtrees are independent — they could share scratch space if converted to an
  iterative bottom-up build (allocate all leaves, then layer up).
- **[codegen]** Null checks (`node.left != null`) and field reads
  (`node.left.hash`) are pointer chases through the class instance each time.
  Field-access CSE would collapse them.
- `cal_hash` recurses twice over each subtree (once implicit via the recursive
  call, once to read children). A single post-order pass would halve traversals.

### nsieve (289 / 1446 ms → 53 / 200 ms — ~1.70× from peephole on top of prior)

Sieve of Eratosthenes over `Buffer<int>` (bit-packed, 64 flags per slot),
marking composites.

- ✓ **[source] DONE:** Use one bit per flag instead of a full `uint32`/`int`.
  The buffer drops 64× in size (better cache), and `flags.store_or_int(slot, bit)`
  becomes a single `ldr`/`orr`/`str` sequence. Implemented as `Buffer<int>` with
  64 flags per slot. Exercised the `store_or_int` inliner for the first time,
  which surfaced and fixed a latent 4-byte-vs-8-byte stride bug. Measured 1.46×
  at n=40M.
- ✓ **[source] DONE:** The outer loop stops at `i*i < n`.
- ✓ **[source] DONE:** Skip even numbers entirely in the outer loop (`i += 2`
  from base 3); `count` starts at 1 for the only even prime (2).
- ✓ **[stdlib/codegen] DONE:** Buffer.store/load inlined to single strided
  instructions. Buffer.data pointer now cached across loop iterations (LICM).
- ✓ **[codegen] DONE (item 18):** Adjacent push/pop peephole elimination. The
  `store_or_int` codegen emitted `str x0`/`ldr x0` pairs around each flag-marking
  operation; removing them lifts nsieve 1.60–1.70× (80 ms → 53 ms at n=10^7).
- **[codegen]** Drop the `0xFFFFFFFF` mask on `uint32` loads — it's a no-op on a
  zero-extended `ldr wN`. (Now N/A for nsieve since it uses `load_int`/
  `store_or_int` on 64-bit slots.)
- The outer/inner loop structure is the standard sieve — no algorithmic change
  needed beyond the above. Pure codegen from here.

### lru (39 / 150 ms → 8 / 27 ms — ~5.5× speedup, now ~4× off Zig)

LRU cache over a `Map<int,int>` plus a doubly-linked-list order tracker.

- ✓ **[source] DONE (item 19):** Replaced the O(n²) shift-array with an O(1)
  doubly-linked list + `Map<int,int>`, matching the Go (`container/list` +
  map) and Zig (`LinkedList` + `HashMap`) references. The list is arena-backed
  (flat arrays of prev/next/key/value indexed by stable node ids). `put` and
  `get` are both O(1). Lifts lru ~2.5–2.8× (150 ms → 27 ms at n=200000).
- ✓ **[source] DONE (item 19):** LCG modulo `% 2147483648` → `& 2147483647`
  (mod a power of 2 = bitmask, removes an `sdiv`).
- **[source]** The keys are bounded by `M = size * 10`. Replace `Map<int,int>`
  with a direct `Buffer<int>` indexed by key — O(1) with no hashing, no probing.
  The "map" is just a slot table; `has(k)` is `table.load_int(k) != 0`.
  (This would dodge the hash-map work the references do; kept as optional.)
- ✓ **[codegen] DONE:** Buffer.load_int/store_int inlined. Buffer.data pointer
  cached across loop iterations (LICM).
- ✓ **[codegen] DONE (item 18):** Adjacent push/pop peephole elimination removes
  redundant `str`/`ldr` pairs in the Map operations.
  probing; the reference Go map is also O(1)-ish but Go's runtime map is far
  tighter than Nomen's.
- ✓ **[codegen] DONE:** Buffer.load_int/store_int inlined. Buffer.data pointer
  cached across loop iterations (LICM).

### knucleotide (18 / 18 ms — ~3× off Zig)

Reads FASTA, packs bases 2-bit, counts k-mers. Already Nomen's closest-to-par
benchmark because the hot loop is a tight sliding-window hash with no
allocation.

- ✓ **[stdlib/codegen] DONE:** The `count_seq` / `write_freq` inner loops'
  `data.load_int(...)` is now inlined to a single strided load. 1.55× speedup
  measured.
- **[source]** The FASTA header scan is a 6-deep if-nest checking
  `>`,`T`,`H`,`R`,`E`,`E` byte-by-byte through `text.at(i) as int`. Replace with
  a single inline-C `memcmp(&text[i], ">THREE", 6)` (or `Regex.find`), and a
  bulk `memchr`-style scan for `>`.
- **[source]** `text.at(i) as int` decodes the string byte-by-byte through a
  method call. A `String.raw_bytes()` accessor returning `uint8*` would let the
  parse loop index directly.
- **[source]** The k-mer sort is a selection sort (`find max, swap`) — O(found²)
  over at most 256 keys. A counting sort or radix sort over the fixed key space
  is linear and tiny.
- **[source]** `count_seq` recomputes the rolling hash from scratch for every
  query sequence. Factor the rolling-hash state out of `write_count` and share
  it across the 5 `write_count` calls (one pass over `data`, updating counts for
  all queries).
- Remaining headroom is small; the Buffer accessor fix closed most of the gap.

### json-serde (46 / 219 ms — ~55× off Go)

Parses `bench/sample.json` into a `JsonTree` pool N times, re-stringifies,
prints the length.

> **Fairness flag (needs review).** Two structural mismatches vs the references
> make this comparison rougher than the others: (1) the Go reference
> `json.Unmarshal`s into a **typed `GeoData` struct** (schema-aware), while Nomen
> parses into a **generic `JsonNode` DOM**; (2) Nomen **resets the `JsonTree`
> pool between parses** (no per-node malloc/free), the same reuse pattern that
> was unfair in binarytrees. Unlike binarytrees this is a _parsing_ benchmark so
> the pool is defensible (production JSON parsers commonly arena-allocate), but
> both points should be reconciled before trusting the ratio here.

- **[source]** The benchmark calls `Json.stringify(...).length` — building a
  full string just to measure it. Add a `Json.serialized_length(tree, root)`
  that walks the tree and accumulates lengths without allocating. Removes the
  largest per-iteration allocation.
- **[stdlib]** Add zero-copy substring support to the JSON parser — string
  tokens reference a slice of the source text instead of being `strdup`'d. Most
  JSON values are strings; this removes the bulk of allocations.
- **[stdlib]** Arena-allocate the `JsonNode` pool: bump-allocate from a
  contiguous slab and reset the bump pointer between parses instead of going
  through the general allocator.
- **[stdlib]** `Buffer.load_T`/`store_T` for the `JsonNode` struct should use
  word-pair loads, not `memcpy` (same fix as binarytrees). Each node access is
  currently a struct memcpy plus string pointer chases.
- **[stdlib]** String handling is a dominant cost: every `+` concatenation and
  tokenize allocates and copies. Go's `encoding/json` is also allocation-heavy
  but Go's allocator and string copy are far faster than Nomen's per-call
  `malloc`/`strdup` + manual free at scope exit.
- **[source]** The first parse + serialize is done outside the loop and
  discarded after printing length; the same work is then done N more times.
  Faithful to the spec, but worth noting.

### regex-redux (62 / 62 ms — ~15× off Rust)

Reads FASTA, runs 9 regex counts and 5 substitutions. Single-threaded (matches
the GOMAXPROCS=1 treatment for Go).

- **[source]** Each of the 9 `Regex.count(pattern, cleaned)` calls recompiles
  the pattern and re-scans the full ~25k-char string. If the stdlib exposes a
  compiled-pattern object (`Regex.compile(pattern)`), hoist all 9 compiles out
  of any loop. Currently there's no such API — needs stdlib support (below).
- **[source]** The 5 chained `Regex.replace_all` calls each scan + allocate a
  fresh string. The substitutions never grow the string (`<…>` → `|`,
  `|…|` → `-`, etc.), so an in-place replacement would remove 4 allocations of a
  25k-char string.
- **[source]** After the variants are counted once each, the results are printed
  one at a time. Concatenating into one write would save 9 syscall round-trips
  (minor).
- **[stdlib]** Add `Regex.compile(pattern) -> Regex` and
  `Regex.count_compiled(re, text) -> int`. Pattern compilation is the dominant
  regex cost; caching it across the 9 calls would help a lot.
- **[stdlib]** Add an in-place `Regex.replace_all_into(pattern, text, repl)` or
  a `StringBuilder`-friendly variant that doesn't allocate a fresh string per
  pass.
- **[stdlib]** A faster regex engine (DFA-first like re2 instead of
  backtracking) would speed up every regex benchmark.

### nbody (230 / 2281 ms → 120 / 1310 ms — ~1.76× speedup)

N-body simulation, 5 bodies, `n` steps. Float-heavy inner loop with `Math.sqrt`.

- ✓ **[codegen] DONE (items 17–18):** Float round-trip elimination + push/pop
  peephole. The `advance` and `energy` inner loops are chains of float
  operations (`dx*dx + dy*dy + dz*dz`, `mag = dist * …`, etc.); eliminating the
  per-op `fmov x0, d0`/`fmov dN, x0` round-trip and the redundant push/pop
  gives 1.40× (180 ms → 130 ms at n=500000).
- ✓ **[codegen] DONE (item 21):** `Math.sqrt` was already `inline func` but the
  general inline path added a per-call `str x19`/`mov x19, x0`/`ldr x19` triple
  (one callee-saved save/restore per parameter). The naked-inline path now
  covers all raw-only inline funcs, so `sqrt` emits just `fmov d0, x0` /
  `fsqrt d0, d0` / `fmov x0, d0`. Lifts nbody 130 ms → 120 ms at n=500000.
- **[source]** Unroll the j-loop manually (it's known trip-count 4 for the last
  i, 3 before that, …). Ugly but a 4× reduction in loop overhead and lets each
  iteration keep its own `bj_*` locals in registers.
- **[source]** Mirror the Rust source's `mass_half = mass * 0.5` precomputation
  in `Body` to save a multiply in the `energy` inner loop, and store
  `mass_ratio` separately so `offset_momentum` doesn't multiply by `solar_mass`
  either.
- ✓ **[codegen] DONE:** Field-level access on fixed-size struct arrays —
  `bodies.at(i).x` compiles to a direct `ldr [base + i*64 + fieldoff]`, not a
  whole-`Body` materialization.
- ✓ **[codegen] DONE:** Float loop locals (`dx`, `dy`, `dz`, `dist`, `mag`, …)
  now promoted to `d8`–`d15` registers.
- The Body is 7 floats = 56 bytes; `.at(i)` materializes the whole thing.
  Passing `ref Body[5]` is correct but the access pattern defeats locality.

### spectral-norm (97 / 875 ms → 40 / 370 ms — `nan` bug fixed)

Approximates the spectral norm via 20 matrix-vector products over the
Hilbert-like matrix `A[i,j] = 1/((i+j)(i+j+1)/2+i+1)`.

- ✓ **[codegen] DONE (item 20):** Fixed the `load_float`/`store_float`
  result-register bugs that produced `nan`. spectral-norm now works: 40 ms at
  n=500, 370 ms at n=1500. The source already had the `eval_a` denominator
  recurrence (see below) and the `Buffer<float>` inlined accessors; the
  remaining gap to Rust (~58 ms at n=1500) is ~6×.
- **[source]** `eval_a(i, j)` recomputes the integer division
  `((i+j)*(i+j+1))/2 + i + 1` from scratch per (i, j). Along a row (fixed `i`,
  increasing `j`) the denominator satisfies a simple recurrence: step from
  `(i+j)` to `(i+j+1)` adds `2*(i+j)+1` to the `(i+j)(i+j+1)/2` term.
  Maintaining the denominator as a running variable removes the multiply and
  divide from the inner loop. (The reference implementations exploit this.)
  — **Already done in the Nomen source** (`denom` running variable in
  `eval_a_times_u`).
- **[source]** `eval_a_times_u` reads `u` and writes `au` via Buffers. Cache
  `u.data` and `au.data` in locals once at the top of the function (the Buffers
  don't change during the loop).
- **[source]** The double product `A^T·A·u` does two passes per iteration over
  the n×n matrix. Since `A` is fixed, precomputing the n×n matrix once into a
  `Buffer<float>` and reusing it for all 20 iterations would eliminate
  recomputation. (Trade memory for speed; for n=1500 that's ~18 MB, fine.)
- **[codegen]** Inline `eval_a` (it's one divide). `eval_a` is a function call
  with a float return through a struct-return buffer, so each element costs a
  call + the division.
- **[codegen]** First-class float return — `eval_a`'s float result goes through
  the struct-return buffer (`x8`) even though it's a single double. A
  float-return calling convention removes the indirection.
- ✓ **[codegen] DONE:** `Buffer<float>` `load_float`/`store_float` inlined.
  Buffer.data pointer cached across loop iterations (LICM).

### mandelbrot (358 / 1423 ms → 140 / 550 ms — ~2.55× speedup)

Computes a Mandelbrot bitmap checksum, double loop over pixels.

- ✓ **[codegen] DONE (items 17–18):** Float round-trip elimination + push/pop
  peephole. The mbrot inner loop's float expression chains (`(zr+zr)*zi+ci`,
  `tr-ti+cr`, `zr*zr`, `zi*zi`) no longer round-trip each intermediate result
  through x0 via `fmov x0, d0` / `fmov dN, x0`. The redundant push/pop
  (`str x0, [sp, #-16]!` / `ldr x0, [sp], #16`) after each expression is also
  eliminated.
- ✓ **[codegen] DONE (item 11):** `mbrot(cr, ci)` is inlined at each call site
  (leaf-function inlining). The per-pixel call frame (prologue/epilogue +
  d8-d15 saves) is eliminated.
- ✓ **[codegen] DONE (item 22):** Float assignment round-trip elimination.
  Assignments to register-allocated float vars (`zi = …`, `zr = …`, `tr = …`,
  `ti = …`) now go directly `d0 → dN` instead of `d0 → x0 → dN`, saving one
  `fmov` per assignment. Combined with items 17–18, lifts mandelbrot 370 ms →
  140 ms at n=1000 (2.64×), 1423 ms → 550 ms at n=2000 (2.59×) vs the
  pre-float-regalloc baseline.
- ✗ **[source] (tried and reverted — changes checksum):** Column recurrence for
  `cr` (`cr += inv` per pixel instead of `(xi as float) * inv - 1.5`). Only ~3%
  faster, but floating-point accumulation shifts boundary pixels and changes
  the checksum (12649259 → 12649257 at n=1000). Since the benchmark verifies
  the checksum, the change was reverted. The reference implementations use the
  multiplication form (not recurrence), so the checksum must match exactly.
- **[source]** The unroll-by-5 trick is already there. Extending it to
  unroll-by-10 with two escape checks amortized would halve branch overhead.
- ✓ **[codegen] DONE:** Float-register-allocate the inner-loop `tr`, `ti`, `zr`,
  `zi`.
- No use of SIMD (Rust/Zig auto-vectorize the 5-iteration unroll). Out of scope
  for the current backend but it's the ceiling.

### edigits (125 / 734 ms → 8.5 / 39 ms → 9 ms — ~2–3× off Rust)

Computes _e_ to `n` digits via BigInt, then prints. Previously Nomen's _worst_
ratio (~245×); within ~15× after the product-tree algorithm; now ~2–3× off
Rust (9 ms vs ~4 ms at n=5000, both dwarfed by the 734 ms starting point).

- ✓ **[source] DONE:** Bulk divmod-by-10^18 for printing (18 digits per long
  division instead of 1).
- ✓ **[source] DONE:** Binary exponentiation for `10^(precision-1)` and
  `10^trim` (repeated squaring, O(log precision) multiplies).
- ✓ **[codegen] DONE:** Fixed the Karatsuba self-multiply bug that blocked
  binary exponentiation. Root cause: the loop register allocator promoted a
  variable (`carry`) redeclared inside the loop body but loaded it from a
  sibling scope's stack slot with the same name.
- ✓ **[source] DONE:** Product-tree algorithm (`sum_terms` recursive function).
  Computes `e = Σ 1/i!` as a single fraction `p/q` via balanced divide-and-
  conquer multiplication, then one final `mul + div`. Matches the Rust/Go/Zig
  references. Replaces the old iterative term-division loop (`O(k·n)`
  sequential BigInt÷int divisions). 19× speedup at n=5000 (734 ms → 39 ms).
- ✓ **[stdlib] DONE:** `BigInt.set(ref self, int val)` and
  `BigInt.set(ref self, uint64 val)` — in-place init without realloc.
  `BigInt.div_to(ref self, BigInt a, BigInt b, ref BigInt remainder)` —
  in-place division following the `_to` pattern (replaces the old `div` with
  `out BigInt` return). The single-limb fast path is internal to `div_to`.
- ✓ **[stdlib/codegen] DONE (item 13):** `div128` was a 64-iteration bit-by-bit
  software division. It's now an `inline func` calling compiler-rt's
  `___udivti3` (~30× faster, 3.7ns vs 120ns). Saturation to `UINT64_MAX` when
  `hi >= d` preserves Knuth-D's `q_hat` correction. Dominant win for the final
  big divide + base conversion.
- ✓ **[stdlib/codegen] DONE (item 14):** `BigInt.get`/`set` now use AArch64
  indexed addressing (`ldr x0, [x0, x1, lsl #3]`) — 4 → 2 instructions per
  limb access. Biggest single factor for the Karatsuba product tree.
- ✓ **[codegen] DONE (item 15):** `Buffer<T>` load/store now inlines for
  monomorphized types (was emitting `bl Buffer_int_load_int`). Cuts the final
  divide + base conversion to inlined strided loads/stores.
- `Math.log(fk)` is used in `test_k` for the initial binary search — that's
  fine, it's O(log) calls. No fix needed there.

---

## Summary — the few fixes that lift _all_ benchmarks

The per-benchmark notes point to the same handful of root causes. They fall into
three families.

### A. Algorithmic / data-structure changes in the Nomen source

These are the **biggest single wins** because they change the work, not just the
constant factor:

| Benchmark       | Source-level change                                        | Impact | Status         |
| --------------- | ---------------------------------------------------------- | ------ | -------------- |
| **edigits**     | Product-tree algorithm + bulk divmod + binary exp          | ~20×   | ✓ Done         |
| **lru**         | Doubly-linked list + map (O(1) LRU) instead of shift-array | ~2.8×  | ✓ Done         |
| **nsieve**      | Bit-pack flags; stop outer loop at `i*i < n`; skip evens   | ~5–10× | ✓ Done (1.46×) |
| **regex-redux** | In-place substitution; compiled-once patterns              | ~2–3×  | Not done       |
| **fannkuch**    | Precomputed permutation masks (no per-iteration rotate)    | ~2×    | Not done       |

(binarytrees and merkletrees source "wins" are **excluded for fairness** — see
the note at the top.)

### B. Stdlib fixes (one-time work, lifts every user)

1. **`Buffer.load_T`/`store_T` for small structs → word pairs instead of
   `memcpy`.** Lifts **json-serde** and any future struct-of-array code. Not
   done. (binarytrees no longer uses a struct buffer — it allocates node objects
   directly.)
2. ✓ **DONE (items 13–15):** Hoist/`div128`/`get`+`set`/`Buffer<T>`-inline
   fixes for BigInt's limb loops. `div128` → `___udivti3`; `get`/`set` use
   indexed addressing; monomorphized `Buffer_int` load/store now inline. (A
   follow-up true LICM hoist of the `digits.data` load was attempted and
   reverted — it doesn't pay off; see Known issues.)
3. ✓ **DONE (item 9):** `BigInt.div_to` (in-place variant) removes the per-call
   value-copy in both BigInt-heavy benchmarks.
4. **Zero-copy substring / arena allocation in the JSON parser.** Lifts
   **json-serde**. Not done.
5. **Compiled-regex API + in-place substitution.** Lifts **regex-redux**. Not
   done.
6. ✓ **DONE:** bit-packing for **nsieve** — 64 flags per `Buffer<int>` slot,
   1.46× at n=40M.

### C. Codegen fixes (one-time work, lifts every user)

1. ✓ **DONE:** Inline `.at`/`.set` and `Buffer.load_*`/`store_*` to direct
   strided loads/stores. Biggest single fix for **fannkuch**, **nsieve**,
   **knucleotide**, **spectral-norm**. Measured 1.27–1.55×.
2. ✓ **DONE:** Loop-invariant `Buffer.data` dedup — cache the data pointer in a
   callee-saved register so repeated accesses to the same Buffer within a scope
   reuse it. Nested-loop register conflicts resolved (promotion avoids
   outer-loop cache registers; cache reset per function body). Now covers both
   local-variable _and_ field targets (`self.x`, `remainder.digits`) with
   invalidation on assignment / resize / non-inlined `bl` and branch
   snapshot/restore. Lifts nsieve, knucleotide, lru, spectral-norm. (Note: this
   is per-scope dedup, _not_ true loop-invariant hoisting — see #9 for why a
   full preheader hoist was attempted and reverted.)
3. ✓ **DONE:** Inline small leaf functions — scanner + `build_inline_function`
   implemented. Inlines free functions with primitive-only `const` params and
   no calls in body. `mbrot` in mandelbrot is now inlined at every call site
   (eliminating the per-pixel call frame). The float assignment round-trip
   elimination (item 22) then made the inlined body itself cheaper.
4. ✓ **DONE:** Register-allocate hot locals including floats (d8-d15). 1.13× on
   nbody; was regressed spectral-norm/mandelbrot ~8-9% due to prologue overhead,
   but now net-positive after items 10–11.
5. ✓ **DONE:** Field-level access on struct arrays (`bodies.at(i).x` → direct
   `[base + i*stride + off]` load). Biggest single fix for **nbody**, now in
   place.
6. ✓ **DONE:** Fixed register allocation bug — variables redeclared inside loop
   bodies were promoted using stale stack offsets from sibling scopes (the
   BigInt Karatsuba self-multiply corruption).
7. ✓ **DONE (partial):** Constant folding — binary operations on two integer
   literals are now folded to a single immediate at compile time. Strength
   reduction (e.g., `x * 1` → `x`, replacing divides by powers of 2 with shifts)
   and float constant folding remain.
8. **Lower per-call prologue cost** (binarytrees, nbody recursion). Not started.
   Every function — even a one-line recursive helper — pays a full
   `stp x29,x30; sub sp,...` frame; a lighter calling convention or tail-call
   would compound with the inlining fix.
9. ✗ **REVERTED — true `Buffer.data` LICM (preheader hoist) doesn't pay off.**
   A sound loop-invariant hoist was implemented (`loop_buffer_licm`): pre-scan
   each loop body, load invariant Buffer data pointers once into callee-saved
   registers in the preheader, seed the cache. It was correct (asm-verified) and
   all tests passed, but A/B benchmarking showed **no speedup on pidigits and
   small regressions on nsieve/fannkuch** from the per-loop overhead. The
   pointer reloads it eliminated are L1 hits hidden by OoO execution, and
   pidigits is dominated by the single-limb path whose BigInt `get`/`set` use
   raw `#arch` asm that bypasses the cache entirely. Reverted; the
   behavior-preserving cache-helper refactor in `build_access_node.ts` was kept.
   See Known issues for the full analysis. The conservative "drop every field
   cache entry on any `bl`" invalidation in `build_function_call_node` remains a
   worthwhile follow-up independent of LICM (it currently limits within-body
   field dedup in any loop with a non-inlined call).
10. ✓ **DONE (item 17):** Float expression round-trip elimination — float binary
    ops keep their result in `d0` when the immediate consumer is another float op,
    instead of round-tripping through x0. 1.76× on mandelbrot, 1.40× on nbody.
    This is a targeted fix; the full d0-based calling convention (d0 returns,
    d0–d7 params, `fcmp`) remains a future improvement.
11. ✓ **DONE (item 18):** Adjacent push/pop peephole elimination — removes
    `str xN, [sp, #-16]!` / `ldr xN, [sp], #16` no-op pairs in the peephole
    optimizer. Broad win: 1.32× fannkuch, 1.60–1.70× nsieve, 1.38× knucleotide,
    and compounds with item 10 on float benchmarks.
12. ✓ **DONE (item 20):** `load_float`/`store_float` result-register bug fix —
    re-enables spectral-norm (was `nan`). See item 20 above.
13. ✓ **DONE (item 21):** Naked inline for all raw-only inline funcs — eliminates
    the per-parameter callee-saved save/mov/restore triple for static raw-only
    inline funcs (`Math.sqrt` et al.). Helps nbody.
14. ✓ **DONE (item 22):** Float assignment round-trip elimination — assignments
    to register-allocated float vars go directly `d0 → dN` instead of
    `d0 → x0 → dN`. Biggest remaining win for mandelbrot (1.50× on top of
    items 17–18).

### Expected payoff

- **Family A (source)** is the cheapest to land (per-benchmark edits, no compiler
  work) and contains the largest individual wins. The edigits and lru changes are
  done; regex-redux and fannkuch permutation masks remain.
- **Family B (stdlib)** is a handful of localized stdlib changes that unblock
  whole classes of code. None done yet.
- **Family C (codegen)** — items 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14 are done.
  The `load_float` bug is fixed (item 12); leaf-function inlining (C3) already
  covers `mbrot`; the float round-trip is now eliminated for both expressions
  (item 10) and assignments (item 14). Item 7 (strength reduction) and the
  full float-result calling convention (d0 returns, d0–d7 params, `fcmp`)
  remain the main codegen levers.

The spectral-norm bug fix (item 12), naked inline (item 13), and float
assignment round-trip (item 14) are now landed. The float benchmarks
(mandelbrot, nbody, spectral-norm) have moved from ~30–143× off the references
into a 6–20× band. The remaining source-level changes (family A: regex-redux,
fannkuch permutation masks) and the full d0 calling convention are the next
levers.
