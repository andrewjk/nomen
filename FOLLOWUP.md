# Follow-ups

Recorded issues that were deliberately not fixed inline (out of scope for the
task that surfaced them). Each entry: what was seen, where, and any context
needed to pick it up later.

## aarch64_use_c bodies silently drop Nomen statements in mixed bodies

When a function's body mixes `#arch: aarch64_use_c` raw blocks with regular
Nomen statements, the aarch64 backend routes the whole function to the C
companion using ONLY the concatenation of the raw blocks
(`check_c_fallback` in `src/build_aarch64/build_raw_node.ts` collects
`raw_code`; `generate_c_function` in `src/build_aarch64/utils/c_companion.ts`
emits exactly that). Any Nomen statements around the raw blocks are silently
dropped — the C backend compiles the full statement list, so the same source
behaves differently per backend.

Surfaced by `core/System/Controls/Spinner.nm` (`start`/`stop` originally
ended with a Nomen-level `self.spinning = true/false` after the raw
startAnimation/stopAnimation blocks): the flag was maintained on the C
backend but never on aarch64. Worked around in Spinner by moving the flag
write INTO the raw bodies (`self->spinning = 1;`), which is also the
established pattern for the other controls.

Proper fix options: emit the Nomen statements into the companion as
generated C (hard — needs a full Nomen→C body compiler for the aarch64
path), or reject mixed bodies at parse/check time with a clear error so the
gap is never silent.

## TextView.set_placeholder relies on AppKit's private KVC placeholder

`core/System/Controls/TextView.nm`, `set_placeholder`: AppKit has no public
NSTextView placeholder API, so the implementation goes through KVC
(`setValue:forKey:@"placeholderString"`). It draws correctly in a live window
on this macOS version, but two caveats:

- `cacheDisplayInRect:` (offscreen rendering, e.g. a screenshot-based test)
  does NOT draw the placeholder — the value round-trips through KVC but stays
  invisible. So placeholder rendering cannot be verified offscreen; only in a
  real window.
- Being private API surface, a future macOS could drop it entirely.

If that happens, the fallback is an NSTextField hint overlaid on the text
view (subview, pinned to the top edge via autoresizing mask, hidden through a
runtime-built `textDidChange:` delegate — same pattern as Container's
NomenResizeDelegate), plus an explicit visibility update in `set_text`.

## TextBox iOS `get_text` selector typo

`core/System/Controls/TextBox.nm`, the `get_text` `#arch: aarch64_use_c` /
`#platform: ios` block sends `sel_registerName("text.ptr")` — a typo'd
selector (should be `"text"`, as the sibling `#arch: c` iOS block does).
Untested on this machine (iOS blocks never compile on a macOS host); noticed
while writing SecureField's parallel blocks. One-character fix whenever iOS
builds get exercised.
