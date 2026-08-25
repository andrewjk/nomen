import { SIMPLE_TYPES } from "../../built_in_types.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";

const MAX_STATEMENTS = 15;

export function scan_inline_candidates(root: BaseNode): Map<string, BaseNode> {
	const result = new Map<string, BaseNode>();
	const statements = (root as any).statements ?? [];
	for (const stmt of statements) {
		if (stmt.node_type === "func") {
			const func = stmt as FunctionNode;
			if (is_inline_candidate(func)) {
				result.set(func.name, func);
			}
		}
	}
	return result;
}

function is_inline_candidate(func: FunctionNode): boolean {
	if (!func.has_body) return false;
	if (func.is_inline) return false;
	if (func.statements.length === 0 || func.statements.length > MAX_STATEMENTS) return false;
	if (func.returns_mov) return false;
	// Raw-block (FFI) functions have arch-specific bodies (`#arch: c`,
	// `aarch64_use_c`, raw `aarch64`, …) that the general inline path can't
	// splice in: a companion-C body emits nothing inline, leaving the call a
	// no-op (the args get set up then discarded). Such functions are already
	// emitted as standalone callable symbols, so force a real `bl` instead.
	if (func.statements.some((s) => s.node_type === "raw")) return false;

	for (const param of func.params) {
		if (param.is_variadic || param.is_variadic_tuple) return false;
		if (!SIMPLE_TYPES.includes(param.type.name)) return false;
		if (param.type.is_ref) return false;
		if (param.is_moved) return false;
		if (param.declaration === "var") return false;
	}

	if (func.return_type && func.return_type.name && !SIMPLE_TYPES.includes(func.return_type.name)) {
		return false;
	}

	return is_leaf(func.statements);
}

function is_leaf(statements: BaseNode[]): boolean {
	const visited = new Set<object>();
	for (const stmt of statements) {
		if (!check_leaf(stmt, visited)) return false;
	}
	return true;
}

function check_leaf(node: BaseNode | undefined, visited: Set<object>): boolean {
	if (!node || typeof node !== "object") return true;
	if (visited.has(node)) return true;
	visited.add(node);

	const nt = (node as any).node_type;
	if (nt === "func_call") return false;
	if (nt === "access" && (node as any).access?.node_type === "access_func") return false;
	if (nt === "func") return false;

	for (const key of Object.keys(node)) {
		if (key === "node_type" || key === "start" || key === "type" || key === "scope") continue;
		const child = (node as any)[key];
		if (Array.isArray(child)) {
			for (const item of child) {
				if (item && typeof item === "object" && (item as any).node_type) {
					if (!check_leaf(item as BaseNode, visited)) return false;
				}
			}
		} else if (child && typeof child === "object" && (child as any).node_type) {
			if (!check_leaf(child as BaseNode, visited)) return false;
		}
	}

	return true;
}
