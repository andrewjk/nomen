import add_error from "../../add_error.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import is_sendable_type from "./is_sendable_type.ts";
import { is_owning_struct_type } from "./ownership.ts";
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
 *   every non-`mv` class/trait argument unconditionally (globals exempt —
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
export function spawn_arg_root_name(param: BaseNode): string | undefined {
	return spawn_arg_root(param);
}

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
 * Whether `type_name` is an OWNING VALUE STRUCT (owns heap resources — a
 * `List`/`Buffer` field, a `#destroy`, heap string fields). Borrowing one
 * into a task env (R1) needs the region proof; outside a nursery the pack
 * keeps the env deep-copy (no join exists to bound a borrow).
 */
function is_owning_struct_name(type_name: string | undefined, status: CheckStatus): boolean {
	if (!type_name) return false;
	const st = status.structs.find((s) => s.name === type_name && !s.is_class && !s.is_simple_type);
	if (!st) return false;
	return is_owning_struct_type(new Type(type_name), status);
}

/**
 * Whether `arg_type` is a non-view, non-array OWNING VALUE STRUCT — the R1
 * borrow-eligible shape inside a nursery.
 */
export function is_owning_spawn_arg(arg_type: Type, status: CheckStatus): boolean {
	if (arg_type.is_view || arg_type.is_array || !arg_type.name) return false;
	return is_owning_struct_name(arg_type.name, status);
}

/**
 * The region classification of one spawn argument (STRUCT_PLAN_3 N1a R1):
 * which arguments BORROW from the caller (and so need the root rule and the
 * R3 freeze) versus pack by copy/transfer. Only meaningful inside an
 * `async` block; `moved` is the callee parameter's `mv T` flag.
 */
export function spawn_arg_region_class(
	arg_type: Type,
	moved: boolean | undefined,
	status: CheckStatus,
): "borrow" | "copy" | "transfer" {
	if (moved) return "transfer";
	if (arg_type.is_view && !arg_type.is_array) return "borrow";
	if (is_shared_reference_type(arg_type.name, status)) return "borrow";
	if (is_owning_struct_name(arg_type.name, status)) return "borrow";
	return "copy";
}

/**
 * N1a R3 — the freeze: from the construction until the enclosing `async`
 * block exits, a BORROWED root is const. Reads are fine; writes, moves, and
 * mutable-passing error. The frozen sets are per-async-block frames
 * (`nursery_frozen_roots`): `check_async_block_node` pushes one, block
 * clones SHARE the innermost set (the freeze lasts to the block exit, not
 * to the construction's branch exit), and the set dies with the block's
 * cloned status — the enclosing scope never sees it.
 */
function freeze_root(root: string, status: CheckStatus): void {
	if (!status.nursery_frozen_roots?.length) return;
	status.nursery_frozen_roots[status.nursery_frozen_roots.length - 1].add(root);
}

/**
 * The R3 write gate: `'m' is borrowed by a task until this 'async' block
 * exits`. Called from every mutation path with the ROOT variable's name.
 * Returns true when the name is frozen (the error has been added).
 */
export function enforce_root_not_frozen(name: string, status: CheckStatus, start: number): boolean {
	const frames = status.nursery_frozen_roots;
	if (!frames?.length) return false;
	if (frames[frames.length - 1].has(name)) {
		add_error(
			status,
			`'${name}' is borrowed by a task until this 'async' block exits — it is read-only here (mv a copy in, or mv it in at the spawn)`,
			start,
		);
		return true;
	}
	return false;
}

/**
 * N1a R2 / N1b E3 — the root rule for a spawn argument borrowed into a task
 * (shared class/trait since tranche 1; mv value structs and views since
 * R1). Called from the Sendable validation site.
 */
export function enforce_spawn_arg_region(
	param: BaseNode,
	arg_type: Type,
	status: CheckStatus,
	is_ref_borrow = false,
): void {
	if ((status.nursery_depth ?? 0) === 0) return;
	const klass = is_ref_borrow ? "borrow" : spawn_arg_region_class(arg_type, false, status);
	if (klass !== "borrow") return;
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
	if (!bound) {
		if (named_donor && root) {
			add_error(
				status,
				`'${root}' does not outlive the task — the join at 'async' happens after '${root}'s scope ends; declare '${root}' in the 'async' block's scope or outside it, or mv it in ('mv ${root}')`,
				param.start,
			);
		} else {
			add_error(
				status,
				`this task shares a temporary ${arg_type.name ?? ""} that dies before the 'async' join — bind it to a local in the 'async' block's scope and pass the local`,
				param.start,
			);
		}
		return;
	}
	// R3: the bound donor is const from here to the block exit — EXCEPT
	// `Task` handles: sharing a task's handle and then cancelling/waiting on
	// it IS the coordination protocol (`t.cancel()` after a spawn is the
	// sanctioned shape, N1's "with(m) stays legal for shareable types"
	// position). The region rule above still bounds the handle's scope.
	if (root !== undefined && arg_type.name !== "Task") freeze_root(root, status);
}

/**
 * N2 / R4 — a detached task owns its captures. Called from the access-func
 * check for the CHAINED daemon form `Thread(fn(args)).detach()` /
 * `Fiber(fn(args)).detach()` (a construction stored in a variable and
 * detached later is not flow-tracked — recorded as a gap). A class/trait
 * argument crosses as a shared pointer and a daemon has no join to bound it,
 * so every non-`mv` shared-reference argument is rejected. Globals are
 * exempt (process lifetime). The closure form is checked through its
 * captures: a class/trait capture cannot be mv-spelled, so it is rejected
 * outright.
 */
export function enforce_detach_owns_captures(ctor: FunctionCallNode, status: CheckStatus): void {
	const first = ctor.params[0];
	if (!first) return;

	// The closure form: the env owns scalar/mv captures, but a CLASS or
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
				`detached task captures '${root}' by reference — detach owns its captures; mv it in ('mv ${root}'), or spawn it into a nursery that outlives the use`,
				param.start,
			);
		} else {
			add_error(
				status,
				`detached task captures a temporary ${arg_type.name ?? ""} by reference — detach owns its captures; bind it to a local and mv it in, or spawn it into a nursery that outlives the use`,
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
