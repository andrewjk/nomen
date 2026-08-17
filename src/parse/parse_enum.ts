import EnumNode from "../nodes/EnumNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import Type from "../nodes/Type.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import expect_close_angle from "./utils/expect_close_angle.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_enum(visibility: "pub" | "private", status: ParseStatus) {
	const start = get_index(status);
	accept(visibility, status);
	accept("enum", status);
	const name = consume(status);
	const node = new EnumNode(start, visibility, name);

	// Generic type parameters: `enum Result<T, E> { ... }`
	if (accept("<", status)) {
		node.type_params.push(consume(status));
		while (accept(",", status)) {
			node.type_params.push(consume(status));
		}
		expect_close_angle(status);
	}

	if (expect("{", status)) {
		status.stack.push(node);

		while (accept("case", status)) {
			const case_name = consume(status);
			const params: ParameterNode[] = [];

			if (accept("(", status)) {
				if (peek_current(status) !== ")") {
					const param_start = get_index(status);
					const param_type = new Type(consume(status));
					const param_name = consume(status);
					params.push(new ParameterNode(param_start, param_name, param_type));

					while (accept(",", status)) {
						const p_start = get_index(status);
						const p_type = new Type(consume(status));
						const p_name = consume(status);
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
