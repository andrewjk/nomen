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
	visibility: "inherit" | "pub" | "mod" | "priv",
	status: ParseStatus,
) {
	const start = get_index(status);
	accept(visibility, status);
	accept("struct", status);
	const name = consume(status);
	const struct = new StructNode(start, visibility, name);

	// Bump the namespace
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

		// Add auto-generated init if user hasn't defined one
		const has_custom_init = struct.functions.some((f) => f.name === "init");
		if (!has_custom_init) {
			const func = new FunctionNode(-1, visibility, "init", new Type(struct.name));
			func.params = struct.fields
				.filter((f) => f.visibility !== "priv" && !f.value)
				.map((f) => new ParameterNode(-1, f.name, f.type));
			func.is_static = true;
			struct.functions.unshift(func);
		}

		add_to_parent(struct, "Struct", status);
	}

	status.namespace = old_namespace;
}
