import type BuildStatus from "../build_c/BuildStatus.ts";
import { should_emit_definition } from "../build_c/utils/is_system_definition.ts";
import emission_label from "../build_common/emission_label.ts";
import { function_returns_owned } from "../build_common/string_return_analysis.ts";
import { SIMPLE_TYPES } from "../built_in_types.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_function_node, is_struct_node, is_trait_node } from "../nodes/check_node_type.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import build_function_node from "./build_function_node.ts";
import build_struct_node from "./build_struct_node.ts";
import { emit_stmt_from_nir } from "./emit_nir.ts";
import { emit_destroy_for_scope } from "./utils/auto_destroy.ts";
import emit_allocations from "./utils/emit_allocations.ts";

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
			if (SIMPLE_TYPES.includes(decl.type.name)) continue;
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
			if (
				!should_emit_definition(child, status.emit_mode, status.structs, status.system_struct_names)
			)
				continue;
			build_struct_node(child as StructNode, status);
		}
	}

	for (let child of node.statements) {
		if (is_function_node(child)) {
			if (
				!should_emit_definition(child, status.emit_mode, status.structs, status.system_struct_names)
			)
				continue;
			build_function_node(child as FunctionNode, status);
		}
	}

	for (let index = 0; index < node.statements.length; index++) {
		const child = node.statements[index];
		if (
			!is_trait_node(child) &&
			!is_struct_node(child) &&
			!is_function_node(child) &&
			child.node_type !== "enum" &&
			child.node_type !== "bitset" &&
			!(child.node_type === "declare" && inlined_const_names.has((child as DeclarationNode).name))
		) {
			emit_allocations(child, status);
			// NIR-driven dispatch (phase 4 stage 2): consumes the index-aligned
			// NIR entry when the emission ctx owns this statement list; falls
			// back to the plain AST walk otherwise. Returns the number of
			// AST statements consumed — the cset fuse (tranche B) consumes a
			// declare AND its following if in one emission.
			//
			// The forwarded-param map is per-statement (emit_allocations resets
			// it above): a nested statement list built inside this statement
			// repopulates it, so restore the enclosing statement's map after.
			const prev_forwarded = status.forwarded_param_inits;
			const consumed = emit_stmt_from_nir(child, index, node.statements, status);
			index += consumed - 1;
			status.forwarded_param_inits = prev_forwarded;
		}
	}

	emit_destroy_for_scope(status, declarations_before);
	status.heap_cleanup_stack.pop();
}

function gather_heap_returning_functions(block: BlockNode, status: BuildStatus) {
	if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
	// Classify only the functions/methods DIRECTLY in this block. Every
	// function body is itself built via build_block_node, which runs its own
	// gather pass — so recursing here would re-classify nested functions
	// (e.g. one defined inside `main`) BEFORE this block's structs/traits are
	// gathered, defeating the method-return resolution in the shared
	// value_is_owned_string analysis (it would fall back to the conservative
	// "owned" guess and mark a borrow as heap, crashing the caller at cleanup).
	//
	// The classification itself is shared (build_common/
	// string_return_analysis.ts) and is stamped on the FunctionNode
	// (`returns_string_borrow`) so any pass can read it without re-running
	// the analysis.
	const visit = (func: FunctionNode) => {
		if (!func.name || func.return_type?.name !== "string") return;
		const owned = function_returns_owned(func, status, new Set<string>(), func.name);
		func.returns_string_borrow = !owned;
		if (owned) {
			status.heap_returning_functions!.add(emission_label(func));
		}
	};
	for (const node of block.statements) {
		if (is_function_node(node)) {
			visit(node as FunctionNode);
		} else if (is_struct_node(node)) {
			const struct = node as StructNode;
			for (const fn of struct.functions ?? []) {
				const func = fn as FunctionNode;
				if (func.name && func.return_type?.name === "string") {
					const owned = function_returns_owned(
						func,
						status,
						new Set<string>(),
						`${struct.name}_${func.name}`,
					);
					func.returns_string_borrow = !owned;
					if (owned) {
						status.heap_returning_functions!.add(`${struct.name}_${func.name.replace(/#/g, "")}`);
					}
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
