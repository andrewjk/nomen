import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import AssignmentNode from "../../nodes/AssignmentNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import IfElseNode from "../../nodes/IfElseNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import SwitchNode from "../../nodes/SwitchNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";

// Collect string variable names that are reassigned a freshly-allocated heap
// string somewhere in the function body (including inside loops/branches).
// The build uses this to heap-allocate their initial literal value so that
// reassignment can uniformly free the previous value (e.g. `s = s + "x"`).
// A string local that is the RECEIVER of a `ref self` method call (e.g.
// `s.set(i, 'x')`) is also included: a literal initializer would store the
// rodata address, which the mutating method cannot write through.
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
			if (a.left_value.node_type === "value" && is_fresh_heap_string(a.right_value)) {
				result.add((a.left_value as ValueNode).value);
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
		default:
			break;
	}
}

// A right-hand side that produces a fresh heap string (concat, repeat,
// interpolation, to_string, or any string-returning function/method call).
// Bare literals and variable references are excluded — they don't allocate.
function is_fresh_heap_string(node: BaseNode | undefined): boolean {
	if (!node) return false;
	const type_name = (node as unknown as { type?: { name?: string } }).type?.name;
	if (type_name !== "string") return false;
	if (node.node_type === "op") return true;
	if (node.node_type === "func_call") return true;
	if (node.node_type === "access") {
		return (node as AccessNode).access.node_type === "access_func";
	}
	return false;
}
