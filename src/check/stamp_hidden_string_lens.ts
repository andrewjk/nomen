import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import type RootNode from "../nodes/RootNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import type CheckStatus from "./CheckStatus.ts";

/**
 * Post-check pass implementing the PERF gap 2.4 fix: thread a string's
 * length through the call boundary so a per-character helper doesn't pay one
 * `strlen` per CALL.
 *
 * For every function whose Nomen-level body reads `<param>.length` on a
 * by-value `string` param (and never rebinds, mutates, or escapes it), the
 * param is stamped `hidden_len`. The backends then lower it as TWO
 * parameters — the `char*` plus a trailing `long _<name>_len` companion
 * (mirroring the nullable `_has` companion) — and the body's `.length` reads
 * become loads of that companion instead of `strlen`. Call sites append the
 * companion argument, preferring a loop-invariant hoisted strlen temp
 * (scan_string_length_hoists treats such args like `.length` reads), so a
 * helper called once per line over a large document costs ONE strlen, not
 * O(lines).
 *
 * Conservative exclusions (any of these keeps the plain one-pointer ABI):
 * - raw blocks anywhere in the body (opaque code may touch the param), or no
 *   body at all
 * - `#init`/`#destroy`/`init`/`destroy`/`main` and any non-identifier or
 *   `_`/`#`-prefixed name (operators, compiler-generated helpers) — their
 *   call sites use bespoke emission paths
 * - variadic params anywhere (their call sites pack hidden count/ptr pairs)
 * - `is_inline` functions (the aarch64 inline splicer)
 * - trait method declarations/default bodies, and struct methods that
 *   implement a trait method (vtable dispatch uses the trait's declared
 *   signature)
 * - functions referenced as VALUES anywhere in the program (`var func f =
 *   helper`, `obj.method` as a value, nursery.spawn targets) — indirect
 *   calls use the declared ABI
 * - params that are ref/mov/view/nullable/variadic/self, or that the body
 *   assigns to, passes ref/mov/swap, mutates through a `var self`/`ref self`
 *   string method, or references across a nested func/async boundary, or
 *   whose companion name `_<name>_len` collides with any declared name in
 *   the body
 */

const NON_IDENTIFIERS = new Set(["true", "false", "null", "self", "as", "default"]);

function is_plain_identifier(value: string | undefined): value is string {
	if (!value) return false;
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) return false;
	if (value.startsWith("_")) return false;
	return !NON_IDENTIFIERS.has(value);
}

function root_name(node: BaseNode | null | undefined): string | undefined {
	if (!node) return undefined;
	if (node.node_type === "value") {
		const v = (node as { value?: string }).value;
		return is_plain_identifier(v) ? v : undefined;
	}
	if (node.node_type === "access") return root_name((node as AccessNode).target);
	return undefined;
}

interface FunctionOwner {
	func: FunctionNode;
	struct?: StructNode;
	is_trait_func?: boolean;
}

function collect_functions(root: RootNode, status: CheckStatus): FunctionOwner[] {
	const out: FunctionOwner[] = [];
	const seen = new Set<FunctionNode>();
	const add = (func: FunctionNode, struct?: StructNode, is_trait_func?: boolean) => {
		if (seen.has(func)) return;
		seen.add(func);
		out.push({ func, struct, is_trait_func });
	};
	// status.structs/functions include checker-synthesized monomorphization
	// copies that are NOT reachable from the root tree; the root walk then
	// adds anything declared in source (nested funcs included).
	for (const struct of status.structs) {
		for (const func of struct.functions) add(func, struct);
	}
	for (const trait of status.traits) {
		for (const func of trait.functions) add(func, undefined, true);
	}
	for (const func of status.functions) add(func);
	walk_tree(root, (n) => {
		if (n.node_type === "struct") {
			const s = n as StructNode;
			for (const func of s.functions) add(func, s);
		} else if (n.node_type === "trait") {
			const t = n as TraitNode;
			for (const func of t.functions) add(func, undefined, true);
		} else if (n.node_type === "func") {
			add(n as FunctionNode);
		}
	});
	return out;
}

/** Names of functions referenced as VALUES (func-typed, non-call nodes). */
function collect_value_referenced_names(root: RootNode, status: CheckStatus): Set<string> {
	const excluded = new Set<string>();
	const visit = (n: BaseNode) => {
		const type_name = (n as unknown as { type?: { name?: string } }).type?.name;
		if (type_name !== "func") return;
		if (n.node_type === "value") {
			const v = (n as { value?: string }).value;
			if (is_plain_identifier(v)) excluded.add(v);
		} else if (n.node_type === "access_field") {
			const name = (n as AccessFieldNode).name;
			if (is_plain_identifier(name)) excluded.add(name);
		}
	};
	walk_tree(root, visit);
	for (const struct of status.structs) walk_tree(struct, visit);
	for (const trait of status.traits) walk_tree(trait, visit);
	for (const func of status.functions) walk_tree(func, visit);
	return excluded;
}

function walk_tree(node: unknown, visit: (n: BaseNode) => void) {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) walk_tree(item, visit);
		return;
	}
	const n = node as BaseNode;
	if (typeof n.node_type !== "string") return;
	visit(n);
	const record = n as unknown as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key === "parent" || key === "scope" || key === "node_type") continue;
		walk_tree(record[key], visit);
	}
}

export default function stamp_hidden_string_lens(root: RootNode, status: CheckStatus) {
	const value_referenced = collect_value_referenced_names(root, status);
	const owners = collect_functions(root, status);
	const string_struct = status.structs.find((s) => s.name === "string");

	for (const { func, struct, is_trait_func } of owners) {
		if (func.hidden_len_stamped) continue;
		func.hidden_len_stamped = true;
		if (!func.has_body || func.statements.length === 0) continue;
		if (func.is_inline || is_trait_func) continue;
		const bare_name = func.name.replace(/^#/, "");
		if (!is_plain_identifier(func.name)) continue;
		if (["main", "init", "destroy"].includes(bare_name)) continue;
		if (value_referenced.has(func.name)) continue;
		if (func.params.some((p) => p.is_variadic || p.is_variadic_tuple)) continue;
		// A struct method implementing a trait method must keep the trait's
		// declared signature — vtable dispatch casts to it.
		if (struct && trait_declares_method(struct, func.name, status)) continue;

		const candidates = new Set<string>();
		for (const param of func.params) {
			if (param_is_hidden_len_candidate(param)) candidates.add(param.name);
		}
		if (candidates.size === 0) continue;

		const reads = new Set<string>();
		const invalidated = new Set<string>();
		const declared_names = new Set<string>();
		let has_raw = false;

		const visit_children = (n: BaseNode, in_boundary: boolean) => {
			const record = n as unknown as Record<string, unknown>;
			for (const key of Object.keys(record)) {
				if (key === "parent" || key === "scope" || key === "node_type") continue;
				const child = record[key];
				if (Array.isArray(child)) {
					for (const item of child) {
						if (item && typeof item === "object" && (item as BaseNode).node_type) {
							visit(item as BaseNode, in_boundary);
						}
					}
				} else if (child && typeof child === "object" && (child as BaseNode).node_type) {
					visit(child as BaseNode, in_boundary);
				}
			}
		};

		const visit = (n: BaseNode, in_boundary: boolean) => {
			switch (n.node_type) {
				case "raw":
					has_raw = true;
					return;
				case "func":
				case "async_block":
					visit_children(n, true);
					return;
				case "value": {
					const v = (n as { value?: string }).value;
					if (in_boundary && is_plain_identifier(v)) invalidated.add(v);
					return;
				}
				case "access": {
					const access = n as AccessNode;
					if (
						!in_boundary &&
						access.access.node_type === "access_field" &&
						(access.access as AccessFieldNode).name === "length" &&
						access.target.node_type === "value"
					) {
						const name = (access.target as { value?: string }).value;
						if (name !== undefined && candidates.has(name)) reads.add(name);
					}
					if (
						!in_boundary &&
						access.access.node_type === "access_func" &&
						access.target.node_type === "value"
					) {
						const name = (access.target as { value?: string }).value;
						const call = access.access as AccessFunctionCallNode;
						if (name !== undefined && candidates.has(name)) {
							const method = string_struct?.functions.find(
								(f) => f.name === call.name || f.name === `#${call.name}`,
							);
							const self_param = method?.params?.[0];
							if (
								self_param?.is_self_param &&
								(self_param.declaration === "var" || self_param.is_ref)
							) {
								invalidated.add(name);
							}
						}
					}
					visit_children(n, in_boundary);
					return;
				}
				case "assign": {
					const assign = n as unknown as { left_value: BaseNode; swap?: BaseNode };
					const lhs = root_name(assign.left_value);
					if (lhs) invalidated.add(lhs);
					const swap = root_name(assign.swap);
					if (swap) invalidated.add(swap);
					visit_children(n, in_boundary);
					return;
				}
				case "declare":
				case "param": {
					const name = (n as unknown as { name?: string }).name;
					if (name) declared_names.add(name);
					visit_children(n, in_boundary);
					return;
				}
				case "for": {
					const item = (n as ForLoopNode).item;
					if (item?.value) declared_names.add(item.value);
					visit_children(n, in_boundary);
					return;
				}
				case "func_call":
				case "access_func": {
					const call = n as unknown as {
						params?: BaseNode[];
						ref_param_indices?: number[];
						mov_param_indices?: number[];
						swap_params?: Map<number, BaseNode>;
					};
					for (const indices of [call.ref_param_indices, call.mov_param_indices]) {
						for (const i of indices ?? []) {
							const arg = root_name(call.params?.[i]);
							if (arg) invalidated.add(arg);
						}
					}
					if (call.swap_params) {
						for (const [i, swap] of call.swap_params) {
							for (const arg of [root_name(call.params?.[i]), root_name(swap)]) {
								if (arg) invalidated.add(arg);
							}
						}
					}
					visit_children(n, in_boundary);
					return;
				}
				default:
					visit_children(n, in_boundary);
					return;
			}
		};

		for (const stmt of func.statements) visit(stmt, false);
		if (has_raw) continue;

		for (const name of candidates) {
			if (!reads.has(name)) continue;
			if (invalidated.has(name)) continue;
			if (declared_names.has(`_${name}_len`)) continue;
			const param = func.params.find((p) => p.name === name)!;
			param.hidden_len = true;
		}
	}
}

function trait_declares_method(
	struct: StructNode,
	method_name: string,
	status: CheckStatus,
): boolean {
	for (const trait_name of struct.traits) {
		const trait = status.traits.find((t) => t.name === trait_name);
		if (trait?.functions.some((f) => f.name === method_name)) return true;
	}
	return false;
}

function param_is_hidden_len_candidate(param: ParameterNode): boolean {
	return (
		!param.is_self_param &&
		!param.is_variadic &&
		!param.is_variadic_tuple &&
		!param.is_ref &&
		!param.is_moved &&
		// NOTE: an `Array<T>`'s parsed Type carries the ELEMENT name
		// (`{name: T, is_array}`), so the name check alone would match
		// `Array<string>` params — is_array excludes them.
		param.type.name === "string" &&
		!param.type.is_array &&
		!param.type.is_ref &&
		!param.type.is_view &&
		!param.type.is_nullable
	);
}
