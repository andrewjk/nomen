import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import parse_expression from "./parse_expression.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_array_value(array: ArrayValuesNode, status: ParseStatus) {
	// Get this value
	const value = parse_expression(status);
	array.values.push(value);

	// Maybe get another value
	if (accept(",", status)) {
		if (peek_current(status) === "]") {
			return;
		}
		parse_array_value(array, status);
	}
}
