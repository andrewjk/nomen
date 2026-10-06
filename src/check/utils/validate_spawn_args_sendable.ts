import add_error from "../../add_error.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import is_sendable_type from "./is_sendable_type.ts";
import {
	enforce_spawn_arg_region,
	is_owning_spawn_arg,
	spawn_arg_root_name,
} from "./spawn_region.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Validate a spawn's packed arguments (CLOSURE.md Phase 3d; the shrunk
 * `Sendable` — docs/ASYNC.md, "Design decisions"; STRUCT_PLAN_3 N1a R1 for
 * the region classification).
 *
 * Argument classes at the task boundary:
 *
 * - MOVED (`move T` param): the callee takes exclusive ownership — no
 *   sharing, no race, no region to prove.
 * - OWNING VALUE STRUCT, bare, INSIDE an `async` block: a region-checked
 *   BORROW (R1) — the env takes a pointer (no deep copy), the donor must
 *   join-bound (the root rule), and the freeze makes it const until the
 *   block exits (R3). Stamped `region_borrowed_args` for the backends'
 *   packers. OUTSIDE a nursery there is no join to bound a borrow, so the
 *   pack keeps today's env deep-copy.
 * - `view`-typed: a borrow of its source — region-checked + frozen inside a
 *   nursery (the env's (ptr, len) pair aliases the source either way).
 * - Class/trait references: shared pointers — `Sendable` gates aliasability
 *   (the shipped transition-era rule), and the root rule bounds the alias
 *   inside a nursery.
 * - Scalars/strings and Copyable structs: copied at the boundary (strings
 *   deep-copied at pack) — no checks.
 */
export default function validate_spawn_args_sendable(
	call: FunctionCallNode,
	status: CheckStatus,
	reason?: string,
): void {
	const callee_params = (call.resolved_function as FunctionNode | undefined)?.params?.filter(
		(p) => !p.is_self_param,
	);
	for (let i = 0; i < call.params.length; i++) {
		const param = call.params[i];
		let arg_type: Type = type_from_value_node(param, status);
		// A constant-folded argument (e.g. `"a" + "b"` → a synthetic data
		// label value) resolves to no declared name — fall back to the
		// checker-stamped node type, which the fold sets.
		const stamped = (param as unknown as { type?: Type }).type;
		if (!arg_type.name && stamped?.name) {
			arg_type = stamped;
		}
		// MOVED: the callee's `move T` parameter takes exclusive ownership
		// of the argument — no sharing, no race, no region to prove.
		if (callee_params?.[i]?.is_moved) {
			continue;
		}
		const inside_nursery = (status.nursery_depth ?? 0) > 0;
		// R1: a `ref T` parameter (T a VALUE struct) inside a nursery is a
		// mutable borrow — the env passes the donor's address (no copy), the
		// root rule bounds the donor, and the freeze keeps the donor itself
		// const while the callee mutates through the ref. Outside a nursery
		// the pack keeps the env copy (no join to bound the borrow).
		const callee_param = callee_params?.[i];
		if (
			inside_nursery &&
			callee_param?.type?.is_ref &&
			arg_type.name &&
			!arg_type.is_view &&
			!arg_type.is_array
		) {
			const st = status.structs.find(
				(st_) => st_.name === arg_type.name && !st_.is_class && !st_.is_simple_type,
			);
			if (st) {
				if (!call.region_borrowed_args) call.region_borrowed_args = [];
				if (!call.region_borrowed_args.includes(i)) call.region_borrowed_args.push(i);
				enforce_spawn_arg_region(param, arg_type, status, true);
				continue;
			}
		}
		// R1: an OWNING value struct passed bare inside a nursery is a
		// region-checked borrow. `Sendable` does not apply to it — the env
		// aliases the donor's storage and the root rule + freeze bound it.
		if (is_owning_spawn_arg(arg_type, status)) {
			// A PROCESS-LIFETIME GLOBAL donor is its own region proof — the
			// same exemption the detach rule takes (enforce_detach_owns_
			// captures): nothing can dangle because nothing ever ends. The
			// app-lifetime Channel/Mutex share (the daemon handshake, a
			// worker pool's lock) rides this — the env packs the pointer
			// (a borrow, no copy, no destroy) and the global stays live.
			const bare_root = spawn_arg_root_name(param);
			const bare_decl =
				bare_root !== undefined ? status.values.findLast((v) => v.name === bare_root) : undefined;
			const global_donor = !!bare_decl?.is_global;
			if (!inside_nursery && !global_donor) {
				// Outside a nursery there is no join to bound a borrow, and an
				// env deep-copy is unsound for owning structs (the pack copies
				// string fields only — a container field would share its
				// buffer and double-free at teardown). The borrow needs the
				// nursery's region proof. The donor's name (when the argument
				// is a bare variable) names the fix.
				const donor = spawn_arg_root_name(param);
				add_error(
					status,
					`spawn argument of type ${arg_type.name} owns heap memory — spawn it inside an 'async' block as a borrowed read (the join bounds the borrow)${
						donor ? `, or move it in ('move ${donor}')` : ""
					}`,
					param.start,
				);
				continue;
			}
			if (!call.region_borrowed_args) call.region_borrowed_args = [];
			if (!call.region_borrowed_args.includes(i)) call.region_borrowed_args.push(i);
			if (inside_nursery) enforce_spawn_arg_region(param, arg_type, status);
			continue;
		}
		// R1: a `view`-typed argument is a borrow of its source — region-
		// checked + frozen inside a nursery (outside one, the env's pair
		// copy has no join to bound it; the shipped posture applies).
		if (inside_nursery && arg_type.is_view && !arg_type.is_array) {
			enforce_spawn_arg_region(param, arg_type, status);
			continue;
		}
		if (is_sendable_type(arg_type.name, status)) {
			// The Sendable gate waves SHARED class/trait references through —
			// inside an `async { }` block their donor must still join-bound
			// (STRUCT_PLAN_3 N1a R2 / N1b E3, in spawn_region.ts).
			enforce_spawn_arg_region(param, arg_type, status);
			continue;
		}
		add_error(
			status,
			`Spawn argument of type ${arg_type.name || "<unknown>"} is not Sendable${
				reason ??
				" — a shared class/trait reference crossing a task boundary must be marked Sendable; move it in (a `move` parameter), share it as a checked region borrow inside an 'async' block, or mediate it through Mutex/Channel/Atomic<T>"
			}`,
			param.start,
		);
	}
}
