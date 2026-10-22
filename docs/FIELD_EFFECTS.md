# Field-Scoped Borrow Invalidation by Declared Effect Sets

Written 2026-10-23. Picks up the FOLLOWUP.md entry "Field-scoped borrow
invalidation (Valen-style effect precision)" (recorded 2026-10-12, out of the
Valen comparison in [GROUP_BORROWING.md](./GROUP_BORROWING.md)) and replaces
that entry's proposed mechanism: instead of scanning method bodies for the
fields they touch, each mutator **declares** the fields it may displace, and
the checker verifies the declaration against the body. The declaration is the
whole truth; nothing is inferred.

This document is self-contained — it can be implemented from scratch without
the conversation that produced it.

## The problem

Nomen's borrow checker keys borrows on the **root variable name** of the
owner. `borrow_owner_of` (`src/check/utils/borrow.ts`) resolves any borrow
down to its ultimate owner variable; `var Box<Data> b = h.data` records only
`borrowed_from: "h"`. When any `ref self` method is called on the receiver,
the single invalidation site — `check_access_node.ts:956` — fires
`invalidate_borrows_of(status, owner)`, poisoning **every** live borrow with
that owner:

```nomen
import System

mv struct Data {
	var int value
}

mv struct Holder {
	var int scratch
	var Box<Data> data

	func poke = (ref self) {
		self.scratch = self.scratch + 1
	}
}

pub func main = () {
	var h = Holder(0, mv Box<Data>(Data(1)))
	var Box<Data> b = h.data   // borrow rooted at h, via `data`
	h.poke()                   // writes only `scratch`...
	Console.write_line("\{b.value}")
}
// Error: Borrow 'b' was invalidated by a mutation of its owner of 'h';
// re-fetch it after the mutation
```

`poke` cannot have displaced `b`, but the checker cannot say so, because the
borrow's key does not include the field it came through. The error message is
the workaround ("re-fetch it after the mutation"), and that false-positive
class is the cost of the coarseness. GROUP_BORROWING.md's shortfall list
("mutate-one-part-while-borrowing-another", view-field poisoning) are the
same coarseness at larger shapes.

## Why declared effects, not body scans

The original FOLLOWUP sketch derived effect sets by syntactically scanning
each method body (mirroring the whole-program scans like
`src/build_common/scan_borrow_returns.ts`), unioning callees' sets in a
memoized fixpoint. That design was rejected on 2026-10-23 for two reasons:

1. **Reasoning burden.** With a scan, understanding what a call invalidates
   means stepping into the callee's body — and transitively into everything
   it calls. The design goal is that **the function's signature is all you
   need to know to understand the code**: one line, no recursion. A scan
   turns "step through each line" into "step through each line and recurse
   into functions."
2. **A memory/speed trap.** The scan needs a second AST pass, a memoized
   call-graph table, and cycle-safe fixpoint logic, all to derive information
   that is cheaper to *state*.

The declared form inverts the flow: the author states the effect set in the
signature, and the checker verifies the body against it. The signature
**cannot lie**, which is what makes it safe to reason from — the same
prove-it philosophy as Nomen's bounds contracts
(`entity_id: entity_id >= 0 && entity_id < world.entities.length`):
declared *and* enforced, never inferred.

A side benefit: it encourages the right shape of program. Most functions
should not mutate anything, and those stay bare-`self` readers with nothing
to declare. The annotated population is mutators only.

## The design

Two halves: borrow-side plumbing (unchanged from the original sketch) and the
declared effect set as the source of truth (new, replacing the scan).

### 1. Borrow-side plumbing: `borrowed_via`

- `borrowed_via?: string` on `StackValue` (`src/check/StackValue.ts`),
  stamped alongside the existing `borrowed_from` at borrow-creation time:
  - field-access borrows get the accessed field name (`h.data` → `data`);
  - method-return borrows get the terminal field of the receiver path
    (`z.animals.at(i)` → `animals`).
- `invalidate_borrows_of(status, owner, fields?)`: with a field set, poison
  only borrows whose `borrowed_via` is in the set. Unstamped/unknown borrows
  are still invalidated (conservative default). Without a set, today's
  whole-owner behavior.
- Object-level aliases (`ref Box<T> q = b` — no `borrowed_via`) are never
  touched by field effects: they point at the instance itself, which only
  owner reassignment/destroy can displace, and that path is deferred
  reclamation today.
- Data-structure note (from the Ante places-over-lifetimes addendum in
  GROUP_BORROWING.md): key borrows as place-sets — `(owner root, field path)`
  pairs — rather than bare field-name strings, so a future place-carrying
  container (`at_ref` returning element references) extends this structure
  instead of reworking it. `borrowed_via` can stay the serialized string;
  path comparison is what matters.

This half is inert on its own: with no source of field sets, every
invalidation is whole-owner, byte-for-byte today. It can land first.

### 2. The declared effect set

A `ref self` parameter may carry a `mutates` clause naming the fields of
`self` the method may displace or free:

```nomen
func poke  = (ref self mutates nothing) { ... }   // touches only value-type fields
func load  = (ref self mutates data, cache) { ... }
func merge = (ref self mutates items, mv List<T> other) { ... }
func take  = (var self) { ... }                   // whole receiver; no narrowing exists
```

Defaults and scope:

- **Un-annotated `ref self` = wildcard** — today's whole-owner invalidation.
  Zero churn: existing code and tests are untouched; precision is opt-in per
  method. The corollary (accepted): un-annotated library methods stay coarse.
- **bare `self` unchanged** — reader, invalidates nothing. The immutability
  exemption is structural, as today.
- **`var self` unchanged** — takes the whole receiver; every borrow rooted
  there dies regardless of any clause. The clause narrows `ref self` only.
- **Value-type fields never need declaring.** Writing an `int` (or a fixed
  array, or any field with no heap interior) cannot free or displace
  anything, so value-type writes are exempt from rule 1 below. This is
  Nomen's version of Valen's "type stability exception," and it is why
  `poke`'s body checks clean against `mutates nothing`.

Verification is entirely **local** — three rules checked against the method's
own body in the existing per-method check pass. No second pass, no call-graph
fixpoint, no memoization beyond the parsed signatures:

1. **Direct displacement**: `self.X = …` or an `mv` transfer into `self.X` →
   `X` must be in the declared set, unless `X` is a value type.
2. **Receiver-field mutators**: a `ref self` call on a `self.X` receiver
   (`self.items.push(…)`) → `X` must be in the declared set. This rule is
   call-site-local: it needs nothing from `push`'s body — any mutator on the
   `self.X` receiver threatens `X`.
3. **Callee subsets**: a call to another `ref self` method → the callee's
   declared set must be a **subset** of the caller's declared set. This is
   the entire transitivity story, checked one call at a time: when writing a
   method you read only the signatures of what you call — which you have open
   anyway, same as parameter types. When reading a call site, the clause is
   the answer.

Violation examples:

```nomen
func bad = (ref self mutates nothing) {
	self.data = mv Box<Data>(Data(0))
}
// Error: 'bad' declares mutates nothing, but the body writes self.data

func calls_wider = (ref self mutates nothing) {
	self.replace()   // replace declares mutates data
}
// Error: 'replace' may mutate 'data', which 'calls_wider' does not declare
```

### The user-facing payoff

```nomen
pub func main = () {
	var h = Holder(0, mv Box<Data>(Data(1)))
	var Box<Data> b = h.data   // borrow rooted at h, via `data`

	h.poke()                   // declared: mutates nothing → invalidates nothing
	Console.write_line("\{b.value}")   // ACCEPTED — b survives

	h.replace()                // declared: mutates data
	Console.write_line("\{b.value}")
}
// Error: Borrow 'b' was invalidated by a mutation of its owner of 'h';
// re-fetch it after the mutation
```

The false-positive class shrinks to the cases where the borrowed field
genuinely could have been displaced. Direction of compatibility is safe:
this is purely a relaxation — anything that compiles today still compiles.

### Traits

The trait's method declaration carries the set. Calls through the trait type
use the trait's declared set; a conformer may declare a **subset**, never a
superset (a conformer that widens is rejected at the declaration). Read the
trait, know the contract — no body knowledge anywhere, including at the
definition sites of conformers' callers.

### Unchanged invalidation paths

- **View-source reassignment** (`check_assignment_node.ts:404`,
  `invalidate_view_borrows_of`) stays whole-field: a `view` slice's backing
  buffer actually frees at reassignment, so there is nothing to narrow.
- **`var self` / owner reassignment / destroy**: whole-receiver by nature
  (deferred reclamation keeps same-scope borrows alive, as today).
- Out of scope here, enabled later by the same machinery: narrowing the
  view-field struct poisoning (one mutated view source currently poisons
  every view field of a struct — GROUP_BORROWING.md shortfall 2). The
  plumbing's place-set keys are the extension point.

## Recorded syntax decisions

Decisions made 2026-10-23, with the alternatives and why they lost:

- **Direction — capability, not invalidation.** Declare what the method *may
  mutate* (`mutates data`); derive the invalidation (borrows via `data` die).
  The alternative phrasing, `mutate(self) invalidates self.data`, has the
  direction backwards: "invalidates" is a promise about callers' state, which
  is the wrong ownership. Capability declarations compose (rule 3); promises
  about callers do not.
- **Placement — receiver-attached, in the param list**
  (`ref self mutates data`), not a trailing clause
  (`func load = (ref self) mutates data { … }`). Reasons:
  1. The clause is a property of the *borrow*, not the function. Nomen
     already encodes receiver capability through the receiver param (bare
     `self` / `ref self` / `var self`); field-narrowing is a refinement of
     that same axis.
  2. Precedent: parameter constraints (`entity_id: …`) already live in the
     param list, next to the thing they constrain. Effects constrain the
     receiver borrow; same home.
  3. It generalizes for free: if free-function `ref` params ever start
     invalidating (the `step(ref World world, …)` shape gets effect precision
     someday), the syntax extends with no new grammar —
     `func step = (ref World world mutates entities, int id: …)`.
     (Verified 2026-10-23: the checker has exactly two invalidation sites —
     the `ref self` arm and view-source reassignment — so free `ref` params
     don't invalidate today, and self-only attachment loses nothing.)
- **Keyword — `mutates`.** Alternatives considered:
  - `mut` (Valen's word): rejected — differs from `mv` by one letter, and
    `mv` saturates transfer positions in this language. `mv data` / `mut
    data` in adjacent lines will be misread as typos forever.
  - `in` (echoing Valen's `entity in world.entities[]`): rejected — reads as
    *placement* ("self lives in data"), and the clause is *capability*.
  - `writes`: viable fallback — accurate (`self.items.push(…)` is a write
    through `items`), no collisions, one letter shorter.
  - The length of `mutates` is a one-time read cost per mutator, on the line
    that most needs documentation; the `mut`/`mv` collision would be a
    permanent tax on every read.
- **Set delimitation — open, pick at implementation time.**
  - Comma list terminated by the first non-identifier token
    (`mutates items, mv List<T> other` — `mv`/`ref`/`out`/a type all end the
    set). Needs an LL(k) rule and formatter/LSP awareness; keeps the param
    list brace-free.
  - Braced set (`mutates {data, cache}`): unambiguous, visually grouped, and
    gives the empty case a tidy spelling (`mutates {}` vs `mutates nothing`).
  The empty case needs a spelling either way (`mutates nothing` / `mutates
  {}`); `pure` was rejected — bare-`self` already *is* the read-only case,
  and an empty-mutates `ref self` method is a genuinely different middle
  ground ("mutates self, but only value-type storage").

## Honest costs (accepted)

- **Abstraction leak, for real.** A field name is now contract surface —
  exactly the constraint GROUP_BORROWING.md flagged as the reason the
  original sketch kept effect sets compiler-internal. Softened by the fact
  that callers never *write* the field name (they call `h.poke()`; the
  difference is behavioral, not textual). Hiding `data` behind an accessor
  later means editing the declaration. If that ever actually hurts, the
  mitigation from GROUP_BORROWING.md is named field groups —
  `group payload = { data }`, then `mutates payload` as a stable effect
  name. Not designed; recorded as the escape hatch.
- **Annotation churn.** Extracting a write into a helper updates declared
  sets up the call chain — the Java-checked-exceptions feeling. This is the
  irreducible price of "the signature is the whole truth": someone maintains
  the truth. Valen pays it; Rust avoids it by being coarse.
- **Wildcard default coarseness.** Un-annotated mutators (including library
  code you don't control) keep whole-owner invalidation — practically the
  same outcome as the scan design's opaque-body fallback.

## Forward compatibility

The declared set is a serialized field path today (`data`). The Ante note in
FOLLOWUP.md (and the GROUP_BORROWING.md addendum) applies unchanged: grow the
key to place-paths (`animals[i]`) later — same clause, same data, no grammar
change. The trait-narrowing rule and the subset rule are already phrased over
sets, not names.

## Implementation plan (staged)

1. **Plumbing (inert).** `borrowed_via?: string` on `StackValue`; stamp it at
   borrow-creation sites (field-access reads in `check_access_node.ts`,
   method-return borrows in `borrow_owner_of`); add the optional `fields`
   parameter to `invalidate_borrows_of` (`src/check/utils/borrow.ts`); call
   sites pass nothing yet. No behavior change.
2. **Parse.** The `mutates` clause on the `self` param (`src/parse/`); store
   the set on the self param node (`src/nodes/` — params carry
   `is_self_param`/`is_ref` already). Both delimitation options evaluated
   here.
3. **Verify.** The three local rules in the method-body check
   (`src/check/`). Error messages suggested in the examples above.
4. **Wire.** At `check_access_node.ts:956`: resolve the receiver owner (as
   today), take the callee's declared set (or wildcard when un-annotated),
   pass it to `invalidate_borrows_of`. `var self` path unchanged.
5. **Traits.** Trait-declared sets on trait methods; the conformer-subset
   rule at conformance check; call-through-trait uses the trait's set.
6. **Tooling.** Formatter/LSP awareness if the comma-list form is chosen.

## Test plan

- `poke` (int write, `mutates nothing`) keeps a `data`-rooted borrow — the
  GROUP_BORROWING.md example flips to accepted.
- `self.items.push` in a `mutates items` method kills `items`-rooted borrows
  but not sibling-field borrows.
- Declared-but-violated body → compile error (rules 1 and 2 each).
- Subset violation: `mutates nothing` caller invoking a `mutates data` callee
  → compile error.
- Value-type write with an empty declaration compiles (the exemption).
- Un-annotated `ref self` = wildcard: every existing invalidation test
  unchanged (`test/borrow-loop-invalidation.test.ts`, the GROUP_BORROWING
  examples, etc.).
- `var self` invalidates everything regardless of any clause.
- Unstamped borrow (no `borrowed_via`) invalidated conservatively.
- Object-level alias (`ref Box<T> q = b`) untouched by field effects.
- Traits: conformer-narrower accepted; conformer-wider rejected;
  call-through-trait invalidates per the trait's set.
- Transitive chain: `a` declares `{items}`, calls `b` declaring `{items}`,
  which pushes to `self.items` — accepted; `a` declaring `nothing` calling
  `b` — rejected.

## Pointers

- Origin entry: FOLLOWUP.md, "Field-scoped borrow invalidation (Valen-style
  effect precision)" — kept as the record of the original body-scan proposal
  and the place-set data-structure note.
- Valen comparison: [GROUP_BORROWING.md](./GROUP_BORROWING.md) — Valen's
  `mut` effect ("mutability as a function effect, not a type") is the
  signature-level idea this design adopts; the doc's "abstraction leak"
  constraint is the cost this design accepts and mitigates.
- Checker machinery: `src/check/utils/borrow.ts` (`borrow_owner_of`,
  `invalidate_borrows_of`, `invalidate_view_borrows_of`);
  `src/check/check_access_node.ts` (the `ref self` arm);
  `src/check/check_assignment_node.ts` (view-source reassignment);
  `src/check/StackValue.ts` (where `borrowed_via` lands).
- Scan precedent (now unused by this design, still relevant as a pattern):
  `src/build_common/scan_borrow_returns.ts` /
  `heap_returning_functions` in `src/build_common/string_return_analysis.ts`.
- Memory model: [MEMORY.md](./MEMORY.md) — "Borrow Lifetimes" (deferred
  reclamation), view borrows.
