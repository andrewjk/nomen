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

## aarch64: stale d0 when a stored float is converted later

The aarch64 backend returns `float` values as BITS in an integer register
(`fmov x0, d0` after the call — see `SplitView_position` in any generated
`main.s`). When the result is stored to a variable and only later converted
with `as int`, the use site emits `fcvtzs x0, d0` — reading the *raw double
register*, which intervening calls have long since clobbered — instead of
first materializing the stored bits (`fmov d0, x0`). Converting INLINE
(`\{c.position() as int}` at the call site) works, because d0 still holds
the return value there.

Surfaced by `core/System/Controls/SplitView.nm` (`position()` — a stored
`const float pos = split.position()` then `\{pos as int}` printed 0 while
the C side computed 100.0). The gui_split_view test works around it with
the inline form. Proper fix: in the aarch64 codegen, a float value loaded
from a variable slot must `fmov d0, x0` before any FP use (`as int`, float
arithmetic, float args).

## Formatter drift: in-source rules vs the published 0.7.1 release

Running the locally-built CLI's `nomen format` over `core/System` rewrites
~30 files: it wants `struct X: Control` (no space before the trait colon)
and re-indents comments inside `#init` bodies, while every committed file
(including the Tier 2 controls added this cycle) follows the 0.7.1
formatter's `struct X : Control` + comment style. The demo programs' trims
(`strip_redundant_types` etc.) also differ. Until the next nomen-lang
release ships the new rules, `nomen format` cannot be run across the repo
without a whole-repo style churn commit — pick one: either a dedicated
"Style: reformat System library" commit or hold the in-source changes until
release.

