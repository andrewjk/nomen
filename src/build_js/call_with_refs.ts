import type BaseNode from "../nodes/BaseNode.ts";
import type ValueNode from "../nodes/ValueNode.ts";
import { expr, next_temp } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/**
 * A Nomen `ref` argument is an OUT-parameter: the callee may write through it
 * and the caller observes the new value. JS has no references to bindings, so
 * each ref argument is boxed (`{ v }`), the callee copies in at entry and
 * writes back on assignment, and the call site copies the box back into the
 * argument's lvalue afterwards.
 *
 * The whole call becomes an IIFE so the temp boxes stay scoped:
 *
 *   (() => { const t = { v: x }; const r = f(t); x = t.v; return r; })()
 */
export default function call_with_refs(
	status: BuildStatus,
	args: BaseNode[],
	ref_indices: number[] | undefined,
	build_call: (arg_exprs: string[]) => string,
): string {
	const arg_exprs = args.map((arg) => expr(arg, status));
	if (!ref_indices?.length) return build_call(arg_exprs);

	const boxes: string[] = [];
	const write_backs: string[] = [];
	const boxed = arg_exprs.map((value, i) => {
		if (!ref_indices.includes(i)) return value;
		const temp = next_temp(status, "ref");
		boxes.push(`const ${temp} = { v: ${value} };`);
		write_backs.push(`${value} = ${temp}.v;`);
		// A ref PARAMETER forwarded onward lives as a local in the callee; the
		// enclosing box must see the update too.
		const arg = args[i];
		if (arg.node_type === "value") {
			const name = (arg as ValueNode).value;
			if (status.ref_params?.has(name)) {
				write_backs.push(`__ref_${name}.v = ${name};`);
			}
		}
		return temp;
	});

	const call = build_call(boxed);
	return `(() => { ${boxes.join(" ")} const __ret = ${call}; ${write_backs.join(" ")} return __ret; })()`;
}
