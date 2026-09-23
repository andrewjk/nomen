# Changelog






## 0.2.4
<sub>2026-09-23</sub>

-  *(patch)* - Feat: highlight types and balance angle brackets
-  *(patch)*
  Strip redundant generic constructor annotations (`var keys = Buffer<TK>()`); infer the type instead. Colour generic `<...>` brackets and type parameters in the extension.

## 0.2.3
<sub>2026-09-17</sub>

-  *(patch)* - Add internal visibility modifier; make Buffer internal to the System library
-  *(patch)* - Add readonly fields (read anywhere, assignable only inside the declaring type)
-  *(patch)* - Re-export Buffer with a sound public API; drop the _T suffix from the size-aware primitives
-  *(patch)* - Enforce internal type-name visibility; fix generic struct-field swap codegen

## 0.2.2
<sub>2026-09-14</sub>

-  *(patch)* - Test files follow src module imports transitively; highlight swap keyword

## 0.2.1
<sub>2026-09-10</sub>

-  *(patch)* - Fix namespace imports resolving directories and spaced :: segments

## 0.2.0
<sub>2026-09-10</sub>

-  *(minor)*
  Rename keywords: `mov` → `move` (reads as English like the rest of the keyword set) and `strict` → `must_use` (names the actual rule — values may not be silently discarded — and avoids the one-letter `struct` collision)

## 0.1.0
<sub>2026-09-09</sub>

-  *(minor)* - Replace / namespace separator with :: and add qualified references (Namespace::Name) in code
-  *(patch)*
  Fix: editor loads project-relative imports (subfolder modules) for hover/go-to-definition/diagnostics, refs work on generic type arguments, and import validation only applies to System-rooted paths
