# BUGS.md

Pre-existing compiler bugs found (and fixed) while implementing
[STRUCT_PLAN_3 Phase A](./docs/STRUCT_PLAN_3.md). Recorded so the fixes survive
a plan rollback: if Phase A is reverted, these are real bugs on `main`
independent of the plan, with their fixes described here.

## 1. Prefix-`move` declarations never transfer (checker gap)

**Seen on `main` (commit 11a7090b), both backends' checker.**

The `move T r = src` **declaration prefix** never stamps the initializer as an
ownership transfer — `decl.value.is_moved` is only set by the _expression_
`move` prefix (`move T r = move src`, parsed in `src/parse/parse_expression.ts`),
never by the declaration keyword (`src/parse/parse_declaration.ts`). Every
downstream transfer rule keys on `decl.value.is_moved`
(`src/check/check_declaration_node.ts`), so the prefix form misbehaves in two
ways:

- **Class source — silently aliases instead of transferring.**
  `move Box r = p` sets `class_alias_of` on `r` (the historical lenient-alias
  path): `p` stays usable, both names share the instance, and the instance is
  destroyed once via `p`'s slot. The documented transfer semantics ("`move Box
q = p` — transfer; p is invalid afterwards") never happen; only
  `move Box r = move p` actually transfers.
- **Owning value-struct source — false "cannot copy" error.**
  `move H q = p` (H owning, e.g. a `List` field) hits the
  `cannot copy 'H' by value — it owns heap resources; use .copy() or move`
  error _even though `move` was written_ — the prescribed fix is
  unsatisfiable in the prefix form. Repro (errors on `main`):
  ```nomen
  import System
  struct H { move List<int> items }
  pub func main = () {
      var H p = H(List<int>())
      move H q = p
      Console.write("\{q.items.length}\n")
  }
  ```

**Fix:** in `check_declaration_node`, when `declaration === "move"` and the
initializer is a bare variable (`decl.value?.node_type === "value"`) without a
swap and not already `is_moved`, stamp `decl.value.is_moved = true` before the
ownership checks. Everything downstream then behaves: the owning-struct
"cannot copy" gate is satisfied, the source lands in `moved_variables`
("used after move" on later uses), both backends' alias classification
(C `val_is_class_alias`, aarch64 `value_is_var_borrow` — both require
`!is_moved`) treat the binding as owned, and the transfer destroy/frees
exactly once. The swap form (`move x = a swap b`) is deliberately left on its
pre-existing path (the transfer arm at the `!decl.swap` gate never owned that
shape).

## 2. Move-through-a-`ref` reported with the wrong message (Phase A arm starved by bug 1)

STRUCT_PLAN_3 §A3.3 (new checker code, but starved by bug 1): `move Box r = q`
where `q` is a `ref` binding must error
`'q' is a ref — move the owner instead`. Because the prefix `move` never set
`decl.value.is_moved`, the §A3.3 arm (gated on `decl.value.is_moved`) never
ran, and the _unspelled-alias_ error fired instead. Fixing bug 1 routes the
prefix form into the §A3.3 arm and the right message comes out. Only visible
with Phase A's `ref` bindings; listed because the fix is the same stamp.

## 3. aarch64: a class TRANSFER declaration destroys the shared instance twice

**Seen on `main` (commit 11a7090b), aarch64 backend only — C is correct.**

`var Box r = move p` (and, after bug 1's fix, the prefix form
`move Box r = p`) ran the instance's `#destroy` **twice** at scope exit on
aarch64. Repro (prints `DD` on aarch64, `D` on C):

```nomen
import System
class Box {
	var int v
	func #destroy = () {
		Console.write("D")
	}
}
pub func main = () {
	var Box p = Box(1)
	move Box r = move p
	Console.write("\{r.v}\n")
}
```

Root cause: the aarch64 declaration path classifies a bare-class-source
initializer as an alias via `value_is_var_borrow`, which required
`!(node.value).is_moved` — so a moved source made the NEW binding an owner
(pushed onto `scoped_declarations`). But the instance's allocation stays
anchored in the SOURCE's heap slot (anchors cannot follow the new binding),
and the source `p` also remains in `scoped_declarations` — scope exit walked
both declarations against the same pointer: `Box_destroy(p); Box_destroy(r)`
(the free itself still fired once, via p's anchor slot, so this corrupted
destructor state rather than the heap — worse in its own way). The C backend
classifies the same shape with `val_is_class_alias`, which deliberately does
NOT consult `is_moved` for a bare class source: `r` stays a non-owning alias,
`p`'s slot is the single owner, and teardown runs exactly once.

**Fix:** drop the `!is_moved` condition from `value_is_var_borrow`
(`src/build_aarch64/build_declaration_node.ts`) so a moved bare class source
classifies exactly like C — the new binding is an alias, the source's anchor
slot owns, teardown is single. Checker-level transfer semantics (the moved
source is unusable afterwards) are unchanged; they live in the checker's
`moved_variables`, which both backends share.

## 4. `ref Box q = <fresh value>` was silently accepted (Phase A checker gap)

Not on `main` (the `ref` keyword is Phase A work), but a hole in the Phase A
checker as first written: the "ref requires an existing binding" error only
fired for bare `value`-node initializers, so `ref Box q = make()` and
`ref Box q = Box(1)` (fresh owned values — nothing to alias) passed the check
and then built as owned storage: `ref` spelled, `var` semantics. Fix: fire the
error for ANY initializer that `ref_alias_source_name` cannot classify as an
existing binding/field/borrow-returning call (§A1). `ref q = move p` also
errors now (an alias never takes ownership).
