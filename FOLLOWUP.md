# Follow-ups

Skipped or out-of-scope items recorded for later.

## Compiler / stdlib gaps

1. **Mono-body annotation re-derivation is partial.**
   `rederive_access_func_annotations` (`src/check/check_function_call_node.ts`)
   recovers `owned_return`, `mangled_name`, `nullable_param_indices`, and
   variadic info on cloned/monomorphized bodies, but return-contract
   evaluation and nursery.spawn recognition are left for a future pass (see
   ROADBLOCKS "`clone_node` drops check-phase annotations — FIXED").

2. **Formatter: no reflow of long single-line signatures.** Multi-line
   signatures are preserved as written and trailing commas stripped, but a
   long single-line parameter list is never auto-broken onto multiple lines
   (see ROADBLOCKS "Multi-line / trailing-comma parameter lists — FIXED",
   closing note).

3. **Backend divergence: returning a container borrow.** On C, returning
   `xs.at(i)` hands the caller an independent (strdup'd) copy; on aarch64 it
   yields a borrow tied to the receiver's storage. Sound, but the two
   backends differ (see ROADBLOCKS "Returning a borrowed `string` — FIXED",
   "Caveat (unchanged)").

4. **`List<T>` (generic container) as an explicit struct-field type doesn't
   monomorphize.** `struct Group { var List<int> items }` checks clean but
   the C backend emits `struct List` (the bare generic) in the synthesized
   `Group_init` signature and the field default wins over the constructor
   arg (`_self.items = Buffer_int_init()` vs `_self.items = *items` —
   conflicting types). A default-valued field (`var List<int> items =
List<int>()`) works on both backends; `check_struct_node` needs the same
   `instantiate_generic_type` treatment that params/returns/local
   declarations get. Found while testing `List<T>.copy()` on a field.

## Differator port (external — `nomen/` in the port project, not this repo)

Status and history in FINDINGS.md / ROADBLOCKS.md. The compiler blockers are
closed; what remains is bounded port-code work:

5. **Finish `combined`** — the move/word-level post-processing
   (`detect_moves` + `reemit` + word pairing) is written but bypassed
   (`combined` returns `histogram(left, right)`) until the shared-ownership
   call sites are reworked to owning extraction (`.pop()` /
   `items.move_T(i)`) or restructured around one owning list.

6. **Finish `renderText` / `renderConsole`** — same shared-ownership family
   in the `split_bare`/`lines_of_bare`/StringBuilder path; `main.nm` still
   prints hunk counts instead of rendered output until those call sites are
   reworked.

7. **Port hygiene / modernization** — run `nomen format`; review the 21 check
   warnings; drop the now-unneeded `List<Token>` wrapper in `diff_arrays`
   (a plain `List<string>` parameter compiles now); optionally switch
   `detect_moves` from the O(n²) scan to `Map<string, List<LineUnit>>`; the
   `has_changes: int` flag and the guarded `int_at`/`int_set`/`unit_at`
   helpers are choices now, not workarounds, and could be simplified
   (nullable structs work; the bounds analyser discharges more shapes).
