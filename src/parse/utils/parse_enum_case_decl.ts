import add_error from "../../add_error.ts";
import EnumCaseDeclNode from "../../nodes/EnumCaseDeclNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import Type from "../../nodes/Type.ts";
import type ParseStatus from "../ParseStatus.ts";
import accept from "./accept.ts";
import consume from "./consume.ts";
import consume_comptime_name from "./consume_comptime_name.ts";
import expect from "./expect.ts";
import get_index from "./get_index.ts";
import peek_current from "./peek_current.ts";

/**
 * One `case` declaration inside an enum-body pragma arm —
 * `#for c of META.info(Shape).cases { case #{c.name} }`. The name is a
 * braced splice template or an ordinary word; payload params spell with
 * fixed types (`case #{c.name}(int code)`), with `#{...}` splices over the
 * binding (`#{c.params[0]}` — the whole source param, type and name;
 * `#{c.params[0].type}` in the type slot and `#{c.params[0].name}` in the
 * name slot for custom shapes). The enum's expansion resolves the
 * templates; callers push the node onto the arm.
 */
export default function parse_enum_case_decl(status: ParseStatus): EnumCaseDeclNode {
	const start = get_index(status);
	consume(status); // case
	let name = "";
	let comptime_name: string | undefined;
	{
		const splice = consume_comptime_name(status);
		if (splice !== undefined) {
			comptime_name = splice;
		} else {
			name = consume(status);
			if (!/^[A-Za-z_]\w*$/.test(name)) {
				add_error(status, "expected a case name or `#{...}` splice", get_index(status));
			}
		}
	}
	const params: ParameterNode[] = [];
	if (accept("(", status)) {
		if (peek_current(status) !== ")") {
			params.push(parse_case_param(status));
			while (accept(",", status)) {
				params.push(parse_case_param(status));
			}
		}
		expect(")", status);
	}
	const node = new EnumCaseDeclNode(start, name, params);
	node.comptime_name = comptime_name;
	return node;
}

/** One payload param of an arm's `case` — fixed, spliced, or whole. */
function parse_case_param(status: ParseStatus): ParameterNode {
	const start = get_index(status);
	const param = new ParameterNode(start, "");
	// TYPE slot: a `#{...}` splice or an ordinary (single-word) type.
	const type_splice = consume_comptime_name(status);
	if (type_splice !== undefined) {
		param.comptime_type_template = type_splice;
	} else {
		param.type = new Type(consume(status));
	}
	// NAME slot: a splice or a word. A type-slot splice followed by no name
	// at all is the WHOLE-PARAM form — the source param's type AND name.
	const name_splice = consume_comptime_name(status);
	if (name_splice !== undefined) {
		param.comptime_name = name_splice;
	} else {
		const next = peek_current(status);
		if (next !== "," && next !== ")") {
			param.name = consume(status);
			if (!/^[A-Za-z_]\w*$/.test(param.name)) {
				add_error(status, "expected a payload param name or `#{...}` splice", get_index(status));
			}
		}
	}
	return param;
}
