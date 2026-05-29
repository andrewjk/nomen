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
	const is_ptr = accept("ptr", status);
	const type = new Type(consume(status));
	if (is_ref) type.is_ref = true;
	if (is_ptr) type.is_ptr = true;
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
	return type;
}
