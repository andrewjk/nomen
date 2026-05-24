import { is_returning_node } from "../nodes/check_node_type.ts";
import type ReturningNode from "../nodes/ReturningNode.ts";
import ReturnNode from "../nodes/ReturnNode.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import get_index from "./utils/get_index.ts";

export default function parse_return(status: ParseStatus) {
	const start = get_index(status);
	accept("return", status);
	let value = null;
	if (accept("=>", status)) {
		value = parse_expression(status);
	} else {
		const next = status.tokens[status.i]?.value;
		if (next && next !== "}" && next !== ";") {
			value = parse_expression(status);
		}
	}
	const ret = new ReturnNode(start, value);

	add_to_parent(ret, "Return statement", status);

	for (let i = status.stack.length - 1; i >= 0; i--) {
		if (is_returning_node(status.stack[i])) {
			const returning = status.stack[i] as ReturningNode;
			returning.has_return = true;
			if (status.stack[i].node_type === "func") {
				break;
			}
		}
	}
}
