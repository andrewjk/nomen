import BaseNode from "./BaseNode.ts";

export default class AssignmentNode extends BaseNode {
	left_value: BaseNode;
	right_value: BaseNode;
	operator?: string;
	swap?: BaseNode;
	/**
	 * Set by the check pass when a live field/method borrow of the lhs exists at
	 * this assignment. The build then keeps the old instance alive (deferred
	 * reclamation) until the borrow's scope ends; otherwise it can eagerly free
	 * the old instance, which is what makes reassignment inside a loop sound.
	 */
	has_live_borrow?: boolean;
	/**
	 * Stamped by the last-use pass (stamp_last_use_moves) on a plain `s = t`
	 * string assignment whose source `t` is provably never read or written
	 * again: the backends transfer the pair (suppressing t's scope-exit free)
	 * instead of strdup'ing an owned copy into s.
	 */
	last_use_move?: boolean;

	/**
	 * Stamped by the synthesized-`copy` builder (auto_derive's build_copy) on
	 * a `c.<field> = self.<field>.copy()` assignment whose field's CURRENT
	 * value is a BORROW: the shell constructor byte-copied `self.<field>` in
	 * (struct/container ctor params alias their argument — only string params
	 * strdup), so the displaced seed shares another owner's heap state and
	 * the field-store paths must NOT reclaim it (the store simply drops the
	 * alias — the fresh copy is the field's first owned value).
	 */
	displaced_is_alias?: boolean;

	/**
	 * Stamped by the synthesized-`copy` builder (auto_derive's build_copy) on
	 * its `c.<field> = self.<field>` stores: the field-store path strdups
	 * string values, so the RHS field read is a sanctioned deep-copy source
	 * (the generic "copy out of an owning field by value" rejection does not
	 * apply to it).
	 */
	synthesized_copy_store?: boolean;

	/**
	 * Stamped by check_assignment_node when the assignment is a BASE↔CASE
	 * enum conversion (PERF_PLAN item 13(3)): the value type is the case
	 * mono and the target is its parent enum (`case_to_base` — a sound
	 * widening prefix copy), or the reverse (`base_to_case` — the builder
	 * emits the runtime tag check and panics on variant mismatch). Both
	 * backends emit a temp + prefix-copy + move-zero of the source; only
	 * this stamp's presence triggers the conversion lowering.
	 */
	enum_case_conversion?: { direction: "case_to_base" | "base_to_case" };

	constructor(start: number, left_value: BaseNode, right_value: BaseNode, operator?: string) {
		super("assign", start);
		this.left_value = left_value;
		this.right_value = right_value;
		// A plain `=` is represented as `undefined` (the parser strips it). A
		// programmatically-built AST (a synthesized method body) may pass the
		// literal `"="` — normalize it here so the backends' `!operator`
		// compound-vs-plain branches treat such a node as a plain assignment
		// instead of falling through to their compound/scalar stores.
		this.operator = operator === "=" ? undefined : operator;
	}
}
