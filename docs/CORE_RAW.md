# Core library raw blocks (`#arch:`) — inventory and plain-Nomen rewrite analysis

The core library (`core/System/*.nm`) implements most functions as raw
`#arch: c` (C source for the C backend) + `#arch: aarch64` (assembly for the
aarch64 backend) block pairs. This document inventories every raw block
outside `Controls/` (which is UI code — `aarch64_use_c` territory, out of
scope), classifies why each is raw, and identifies which could become plain
Nomen code without regressing the **C backend** benchmarks (the aarch64
backend is not at parity and is explicitly not the target here).

**Status: roadmap item 2 (`unsafe`) is implemented, and a first tranche of
memory primitives has been rewritten — see "Unsafe outcomes" below for what
moved, what deliberately stayed raw, and the measurements.**

See also [AGENTS.md](./AGENTS.md) ("Inline code blocks") for the directive
mechanics.

## Key facts that shape the analysis

- **One translation unit, clang -O2.** `bench/compile_nomen.ts` joins the
  program _and_ the whole core library into a single C file compiled with
  `clang -O2`. Plain-Nomen rewrites therefore get full LLVM inlining and
  optimization — there is no per-call overhead penalty for small Nomen
  functions, unlike the aarch64 backend where every call is real.
- **Constraints are proven, not checked.** Parameter constraints (e.g.
  `at`'s `index >= 0 && index < self.length`) are discharged at compile time
  by the constraint evaluator (`evaluate_const_condition` +
  `src/check/utils/flow_bounds.ts`). Loop-carried index bounds _are_
  provable (the pure-Nomen `Array.at_or` / `String.at_or` bodies rely on
  this), so a Nomen loop over `self.at(i)` carries no per-iteration runtime
  check. Unprovable calls are compile errors, not silent runtime checks.
- **Precedent exists.** `Array.at_or`, `Array.at_or_panic`,
  `String.at_or`, `String.at_or_panic` are already plain Nomen bodies
  calling raw `at` — both backends handle receiver conventions through them
  correctly.
- **Most of core is already plain Nomen.** Map, Set, List, LinkedList, Tree,
  Json, Regex, BigInt's arithmetic (Karatsuba, Knuth-D, add/sub), and all
  the benchmark hot loops outside the primitives below. The raw surface is
  smaller than the block count suggests: it is concentrated in the memory
  primitives.

## Classification

### A. Must stay raw — pointer/memory manipulation (no safe Nomen equivalent)

Nomen has no unsafe pointer casts or address-taken indexing; these blocks
cast a `uint64` handle (or a struct pointer) to a `T*`, or need inline
element storage.

| File                   | Functions                                                                                                                | Why raw                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Buffer.nm` (27 funcs) | alloc/grow/zero/load/store/store_or/move/replace/shift + `_int`/`_T`/`_float` variants, slice, #destroy                  | `data` is a `uint64` slab handle, cast to `int*`/`T*`/`double*` per access; calloc/realloc/memset/memcpy                                                                                          |
| `ClassBuffer.nm` (13)  | alloc_int/grow_int/load_int/grow_T/load_T/store_T/move_T/store_int/move_int/replace_int/replace_T/shift_T/slice/#destroy | Same pattern plus per-element destroy; monomorphizer rewrites `Buffer<T>` fields to this for classes                                                                                              |
| `Array.nm` (9)         | #init, at, first, set, at_end, slice, with, add, mul                                                                     | Elements stored inline after the header (`(T*)((char*)self + sizeof(*self))`); `T_NEEDS_STRDUP` string-slot specialization                                                                        |
| `BigInt.nm` (7)        | get, set, data_ptr, get_at, set_at, div128, mul_wide_hi                                                                  | uint64-as-pointer limb access; `div128` needs `unsigned __int128` 128/64 divide (aarch64: `___udivti3`); `mul_wide_hi` needs the high half of a 64×64 product (`umulh`) — no 128-bit ops in Nomen |
| `StringBuilder.nm` (5) | ensure, append_char, append_string, to_string, #destroy                                                                  | uint64 byte-buffer handle + realloc/memcpy; `to_string` transfers ownership of the raw buffer                                                                                                     |
| `JsonTree.nm` (3)      | alloc_node, free_text, set_text                                                                                          | strdup directly into the node slab (file header: cannot go through load_T/store_T without double-free)                                                                                            |
| `String.nm` (3)        | at, set, slice                                                                                                           | Pointer arithmetic on the fat-string ptr (`self + start`, `(*self)[index]`) — this _is_ the primitive everything else indexes through                                                             |

BigInt is the clearest example of the intended split: every algorithm
(add/sub/mul/Karatsuba/Knuth-D/normalization) is plain Nomen; only the six
limb-access/128-bit primitives are raw, and they are genuinely
inexpressible.

### B. Must stay raw — libc / OS calls

| File                                                                                                                  | Functions                                                                         | Why raw                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Console.nm`                                                                                                          | write, write_line, read_line, read_char, platform                                 | stdio; platform detection                                                                                                                                                                                                      |
| `Time.nm`                                                                                                             | now_ms, now_ns, now_unix, sleep_ms                                                | clock_gettime / nanosleep                                                                                                                                                                                                      |
| `Mutex.nm`                                                                                                            | all                                                                               | pthread mutexes                                                                                                                                                                                                                |
| `Task.nm`                                                                                                             | all                                                                               | thread pool, cancellation state                                                                                                                                                                                                |
| `Channel.nm`                                                                                                          | all                                                                               | pthread mutex/cond + malloc'd intrusive nodes held in uint64 fields                                                                                                                                                            |
| `Stream/File.nm`, `Stream/Directory.nm`, `Stream/Http.nm`                                                             | all `raw_*`                                                                       | fopen/opendir/socket layer                                                                                                                                                                                                     |
| `Init.nm`                                                                                                             | parse_int                                                                         | atoi                                                                                                                                                                                                                           |
| `int.nm`                                                                                                              | parse                                                                             | atoi (whitespace/sign/nondigit semantics; not worth re-deriving in Nomen)                                                                                                                                                      |
| all numeric types (`int8`–`int64`, `uint8`–`uint64`, `int`, `uint`, `float`, `float32`, `float64`, `ufloat*`, `char`) | to_string                                                                         | snprintf                                                                                                                                                                                                                       |
| `Math.nm`                                                                                                             | sqrt (inline raw fsqrt splice — see below), log (extern)                          | libm (aarch64: `fsqrt` is single-instruction)                                                                                                                                                                                  |
| `String.nm`                                                                                                           | to_string (strdup), #op_add (malloc + two memcpy), #op_mul (malloc + memcpy loop) | Needs malloc/memcpy; note the asm versions exploit the tracked length while the C versions strlen — replacing the C with length-based Nomen would require raw memcpy access anyway                                             |
| `String.nm`                                                                                                           | #op_eq                                                                            | C uses libc `strcmp`/asm uses `memcmp` with the length pre-check — both vectorized. A Nomen byte-loop is 1 byte/iter; LLVM's loop-idiom → `bcmp` transform is not guaranteed once the length guard is in front. Keep (see C.5) |

### C. Decisions on the former rewrite candidates

1. **`Math.power`** — **rewritten** (plain Nomen multiply loop).
2. **Hash functions (identity casts):** `int`, `int8`–`int64`, `uint`,
   `uint8`–`uint64`, `char`, `bool` — **rewritten** (`return self as uint`
   / `return self`).
3. **`String.hash`** — **rewritten** (djb2 over `0..self.length` via
   `self.at(i)`). The Nomen version is length-based, matching the aarch64
   body's semantics exactly (the old C body NUL-scanned). Constraint bounds
   are proven at compile time; `at` inlines at -O2 in the single TU.
4. **`Regex.find_next_byte`** — **rewritten** (plain Nomen double loop over
   `input[pos..len)` × `charset`). Measured on the C backend: output
   byte-identical; regex-redux at the standard bench input is unchanged
   (12.5ms, startup-dominated), and on a 1MB input it ran ~2× **faster**
   than the `strpbrk` version (0.41s vs 0.82s best-of-5) — the per-call
   libc overhead dominated the tiny-charset scans. Kept.
5. **`String.#op_eq`** — **stays raw, by policy.** String compares should be
   fast: the C body's libc `strcmp` (and the asm's length-guarded `memcmp`)
   are vectorized, and a Nomen byte loop cannot be guaranteed the same
   treatment. Do not rewrite without a strong reason.

### Compiler fixes the rewrites surfaced

- **C backend:** methods of SIMPLE-TYPE structs (int/uint/bool/char/floats)
  receive `self` by value (`unsigned long uint_hash(unsigned long self)`),
  but `build_struct_functions` unconditionally registered `self` in
  `function_ref_params`, so a plain-Nomen body's value-use of `self`
  emitted `*self` on a scalar. No primitive type had a Nomen body before,
  so this was never exercised. Fixed in `build_struct_functions`
  (self is a pointer param only when the struct is not simple).
- **aarch64 backend:** the asm validator's `MNEMONICS` table was missing
  `sxtb`/`sxth`/`sxtw` (emitted by widening casts like `int32 as uint`);
  added.
- **Unsafe blocks are unwrapped post-check** (see `check.ts`): the wrapper
  only carries the checker's `in_unsafe` context; after checking, its
  statements are spliced into the enclosing list so the NIR flattening and
  both backends' index-based statement pairing stay 1:1. (Consequence:
  `clone_node` must deep-copy unsafe blocks, or mono clones would share —
  and late-stamp-clobber — the generic body's subtree.)

### Not candidates

- `Console.read_line`/`read_char` (getline/fgetc), everything in `Stream/`,
  `Task`, `Mutex`, `Time`, `Channel` — thin libc/OS wrappers where a Nomen
  rewrite would just re-express the same calls with more code.
- `Controls/` — UI layer; `aarch64_use_c` there is by policy (AGENTS.md).

## Roadmap: language features to retire the remaining raw blocks

The remaining raw blocks split into two groups, and each group needs its own
language feature. They are complementary, not alternatives.

### 1. C extern mappings (implemented — retires the libc/OS wrappers)

A declaration-only function whose body is a C symbol call:

```
extern func atoi = (string s, out int)
```

- **Status: implemented.** First conversions: `Init.parse_int` (→ `atoi`),
  `String.to_string` (→ `strdup`), and `Math.log` (→ `log`), exercised end
  to end on both backends by `test/externs.test.ts` and the spec suite. See
  `src/build_c/build_extern.ts` and `src/build_aarch64/build_extern.ts`.
  Method externs emit the adapter under the normal `Struct_method` label
  (the symbol stays bare) — landed for `Math.log`, the first method
  extern; free externs keep the `extern_` prefix as before.
- **Semantics:** string params marshal to the thin `char*` (`.ptr`); a
  string return is re-wrapped as an owned fat string via `strlen`. Free
  externs emit under an `extern_<name>` label so the adapter can never
  collide with the C symbol it wraps; method externs keep the normal
  `struct_method` label. Lockdown is enforced in `check_function_node`
  (library-only, same trust line as core constraints).
- **Not yet supported:** variadic externs (blocks the `snprintf`
  to_strings), float32/64 argument lists beyond the sole-param shape, and
  symbol renaming (`extern func open = ("fopen" ...)`).
- **`Math.sqrt` stays an inline raw body for speed.** The single-`fsqrt`
  splice keeps `advance`'s inner loop call-free so it holds the SLP
  vector shapes; a real `bl` scalarizes the loop. (Correctness no longer
  depends on it: field-pair SLP now only forms in call-free scopes, so a
  scalar loop can no longer zero a live pair lane — see the
  `slp_pair_nested_call` regression test. An extern `sqrt` is correct,
  just slower.)
- **Retires when fully rolled out:** Console, Time, Mutex, Task,
  Stream/*, the `snprintf` to_strings. This is the larger half of the
  remaining block count, and the low-risk half: both backends already
  emit calls to these exact symbols from raw blocks today.

### 2. `unsafe` (implemented — memory primitives single-sourceable)

A minimal typed pointer subset, usable only inside `unsafe` blocks (or
unsafe-declared functions):

- **Status: implemented.** `ptr T` values, `p[i]` indexing (load and
  store, scalar/string/struct widths), integer↔pointer casts, `string →
ptr char`, struct-pointer→`uint64`, and the generic constants `T_SIZE` /
  `T_NEEDS_STRDUP` / `T_FAT` as real Nomen expressions (the monomorphizer
  substitutes them with literals and folds the dead arm of any `if` they
  guard — replacing the raw `#if T_NEEDS_STRDUP` preprocessor idiom).
  Lockdown is airtight by construction (see `test/unsafe.test.ts` for the
  pin of every path):
  - the parser rejects `unsafe` declarations/blocks outside the appended
    System library source (source-offset boundary), and **raw `#arch:`
    blocks too** — they subsume everything `unsafe` offers (the compiler's
    own machinery tests opt back in via `parse`'s `allow_user_raw` flag,
    which the CLI never sets);
  - the checker rejects pointer operations (casts, indexing) outside an
    unsafe context, `ptr`-typed introductions (locals, fields, params,
    returns) outside the library, and `T_SIZE`/`T_NEEDS_STRDUP`/`T_FAT`
    in user generics;
  - no library function exposes `ptr` in its public signature, so user
    code cannot obtain a pointer value at all;
  - the build backends need no gate of their own: they run only on the
    error-free checked AST, index nodes originate solely from the parser's
    `[` postfix (checker-gated), and mono clones derive from
    library-checked bodies. See SPEC.md "Unsafe Code".
- **First tranche rewritten (all single-sourced, both backends).** Every
  rewritten body is an ordinary `func` containing an `unsafe { ... }`
  block — the `unsafe func` form exists but the library doesn't use it:
  unsafe-ness is an implementation detail callers shouldn't see, and the
  block form keeps the exposed signature identical to any other method.
  - `Buffer.nm`: `alloc`, `grow`, `zero`, `alloc_int`, `grow_int`,
    `zero_int`, `alloc_T`, `grow_T`, `zero_T`, `alloc_float`, `#destroy`
  - `StringBuilder.nm`: `ensure`, `append_string`, `append_string_view`,
    `seed`, `#destroy`
  - `Array.nm`: `at`, `first`, `at_end`, `set` (the `set` body replaces
    `#if T_NEEDS_STRDUP` with the folded `T_NEEDS_STRDUP` constant)
  - `String.nm`: `at`, `set`
- **New memory externs** (in `String.nm`, an always-linked base-type file,
  so every core file sees them regardless of pull order):
  `calloc`, `malloc`, `realloc`, `free`, `memcpy`, `memset`. Under audit,
  the aarch64 adapter routes allocator symbols through the
  `nomen_*_wrap` counters so the leak checks stay balanced.
- **Deliberately still raw, with measured reasons:**
  - `BigInt.nm` get/set/get_at/set_at (and `data_ptr`): the limbs sit in
    the hottest loops and the functions are `inline`. The unsafe-Nomen
    forms splice through the general inline-method ABI (self parking,
    param marshalling, local spills per splice) and measured **3× slower
    pidigits on aarch64** (0.48s → 1.5s; even the once-per-loop
    `data_ptr` cost ~30% via loop-plan perturbation). The C backend was
    identical either way. Reverted to raw; documented inline.
  - `Buffer.nm` load/store/store_or family, `move_T`, `replace_T`,
    `shift_T` (inline splice targets — same ABI cost risk), plus
    `slice` (needs a `view` constructor, not expressible yet).
  - `Array.nm` `#init` (variadic packing), `with`/`add`/`mul`
    (backend-specific result layouts: the C header is a real struct, the
    aarch64 value is a first-element pointer with the length prefix at
    `[-8]` — one Nomen body cannot construct both), `slice` (view
    constructor).
  - `String.nm` `slice` (view constructor), `#op_eq` (C.5 policy),
    `#op_add`/`#op_mul`.
  - `StringBuilder.nm` `append_char`/`to_string` (inline hot path;
    ownership hand-off shapes).
- **Compiler fixes the rewrites surfaced** (each would miscompile
  independently of unsafe):
  - Monomorphized clones copy plain free-function calls UNRESOLVED (the
    generic body is checked after the clone is taken), so an `extern`
    callee emitted its bare symbol instead of the `extern_<name>` adapter.
    Fixed with `resolve_free_func_calls` in the clone pipeline and extern
    pre-registration at root gather.
  - `ownership.ts` classified "owning" by the presence of a raw block in
    `#destroy`; Nomen destroys that call the memory externs now count too
    (`contains_release`), with order-independent extern resolution.
  - The aarch64 string-slot `set` specialization freed the displaced
    pointer and then read the value pair from caller-saved registers the
    free had clobbered (pre-existing, exposed by the new tests); fixed by
    parking the pair in callee-saved registers across the calls.
  - `value_is_owned_string` treats the unknown index node as
    "conservatively owned" — a `return self[index]` (unsafe element read)
    is a BORROW like a field access; mis-classifying it made call sites
    free array slots (libmalloc abort).

### Unsafe outcomes (benchmarks)

Best-of-5 wall times, `bench/ab.sh` (same-day same-machine baseline vs
post-rewrite; nsieve/knucleotide/lru/regex-redux sit at 0.0–0.2s and are
noise-limited, all unchanged):

| Benchmark   | C before | C after | aarch64 before | aarch64 after |
| ----------- | -------- | ------- | -------------- | ------------- |
| nsieve      | 0.13s    | 0.13s   | 0.16s          | 0.16s         |
| json-serde  | 0.03s    | 0.03s   | 0.06s          | 0.06s         |
| pidigits    | 0.33s    | 0.33s   | 0.48s          | 0.48s         |
| binarytrees | 1.34s    | 1.33s   | 1.53s          | 1.54s         |

No regressions beyond noise on either backend. The BigInt experiment
(3× aarch64) is why the per-limb primitives stay raw.

### What stays raw even after both

- 128-bit helpers (`BigInt.div128`, `mul_wide_hi`) — better served by
  `mul_hi`-style builtins than by unsafe pointers.
- The inline per-element load/store primitives (`Buffer.load*`/`store*`,
  `BigInt` limb access, `Array.at`'s old raw form) that splice into hot
  loops: the aarch64 inline-method ABI (self parking + param marshalling
  per splice) measurably costs more than the raw bodies save. Unsafe
  Nomen wins for once-per-operation primitives (alloc/grow/destroy) and
  non-inline functions; it loses inside tight loops on aarch64. Revisit
  if the inline splice path ever learns to emit naked bodies for
  allocation-free unsafe snippets.
- Result-constructing primitives whose LAYOUT differs per backend
  (`Array.with`/`add`/`mul`: C returns a real struct, aarch64 a
  first-element pointer with the length at `[-8]`) — one Nomen body
  cannot construct both until the language gains a backend-neutral
  "make an Array value" expression.
- `Console.platform` (OS detection) and the `Task`/`Channel` pool internals
  unless externs (pthread) + unsafe (node structs) are pushed through them.
- `Controls/` (UI, `aarch64_use_c` by policy).
- Remaining category A blocks not yet migrated (no measured reason — just
  not done yet): `ClassBuffer.*` (uint64 handle ops — safe future work),
  `JsonTree` slab, `String.slice`/`#op_add`/`#op_mul` (need a view
  constructor or raw memcpy shapes), `Buffer.slice`.

## Benchmark hot-path summary (C backend)

Where the raw blocks actually sit in the current `bench/benchmark.sh`
Nomen/C numbers:

| Benchmark                                        | Touches raw blocks via                          | Category                                           |
| ------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------- |
| nsieve                                           | `Buffer.store_or`/`load`                        | A (irreplaceable)                                  |
| knucleotide                                      | `String.at`, `Buffer.load_int`/`store_int`      | A                                                  |
| json-serde                                       | `JsonTree` slab, `StringBuilder`                | A                                                  |
| pidigits, edigits                                | `BigInt` limb access, `div128`, `mul_wide_hi`   | A                                                  |
| binarytrees, merkletrees                         | class allocation only                           | A (alloc path)                                     |
| lru                                              | `int.hash`, `Buffer`, `LinkedList` (pure Nomen) | A + C.2 (rewritten, measured parity)               |
| regex-redux                                      | `Regex` (pure Nomen incl. `find_next_byte`)     | C.4 (rewritten, measured 2× faster on large input) |
| nbody, spectral-norm, mandelbrot, fannkuch-redux | plain Nomen float/int code only                 | —                                                  |

**The important finding:** every raw block that remains hot in the C
benchmarks is category A — raw memory manipulation that plain Nomen cannot
express. The former category C candidates (now rewritten) sat outside the
benchmark inner loops, and the one measurable case (`find_next_byte`) got
_faster_. Regex.nm is now pure Nomen end to end.

## Procedure for future rewrites

1. Convert one function (or one family, e.g. all identity hashes) at a
   time; delete **both** the `#arch: c` and `#arch: aarch64` blocks and
   write the Nomen body.
2. `npm run check` and `npm test` (the `test/spec/` and `tests/` suites
   cover core behavior).
3. Anything touching a benchmark path: build before/after binaries with
   `bench/compile_nomen.ts <bench.nm> <out> core c` and compare on the
   relevant `bench/benchmark.sh` row's **Nomen/C** column; keep the raw
   version if it regresses beyond noise. Watch for exact-asm aarch64 tests
   (`test/region_pool.test.ts`, `test/scratch_pool.test.ts`, …) that slice
   main's loops by label — use their `main_loops` helper rather than
   hardcoded `.while_N` numbers, since core Nomen loops consume the global
   label counter.
4. Avoid short common local names in core Nomen bodies (see FOLLOWUP.md:
   core locals and user names share one checker namespace, first match
   wins).
5. Add a bump file per AGENTS.md releases policy.
