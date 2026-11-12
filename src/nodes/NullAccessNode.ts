import AccessFieldNode from "./AccessFieldNode.ts";
import BaseNode from "./BaseNode.ts";
import Type from "./Type.ts";

/**
 * ERRORS_PLAN (nullable chaining): `a?.b` — a member access that
 * short-circuits on a nullable target. The result is `field-type?`: null
 * when the target is null, the member otherwise. Chains repeat the
 * operator (`a?.b?.c`).
 *
 * A chain's nullness must be CONSUMED rather than stored in v1: the
 * language's nullable representations are per-slot (in-band for strings,
 * companion flags for scalars/structs), so a general nullable EXPRESSION
 * value has no carrier yet. The supported consumers — `chain ?? fallback`
 * and `chain != null` / `== null` — lower the whole chain in one
 * expression (target evaluated once, fallback lazy).
 */
export default class NullAccessNode extends BaseNode {
	target: BaseNode;
	access: AccessFieldNode;
	type: Type;

	constructor(start: number, target: BaseNode, access: AccessFieldNode, type?: Type) {
		super("null_access", start);
		this.target = target;
		this.access = access;
		this.type = type || new Type("");
	}
}
