# Changelog

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
