import { is_interp_name, parse_interp_name } from "../check/utils/interp_arg_kinds.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import call_with_refs from "./call_with_refs.ts";
import { enum_case_value, find_enum_case } from "./enums.ts";
import { library_constructor } from "./library.ts";
import { function_label, init_label } from "./names.ts";

/**
 * Emit a JS expression for a call node:
 *  - interpolation helpers (`_string_interpolate_N[_kinds]`) → `__interp`;
 *  - enum case constructions → tagged object literals;
 *  - struct constructors → the `<Struct>_init` factory;
 *  - library containers (List/Map/Box/StringBuilder) → their JS values;
 *  - free/nested functions → the checker's emission label (with `ref`
 *    arguments boxed and copied back).
 */
export default function build_function_call_node(
	node: FunctionCallNode,
	status: BuildStatus,
): string {
	const name = node.name;

	if (is_interp_name(name)) {
		const { kinds } = parse_interp_name(name);
		const pattern = expr(node.params[0], status);
		const args = node.params.slice(1).map((p) => expr(p, status));
		const kind_string = kinds ? kinds.join("") : "s".repeat(args.length);
		const rest = args.length ? `, ${args.join(", ")}` : "";
		return `__interp(${pattern}, "${kind_string}"${rest})`;
	}

	// Enum case construction, including the shorthand `.ok(x)` the checker
	// rewrites to the flattened `Enum_case` name.
	if ((node as unknown as { is_enum_shorthand?: boolean }).is_enum_shorthand) {
		const args = node.params.map((p) => expr(p, status));
		const hit = find_enum_case(status.enums, name);
		if (hit) return enum_case_value(hit.enum_node, hit.case_index, args);
		const enum_node = status.enums.find((e) => e.name === node.type?.name);
		if (enum_node) {
			const case_name = name.replace(/^\./, "").replace(`${enum_node.name}_`, "");
			const case_index = enum_node.cases.findIndex((c) => c.name === case_name);
			if (case_index !== -1) return enum_case_value(enum_node, case_index, args);
		}
	}

	const struct = status.structs.find((s) => s.name === name);
	if (struct) {
		const args = node.params.map((p) => expr(p, status));
		return `${node.mangled_name ?? init_label(name)}(${args.join(", ")})`;
	}

	// Library containers (List/Map/Box/StringBuilder) map onto JS values.
	const args = node.params.map((p) => expr(p, status));
	const library = library_constructor(name, args);
	if (library !== undefined) return library;

	// A free (or nested) function call: `ref` arguments are boxed and copied
	// back by the wrapper.
	const label = function_label(node.resolved_function ?? node);
	return call_with_refs(
		status,
		node.params,
		node.ref_param_indices,
		(arg_exprs) => `${label}(${arg_exprs.join(", ")})`,
	);
}
