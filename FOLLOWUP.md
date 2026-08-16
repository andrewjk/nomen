# Follow-ups

Skipped or out-of-scope items recorded for later.

## Compiler / stdlib gaps

1. **Build-backend duplication — shared layer (decided & built).**
   `src/build_common/` owns the genuinely duplicated families:
   `mono_name.ts` (the `List<int>` → `List_int` flattening, previously
   inlined at a dozen sites), `destroy_analysis.ts`
   (`has_destroy`/`struct_needs_destroy`/`struct_needs_auto_destroy`,
   previously two near-identical per-backend predicate families), and
   `param_classify.ts` (`classify_param` — the struct-tag/pointer-count
   decision, previously duplicated between `build_parameter_node` and
   `c_param_decl`, which had even diverged: a `ref` custom-`#init` param
   emitted a by-value signature while the call site passed `&arg`; now
   unified and working, regression test in `test/construction.test.ts`).
   **Decided against sharing the rest:**
   - The tree walks stay per-backend — the backends differ in model, not
     syntax (strings, register allocation, reliance on clang).
   - aarch64's `build_function_node` param loop keeps its own predicates —
     its decision is register allocation (callee-saved vs stack slot),
     which has no C counterpart; and the C body-use registration loops
     keep theirs (deref-at-use ≠ signature-pointer: an array param is a
     pointer but is used directly, never dereferenced).
   - String-ownership analysis — the CLASSIFICATION is now shared and
     stamped: `build_common/string_return_analysis.ts` owns the precise
     borrow-vs-owned body analysis (`borrow_string_names` /
     `value_is_owned_string` / `function_returns_owned`, previously a
     300-line private family in the aarch64 backend), and each gather
     stamps the result on the FunctionNode (`returns_string_borrow`;
     regression test in `test/string_return_analysis.test.ts`). The
     EMISSION models stay deliberately per-backend: C's boundary-strdup
     (callee normalizes, caller always frees) is load-bearing — the C
     backend has no borrow-lifetime tracking for returned aliases, so
     passing borrows through raw would alias caller storage into results
     the caller then frees. The aarch64 backend now normalizes the SAME
     shapes at its return sites (a borrow-valued return from a
     heap-classified function is strdup'd; see ROADBLOCKS "Returning a
     borrowed `string` — FIXED", "Caveat (FIXED)"), so the backends agree
     on observable semantics for the container-borrow family — only
     borrow-PURE functions (e.g. a bare parameter pass-through) still
     differ, with aarch64 passing the borrow through zero-copy instead of
     copying.
     **Go-forward pattern:** for new duplication, prefer pushing the
     DECISION into the check phase as an annotation both backends read
     (`storage_kind`, `nullable_param_indices`, `owned_return` are this
     pattern working) over sharing emission code.

## Differator port (external — `nomen/` in the port project, not this repo)

Status and history in FINDINGS.md / ROADBLOCKS.md. The compiler blockers are
closed; what remains is bounded port-code work:

2. **Finish `combined`** — the move/word-level post-processing
   (`detect_moves` + `reemit` + word pairing) is written but bypassed
   (`combined` returns `histogram(left, right)`) until the shared-ownership
   call sites are reworked to owning extraction (`.pop()` /
   `items.move_T(i)`) or restructured around one owning list.

3. **Finish `renderText` / `renderConsole`** — same shared-ownership family
   in the `split_bare`/`lines_of_bare`/StringBuilder path; `main.nm` still
   prints hunk counts instead of rendered output until those call sites are
   reworked.

4. **Port hygiene / modernization** — run `nomen format`; review the 21 check
   warnings; drop the now-unneeded `List<Token>` wrapper in `diff_arrays`
   (a plain `List<string>` parameter compiles now); optionally switch
   `detect_moves` from the O(n²) scan to `Map<string, List<LineUnit>>`; the
   `has_changes: int` flag and the guarded `int_at`/`int_set`/`unit_at`
   helpers are choices now, not workarounds, and could be simplified
   (nullable structs work; the bounds analyser discharges more shapes).
