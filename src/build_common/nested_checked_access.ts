import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import Type from "../nodes/Type.ts";

/**
 * The pieces a backend lowers `g.at_or(i, fb)` / `g.at_or_panic(i)` on a
 * nested array from (`nested_checked_access`, stamped by
 * check_access_node): `g.length` for the bounds check and the inline
 * `g.at(i)` row read. The index is a hoisted local (params[0]), so both
 * read it without re-running its expression.
 */
export default function nested_checked_parts(
	node: AccessNode,
	call: AccessFunctionCallNode,
): { length: AccessNode; at: AccessNode } {
	const length_field = new AccessFieldNode(node.start, "length");
	length_field.type = new Type("int");
	const at_call = new AccessFunctionCallNode(node.start, "at", call.type, [call.params[0]]);
	at_call.inline_nested_access = true;
	return {
		length: new AccessNode(node.start, node.target, length_field),
		at: new AccessNode(node.start, node.target, at_call),
	};
}
