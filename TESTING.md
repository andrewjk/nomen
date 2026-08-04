# Nomen Testing

A built-in test runner for Nomen, invoked with `nomen test`. It discovers
`*.test.nm` files, generates a harness that drives each `pub func` declared in
them, compiles + links + runs the resulting program, and renders vitest-style
output from the records the binary streams back over stdout.

This document is the design spec for the feature. The runtime half lives in
[`core/System/Test.nm`](core/System/Test.nm) (the `Tester` class); the compile
half lives in [`cli/src/test.ts`](cli/src/test.ts) and
[`cli/src/bench_loop.nm`](cli/src/bench_loop.nm).

## Goals

- **Tests live next to source, not inside it.** A `*.test.nm` file is ordinary
  Nomen source; no new syntax or magic attributes.
- **Zero new language features.** The harness is generated Nomen code appended
  to the test file, compiled by the existing pipeline. The only special-case is
  `Tester` being auto-resolved by `import System` (see
  [Library Resolution](#library-resolution)).
- **A real assertion object.** `Tester` records pass/fail counts, short-circuits
  the remaining asserts in a test after the first failure (one root cause =
  one failure), and exposes `has_failed` so a test can bail out of expensive
  follow-up work itself.
- **Benchmarks with real statistics** — min / median / mean / max / stddev over
  a sample set — reported alongside tests.
- **Vitest-style output** so the runner feels familiar.

## Test file conventions

A test file is any file matching `*.test.nm`. The runner discovers them
recursively under the target folder (default: the cwd), skipping `build/` and
`node_modules/`.

A test file declares zero or more test functions and zero or more benchmark
functions, distinguished by signature:

```nomen
import System
import System/Test

// Any `pub func` taking `(ref Tester t)` is a test. The `ref` is required so
// the tester can record results.
pub func test_add = (ref Tester t) {
	const result = add(1, 1)
	t.expect(result == 2, "1 + 1 should be 2")
}

// A test function whose body calls `t.bench(...)` / `t.bench_n(...)` is a
// benchmark. The runner detects the call and drives the timing loop itself.
pub func bench_add = (ref Tester t) {
	t.bench("add", add_once)
}
```

Helper functions (not taking `ref Tester t`) are ignored by the runner — they
are ordinary module-level functions the tests can call.

### Discovery rules

- A **test function** is `pub func <name> = ((ref )?Tester t)`. `ref` is the
  normal case; a by-value `Tester t` matches too but cannot record results, so
  it is only useful for compile-only smoke tests.
- A **benchmark function** is a test function whose body contains a
  `t.bench("label", target)` or `t.bench_n("label", target, n)` call. The
  runner extracts `label`, `target` (a named, nullary function reference), and
  the optional sample count `n`. Only the **first** `t.bench(...)` call in a
  function is timed; a function that wants multiple benchmarks should be split
  into several `pub func`s. A benchmark function is excluded from the plain
  test list so it isn't run twice.

## The `Tester` API

`Tester` is defined in [`core/System/Test.nm`](core/System/Test.nm). Every test
function receives one by reference.

### Assertions

```nomen
t.expect(condition, message)   // pass/fail; no-op once this test has failed
t.fail(message)                // unconditional failure (e.g. an unreachable branch)
t.assert(value, message)       // assert a nullable holds a value (see below)
```

- `expect` is the workhorse: it increments `passed` on truthy, records a
  failure otherwise.
- After the first failure in a test, `has_failed` is set and every later
  `expect` / `fail` / `assert` / `bench` in **that test** is a no-op. The next
  test resets `has_failed`. This keeps a single root cause from spamming a
  cascade of follow-on failures.
- `t.has_failed` is public — read it to skip expensive post-mortem work:
  ```nomen
  if t.has_failed {
  	return
  }
  ```

### `assert` (nullable is-not-null)

`assert` checks that a nullable value holds a value. Nomen has no generic
methods, so there is one overload per nullable primitive the compiler can
compare against `null`: `int?`, `uint?`, `int64?`, `uint64?`, `int8?`,
`uint8?`, `float?`, `bool?`, `char?`, `string?`. Nullable _struct_ values
(`Point?`) are not yet supported by the backend — use
`t.expect(p != null, "...")` once that gap closes.

### Benchmarks

```nomen
func add_once = () {
	const _ = add(1, 1)
}

pub func bench_add = (ref Tester t) {
	t.bench("add", add_once)          // default 1000 samples
	t.bench_n("add slow", add_once, 50) // exactly 50 samples
}
```

**Why a named function and not an inline lambda?** Nomen cannot store or call a
function pointer from a parameter (the C backend has no way to emit it), so
`t.bench` only _captures_ the label and sample count. The runner detects the
`target` name statically from the call site, generates a dedicated timing loop
(`bench_loop_<name>`) that calls `target` directly, and reports the result back
through `t.record_bench(...)`. The `func () body` parameter exists purely for
type-checking — it is never invoked through the parameter.

Each benchmark warms up (8 untimed calls), then times `target` once per sample,
sorts the samples, and computes min / median / mean / max / stddev. Samples are
capped at 4096 to keep the on-device sort bounded.

## The `nomen test` command

```bash
nomen test                  # run every *.test.nm under the cwd
nomen test --in src         # run every *.test.nm under src/
nomen test --filter list    # only files whose path matches /list/
nomen test --arch c         # use the C backend instead of AArch64
```

| Option     | Description                                                                     |
| ---------- | ------------------------------------------------------------------------------- |
| `--in`     | Folder to search for `*.test.nm`. Defaults to the cwd.                          |
| `--filter` | Regex; only files whose path matches are run.                                   |
| `--arch`   | `aarch64` (default) or `c`.                                                     |
| `--lib`    | Path to the `System` library folder (auto-resolved from the target by default). |

Files are compiled and run **serially**, one at a time. Each file is an
independent program: parse + check + build + link with `clang` + execute, then
the next file. Serial execution keeps the model simple and avoids contention
during the compile-heavy phase.

### Exit code

Unlike `run`/`build`/`check` (which exit `0` even on compile errors), `nomen
test` exits **`1`** if any test fails or any file fails to build, and **`0`**
only when everything passes. This makes it usable as a CI gate.

### Build output

Each test file's artifacts land in a `build/` folder next to the file, named
after the file stem (e.g. `calc.test.nm` → `build/calc.test.s`,
`build/calc.test`). These are intermediate and may be deleted.

## Harness generation

For each file the runner:

1. Reads the source and extracts the test and benchmark functions.
2. Concatenates the file's source with a generated `main` (and, per benchmark,
   a generated `bench_loop_<name>` timing function from
   [`bench_loop.nm`](cli/src/bench_loop.nm)).
3. Parses + checks + builds the combined program.
4. Links with `clang` and executes it, capturing stdout.
5. Parses the [record protocol](#record-protocol) the binary emits and renders
   the result.

The generated `main` is:

```nomen
import System
import System/Test

pub func main = () {
	var Tester t = Tester()
	t.begin_test("test_add")
	test_add(ref t)
	t.end_test()
	// ...one begin/end pair per test...
	bench_add(ref t)
	if t.bench_pending {
		bench_loop_bench_add(ref t)
	}
}
```

`begin_test` / `end_test` bracket each test with timing and emit its `done`
record; the benchmark functions set `bench_pending`, and `main` responds by
calling the matching `bench_loop_*`.

## Record protocol

The test binary and the runner communicate over stdout using one-line,
machine-readable records. Every record line begins with the literal prefix
`\nomen|` (a backslash followed by `nomen|` — Nomen strings don't process `\n`
as an escape, so the backslash is literal, which keeps records off the same
lines as ordinary `Console.write_line` output). Fields are `|`-separated:

```
\nomen|start|<test>
\nomen|fail|<test>|<message>
\nomen|done|<test>|<passed>|<failed>|<ns>
\nomen|bench|<label>|<n>|<min>|<median>|<max>|<mean>|<stddev>
```

`<message>` may itself contain `|` — the runner only splits fields up to the
fixed arity of each record kind, so the remainder is taken verbatim. Anything a
test prints that does not start with `\nomen|` is forwarded verbatim and shown
beneath the file when it fails.

## Output format

The runner mimics vitest's summary style. Per file:

```
 ✓ src/math/add.test.nm (3 tests) 12ms
 ✓ src/text/trim.test.nm (14 tests) 7ms
 ✗ src/events/keyboard.test.nm (1 test) 9ms
   ✗ test_key_down expects key code (1 passed, 1 failed)
   ❯ keyboard input was empty
   ⏱ parse_keys (n=1000) min 412ns median 480ns mean 502ns max 2.1µs ± 78ns
```

And a trailing summary:

```
 Files  3 1 failed (3)
 Tests  18 1 failed (17 passed, 1 failed)
 Time   78.04s
```

A file that fails to parse/build is reported as a build failure with the
compiler errors inline; a file whose binary crashes is reported with whatever
records it managed to emit plus a crash notice.

## Library resolution

The generated `main` only carries `import System`. For that to resolve
`Tester`, the compiler's `BASE_TYPES` list (in
[`src/parse.ts`](src/parse.ts)) includes `Tester`, so a plain `import System`
pulls in `Test.nm`'s source the same way it pulls in `List` or `Console`. Test
files conventionally also `import System/Test` for editor/source-map purposes;
the dependency walker deduplicates the source either way.

The `System` library itself is located by walking up from the target folder
looking for a `package.jsonc` whose package is (or imports) `System`, or a
`core/` layout with a `System` subfolder — mirroring the `run`/`build` library
resolution.
