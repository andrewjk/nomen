import flatten_null_chain from "../build_common/null_chain.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import type Type from "../nodes/Type.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { stamped_type } from "./types.ts";

/**
 * A nullable chain (`a?.b`, `a?.b.c`, `a?.m(args)`, `xs?.length`) as a JS
 * value. Every nullable representation is in-band `null` on this backend,
 * so each nullable hop tests `=== null` and the guarded value path is an
 * ordinary access chain. The checker hoisted any call in the base, so the
 * hops are pure reads and safe to re-evaluate.
 */
export default function build_null_chain(node: BaseNode, status: BuildStatus): string {
	const flat = flatten_null_chain(node, (t, f) => {
		const st = status.structs.findLast((s) => s.name === t && !s.is_generic);
		return st?.fields.find((fld) => fld.name === f)?.type;
	});
	if (!flat) return `__skip("expression null_access")`;
	const tests: string[] = [];
	for (const hop of flat.hops) {
		const t = stamped_type(hop) ?? (hop as { type?: Type }).type;
		const nullable = t?.is_nullable_array || t?.is_nullable;
		if (!nullable) continue;
		tests.push(`(${expr(hop, status)}) === null`);
	}
	const value = expr(flat.value, status);
	if (!tests.length) return value;
	return `((${tests.join(" || ")}) ? null : (${value}))`;
}
