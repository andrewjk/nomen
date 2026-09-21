import add_error from "../../add_error.ts";
import type AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type AssignmentNode from "../../nodes/AssignmentNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import { child_nodes } from "../../nodes/child_nodes.ts";
import type DeclarationNode from "../../nodes/DeclarationNode.ts";
import type FunctionNode from "../../nodes/FunctionNode.ts";
import type ParameterNode from "../../nodes/ParameterNode.ts";
import type StructNode from "../../nodes/StructNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";

interface FieldWrites {
	/** Field names written on the tracked instance, directly or through any
	 *  callee the instance flows into. */
	fields: Set<string>;
	/** True when the walk hit something it cannot see through (a raw `#arch`
	 *  block, an unresolvable callee, a variadic escape, ...). */
	opaque: boolean;
	/** Why the walk gave up, for the diagnostic. Set when `opaque` is first
	 *  raised; propagated from callees. */
	reason?: string;
}

interface WalkContext {
	/** The tracked instance's local name (`self` in the init, the parameter's
	 *  name inside a followed callee). */
	root_name: string;
	/** The instance's struct definition, for method resolution. */
	root_struct: StructNode | undefined;
	/**
	 * Locals re-bound from the instance (`var Person t = self`). Only tracked
	 * when the instance is a CLASS — class assignment aliases the same
	 * instance, while value-struct assignment copies it (so a rebound struct
	 * local is independent and its writes don't propagate).
	 */
	aliases: Set<string>;
	status: CheckStatus;
	visiting: Set<string>;
	result: FieldWrites;
}

const checked_structs = new WeakSet<StructNode>();
const writes_memo = new WeakMap<FunctionNode, Map<number, FieldWrites>>();
const func_ids = new WeakMap<FunctionNode, number>();
let next_func_id = 1;

function fresh_writes(): FieldWrites {
	return { fields: new Set(), opaque: false };
}

function func_key(func: FunctionNode): string {
	let id = func_ids.get(func);
	if (id === undefined) {
		id = next_func_id++;
		func_ids.set(func, id);
	}
	return String(id);
}

/**
 * Custom `#init` completeness check: every field without a declared default
 * must be assigned by every custom `#init` overload (mirroring the auto-init,
 * which takes a constructor parameter for exactly those fields). The instance
 * starts as raw malloc/stack garbage, so a skipped field holds garbage for the
 * instance's whole life — the scope-exit `<Class>_destroy` then frees a
 * garbage string pointer or destroys a garbage class pointer (invalid free /
 * crash), and even a benign scalar reads nondeterministic data.
 *
 * The scan follows the instance through the program, so delegating part of
 * construction to a helper cannot silently switch the check off:
 *   - `self.<field> = ...` counts directly,
 *   - a method dispatched on `self` is followed (methods receive the instance
 *     by pointer on both backends, so its writes reach the instance),
 *   - `self` passed to a call is followed positionally when the receiving
 *     parameter aliases it (`ref`, or a class/trait-typed parameter); a
 *     by-value parameter gets a copy, so its writes don't propagate.
 * Following is transitive and memoized per (function, parameter), with a
 * cycle guard — a cyclic edge contributes nothing (the same policy
 * string_mutation_scan uses).
 *
 * An init whose reachable chain contains something the walk cannot see
 * through is UNVERIFIABLE and rejected for user code — the constructor must
 * use a pattern the checker can follow. The error fires only when there is
 * something at stake (at least one non-defaulted field); with every field
 * defaulted, the instance is fully seeded before the body runs and an
 * unanalyzable body is harmless. Trusted code is exempt, matching the
 * language's other lockdowns (raw/extern/ptr are library-only): the System
 * library (`is_library`, e.g. Mutex's raw-C constructor) and
 * `allow_internal` builds. The unverifiable shapes are:
 *   - a raw `#arch` block in the chain (library-only anyway),
 *   - an unresolvable callee — including dispatch through a func-typed
 *     field, which is also a genuine hazard: an unknown callback invoked
 *     mid-construction can read the not-yet-assigned fields,
 *   - the instance flowing into a variadic/unknown parameter position.
 *
 * Fields assigned anywhere in a body — including inside if/loop branches —
 * count as assigned there; proving must-assign flow is left for later.
 * Deferred bodies (nested funcs, lambdas, spawn/async) never run at
 * construction time, so assignments inside them never count.
 *
 * `inits` is the struct's custom `#init` overloads (with bodies); for generic
 * structs it is the monomorphized clones. A field missing from any judged
 * overload — or an unverifiable overload — is reported once per field/overload.
 */
export default function check_init_assigns_all_fields(
	struct: StructNode,
	inits: FunctionNode[],
	status: CheckStatus,
): void {
	if (!inits.length) return;
	// Monomorphize pushes the mono struct into the root's statements, so the
	// statement-order walk re-enters here for a struct the mono path already
	// checked. Diagnose each struct exactly once per compile.
	if (checked_structs.has(struct)) return;
	checked_structs.add(struct);
	const has_unverifiable_fields = struct.fields.some((f) => !f.value);
	const trusted = !!struct.is_library || !!status.allow_internal;
	const visiting = new Set<string>();
	const judged: FieldWrites[] = [];
	for (const init of inits) {
		const self_index = init.params.findIndex((p) => p.is_self_param);
		if (self_index === -1) continue;
		const writes = collect_writes(init, self_index, status, visiting);
		if (writes.opaque) {
			// Nothing to verify when every field is defaulted (the backends
			// seed them all before the body runs); trusted code is exempt the
			// same way it is for raw/extern/ptr.
			if (!has_unverifiable_fields || trusted) continue;
			add_error(
				status,
				`Cannot verify that '#init' assigns every field: ${writes.reason ?? "the body cannot be fully analyzed"}. Assign fields directly or call resolvable helpers, or declare field defaults.`,
				init.start,
			);
			continue;
		}
		judged.push(writes);
	}
	for (const field of struct.fields) {
		// A defaulted field is seeded before the body runs (both backends).
		if (field.value) continue;
		const missed = judged.some((scan) => !scan.fields.has(field.name));
		if (!missed) continue;
		add_error(
			status,
			`Field '${field.name}' is not assigned by '#init' and has no default`,
			field.start,
		);
	}
}

/**
 * Collect the field names written on the instance received at
 * `func.params[root_index]` (its `self`, or the parameter an init passed
 * `self` to). Memoized per (function, root_index); `visiting` breaks cycles.
 */
function collect_writes(
	func: FunctionNode,
	root_index: number,
	status: CheckStatus,
	visiting: Set<string>,
): FieldWrites {
	let memo = writes_memo.get(func);
	if (!memo) {
		memo = new Map();
		writes_memo.set(func, memo);
	}
	const cached = memo.get(root_index);
	if (cached) return cached;
	const key = `${func_key(func)}#${root_index}`;
	if (visiting.has(key)) return fresh_writes();
	visiting.add(key);
	const result = fresh_writes();
	const param = func.params[root_index];
	if (param) {
		const ctx: WalkContext = {
			root_name: param.name,
			root_struct: resolve_struct(param.type?.name, status),
			aliases: new Set(),
			status,
			visiting,
			result,
		};
		for (const stmt of func.statements) {
			walk_writes(stmt, ctx);
		}
	}
	visiting.delete(key);
	memo.set(root_index, result);
	return result;
}

function resolve_struct(name: string | undefined, status: CheckStatus): StructNode | undefined {
	if (!name) return undefined;
	return status.structs.find((s) => s.name === name && !s.is_simple_type);
}

function is_bare_root(node: BaseNode, root_name: string): boolean {
	return node.node_type === "value" && (node as ValueNode).value === root_name;
}

/** Whether `node` denotes the tracked instance: the root name itself or a
 *  local re-bound from it (`var Person t = self`). */
function is_instance_ref(node: BaseNode, ctx: WalkContext): boolean {
	return (
		is_bare_root(node, ctx.root_name) ||
		(node.node_type === "value" && ctx.aliases.has((node as ValueNode).value))
	);
}

/**
 * Whether a value received by `param` aliases the caller's instance (writes
 * through it reach the original) or is an independent copy. Method receivers
 * are handled before this — they always alias. Free-function parameters alias
 * when declared `ref` or when their type is a class/trait (reference types);
 * a by-value struct/scalar parameter is a copy.
 */
function param_aliases_instance(param: ParameterNode | undefined, status: CheckStatus): boolean {
	if (!param) return false;
	if (param.is_ref || param.type?.is_ref) return true;
	const name = param.type?.name;
	if (!name) return false;
	if (status.structs.find((s) => s.name === name && s.is_class)) return true;
	if (status.traits.some((t) => t.name === name)) return true;
	return false;
}

function walk_writes(node: BaseNode, ctx: WalkContext): void {
	if (!node || typeof node !== "object") return;
	if (node.node_type === "raw") {
		ctx.result.opaque = true;
		ctx.result.reason ??= "it contains a raw '#arch' block";
		return;
	}
	// Deferred bodies (nested funcs / lambdas, spawned tasks) don't run at
	// construction time — don't descend, so assignments inside them never
	// count.
	if (node.node_type === "func" || node.node_type === "spawn" || node.node_type === "async_block")
		return;
	if (node.node_type === "declare") {
		// A class re-bind (`var Person t = self`) aliases the same instance —
		// follow writes through the new name. A value-struct re-bind is a
		// COPY, so it stays independent and is not tracked.
		const decl = node as DeclarationNode;
		if (ctx.root_struct?.is_class && decl.value && is_instance_ref(decl.value, ctx)) {
			ctx.aliases.add(decl.name);
		}
	}
	if (node.node_type === "assign") {
		const assign = node as AssignmentNode;
		// Only a plain `=` initializes: `+=` and friends read the field first,
		// and a `swap` exchange can store a garbage displaced value.
		if (!assign.operator && !assign.swap && assign.left_value.node_type === "access") {
			const access = assign.left_value as AccessNode;
			if (access.access.node_type === "access_field" && is_instance_ref(access.target, ctx)) {
				ctx.result.fields.add(access.access.name);
			}
		}
	}
	// `self.helper(...)` and `helper(self)` can both write the instance's
	// fields — follow the callee. Dispatch on a FIELD (`self.items.grow(...)`)
	// mutates contents, not the binding, so it stays transparent.
	let call_params: BaseNode[] = [];
	let access_func: AccessFunctionCallNode | undefined;
	if (node.node_type === "func_call") {
		call_params = (node as unknown as { params?: BaseNode[] }).params ?? [];
	} else if (node.node_type === "access") {
		const access = (node as AccessNode).access;
		if (access.node_type === "access_func") {
			access_func = access as AccessFunctionCallNode;
			call_params = access_func.params;
		}
	}
	if (access_func || node.node_type === "func_call") {
		const self_flows = !!access_func && is_instance_ref((node as AccessNode).target, ctx);
		const arg_positions: number[] = [];
		for (let j = 0; j < call_params.length; j++) {
			if (is_instance_ref(call_params[j], ctx)) arg_positions.push(j);
		}
		if (self_flows || arg_positions.length) {
			const callee = access_func
				? resolve_method(access_func, node as AccessNode, ctx)
				: resolve_free(node as unknown as { name: string }, call_params.length, ctx);
			if (!callee) {
				// Unresolvable flow — e.g. an indirect call through a
				// func-typed field, which can also READ the not-yet-assigned
				// fields mid-construction.
				ctx.result.opaque = true;
				ctx.result.reason ??= access_func
					? `the call to 'self.${access_func.name}' cannot be resolved`
					: `the call to '${(node as unknown as { name: string }).name}' cannot be resolved`;
				return;
			}
			const self_offset = callee.params[0]?.is_self_param ? 1 : 0;
			if (self_flows) {
				if (self_offset === 0) {
					ctx.result.opaque = true;
					ctx.result.reason ??= `the call to '${callee.name}' does not receive the instance`;
					return;
				}
				// The instance is the receiver: methods always alias it.
				follow_callee(ctx, callee, 0);
			}
			for (const j of arg_positions) {
				const pos = j + self_offset;
				const target_param = callee.params[pos];
				if (!target_param || target_param.is_variadic) {
					// The instance escapes into a position the callee can
					// forward anywhere.
					ctx.result.opaque = true;
					ctx.result.reason ??= `the instance is passed into a variadic or unknown parameter of '${callee.name}'`;
					return;
				}
				follow_callee(ctx, callee, pos);
			}
		}
	}
	for (const child of child_nodes(node)) {
		walk_writes(child, ctx);
	}
}

/** Merge the writes of the callee receiving the instance at `param_index`
 *  into the current scan — unless the parameter takes an independent copy. */
function follow_callee(ctx: WalkContext, callee: FunctionNode, param_index: number): void {
	if (!param_aliases_instance(callee.params[param_index], ctx.status)) return;
	const writes = collect_writes(callee, param_index, ctx.status, ctx.visiting);
	if (writes.opaque) {
		ctx.result.opaque = true;
		ctx.result.reason ??= writes.reason;
		return;
	}
	for (const field of writes.fields) {
		ctx.result.fields.add(field);
	}
}

/** Resolve a dispatched call to its FunctionNode: prefer the checker's stamp,
 *  fall back to a name (+non-self arity) match on the receiver's struct. */
function resolve_method(
	access_func: AccessFunctionCallNode,
	node: AccessNode,
	ctx: WalkContext,
): FunctionNode | undefined {
	const stamped = (access_func as unknown as { resolved_function?: FunctionNode })
		.resolved_function;
	if (stamped) return stamped;
	// Only a dispatch ON the instance reaches here un-resolved (the checker
	// stamps every call it resolves, so a miss means it isn't a real method —
	// e.g. an indirect call through a func-typed field).
	if (!is_instance_ref(node.target, ctx) || !ctx.root_struct) return undefined;
	const arity = access_func.params.length;
	const by_arity = ctx.root_struct.functions.filter(
		(f) => f.name === access_func.name && f.params.filter((p) => !p.is_self_param).length === arity,
	);
	return by_arity.at(-1) ?? ctx.root_struct.functions.findLast((f) => f.name === access_func.name);
}

/** Resolve a free call to its FunctionNode: prefer the checker's stamp, fall
 *  back to the gathered function table (methods identified by their leading
 *  self parameter, mirroring find_free_function). */
function resolve_free(
	node: { name: string; resolved_function?: FunctionNode },
	arity: number,
	ctx: WalkContext,
): FunctionNode | undefined {
	if (node.resolved_function) return node.resolved_function;
	const non_method = (f: FunctionNode) => !f.params?.[0]?.is_self_param;
	return (
		ctx.status.functions.findLast(
			(f) =>
				f.name === node.name &&
				non_method(f) &&
				(f.params.filter((p) => !p.is_self_param).length === arity ||
					f.params.some((p) => p.is_variadic)),
		) ?? ctx.status.functions.findLast((f) => f.name === node.name && non_method(f))
	);
}
