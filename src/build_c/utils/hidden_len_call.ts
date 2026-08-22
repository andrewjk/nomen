import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import build_node from "../build_node.ts";
import type BuildStatus from "../BuildStatus.ts";

/**
 * Call-site support for hidden string-length companions
 * (`ParameterNode.hidden_len`, PERF gap 2.4). The callee's `string` param is
 * followed by a `long _<name>_len` C parameter; every call site appends the
 * companion argument right after the string argument.
 *
 * The length expression, cheapest first:
 * - a loop-invariant hoisted strlen temp (`string_length_temps`, from
 *   scan_string_length_hoists) — free per call inside the loop;
 * - `sizeof(literal) - 1` for string literal args (constant-folded);
 * - `strlen(<expr>)` for bare variables and field lvalues (a duplicate READ
 *   of an lvalue is side-effect-free);
 * - any other argument shape (interpolations, concats, calls) would be
 *   EVALUATED twice by the duplicated strlen — those are materialised once
 *   into a `char*` temp inside a GCC statement-expression wrapping the call.
 */

export interface HiddenLenWrap {
	/** arg index → materialised `char*` temp holding the string pointer */
	temps: Map<number, string>;
	open: boolean;
}

export function needs_len_materialize(arg: BaseNode): boolean {
	if (arg.node_type === "value") return false;
	if (arg.node_type === "access" && (arg as AccessNode).access.node_type === "access_field") {
		return false;
	}
	return true;
}

/**
 * Emit the statement-expression prologue materialising every non-lvalue
 * hidden-len argument once. Must be called immediately BEFORE the call's
 * label text is emitted; the args loop then substitutes the temps, and
 * close_hidden_len_wrap() terminates the expression after the call.
 */
export function open_hidden_len_wrap(
	indices: number[],
	params: BaseNode[],
	status: BuildStatus,
): HiddenLenWrap {
	const temps = new Map<number, string>();
	const to_materialize = indices.filter((i) => params[i] && needs_len_materialize(params[i]));
	if (to_materialize.length === 0) return { temps, open: false };
	status.code += `({ `;
	for (const i of to_materialize) {
		const tmp = `_hlm_${(status.label_counter = (status.label_counter ?? 0) + 1)}`;
		status.code += `char* ${tmp} = `;
		build_node(params[i], status);
		status.code += `; `;
		temps.set(i, tmp);
	}
	return { temps, open: true };
}

export function close_hidden_len_wrap(wrap: HiddenLenWrap, status: BuildStatus) {
	if (wrap.open) status.code += `; })`;
}

/**
 * Emit the companion length EXPRESSION for the argument at a hidden-len
 * index (the caller emits the separating `, `). `temp` is the materialised
 * pointer temp when one exists (open_hidden_len_wrap).
 */
export function emit_hidden_len_expr(arg: BaseNode, temp: string | undefined, status: BuildStatus) {
	if (temp) {
		status.code += `strlen(${temp})`;
		return;
	}
	if (arg.node_type === "value") {
		const value = (arg as ValueNode).value;
		if (value.startsWith('"')) {
			status.code += `sizeof(${value}) - 1`;
			return;
		}
		const hoisted = status.string_length_temps?.get(value);
		if (hoisted) {
			status.code += hoisted;
			return;
		}
		status.code += `strlen(${value})`;
		return;
	}
	// Field lvalue: build its text and wrap in strlen (a duplicate lvalue
	// read is side-effect-free).
	status.code += `strlen(`;
	build_node(arg, status);
	status.code += `)`;
}
