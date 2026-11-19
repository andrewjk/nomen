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
 * braced splice template or an ordinary word; optional payload params
 * spell with fixed types (`case #{c.name}(int code)` — payload splices
 * are not supported). The current token is `case`.
 *
 * Returns the node with `comptime_name` set when the name was a template
 * (the enum's expansion resolves it); callers push it onto the arm.
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
	const node = new EnumCaseDeclNode(start, name, params);
	node.comptime_name = comptime_name;
	return node;
}
