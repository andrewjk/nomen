import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";

// TODO: This should actually be calling a standard String.interpolate method with a params array

export default function parse_string_interpolation(status: ParseStatus): FunctionCallNode {
	const start = get_index(status);

	let pattern = consume(status);
	let values = [];

	while (true) {
		const value = consume(status);
		if (value === "\\{") {
			pattern += "\\{}";
			let param = parse_expression(status);
			// TODO: Not if it's already a string
			param = new AccessNode(
				start,
				param,
				new AccessFunctionCallNode(start, "to_string" /*, new Type("string", true)*/),
			);
			//console.log("PARAM", param);
			values.push(param);
			accept("}", status);
		} else if (value.endsWith('"')) {
			pattern += value;
			break;
		} else {
			pattern += value;
		}
	}

	// HACK: This should be done in build
	pattern = pattern.replaceAll("\\{}", "%s");

	return new FunctionCallNode(start, `_string_interpolate_${values.length}`, new Type("string"), [
		new ValueNode(0, pattern, new Type("string", true)),
		...values,
	]);
}
