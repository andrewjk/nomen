import { is_view_value } from "../../build_common/view_value.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import build_node from "../build_node.ts";
import type BuildStatus from "../BuildStatus.ts";

export { is_view_value };

/**
 * Emit a C expression for an argument passed to a `view string` parameter.
 * A view-typed argument is already a nomen_view — pass it through. An owned
 * `string` expression is a fat nomen_string; borrowing it into a view is a
 * plain (ptr, len) struct copy — no strlen, no allocation (the caller keeps
 * ownership of the string).
 */
export function c_view_string_arg(arg: BaseNode, status: BuildStatus) {
	if (is_view_value(arg, status)) {
		build_node(arg, status);
		return;
	}
	status.code += `({ nomen_string _p = `;
	build_node(arg, status);
	status.code += `; nomen_view _v = { (void*)_p.ptr, _p.len }; _v; })`;
}

/**
 * Emit a C expression materializing a `view string` into an OWNED heap
 * string (malloc len+1 / memcpy / null-terminate). Used when a view value
 * initializes an owned `string` declaration (`const string s = v`) — the
 * resulting pointer is heap-owned and must be freed at scope exit.
 */
export function c_materialize_view_string(arg: BaseNode, status: BuildStatus) {
	status.code += `({ nomen_view _t = `;
	build_node(arg, status);
	status.code += `; char* _r = malloc(_t.len + 1); memcpy(_r, _t.ptr, _t.len); _r[_t.len] = 0; (nomen_string){ _r, _t.len }; })`;
}
