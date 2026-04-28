import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";

export default function parse_array_value(array: ArrayValuesNode, status: ParseStatus) {
	// Get this value
	const value = parse_expression(status);
	array.values.push(value);

	// Maybe get another value
	if (accept(",", status)) {
		parse_array_value(array, status);
	}
}
