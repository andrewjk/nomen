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

	constructor(start: number, left_value: BaseNode, right_value: BaseNode, operator?: string) {
		super("assign", start);
		this.left_value = left_value;
		this.right_value = right_value;
		this.operator = operator;
	}
}
