import BitsetNode from "../nodes/BitsetNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_function_node, is_struct_node, is_trait_node } from "../nodes/check_node_type.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import build_bitset_node from "./build_bitset_node.ts";
import build_enum_node from "./build_enum_node.ts";
import build_function_node from "./build_function_node.ts";
import build_node from "./build_node.ts";
import build_struct_body from "./build_struct_body.ts";
import build_struct_node from "./build_struct_node.ts";
import build_trait_node from "./build_trait_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import emit_allocations from "./utils/emit_allocations.ts";

/** Primitive types whose `const` initializers are valid C file-scope globals. */
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

export default function build_block_node(
	node: BlockNode,
	status: BuildStatus,
	with_declarations = true,
) {
	// Gather structs, traits and funcs that might be used before they are declared
	gather_structs(node, status);

	// Names of top-level non-primitive `const` declarations (e.g. geometry
	// type constants like `DEFAULT_PARAMS`) that are inlined at every use site
	// by `build_value_node` rather than emitted as a file-scope global — the
	// initializer is typically a struct constructor call, which is not a
	// valid file-scope constant expression in C. The statement loop below
	// skips these declarations; uses resolve them through
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

	// Pre-pass: record every user function that returns an OWNED heap string
	// (a computed/concatenated result, not a borrowed field). Callers use this
	// (build_auto_free / build_return_node) to free the result at scope exit
	// and to avoid redundant strdup. Runs before any function body is built so
	// a call is correctly classified even when the callee is defined later.
	gather_heap_returning_functions(node, status);

	// When called from inside a function body (e.g. main), skip struct/function
	// declarations — they're already emitted at file scope by the root's
	// build_block_node call and would produce invalid C if nested inside a function.
	if (with_declarations) {
		// Emit all struct forward declarations to headers before building anything,
		// so that function declarations can reference struct types not yet built.
		for (let child of node.statements) {
			if (is_struct_node(child)) {
				const struct = child as StructNode;
				if (!struct.is_simple_type && !struct.is_generic) {
					status.headers += `struct ${struct.name};\n`;
				}
			}
		}

		// Pass 1: Emit all struct bodies first so that all types are fully defined
		// before any struct functions are emitted (which may access fields of other structs).
		// Structs are emitted in dependency order: if struct A has a by-value field
		// of struct B, B is emitted first (C requires complete types for by-value fields).
		const emitted_structs = new Set<StructNode>();
		for (let child of node.statements) {
			if (is_struct_node(child)) {
				emit_struct_in_order(child as StructNode, status, emitted_structs);
			}
		}

		// Pass 2: Build traits, then enums/bitsets, then struct functions, then functions
		for (let child of node.statements) {
			if (is_trait_node(child)) {
				build_trait_node(child, status);
			}
		}

		for (let child of node.statements) {
			if (child.node_type === "enum") {
				build_enum_node(child as EnumNode, status);
			}
		}

		for (let child of node.statements) {
			if (child.node_type === "bitset") {
				build_bitset_node(child as BitsetNode, status);
			}
		}

		for (let child of node.statements) {
			if (is_struct_node(child)) {
				build_struct_node(child, status);
			}
		}

		// Emit forward declarations for top-level primitive constants (e.g.
		// `const float ln10 = ...`) so function bodies can reference them.
		// The actual definitions remain after functions in the remaining loop.
		// Only run at the root level — inner blocks (if/while/for bodies) also
		// default to with_declarations=true but their locals must not be
		// forward-declared as globals. Non-primitive `const` declarations are
		// NOT forward-declared here — they're inlined at use sites (see
		// `inlined_const_names` above) so they have no file-scope global.
		if (node.node_type === "root") {
			for (let child of node.statements) {
				if (child.node_type === "declare") {
					const decl = child as DeclarationNode;
					if (!decl.func_params && SIMPLE_TYPES.has(decl.type.name)) {
						if (decl.type.is_array) {
							// A global fixed-size array (e.g. `const nums = Array(1, 2, 3)`
							// lowered to `long nums[3] = {...}`) is defined after the
							// functions (see the statement loop below). Forward-declare it
							// as an incomplete array so functions compiled earlier can
							// subscript it (e.g. `nums.at(0)` → `nums[0]`).
							status.headers += `extern ${c_type(decl.type.name)} ${c_function_name(
								decl.name,
							)}[];\n`;
						} else {
							status.headers += `extern ${c_type(decl.type.name)} ${c_function_name(decl.name)};\n`;
						}
					}
				}
			}
		}

		for (let child of node.statements) {
			if (is_function_node(child)) {
				build_function_node(child, status);
			}
		}
	}

	// Build the block's statements
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
				// monomorphized generics that reference them are built.
				const func = node as FunctionNode;
				if (func.statements?.length) {
					gather_structs(func, status);
				}
				break;
			}
		}
	}
}

// Whether a returned expression produces a fresh owned heap string (the caller
// must free) vs. a borrowed field, a static literal, or a match/switch that
// only yields literals. Recurses through match/switch branches.
function value_is_owned_string(v: any): boolean {
	if (!v || typeof v !== "object") return false;
	// The C backend strdup's EVERY string return before handing it to the
	// caller: literals (`return "x"` → strdup), borrowed field accesses
	// (`return self.name` → strdup), method/func calls already produce a
	// fresh heap string, and match/switch/if returns are strdup'd too (see
	// build_return_node). So any path through a string-returning function
	// transfers ownership of a heap string to the caller — register the
	// function unconditionally so callers know to free the result.
	return true;
}

function gather_heap_returning_functions(block: BlockNode, status: BuildStatus) {
	if (!status.heap_returning_functions) status.heap_returning_functions = new Set();
	const func_returns_owned = (func: FunctionNode): boolean => {
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
	};
	const visit = (func: FunctionNode) => {
		if (func.return_type?.name === "string" && func.name && func_returns_owned(func)) {
			status.heap_returning_functions!.add(c_function_name(func.name));
		}
		for (const stmt of func.statements ?? []) {
			if (is_function_node(stmt)) visit(stmt as FunctionNode);
		}
	};
	const visit_method = (struct_name: string, func: FunctionNode) => {
		if (func.return_type?.name !== "string" || !func.name) return;
		if (func_returns_owned(func)) {
			const method_c_name = func.name.replace(/#/g, "");
			status.heap_returning_functions!.add(`${struct_name}_${method_c_name}`);
		}
	};
	for (const node of block.statements) {
		if (is_function_node(node)) {
			visit(node as FunctionNode);
		} else if (is_struct_node(node)) {
			const struct = node as StructNode;
			for (const fn of struct.functions ?? []) {
				visit_method(struct.name, fn as FunctionNode);
			}
		}
	}
}

function emit_struct_in_order(struct: StructNode, status: BuildStatus, emitted: Set<StructNode>) {
	if (emitted.has(struct)) return;
	if (struct.is_generic || struct.is_simple_type) return;
	emitted.add(struct);

	// Emit dependencies first: any by-value struct field needs the referenced
	// struct to be fully defined beforehand. Generic field types (e.g.
	// Map<int,int>) are monomorphized to concrete names (Map_int_int), so
	// resolve the monomorphized name when looking up the dependency.
	for (const field of struct.fields) {
		const mono_name = field.type.type_args?.length
			? `${field.type.name}_${field.type.type_args.map((t) => t.name).join("_")}`
			: field.type.name;
		const dep = status.structs.find(
			(s) => s.name === mono_name && !s.is_simple_type && !s.is_generic,
		);
		if (dep && !emitted.has(dep)) {
			emit_struct_in_order(dep, status, emitted);
		}
	}

	build_struct_body(struct, status);
}
