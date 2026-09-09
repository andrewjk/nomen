# Core library raw blocks (`#arch:`) — inventory and plain-Nomen rewrite analysis

The core library (`core/System/*.nm`) implements most functions as raw
`#arch: c` (C source for the C backend) + `#arch: aarch64` (assembly for the
aarch64 backend) block pairs. This document inventories every raw block
outside `Controls/` (which is UI code — `aarch64_use_c` territory, out of
scope), classifies why each is raw, and identifies which could become plain
Nomen code without regressing the **C backend** benchmarks (the aarch64
backend is not at parity and is explicitly not the target here).

See also [AGENTS.md](./AGENTS.md) ("Inline code blocks") for the directive
mechanics.

## Key facts that shape the analysis

- **One translation unit, clang -O2.** `bench/compile_nomen.ts` joins the
  program *and* the whole core library into a single C file compiled with
  `clang -O2`. Plain-Nomen rewrites therefore get full LLVM inlining and
  optimization — there is no per-call overhead penalty for small Nomen
  functions, unlike the aarch64 backend where every call is real.
- **Constraints are proven, not checked.** Parameter constraints (e.g.
  `at`'s `index >= 0 && index < self.length`) are discharged at compile time
  by the constraint evaluator (`evaluate_const_condition` +
  `src/check/utils/flow_bounds.ts`). Loop-carried index bounds *are*
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

| File | Functions | Why raw |
|---|---|---|
| `Buffer.nm` (27 funcs) | alloc/grow/zero/load/store/store_or/move/replace/shift + `_int`/`_T`/`_float` variants, slice, #destroy | `data` is a `uint64` slab handle, cast to `int*`/`T*`/`double*` per access; calloc/realloc/memset/memcpy |
| `ClassBuffer.nm` (13) | alloc_int/grow_int/load_int/grow_T/load_T/store_T/move_T/store_int/move_int/replace_int/replace_T/shift_T/slice/#destroy | Same pattern plus per-element destroy; monomorphizer rewrites `Buffer<T>` fields to this for classes |
| `Array.nm` (9) | #init, at, first, set, at_end, slice, with, add, mul | Elements stored inline after the header (`(T*)((char*)self + sizeof(*self))`); `T_NEEDS_STRDUP` string-slot specialization |
| `BigInt.nm` (7) | get, set, data_ptr, get_at, set_at, div128, mul_wide_hi | uint64-as-pointer limb access; `div128` needs `unsigned __int128` 128/64 divide (aarch64: `___udivti3`); `mul_wide_hi` needs the high half of a 64×64 product (`umulh`) — no 128-bit ops in Nomen |
| `StringBuilder.nm` (5) | ensure, append_char, append_string, to_string, #destroy | uint64 byte-buffer handle + realloc/memcpy; `to_string` transfers ownership of the raw buffer |
| `JsonTree.nm` (3) | alloc_node, free_text, set_text | strdup directly into the node slab (file header: cannot go through load_T/store_T without double-free) |
| `String.nm` (3) | at, set, slice | Pointer arithmetic on the fat-string ptr (`self + start`, `(*self)[index]`) — this *is* the primitive everything else indexes through |

BigInt is the clearest example of the intended split: every algorithm
(add/sub/mul/Karatsuba/Knuth-D/normalization) is plain Nomen; only the six
limb-access/128-bit primitives are raw, and they are genuinely
inexpressible.

### B. Must stay raw — libc / OS calls

| File | Functions | Why raw |
|---|---|---|
| `Console.nm` | write, write_line, read_line, read_char, platform | stdio; platform detection |
| `Time.nm` | now_ms, now_ns, now_unix, sleep_ms | clock_gettime / nanosleep |
| `Mutex.nm` | all | pthread mutexes |
| `Task.nm` | all | thread pool, cancellation state |
| `Channel.nm` | all | pthread mutex/cond + malloc'd intrusive nodes held in uint64 fields |
| `Stream/File.nm`, `Stream/Directory.nm`, `Stream/Http.nm` | all `raw_*` | fopen/opendir/socket layer |
| `Init.nm` | parse_int | atoi |
| `int.nm` | parse | atoi (whitespace/sign/nondigit semantics; not worth re-deriving in Nomen) |
| all numeric types (`int8`–`int64`, `uint8`–`uint64`, `int`, `uint`, `float`, `float32`, `float64`, `ufloat*`, `char`) | to_string | snprintf |
| `Math.nm` | sqrt, log | libm (aarch64: `fsqrt` is single-instruction) |
| `String.nm` | to_string (strdup), #op_add (malloc + two memcpy), #op_mul (malloc + memcpy loop) | Needs malloc/memcpy; note the asm versions exploit the tracked length while the C versions strlen — replacing the C with length-based Nomen would require raw memcpy access anyway |
| `String.nm` | #op_eq | C uses libc `strcmp`/asm uses `memcmp` with the length pre-check — both vectorized. A Nomen byte-loop is 1 byte/iter; LLVM's loop-idiom → `bcmp` transform is not guaranteed once the length guard is in front. Keep until measured (see C.4) |
| `Regex.nm` | find_next_byte | `strpbrk` (see C.5) |

### C. Rewrite candidates — pure logic, expressible in plain Nomen

Ordered by confidence. For each: expected C-backend impact ≈ zero, because
clang -O2 sees the same single TU either way.

1. **`Math.power`** — a multiply loop. Direct transcription:
   `var result = 1; var i = 0; while i < exp; i += 1 { result *= base }`.
   Trivially identical codegen. Zero risk.
2. **Hash functions (identity casts):** `int`, `int8`–`int64`, `uint`,
   `uint8`–`uint64`, `char`, `bool` — all are `return (unsigned long)self;`.
   Becomes `return self as uint` (the `as`-cast path is already exercised:
   `BigInt.to_digit`, `Map`'s `key.hash() as int`). Identity codegen. Hot in
   lru (`Map<int,int>` hashes on every get/put) — but identity is identity.
   Zero risk, 12 functions of readability gained.
3. **`String.hash`** — djb2. Nomen form: loop `0..self.length` calling
   `self.at(i)` (which stays raw, category A). The constraint evaluator
   proves the loop bounds, so no runtime checks; at -O2 `at` inlines to the
   same `ldrb`. One semantic note: the current C body NUL-scans instead of
   trusting `length` (fine for owned strings and literals, which is all
   `hash` receives); the Nomen version *requires* the length and is
   actually the more honest of the two — it matches the aarch64 body's
   semantics exactly. Not on any benchmark hot path (knucleotide packs
   2-bit keys into ints; lru hashes ints). Low risk.
4. **`String.#op_eq`** — *measure first*. Nomen form would mirror the asm:
   length compare + per-byte loop. Risk: losing libc `strcmp`'s
   vectorization on the C backend for long common prefixes. Currently no
   benchmark appears to string-compare in its inner loop (json-serde
   dispatches on int kinds; knucleotide compares ints), so the risk is
   theoretical — but this is the one rewrite where a before/after
   `bench/benchmark.sh` Nomen/C comparison should gate the change.
5. **`Regex.find_next_byte`** — *measure first*. `strpbrk` vs a Nomen
   double loop over `input[pos..len)` × `charset` (charset is ≤ 4 bytes in
   practice, so the inner loop unrolls to a small OR-tree — likely
   competitive, but regex-redux is a benchmark and `strpbrk` is SIMD).
   Gate on a regex-redux Nomen/C before/after.

### Not candidates

- `Console.read_line`/`read_char` (getline/fgetc), everything in `Stream/`,
  `Task`, `Mutex`, `Time`, `Channel` — thin libc/OS wrappers where a Nomen
  rewrite would just re-express the same calls with more code.
- `Controls/` — UI layer; `aarch64_use_c` there is by policy (AGENTS.md).

## Benchmark hot-path summary (C backend)

Where the raw blocks actually sit in the current `bench/benchmark.sh`
Nomen/C numbers:

| Benchmark | Touches raw blocks via | Category |
|---|---|---|
| nsieve | `Buffer.store_or`/`load` | A (irreplaceable) |
| knucleotide | `String.at`, `Buffer.load_int`/`store_int` | A |
| json-serde | `JsonTree` slab, `StringBuilder` | A |
| pidigits, edigits | `BigInt` limb access, `div128`, `mul_wide_hi` | A |
| binarytrees, merkletrees | class allocation only | A (alloc path) |
| lru | `int.hash`, `Buffer`, `LinkedList` (pure Nomen) | A + C.2 |
| regex-redux | `Regex` (pure Nomen) + `find_next_byte` | B + C.5 |
| nbody, spectral-norm, mandelbrot, fannkuch-redux | plain Nomen float/int code only | — |

**The important finding:** every raw block that is hot in the C benchmarks
is category A — raw memory manipulation that plain Nomen cannot express.
The category C rewrites (C.1–C.5) are outside the benchmark inner loops
(except C.5, which is measurable and gated). Rewriting them is a pure
readability/maintainability win with no expected Nomen/C regression.

## Recommended procedure for a rewrite PR

1. Convert one function (or one family, e.g. all identity hashes) at a
   time; delete **both** the `#arch: c` and `#arch: aarch64` blocks and
   write the Nomen body.
2. `npm run check` and `npm test` (the `test/spec/` and `tests/` suites
   cover core behavior).
3. For C.4/C.5 (and anything else touching a benchmark path): build
   before/after binaries with
   `bench/compile_nomen.ts <bench.nm> <out> core c` and compare on the
   relevant `bench/benchmark.sh` row's **Nomen/C** column; keep the raw
   version if it regresses beyond noise.
4. Add a bump file per AGENTS.md releases policy.
