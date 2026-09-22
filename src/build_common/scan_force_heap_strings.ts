import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import StructNode from "../nodes/StructNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { is_call_site_borrow_accessor } from "./string_return_analysis.ts";

// Collect string variable names that are reassigned a freshly-allocated heap
// string somewhere in the function body (including inside loops/branches).
// The build uses this to heap-allocate their initial literal value so that
// reassignment can uniformly free the previous value (e.g. `s = s + "x"`).
// A string local that is the RECEIVER of a `ref self` method call (e.g.
// `s.set(i, 'x')`) is also included: a literal initializer would store the
// rodata address, which the mutating method cannot write through.
//
// Shared by both backends. For the C backend the set additionally gates the
// borrow-reception strdup: a variable in this set will own heap from some
// point onward, so EVERY value it can hold must be heap-owned (a borrow
// reception is strdup'd into an owned copy) — otherwise the unconditional
// reassign/scope-exit frees would reclaim container storage when the heap
// branch never executed.
export default function scan_force_heap_strings(
	statements: BaseNode[],
	structs?: StructNode[],
): Set<string> {
	const result = new Set<string>();
	walk(statements, result, structs);
	return result;
}

function walk(statements: BaseNode[] | undefined, result: Set<string>, structs?: StructNode[]) {
	if (!statements) return;
	for (const stmt of statements) {
		visit(stmt, result, structs);
	}
}

function visit(node: BaseNode | undefined, result: Set<string>, structs?: StructNode[]) {
	if (!node) return;
	switch (node.node_type) {
		case "assign": {
			const a = node as AssignmentNode;
			if (a.left_value.node_type === "value") {
				if (is_fresh_heap_string(a.right_value)) {
					result.add((a.left_value as ValueNode).value);
				} else if (!a.operator && is_owned_string_var_rhs(a.right_value)) {
					// Plain `s = t` string assignment: value semantics strdups
					// the source into an OWNED copy (or transfers an owned pair
					// on last-use), so the target ends up heap-owning either
					// way. Pre-mark it: the declare site heap-allocates the
					// literal initializer and registers the scope-exit free.
					result.add((a.left_value as ValueNode).value);
				}
			}
			visit(a.right_value, result, structs);
			break;
		}
		case "access": {
			// A `ref self` method call on a string local (`s.set(i, 'x')`):
			// the method writes through the receiver, so the local must not
			// hold a read-only rodata literal — force it to a heap copy.
			const n = node as AccessNode;
			if (n.access.node_type === "access_func" && n.target.node_type === "value") {
				const target = n.target as ValueNode;
				if (
					target.type?.name === "string" &&
					structs
						?.find((s) => s.name === "string")
						?.functions.find((f) => f.name === (n.access as AccessFunctionCallNode).name)
						?.params?.some((p) => p.is_self_param && (p.is_ref || p.type?.is_ref))
				) {
					result.add(target.value);
				}
			}
			break;
		}
		case "while":
		case "for": {
			walk((node as unknown as { statements: BaseNode[] }).statements, result, structs);
			break;
		}
		case "if": {
			const n = node as IfElseNode;
			walk(n.if_branch?.statements, result, structs);
			walk(n.else_branch?.statements, result, structs);
			break;
		}
		case "switch": {
			const n = node as SwitchNode;
			for (const c of n.cases) {
				walk(c.branch?.statements, result, structs);
			}
			walk(n.else_branch?.statements, result, structs);
			break;
		}
		case "match": {
			const m = node as unknown as {
				cases?: { branch?: { statements?: BaseNode[] } }[];
				else_branch?: { statements?: BaseNode[] };
			};
			for (const c of m.cases ?? []) {
				walk(c.branch?.statements, result, structs);
			}
			walk(m.else_branch?.statements, result, structs);
			break;
		}
		default:
			break;
	}
}

// A right-hand side that produces a fresh heap string (concat, repeat,
// interpolation, to_string, or any string-returning function/method call).
// Bare literals and variable references are excluded — they don't allocate.
// A container BORROW accessor call (`.at`/`.first` without `owned_return`)
// is excluded too: it hands back a view into the receiver's storage, not a
// fresh allocation — forcing the target's initializer to a heap copy for
// those would strdup every plain borrow read (a leak).
function is_fresh_heap_string(node: BaseNode | undefined): boolean {
	if (!node) return false;
	// `x.to_string()` always yields an OWNED string copy (heap), and its
	// cached `.type` is not always stamped — special-case it before the type
	// gate so a literal-initialized target that is later reassigned from
	// `.to_string()` is force-heap (the literal gets strdup'd, so the
	// reassignment's free of the previous value is valid).
	if (node.node_type === "access") {
		const access = (node as AccessNode).access;
		if (
			access.node_type === "access_func" &&
			(access as AccessFunctionCallNode).name === "to_string"
		) {
			return true;
		}
	}
	const type_name = (node as unknown as { type?: { name?: string } }).type?.name;
	if (type_name !== "string") return false;
	if (node.node_type === "op") return true;
	if (node.node_type === "func_call") return true;
	if (node.node_type === "access") {
		const access = (node as AccessNode).access;
		if (access.node_type !== "access_func") return false;
		const fn = access as AccessFunctionCallNode;
		return !(!fn.owned_return && is_call_site_borrow_accessor(fn.name));
	}
	return false;
}

// A bare owned-string VARIABLE right-hand side (`s = t`, no explicit move):
// assignment value semantics strdup t into a copy the target owns. A bare
// identifier only — literals (rodata stores stay raw), explicit moves
// (`s = move t`, handled by the move transfer path), and view-typed sources
// (non-owning pair stores) are excluded.
function is_owned_string_var_rhs(node: BaseNode | undefined): boolean {
	if (!node || node.node_type !== "value") return false;
	const vn = node as ValueNode;
	if (typeof vn.value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(vn.value)) return false;
	if (vn.value === "true" || vn.value === "false" || vn.value === "null") return false;
	if (vn.is_moved) return false;
	const type = vn.type;
	return !!type && type.name === "string" && !type.is_view && !type.is_array;
}
