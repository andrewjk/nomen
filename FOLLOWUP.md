# Follow-ups

Skipped or out-of-scope items recorded for later.

## Pre-existing aarch64 SIGSEGV: `ClassBuffer_CharChange_destroy` reads a garbage element pointer

Found while hunting the Differator repro leaks; **predates the leak fixes in this
change set** (verified by stashing all local modifications and rebuilding — the
crash still reproduces on HEAD).

**Repro** (uses `test/repro/` as the module folder; sibling files are pulled in
automatically):

```nm
import System
import combined

pub func main = (Init init) {
	var List<Diff> diffs = histogram("a\nb\n", "a\nB\n")
	var List<LineUnit> units = collect_units("a\nb\n", "a\nB\n", diffs)
	var List<LineUnit> dels = List<LineUnit>()
	var List<LineUnit> ins = List<LineUnit>()
	gather_for_diff(units, 0, ref dels, ref ins)
	Console.write_line("\{dels.length} \{ins.length}")
}
```

Run: `nomen run --in <file>.nm --arch aarch64` (C backend is fine).

**Symptoms**

- Crashes in `ClassBuffer_CharChange_destroy` at
  `.LClassBuffer_CharChange_cb_destroy_loop`: `ldr x0, [x20, x22, lsl #3]` loads
  `0x6800000000000000` from an element slot — a garbage/uninitialized pointer,
  not a valid `CharChange*`.
- lldb backtrace goes through `List_CharChange_copy` →
  `.return_List_CharChange_copy + 44`, i.e. the List<CharChange> copy path
  destroys/re-reads elements whose slots were never populated by the copy loop.

**Observations that may help**

- `Diff`'s generated field offsets are odd: `bool moved` at 88, `int
has_changes` at 89, and the `mov List<CharChange> changes` pointer at **97** —
  an 8-byte pointer at an unaligned offset. `Diff_init` copies the List into
  [x19, #97] word-by-word. Unaligned `ldr` works on Apple Silicon, but any
  path assuming 8-byte alignment (element stride math, memcpy, atomics) will
  corrupt.
- `ClassBuffer_CharChange_destroy`'s element loop is entered even when the
  buffer's `data` is non-null but the element slots were only partially
  initialized, suggesting the copy/destroy pairing around `List_CharChange_copy`
  (used by `List<T>` copy semantics) disagrees about element count or stride.
- The full `combined()` repro does **not** crash — only this narrower
  `gather_for_diff` path does — so some interleaving of List copies and
  destroys leaves a stale/garbage slot behind.
- Was not fixed here: it is a pre-existing miscompile/corruption bug distinct
  from the ownership leaks being fixed, and reproduces with every leak fix
  stashed.

## Latent ownership-tracking holes (not hit by the repro, left unfixed)

- **aarch64 `self.field = <heap string>` inside a value-struct method**: the
  assignment writes through to the caller's storage, so the new
  `heap_string_fields` tracking deliberately does not record it (double-free at
  method scope exit). That means such an assignment's old value is reclaimed
  eagerly (correct), but if the method's caller also assigns the same field
  later, the record may not reflect reality. Narrow, but worth a test when
  value-struct methods with string fields become common.
- **C mov-site splice is frame-local**: `build_access_node` /
  `build_function_call_node` splice `mov` args from `status.scoped_declarations`
  (current frame only). A `mov` of an OUTER-scope variable inside an `if`
  branch fails to splice (same for aarch64 `mark_moved_if_struct`'s
  `is_local`), so the outer scope-exit cleanup can still reclaim the moved
  value — a latent double-free. Mirror of the return-path scope bug fixed via
  `c_scope_stack` / `outer_scope_declarations`, but for mov sites.
