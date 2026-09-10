# Changelog



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
