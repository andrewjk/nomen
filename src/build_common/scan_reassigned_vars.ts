import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import BaseNode from "../nodes/BaseNode.ts";
import IfElseNode from "../nodes/IfElseNode.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import ValueNode from "../nodes/ValueNode.ts";

/**
 * Collect the names reassigned anywhere in a function body (any nested
 * scope). The aarch64 string-concat constant folder (`resolve_string_value`)
 * resolves a variable operand to its DECLARATION initializer; that is only
 * sound while the variable still holds it. Once the name is reassigned, the
 * fold must be suppressed (`var tag = ""; tag = f(); "</" + tag + ">"` folded
 * to `"</>"` using the stale `""`).
 */
export default function scan_reassigned_vars(statements: BaseNode[] | undefined): Set<string> {
	const result = new Set<string>();
	walk(statements, result);
	return result;
}

function walk(statements: BaseNode[] | undefined, result: Set<string>) {
	if (!statements) return;
	for (const stmt of statements) visit(stmt, result);
}

function visit(node: BaseNode | undefined, result: Set<string>) {
	if (!node) return;
	switch (node.node_type) {
		case "assign": {
			const a = node as AssignmentNode;
			if (a.left_value.node_type === "value") {
				const name = (a.left_value as ValueNode).value;
				if (typeof name === "string") result.add(name);
			} else if (a.left_value.node_type === "access") {
				// A field/index target (`obj.f = …`, `a[i] = …`) can mutate a
				// borrowed value; not a bare name, so nothing to record here.
				void (a.left_value as AccessNode);
			}
			visit(a.right_value, result);
			break;
		}
		case "while":
		case "for": {
			walk((node as unknown as { statements: BaseNode[] }).statements, result);
			break;
		}
		case "if": {
			const n = node as IfElseNode;
			walk(n.if_branch?.statements, result);
			walk(n.else_branch?.statements, result);
			break;
		}
		case "switch": {
			const n = node as SwitchNode;
			for (const c of n.cases) walk(c.branch?.statements, result);
			walk(n.else_branch?.statements, result);
			break;
		}
		case "match": {
			const m = node as unknown as {
				cases?: { branch?: { statements?: BaseNode[] } }[];
				else_branch?: { statements?: BaseNode[] };
			};
			for (const c of m.cases ?? []) walk(c.branch?.statements, result);
			walk(m.else_branch?.statements, result);
			break;
		}
		default:
			break;
	}
}
