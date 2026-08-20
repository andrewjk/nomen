import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";

interface HoistScanStatus {
	variable_types?: Map<string, Type>;
	scoped_declarations?: DeclarationNode[];
	structs?: { name: string; functions?: FunctionNode[] }[];
}

const NON_IDENTIFIERS = new Set(["true", "false", "null", "self", "as", "default"]);

function is_identifier(value: string): boolean {
	return (
		!!value &&
		!NON_IDENTIFIERS.has(value) &&
		!/^(\+|-)?\d+(\.\d+)?$/.test(value) &&
		!value.startsWith('"') &&
		!value.startsWith("'")
	);
}

function root_name(node: BaseNode | null | undefined): string | undefined {
	if (!node) return undefined;
	if (node.node_type === "value") return (node as ValueNode).value;
	if (node.node_type === "access") return root_name((node as AccessNode).target);
	return undefined;
}

/**
 * Find the bare `string` variables whose `.length` is read inside a while
 * loop (condition, body, or update clause) and that the loop never
 * rebinds — the set of variables for which a single hoisted `strlen` before
 * the loop is equivalent to the per-evaluation `strlen` the backends
 * otherwise emit. Returns variable name → the `.length` target node.
 *
 * A variable is rejected when the loop subtree contains any of:
 * - an assignment whose left-hand root name is the variable (rebinds it)
 * - a declaration/parameter/for-item with the same name (shadows it)
 * - a call passing it `ref`/`mov`/`swap` (callee may rebind or drain it)
 * - a mutating (`ref self`) string method dispatched on it (e.g. `set`,
 *   which can change the effective strlen in place)
 * - any reference inside a nested `func`/`async_block` boundary (those
 *   bodies are emitted outside the loop's scope, where the hoisted temp
 *   or slot is not visible)
 * - any `raw` block anywhere (its code is opaque and may rebind anything)
 * Nullable strings are also rejected: hoisting would evaluate `strlen`
 * before the first condition check, moving a null dereference that today
 * only happens if the condition is actually reached.
 */
export default function scan_string_length_hoists(
	condition: BaseNode,
	statements: BaseNode[],
	update: BaseNode | undefined,
	status: HoistScanStatus,
): Map<string, ValueNode> {
	const candidates = new Map<string, ValueNode>();
	const invalidated = new Set<string>();
	const boundary_refs = new Set<string>();
	let has_raw = false;

	const is_string_target = (target: ValueNode): boolean => {
		const t = target.type;
		if (t?.is_view || t?.is_nullable) return false;
		if (t?.name) return t.name === "string";
		const vt = status.variable_types?.get(target.value);
		if (vt) return vt.name === "string" && !vt.is_view && !vt.is_nullable;
		const decl = status.scoped_declarations?.findLast((d) => d.name === target.value);
		if (!decl?.type) return false;
		return decl.type.name === "string" && !decl.type.is_view && !decl.type.is_nullable;
	};

	// Whether a string method call mutates its receiver: the method's self
	// param is `ref self` / `var self` (parse marks both with
	// declaration "var"). A mutating method can change the receiver's
	// effective strlen in place (e.g. `set` writing a NUL), so its receiver
	// is not loop-invariant. Non-mutating methods (`at`, `slice`, `hash`,
	// `to_string`, operators) leave the strlen result unchanged.
	const is_mutating_string_call = (call: AccessFunctionCallNode): boolean => {
		const string_struct = status.structs?.find((s) => s.name === "string");
		const method = string_struct?.functions?.find(
			(f) => f.name === call.name || f.name === `#${call.name}`,
		);
		if (!method) return false;
		const self_param = method.params?.[0];
		return !!self_param?.is_self_param && self_param.declaration === "var";
	};

	const walk_children = (n: BaseNode, in_boundary: boolean) => {
		const record = n as unknown as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (key === "parent" || key === "scope" || key === "node_type") continue;
			walk(record[key], in_boundary);
		}
	};

	const walk = (value: unknown, in_boundary: boolean) => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item, in_boundary);
			return;
		}
		const n = value as BaseNode;
		if (typeof n.node_type !== "string") return;
		switch (n.node_type) {
			case "raw": {
				has_raw = true;
				return;
			}
			case "func":
			case "async_block": {
				walk_children(n, true);
				return;
			}
			case "value": {
				const v = (n as ValueNode).value;
				if (in_boundary && is_identifier(v)) boundary_refs.add(v);
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
					const target = access.target as ValueNode;
					if (is_identifier(target.value) && is_string_target(target)) {
						candidates.set(target.value, target);
					}
				}
				if (
					!in_boundary &&
					access.access.node_type === "access_func" &&
					access.target.node_type === "value"
				) {
					const target = access.target as ValueNode;
					if (
						is_string_target(target) &&
						is_mutating_string_call(access.access as AccessFunctionCallNode)
					) {
						invalidated.add(target.value);
					}
				}
				walk_children(n, in_boundary);
				return;
			}
			case "assign": {
				const assign = n as unknown as {
					left_value: BaseNode;
					swap?: BaseNode;
				};
				const lhs = root_name(assign.left_value);
				if (lhs) invalidated.add(lhs);
				const swap = root_name(assign.swap);
				if (swap) invalidated.add(swap);
				walk_children(n, in_boundary);
				return;
			}
			case "declare":
			case "param": {
				const name = (n as unknown as { name?: string }).name;
				if (name) invalidated.add(name);
				walk_children(n, in_boundary);
				return;
			}
			case "for": {
				const item = (n as ForLoopNode).item;
				if (item?.value) invalidated.add(item.value);
				walk_children(n, in_boundary);
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
				walk_children(n, in_boundary);
				return;
			}
			default: {
				walk_children(n, in_boundary);
				return;
			}
		}
	};

	walk(condition, false);
	walk(statements, false);
	if (update) walk(update, false);

	for (const name of invalidated) candidates.delete(name);
	for (const name of boundary_refs) candidates.delete(name);
	if (has_raw) candidates.clear();
	return candidates;
}
