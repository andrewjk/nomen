import type BuildStatus from "../build_c/BuildStatus.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_function_node, is_struct_node, is_trait_node } from "../nodes/check_node_type.ts";
import EnumNode from "../nodes/EnumNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import build_function_node from "./build_function_node.ts";
import build_node from "./build_node.ts";
import build_struct_node from "./build_struct_node.ts";
import { emit_destroy_for_scope } from "./utils/auto_destroy.ts";

export default function build_block_node(node: BlockNode, status: BuildStatus) {
	gather_structs(node, status);

	// Pre-pass: record every user function/method that returns an OWNED heap
	// string, so a call is classified correctly even when the callee is defined
	// later (e.g. core methods used by main). Callers use this to free the
	// result at scope exit (build_auto_free / emit_string_length).
	gather_heap_returning_functions(node, status);

	if (!status.heap_cleanup_stack) status.heap_cleanup_stack = [];
	status.heap_cleanup_stack.push({
		heap_strings: new Set<string>(),
		heap_slots: [],
		struct_decls: [],
	});

	const declarations_before = status.scoped_declarations.length;

	for (let child of node.statements) {
		if (is_struct_node(child)) {
			build_struct_node(child as StructNode, status);
		}
	}

	for (let child of node.statements) {
		if (is_function_node(child)) {
			build_function_node(child as FunctionNode, status);
		}
	}

	for (let child of node.statements) {
		if (
			!is_trait_node(child) &&
			!is_struct_node(child) &&
			!is_function_node(child) &&
			child.node_type !== "enum" &&
			child.node_type !== "bitset"
		)
			build_node(child, status, true);
	}

	emit_destroy_for_scope(status, declarations_before);
	status.heap_cleanup_stack.pop();
}

// Whether a returned expression produces a fresh owned heap string (that the
// caller must free), as opposed to a borrowed field, a variable, or a static
// string literal. Recurses through match/switch branches so a match returning
// only literals (e.g. `return match c { case 1 -> "A" ... }`) is NOT owned.
function value_is_owned_string(v: any): boolean {
	if (!v || typeof v !== "object") return false;
	if (v.node_type === "value") {
		// String literals are static storage (not owned). A bare variable
		// reference returns an owned local built in the callee — treat as owned.
		const isLiteral = typeof v.value === "string" && v.value.startsWith('"');
		return !isLiteral;
	}
	if (v.node_type === "op") return true;
	if (v.node_type === "access") {
		if (v.access?.node_type === "access_field") return false;
		if (v.access?.node_type === "access_func") {
			const raw = v.access.name as string;
			const mangled = (v.access.mangled_name as string) || raw;
			if (mangled.startsWith("_string_interpolate_")) return true;
			if (mangled.endsWith("_to_string") && mangled !== "string_to_string") return true;
			if (raw === "to_string" && v.target?.type?.name && v.target.type.name !== "string")
				return true;
			// Unknown method: conservatively treat as owned (it may build a string).
			return true;
		}
		return false;
	}
	if (v.node_type === "func_call") {
		const raw = v.name as string;
		const mangled = (v.mangled_name as string) || raw;
		if (mangled.startsWith("_string_interpolate_")) return true;
		// A call to another function returning string: conservatively owned.
		return true;
	}
	if (v.node_type === "match" || v.node_type === "switch") {
		const branches: any[] = [];
		if (Array.isArray(v.cases)) for (const c of v.cases) if (c?.branch) branches.push(c.branch);
		if (v.else_branch) branches.push(v.else_branch);
		if (Array.isArray(v.branches)) for (const b of v.branches) branches.push(b);
		for (const b of branches) {
			const stmts = b?.statements ?? [];
			for (const s of stmts) {
				// Arrow branches (`-> expr`) wrap the result in a `let`; `=>`
				// branches wrap it in a `return`. Unwrap to the real expression.
				if (s?.node_type === "let" || s?.node_type === "return") {
					if (value_is_owned_string(s.value)) return true;
				} else if (value_is_owned_string(s)) {
					return true;
				}
			}
		}
		return false;
	}
	// Any other expression kind: conservatively owned.
	return true;
}

function returns_owned_string(func: FunctionNode): boolean {
	if (func.return_type?.name !== "string") return false;
	let has_owned_return = false;
	const walk = (n: any): void => {
		if (!n || typeof n !== "object") return;
		if (n.node_type === "return" && n.value) {
			if (value_is_owned_string(n.value)) has_owned_return = true;
		}
		if (n.node_type === "func") return;
		for (const key of Object.keys(n)) {
			if (key === "node_type") continue;
			const val = (n as any)[key];
			if (Array.isArray(val)) for (const item of val) walk(item);
			else if (val && typeof val === "object") walk(val);
		}
	};
	for (const stmt of func.statements ?? []) walk(stmt);
	return has_owned_return;
}

function gather_heap_returning_functions(block: BlockNode, status: BuildStatus) {
	if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
	const visit = (func: FunctionNode) => {
		if (func.name && returns_owned_string(func)) {
			status.heap_returning_functions!.add(func.name.replace(/#/g, ""));
		}
		for (const stmt of func.statements ?? []) {
			if (is_function_node(stmt)) visit(stmt as FunctionNode);
		}
	};
	for (const node of block.statements) {
		if (is_function_node(node)) {
			visit(node as FunctionNode);
		} else if (is_struct_node(node)) {
			const struct = node as StructNode;
			for (const fn of struct.functions ?? []) {
				const func = fn as FunctionNode;
				if (func.name && returns_owned_string(func)) {
					status.heap_returning_functions!.add(`${struct.name}_${func.name.replace(/#/g, "")}`);
				}
			}
		}
	}
}

function gather_structs(block: BlockNode, status: BuildStatus) {
	for (let node of block.statements) {
		switch (node.node_type) {
			case "struct": {
				const struct = node as StructNode;
				status.structs.push(struct);
				break;
			}
			case "trait": {
				const trait = node as TraitNode;
				status.traits.push(trait);
				break;
			}
			case "enum": {
				status.enums.push(node as EnumNode);
				break;
			}
			case "bitset": {
				status.bitsets.push(node as BitsetNode);
				break;
			}
		}
	}
}
