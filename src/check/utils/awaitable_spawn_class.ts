import type StructNode from "../../nodes/StructNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { resolve_declared_struct } from "./resolve_declared_type.ts";

/**
 * The spawn-handle field contract an Awaitable class must declare for the
 * `X(fn(args))` construction sugar (ASYNC.md, "User-defined async
 * primitives"). The sugar packs the wrapped call eagerly and stores the
 * launch machinery in these fields — the same layout Thread/Fiber carry and
 * their own launch methods consume; a user primitive's launch methods read
 * the same contract.
 */
export const SPAWN_FIELD_CONTRACT = ["task", "result_slot", "cancel_flag", "future"] as const;

/**
 * Resolve the Awaitable-conforming CLASS a generalized spawn-sugar call
 * (`X(fn(args))` / `X(() => work(n))`) targets. Undefined for everything
 * else: non-classes, classes not conforming to the core `Awaitable` trait,
 * and the reserved library names Thread/Fiber (whose own fast path runs
 * first and whose user-named shadows mean a plain struct).
 *
 * The class must additionally carry the spawn-handle field contract
 * (`spawn_field_contract_gaps`) and at most one type parameter before the
 * sugar fires — the callers validate those and report dedicated errors.
 */
export default function resolve_awaitable_spawn_class(
	name: string,
	status: CheckStatus,
): StructNode | undefined {
	if (name === "Thread" || name === "Fiber") return undefined;
	const struct = resolve_declared_struct(name, status) as StructNode | undefined;
	if (!struct || !struct.is_class) return undefined;
	if (!struct.traits.includes("Awaitable")) return undefined;
	return struct;
}

/**
 * The class's spawn-field contract gaps: one human-readable entry per
 * missing or mistyped handle field. Empty means the class can carry the
 * packed task machinery.
 */
export function spawn_field_contract_gaps(struct: StructNode): string[] {
	const gaps: string[] = [];
	for (const field_name of SPAWN_FIELD_CONTRACT) {
		const field = struct.fields.find((f) => f.name === field_name);
		if (!field) {
			gaps.push(`missing field '${field_name}'`);
		} else if (field.type?.name !== "uint64") {
			gaps.push(`field '${field_name}' must be uint64, got '${field.type?.name || "<none>"}'`);
		}
	}
	return gaps;
}
