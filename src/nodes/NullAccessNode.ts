import AccessFieldNode from "./AccessFieldNode.ts";
import type AccessFunctionCallNode from "./AccessFunctionCallNode.ts";
import type AccessNode from "./AccessNode.ts";
import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

/**
 * ERRORS_PLAN (nullable chaining): `a?.b` — a member access that
 * short-circuits on a nullable target. The result is `field-type?`: null
 * when the target is null, the member otherwise. Chains repeat the
 * operator (`a?.b?.c`), may run through plain `.` steps (`a?.b.c`), and
 * may end in a METHOD call (`a?.m(args)` — `access` is an
 * AccessFunctionCallNode; the checker checks the guarded call and stores
 * its wrapper in `call` so the builders emit the checked node verbatim).
 *
 * A chain is a nullable VALUE: null is in-band for strings (the fat zero
 * pair) and rides the companion `_has` flag for scalars/structs — the
 * same representations a nullable call result uses, so a chain lowers
 * anywhere a nullable value is consumed (declarations, assignments,
 * returns, arguments) as well as in the coalesce/test forms (`chain ??
 * fallback`, `chain == / != null`).
 */
export default class NullAccessNode extends BaseNode {
	target: BaseNode;
	access: AccessFieldNode | AccessFunctionCallNode;
	type: Type;
	/** A final method-call hop (`a?.m(args)`): the checked
	 *  `AccessNode(target, access_func)` the checker produced. The
	 *  builders rebuild the chain's value path from `flatten_null_chain`,
	 *  which prefers this node so every stamp (resolved_function, hoisted
	 *  params, ...) survives to the backends. */
	call?: AccessNode;

	constructor(
		start: number,
		target: BaseNode,
		access: AccessFieldNode | AccessFunctionCallNode,
		type?: Type,
	) {
		super("null_access", start);
		this.target = target;
		this.access = access;
		this.type = type || new Type("");
	}
}
