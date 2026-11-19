import add_error from "../add_error.ts";
import EnumNode from "../nodes/EnumNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import Type from "../nodes/Type.ts";
import parse_statement from "./parse_statement.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import add_to_parent from "./utils/add_to_parent.ts";
import consume from "./utils/consume.ts";
import consume_comptime_name from "./utils/consume_comptime_name.ts";
import consume_name from "./utils/consume_name.ts";
import expect from "./utils/expect.ts";
import expect_close_angle from "./utils/expect_close_angle.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_enum(
	visibility: "pub" | "private" | "internal",
	status: ParseStatus,
	is_owning = false,
	is_error = false,
) {
	const start = get_index(status);
	accept(visibility, status);
	if (is_owning) accept("mv", status);
	// Optional `checked` modifier between visibility and `enum`
	// (`pub checked enum Result<T, E> { ... }`). Contextual: only consumed when
	// it appears in this position, so `checked` remains usable as a name.
	const checked = accept("checked", status);
	// The kind keyword: `enum`, or `error` (ERRORS_PLAN — the third
	// specialized declaration; `error FetchError { ... }`). `checked error`
	// is redundant (error enums are always checked) and is not routed.
	if (is_error) {
		consume(status); // the `error` keyword
	} else {
		accept("enum", status);
	}
	// A comptime name splice — `enum Kind_#{w} { ... }` inside a file-scope
	// `#for` (declaration generation) — bare, or with a glued literal
	// prefix/suffix. The real name arrives at the expansion; the enum-body
	// case generation (`case #{c.name}`) is untouched by this.
	let name = "";
	let enum_comptime_name: string | undefined;
	{
		const splice = consume_comptime_name(status);
		if (splice !== undefined) {
			enum_comptime_name = splice;
		} else {
			name = consume_name(status);
		}
	}
	const node = new EnumNode(start, visibility, name);
	if (enum_comptime_name !== undefined) node.comptime_name = enum_comptime_name;
	node.checked = checked;
	if (is_error) node.is_error = true;
	if (is_owning) node.is_owning = true;

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

		while (peek_current(status) !== "}" && peek_current(status) !== undefined) {
			if (accept("case", status)) {
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
				continue;
			}
			const next = status.tokens[status.i + 1]?.value;
			if (peek_current(status) === "#" && ["for", "if", "switch"].includes(next ?? "")) {
				// An enum-body pragma (`#for` generating cases, `#if`
				// selecting them) — parsed like a struct-body member pragma;
				// the arms hold `case` declarations, which parse_statement
				// accepts while an enum is on the stack.
				parse_statement(status);
				continue;
			}
			add_error(status, "expected a case declaration or a compile-time pragma", get_index(status));
			consume(status);
		}

		expect("}", status);
		status.stack.pop();

		add_to_parent(node, "Enum", status);
	}
}
