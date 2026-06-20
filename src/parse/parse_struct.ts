import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";

export default function parse_struct(
	visibility: "pub" | "private",
	status: ParseStatus,
	is_class = false,
) {
	const start = get_index(status);
	accept(visibility, status);
	accept(is_class ? "class" : "struct", status);
	const name = consume(status);
	const struct = new StructNode(start, visibility, name);
	if (is_class) struct.is_class = true;

	if (accept("<", status)) {
		struct.type_params.push(consume(status));
		while (accept(",", status)) {
			struct.type_params.push(consume(status));
		}
		expect(">", status);
	}

	const old_namespace = status.namespace;
	status.namespace += `.${name}`;

	if (accept(":", status)) {
		struct.traits.push(consume(status));
		while (accept(",", status)) {
			struct.traits.push(consume(status));
		}
	}

	if (expect("{", status)) {
		status.stack.push(struct);
		parse_statement(status);
		expect("}", status);
		status.stack.pop();

		const has_custom_init = struct.functions.some((f) => f.name === "#init");
		if (!has_custom_init) {
			const func = new FunctionNode(-1, visibility, "#init", new Type(struct.name));
			func.params = struct.fields
				.filter((f) => f.visibility !== "private" && !f.value)
				.map((f) => {
					const param = new ParameterNode(-1, f.name, f.type);
					if (f.declaration === "mov") {
						param.is_moved = true;
					}
					param.constraint = f.constraint;
					return param;
				});
			func.is_static = true;
			struct.functions.unshift(func);
		}

		add_to_parent(struct, "Struct", status);
	}

	status.namespace = old_namespace;
}
