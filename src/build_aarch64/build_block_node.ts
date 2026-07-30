import type BuildStatus from "../build_c/BuildStatus.ts";
import type_from_value_node from "../build_c/utils/type_from_value_node.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_function_node, is_struct_node, is_trait_node } from "../nodes/check_node_type.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import build_function_node from "./build_function_node.ts";
import build_node from "./build_node.ts";
import build_struct_node from "./build_struct_node.ts";
import { emit_destroy_for_scope } from "./utils/auto_destroy.ts";
import emit_allocations from "./utils/emit_allocations.ts";

/** Primitive types whose `const` initializers are valid aarch64 file-scope data. */
const SIMPLE_TYPES = new Set([
	"int",
	"uint",
	"int8",
	"uint8",
	"int16",
	"uint16",
	"int32",
	"uint32",
	"int64",
	"uint64",
	"float",
	"float32",
	"float64",
	"bool",
	"char",
]);

export default function build_block_node(node: BlockNode, status: BuildStatus) {
	gather_structs(node, status);

	// Top-level (root-scope) non-primitive `const` declarations (e.g. geometry
	// constants like `DEFAULT_PARAMS`) are inlined at every use site by
	// `build_value_node` rather than emitted as a module-scope global — the
	// initializer is typically a struct constructor call, which would emit
	// bare instructions at module scope that never run. The statement loop
	// below skips these declarations; uses resolve them through
	// `status.top_level_consts`.
	const inlined_const_names = new Set<string>();
	if (node.node_type === "root") {
		for (const child of node.statements) {
			if (child.node_type !== "declare") continue;
			const decl = child as DeclarationNode;
			if (decl.declaration !== "const") continue;
			if (!decl.type?.name || !decl.value) continue;
			if (SIMPLE_TYPES.has(decl.type.name)) continue;
			if (decl.type.is_array) continue;
			inlined_const_names.add(decl.name);
			if (!status.top_level_consts) status.top_level_consts = new Map();
			status.top_level_consts.set(decl.name, decl);
		}
	}

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
			child.node_type !== "bitset" &&
			!(child.node_type === "declare" && inlined_const_names.has((child as DeclarationNode).name))
		) {
			emit_allocations(child, status);
			build_node(child, status, true);
		}
	}

	emit_destroy_for_scope(status, declarations_before);
	status.heap_cleanup_stack.pop();
}

// Whether a returned expression produces a fresh owned heap string (that the
// caller must free), as opposed to a borrowed field, a variable, or a static
// string literal. Recurses through match/switch branches so a match returning
// only literals (e.g. `return match c { case 1 -> "A" ... }`) is NOT owned.
//
// `visiting` tracks methods currently being analyzed (by mangled key) to break
// cycles when a method returns another method that returns it.
function value_is_owned_string(v: any, status: BuildStatus, visiting?: Set<string>): boolean {
	if (!visiting) visiting = new Set<string>();
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
			// Resolve the method to its implementation(s) and classify by what
			// they actually return. Without this, a wrapper like
			// `func f = (Speaker s, out string) { return s.speak() }` is
			// conservatively marked heap-returning, so its caller frees the
			// result — but `speak` returns a borrow of an owning field
			// (`self.name`), so freeing it double-frees the field / frees a
			// static literal and crashes at cleanup.
			const resolved = method_call_returns_owned(v, status, visiting);
			if (resolved !== undefined) return resolved;
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
					if (value_is_owned_string(s.value, status, visiting)) return true;
				} else if (value_is_owned_string(s, status, visiting)) {
					return true;
				}
			}
		}
		return false;
	}
	// Any other expression kind: conservatively owned.
	return true;
}

// Resolve a method-call access node (`receiver.method(...)`) to whether its
// result is an owned heap string, by inspecting the implementation body.
// Returns `undefined` when the target can't be resolved (caller falls back to
// a conservative guess).
function method_call_returns_owned(
	v: any,
	status: BuildStatus,
	visiting: Set<string>,
): boolean | undefined {
	const method_name = v.access.name as string;
	const recv_type = type_from_value_node(v.target);
	const recv_name = recv_type?.name;
	if (!recv_name) return undefined;

	// Trait-typed receiver: dispatches to a conforming implementation, which
	// hands back the raw pointer it returns (aarch64 does not strdup at the
	// dispatch site). The result is owned only if EVERY conformer's method
	// returns an owned string; if any returns a borrow (or we can't tell),
	// treat as not-owned — never free, since freeing a borrow double-frees a
	// field. This matches the call-site behaviour in build_access_node, which
	// never marks a trait-dispatched result as heap.
	if (status.traits.find((t) => t.name === recv_name)) {
		const conformers = status.structs.filter((s) => s.traits.includes(recv_name));
		let found = false;
		let all_owned = true;
		for (const conf of conformers) {
			const m = (conf.functions ?? []).find((f) => f.name === method_name);
			if (!m || !(m as FunctionNode).has_body) continue;
			found = true;
			if (
				!function_returns_owned(m as FunctionNode, status, visiting, `${conf.name}_${method_name}`)
			) {
				all_owned = false;
				break;
			}
		}
		if (!found) return undefined;
		return all_owned;
	}

	// Concrete receiver: resolve the struct's method, accounting for
	// monomorphized names (e.g. `Foo<int>` → `Foo_int`).
	let struct_name = recv_name;
	if (recv_type.type_args?.length) {
		const mono = recv_name + "_" + recv_type.type_args.map((t: any) => t.name).join("_");
		if (status.structs.find((s) => s.name === mono)) struct_name = mono;
	}
	const struct = status.structs.find((s) => s.name === struct_name);
	if (struct) {
		const m = (struct.functions ?? []).find((f) => f.name === method_name);
		if (m && (m as FunctionNode).has_body) {
			return function_returns_owned(
				m as FunctionNode,
				status,
				visiting,
				`${struct_name}_${method_name}`,
			);
		}
	}
	return undefined;
}

// Whether a function/method has any `return` whose expression produces an owned
// heap string. `key` is the mangled identity used for cycle protection.
function function_returns_owned(
	func: FunctionNode,
	status: BuildStatus,
	visiting: Set<string>,
	key: string,
): boolean {
	if (func.return_type?.name !== "string") return false;
	if (visiting.has(key)) return false;
	visiting.add(key);
	let has_owned_return = false;
	const walk = (n: any): void => {
		if (!n || typeof n !== "object") return;
		if (n.node_type === "return" && n.value) {
			if (value_is_owned_string(n.value, status, visiting)) has_owned_return = true;
		}
		if (n.node_type === "func") return;
		for (const k of Object.keys(n)) {
			if (k === "node_type") continue;
			const val = (n as any)[k];
			if (Array.isArray(val)) for (const item of val) walk(item);
			else if (val && typeof val === "object") walk(val);
		}
	};
	for (const stmt of func.statements ?? []) walk(stmt);
	visiting.delete(key);
	return has_owned_return;
}

function returns_owned_string(func: FunctionNode, status: BuildStatus): boolean {
	return function_returns_owned(func, status, new Set<string>(), func.name);
}

function gather_heap_returning_functions(block: BlockNode, status: BuildStatus) {
	if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
	// Classify only the functions/methods DIRECTLY in this block. Every
	// function body is itself built via build_block_node, which runs its own
	// gather pass — so recursing here would re-classify nested functions
	// (e.g. one defined inside `main`) BEFORE this block's structs/traits are
	// gathered, defeating the method-return resolution in value_is_owned_string
	// (it would fall back to the conservative "owned" guess and mark a borrow
	// as heap, crashing the caller at cleanup).
	const visit = (func: FunctionNode) => {
		if (func.name && returns_owned_string(func, status)) {
			status.heap_returning_functions!.add(func.name.replace(/#/g, ""));
		}
	};
	for (const node of block.statements) {
		if (is_function_node(node)) {
			visit(node as FunctionNode);
		} else if (is_struct_node(node)) {
			const struct = node as StructNode;
			for (const fn of struct.functions ?? []) {
				const func = fn as FunctionNode;
				if (func.name && returns_owned_string(func, status)) {
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
			case "func": {
				// Recurse into function bodies: user-defined types nested inside
				// a function (commonly `main`) must be in status.structs before
				// monomorphized generics that reference them are built (e.g.
				// `struct Box<T> { var T item }` monomorphized to `Box_Point`,
				// where `Point` is declared inside `main`). Mirrors the C
				// backend's gather_structs.
				const func = node as FunctionNode;
				if (func.statements?.length) {
					gather_structs(func, status);
				}
				break;
			}
		}
	}
}
