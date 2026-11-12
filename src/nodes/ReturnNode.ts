import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

export default class ReturnNode extends BaseNode {
	value: BaseNode | null;
	type: Type;

	from_inline?: boolean;
	/**
	 * ERRORS_PLAN: the return value is DISCARDED — `out ! E` has no success
	 * slot, so `return <value>` evaluates the expression and succeeds (the
	 * spelling for `return load(path)!`). Stamped by check_return_node; the
	 * builders emit the value as a statement and return the ok case.
	 */
	unit_discard?: boolean;
	/**
	 * Return-side NRVO: this return's value is a binding that
	 * constructs directly in the caller's sret buffer (see
	 * `DeclarationNode.nrvo_sret`) — the return copies nothing. Stamped by
	 * check_function_node's post-body pass.
	 */
	nrvo_elided?: boolean;

	constructor(start: number, value: BaseNode | null, type?: Type) {
		super("return", start);
		this.value = value;
		this.type = type || new Type("");
	}
}
