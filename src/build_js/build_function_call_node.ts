import { is_interp_name, parse_interp_name } from "../check/utils/interp_arg_kinds.ts";
import type FunctionCallNode from "../nodes/FunctionCallNode.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { function_label, init_label } from "./names.ts";

/**
 * Emit a JS expression for a call node:
 *  - interpolation helpers (`_string_interpolate_N[_kinds]`) → `__interp`;
 *  - struct constructors → the `<Struct>_init` factory;
 *  - free/nested functions → the checker's emission label.
 * Enum constructors and library constructors are outside the v1 subset.
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

	const struct = status.structs.find((s) => s.name === name);
	if (struct) {
		const args = node.params.map((p) => expr(p, status));
		return `${node.mangled_name ?? init_label(name)}(${args.join(", ")})`;
	}

	const args = node.params.map((p) => expr(p, status));
	return `${function_label(node.resolved_function ?? node)}(${args.join(", ")})`;
}
