import EnumNode from "../nodes/EnumNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import Type from "../nodes/Type.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import consume_name from "./utils/consume_name.ts";
import expect from "./utils/expect.ts";
import expect_close_angle from "./utils/expect_close_angle.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_enum(
	visibility: "pub" | "private" | "internal",
	status: ParseStatus,
) {
	const start = get_index(status);
	accept(visibility, status);
	// Optional `must_use` modifier between visibility and `enum`
	// (`pub must_use enum Result<T, E> { ... }`). Contextual: only consumed when
	// it appears in this position, so `must_use` remains usable as a name.
	const must_use = accept("must_use", status);
	accept("enum", status);
	const name = consume_name(status);
	const node = new EnumNode(start, visibility, name);
	node.must_use = must_use;

	// Generic type parameters: `enum Result<T, E> { ... }`
	if (accept("<", status)) {
		node.type_params.push(consume_name(status));
		while (accept(",", status)) {
			node.type_params.push(consume_name(status));
		}
		expect_close_angle(status);
	}

	if (expect("{", status)) {
		status.stack.push(node);

		while (accept("case", status)) {
			const case_name = consume_name(status);
			const params: ParameterNode[] = [];

			if (accept("(", status)) {
				if (peek_current(status) !== ")") {
					const param_start = get_index(status);
					const param_type = new Type(consume(status));
					const param_name = consume_name(status);
					params.push(new ParameterNode(param_start, param_name, param_type));

					while (accept(",", status)) {
						const p_start = get_index(status);
						const p_type = new Type(consume(status));
						const p_name = consume_name(status);
						params.push(new ParameterNode(p_start, p_name, p_type));
					}
				}
				expect(")", status);
			}

			node.cases.push({ name: case_name, params });
		}

		expect("}", status);
		status.stack.pop();

		add_to_parent(node, "Enum", status);
	}
}
