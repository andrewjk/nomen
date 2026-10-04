import add_error from "../../add_error.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import is_sendable_type from "./is_sendable_type.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * STRUCT_PLAN_3 Phase N — checked region borrows at the task boundary.
 *
 * Class and trait arguments to a `#spawn` construction are SHARED pointers
 * (the env aliases the instance — build_magic_ctor, "Class and trait args
 * stay shared pointers"). `Sendable` gates aliasability but not LIFETIME: a
 * donor whose scope ends before the task stops reading the alias dangles.
 * Two rules close the dangles that have a static bound:
 *
 * - **The root rule (N1a R2, transition era per N1b E3)** — inside an
 *   `async { }` block the join at the closing brace is the bound: a shared
 *   argument's ROOT (the variable at the base of the access path) must be
 *   declared in the async block's own scope or outside it — never in a
 *   nested block (a loop body whose iteration ends first) — and a fresh
 *   class temporary must be constructed in the block's own scope (its
 *   anchor lives there). Params and globals always pass.
 * - **Detach owns its captures (N2/R4)** — `.detach()` has no join anywhere:
 *   a daemon outlives every scope, so a shared class/trait argument has
 *   nothing bounding it. The chained form `Thread(fn(x)).detach()` rejects
 *   every non-`move` class/trait argument unconditionally (globals exempt —
 *   process lifetime).
 */

/** Whether `type_name` is a SHARED-REFERENCE type (class or trait) — the
 *  kinds packed into a task env as a bare pointer. */
function is_shared_reference_type(type_name: string | undefined, status: CheckStatus): boolean {
	if (!type_name) return false;
	if (status.traits.some((t) => t.name === type_name)) return true;
	return !!status.structs.find((s) => s.name === type_name && s.is_class);
}

/**
 * The root variable an argument's access path is based on (`m` in `m`,
 * `holder` in `holder.field`), or undefined when the argument is a fresh
 * value (a call/constructor result — no lexical donor).
 */
function spawn_arg_root(param: BaseNode): string | undefined {
	let node = param;
	while (node.node_type === "access") {
		node = (node as AccessNode).target;
	}
	if (node.node_type === "value") {
		const name = (node as ValueNode).value;
		return name === "null" ? undefined : name;
	}
	return undefined;
}

/**
 * The scope depth of the innermost enclosing `async` block's BODY (where its
 * locals live and where the join runs), or undefined outside any async block.
 */
function innermost_nursery_depth(status: CheckStatus): number | undefined {
	const depths = status.nursery_scope_depths;
	return depths?.length ? depths[depths.length - 1] : undefined;
}

/**
 * N1a R2 / N1b E3 — the root rule for a SHARED class/trait argument spawned
 * inside an `async { }` block. Called from the Sendable validation site for
 * arguments that passed every other gate (so this fires only for the
 * Sendable-class case the Sendable gate waves through).
 */
export function enforce_spawn_arg_region(
	param: BaseNode,
	arg_type: Type,
	status: CheckStatus,
): void {
	if ((status.nursery_depth ?? 0) === 0) return;
	if (!is_shared_reference_type(arg_type.name, status)) return;
	const join_depth = innermost_nursery_depth(status);
	if (join_depth === undefined) return;

	const root = spawn_arg_root(param);
	const decl = root !== undefined ? status.values.findLast((v) => v.name === root) : undefined;
	let bound: boolean;
	let named_donor = false;
	if (decl) {
		named_donor = true;
		// Globals and params outlive the join; a local without a recorded
		// depth (should not happen) fails open.
		bound = decl.is_global || decl.decl_depth === undefined || decl.decl_depth <= join_depth;
	} else {
		// No named donor: a fresh temporary, or a checker-hoisted call-arg
		// temp (`const _param_N = <arg>`, declared in the construction's own
		// block once its statement checks). Either way the CONSTRUCTION's
		// scope is the anchor's scope — it must reach the join.
		bound = status.scope_depth <= join_depth;
	}
	if (bound) return;
	if (named_donor && root) {
		add_error(
			status,
			`'${root}' does not outlive the task — the join at 'async' happens after '${root}'s scope ends; declare '${root}' in the 'async' block's scope or outside it, or move it in ('move ${root}')`,
			param.start,
		);
	} else {
		add_error(
			status,
			`this task shares a temporary ${arg_type.name ?? ""} that dies before the 'async' join — bind it to a local in the 'async' block's scope and pass the local`,
			param.start,
		);
	}
}

/**
 * N2 / R4 — a detached task owns its captures. Called from the access-func
 * check for the CHAINED daemon form `Thread(fn(args)).detach()` /
 * `Fiber(fn(args)).detach()` (a construction stored in a variable and
 * detached later is not flow-tracked — recorded as a gap). A class/trait
 * argument crosses as a shared pointer and a daemon has no join to bound it,
 * so every non-`move` shared-reference argument is rejected. Globals are
 * exempt (process lifetime). The closure form is checked through its
 * captures: a class/trait capture cannot be move-spelled, so it is rejected
 * outright.
 */
export function enforce_detach_owns_captures(ctor: FunctionCallNode, status: CheckStatus): void {
	const first = ctor.params[0];
	if (!first) return;

	// The closure form: the env owns scalar/owning captures, but a CLASS or
	// TRAIT capture is a shared pointer (the Sendable gate) with no join to
	// bound it — reject.
	if (first.node_type === "func") {
		const lambda = first as FunctionNode;
		for (const cap of lambda.captures ?? []) {
			if (is_shared_reference_type(cap.type?.name, status)) {
				add_error(
					status,
					`detached task captures '${cap.name ?? cap.type?.name}' by reference — detach owns its captures; capture nothing shared, or spawn it into a nursery that outlives the use`,
					first.start,
				);
			}
		}
		return;
	}
	if (first.node_type !== "func_call") return;

	// The call form: moved args transfer ownership; everything else shared.
	const call = first as FunctionCallNode;
	const callee_params = (call.resolved_function as FunctionNode | undefined)?.params?.filter(
		(p) => !p.is_self_param,
	);
	for (let i = 0; i < call.params.length; i++) {
		const param = call.params[i];
		let arg_type: Type = type_from_value_node(param, status);
		const stamped = (param as unknown as { type?: Type }).type;
		if (!arg_type.name && stamped?.name) arg_type = stamped;
		if (callee_params?.[i]?.is_moved) continue;
		if (!is_shared_reference_type(arg_type.name, status)) continue;
		// A process-lifetime global is a sound share for a daemon.
		const root = spawn_arg_root(param);
		if (root !== undefined) {
			const decl = status.values.findLast((v) => v.name === root);
			if (decl?.is_global) continue;
		}
		// Sendable is irrelevant here: even a Sendable class is a shared
		// mutable instance, and nothing bounds the daemon's reads. A hoisted
		// `_param_N` temp (no StackValue) counts as an unnamed temporary.
		const named =
			root !== undefined &&
			!root.startsWith("_param_") &&
			!!status.values.findLast((v) => v.name === root);
		if (named && root) {
			add_error(
				status,
				`detached task captures '${root}' by reference — detach owns its captures; move it in ('move ${root}'), or spawn it into a nursery that outlives the use`,
				param.start,
			);
		} else {
			add_error(
				status,
				`detached task captures a temporary ${arg_type.name ?? ""} by reference — detach owns its captures; bind it to a local and move it in, or spawn it into a nursery that outlives the use`,
				param.start,
			);
		}
	}
}

/**
 * Convenience used by the Sendable validator: whether an argument that
 * already passed the Sendable gate is a shared reference (so the region
 * rule applies to it).
 */
export function is_sendable_shared_reference(
	type_name: string | undefined,
	status: CheckStatus,
): boolean {
	return is_sendable_type(type_name, status) && is_shared_reference_type(type_name, status);
}
