import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_type(status: ParseStatus): Type {
	const is_ref = accept("ref", status);
	const type = new Type(consume(status));
	if (is_ref) type.is_ref = true;
	if (accept("<", status)) {
		type.type_args = [parse_type(status)];
		while (accept(",", status)) {
			type.type_args.push(parse_type(status));
		}
		expect(">", status);
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
