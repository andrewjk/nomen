import add_error from "../add_error.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

export default function parse_destroy(status: ParseStatus) {
	const start = get_index(status);
	accept("destroy", status);

	const parent = status.stack.at(-1);
	if (!parent || parent.node_type !== "struct") {
		add_error(status, "destroy can only appear inside a struct", start);
		return;
	}

	const struct_node = parent as StructNode;

	if (!expect("=", status) || !expect("{", status)) return;

	const func = new FunctionNode(start, "mod", "destroy", new Type(""));
	func.params.push(new ParameterNode(start, "self", new Type(struct_node.name)));
	func.params[0].is_self_param = true;
	func.has_body = true;

	status.stack.push(func);
	parse_statement(status);
	expect("}", status);
	status.stack.pop();

	struct_node.destroy_body = func;
}
