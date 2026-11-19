import BaseNode from "./BaseNode.ts";
import NestedBlockNode from "./NestedBlockNode.ts";

/**
 * A compile-time field iteration — `#for field of META.info(T).fields { ... }`
 * — docs/COMPTIME.md stage 2 (R3/R4/R5/R8). Body scope only.
 *
 * The binding is a comptime value: inside the arm, `<binding>.name` is a
 * comptime string, `<binding>.type.name` a comptime type-name string, and
 * `<binding>.get(obj)` / `<binding>.set(obj, value)` are ordinary field
 * access/assignment once the loop unrolls (R5 — methods on the binding, not
 * a magic `@field`).
 *
 * Expansion happens at CHECK time, before the arm is checked (R2): concrete
 * `T` unrolls immediately, producing one NestedBlockNode per field (fresh
 * scope = the R8 hygiene: iteration locals cannot collide). `T` still in
 * `status.type_params` defers — the node survives until the generic body is
 * specialized and re-checked, then unrolls there. A `#for` whose T never
 * binds and never resolves is a compile error, never a silent drop.
 *
 * `spawn_of` (R7) is stamped on every cloned statement so diagnostics can
 * point from generated code back at the `#for` that produced it.
 *
 * A loop nested inside another loop's expansion arm (a member loop in a
 * generated type's body, or a body loop inside an arm) carries
 * `outer_bindings` — the enclosing bindings stamped by the outer rewrite.
 * The outer walk leaves the nested arm alone (its templates resolve against
 * the OUTER binding otherwise), and the loop's own expansion folds
 * references to the enclosing bindings through the stack.
 */
export default class PragmaForNode extends BaseNode {
	binding: string;
	iterable: BaseNode;
	block: NestedBlockNode;
	/** Enclosing `#for` bindings (`binding` + its comptime value), stamped
	 *  when an outer expansion's rewrite reaches this loop. Loose-typed —
	 *  the comptime value shapes are the checker's (`ComptimeField`). */
	outer_bindings?: { binding: string; field: unknown }[];

	constructor(start: number, binding: string, iterable: BaseNode, block?: NestedBlockNode) {
		super("pragma_for", start);
		this.binding = binding;
		this.iterable = iterable;
		this.block = block ?? new NestedBlockNode(start);
	}
}
