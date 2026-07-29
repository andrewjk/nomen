import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import expect_close_angle from "./utils/expect_close_angle.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_type(status: ParseStatus): Type {
	// Tuple type: `[T1, T2, ...]`
	if (peek_current(status) === "[") {
		accept("[", status);
		const tuple_types: Type[] = [];
		if (peek_current(status) !== "]") {
			tuple_types.push(parse_type(status));
			while (accept(",", status)) {
				// Allow trailing comma
				if (peek_current(status) === "]") break;
				tuple_types.push(parse_type(status));
			}
		}
		expect("]", status);
		// Variadic tuple type: follows `...` prefix handled by caller
		const type = new Type("tuple");
		type.tuple_types = tuple_types;
		// Variadic tuple marker — caller may set is_array via the ... prefix
		if (accept("?", status)) {
			type.is_nullable = true;
		}
		return type;
	}

	const is_view = accept("view", status);
	const is_ref = accept("ref", status);
	const type = new Type(consume(status));
	if (is_view) type.is_view = true;
	if (is_ref) type.is_ref = true;
	if (accept("<", status)) {
		type.type_args = [parse_type(status)];
		while (accept(",", status)) {
			type.type_args.push(parse_type(status));
		}
		expect_close_angle(status);
	}
	if (accept("?", status)) {
		type.is_nullable = true;
	}
	if (accept("[", status)) {
		type.is_array = true;
		if (peek_current(status) !== "]") {
			type.length = new ValueNode(get_index(status), consume(status));
		}
		expect("]", status);
	}
	// Convert `Array<T>` to internal array representation: name=T, is_array=true
	if (type.is_array === undefined && type.name === "Array" && type.type_args?.length === 1) {
		const elem = type.type_args[0];
		type.name = elem.name;
		type.is_array = true;
		type.is_nullable = elem.is_nullable;
		type.type_args = undefined;
	}
	return type;
}
