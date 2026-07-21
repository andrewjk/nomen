import BitsetNode from "../nodes/BitsetNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_function_node, is_struct_node, is_trait_node } from "../nodes/check_node_type.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_bitset_node from "./build_bitset_node.ts";
import build_block_node from "./build_block_node.ts";
import build_enum_node from "./build_enum_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import build_struct_body from "./build_struct_body.ts";
import build_struct_node from "./build_struct_node.ts";
import build_trait_node from "./build_trait_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import scan_borrow_only_strings from "./utils/scan_borrow_only_strings.ts";

export default function build_function_node(node: FunctionNode, status: BuildStatus) {
	if (node.is_generic) return;

	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = enter_c_scope(status);
	const old_deferred_frees = status.deferred_frees;
	status.deferred_frees = [];
	const old_borrow_only = status.c_borrow_only_strings;
	status.c_borrow_only_strings = scan_borrow_only_strings(node);

	// Emit nested struct/function definitions at file scope before the function
	// signature, so the generated C code is valid (no nested function defs).
	// Buffer the output so it appears before this function, not inside it.
	const nested_buf_code = status.code;
	const nested_buf_headers = status.headers;
	status.code = "";
	status.headers = "";
	emit_nested_declarations(node, status);
	const nested_code = status.code;
	const nested_headers = status.headers;
	status.code = nested_buf_code;
	status.headers = nested_buf_headers;
	status.headers += nested_headers;
	status.code += nested_code;

	// TODO: Only if top-level
	status.headers += `// Func ${node.name}\n`;
	status.code += `// Func ${node.name}\n`;

	const is_main_with_init =
		node.name.toLocaleLowerCase() === "main" &&
		node.params.length > 0 &&
		node.params[0].type.name === "Init";

	const func_start = status.code.length;
	if (is_main_with_init) {
		status.code += `int main(int argc, char **argv)`;
	} else if (node.name.toLocaleLowerCase() === "main") {
		status.code += `int main(`;
	} else {
		if (node.return_type.name) {
			if (node.return_type.is_array) {
				// Arrays can't be returned by value in C. Return a pointer to
				// the Array_<T> header struct (heap-allocated by build_return_node
				// when the local stack array is copied to the heap at return).
				status.code += `struct Array_${node.return_type.name}* `;
			} else {
				// Monomorphize generic return types: `List<int>` → `List_int`.
				// The type_args are already present on node.return_type from the
				// check pass; fold them into the C name so the signature matches
				// the specialized struct definition.
				const mono_return_name = node.return_type.type_args?.length
					? `${node.return_type.name}_${node.return_type.type_args.map((t) => t.name).join("_")}`
					: node.return_type.name;
				// TODO: Set is_struct / is_trait on type when checking
				const return_is_class = !!status.structs.find(
					(s) => s.name === mono_return_name && s.is_class,
				);
				if (
					status.structs.find((s) => s.name === mono_return_name && !s.is_simple_type) ||
					status.structs.find((s) => s.name === node.return_type.name && !s.is_simple_type) ||
					status.traits.find((t) => t.name === node.return_type.name)
				) {
					status.code += `struct `;
				}
				status.code += `${c_type(mono_return_name)}`;
				if (return_is_class) {
					status.code += `*`;
				}
				status.code += ` `;
				if (status.traits.find((t) => t.name === node.return_type.name)) {
					status.code += `*`;
				}
			}
		} else {
			status.code += `void `;
		}
		status.code += `${c_function_name(node.name)}(`;
	}
	if (!is_main_with_init) {
		for (let i = 0; i < node.params.length; i++) {
			if (i > 0) {
				status.code += ", ";
			}
			if (node.params[i].is_variadic) {
				status.code += `long _${node.params[i].name}_len, `;
			}
			build_parameter_node(node.params[i], status);
		}
		status.code += `)`;
	}

	// TODO: Only if top-level
	status.headers += `${status.code.substring(func_start)};\n\n`;

	status.code += `\n{\n`;

	if (is_main_with_init) {
		const pname = c_function_name(node.params[0].name);
		status.code += `struct Init _echo_init_data;\n`;
		status.code += `struct Init *${pname} = &_echo_init_data;\n`;
		status.code += `${pname}->_vt = 0;\n`;
		status.code += `${pname}->argc = argc;\n`;
		status.code += `for (int _echo_i = 0; _echo_i < argc && _echo_i < 16; _echo_i++) ${pname}->args[_echo_i] = argv[_echo_i];\n`;
	}

	const old_ref_params = status.function_ref_params;
	status.function_ref_params = new Set<string>();
	const old_class_vars = status.class_vars;
	status.class_vars = new Set<string>();
	const old_ref_class_params = status.ref_class_params;
	status.ref_class_params = new Set<string>();
	const old_ref_class_param_types = status.ref_class_param_types;
	status.ref_class_param_types = new Map();
	const old_variadic_params = status.function_variadic_params;
	status.function_variadic_params = new Set<string>();
	const old_return_type = status.function_return_type;
	status.function_return_type = node.return_type;
	for (let param of node.params) {
		if (param.is_variadic) {
			status.function_variadic_params.add(c_function_name(param.name));
		}
		const param_struct = status.structs.find((s) => s.name === param.type.name);
		const param_trait = status.traits.find((t) => t.name === param.type.name);
		// `function_ref_params` tracks params that are emitted as pointers in
		// the C signature (so uses must dereference, and the address is the
		// param itself when forwarding). Only struct/trait/self/ref params and
		// non-simple `var` params are pointers; a `var int x` is by-value.
		// Variadic params are arrays (passed as `T *name` — pointer to first
		// element), not pointers to a single struct, so they must NOT be in
		// function_ref_params (no `*name` dereference at use sites).
		// Class params go to `class_vars` instead — they're pointers but must
		// NOT be dereferenced at value-use sites (the pointer IS the value).
		const is_pointer_param =
			!param.is_variadic &&
			(param.is_self_param ||
				(param_struct && !param_struct.is_simple_type) ||
				param_trait ||
				param.is_ref ||
				param.type.is_ref ||
				(param.declaration === "var" && param_struct && !param_struct.is_simple_type));
		if (is_pointer_param) {
			const pname = c_function_name(param.name);
			if (param_struct?.is_class) {
				status.class_vars.add(pname);
				// A `ref` class param is emitted as a double pointer
				// (`struct T **`). Track it so use sites dereference once
				// (`(*name)`) and reassignments write back through it.
				if ((param.is_ref || param.type.is_ref) && !param.is_self_param) {
					status.ref_class_params.add(pname);
					status.ref_class_param_types!.set(pname, param.type);
				}
			} else {
				status.function_ref_params.add(pname);
			}
			// A `mov` class param transfers ownership to the callee. Register
			// it as a scoped declaration so build_auto_free destroys+frees it
			// at function exit — unless the body further moves it out (the mov
			// param handling in build_function_call_node splices it), or it is
			// returned (handled in build_return_node). Mirrors aarch64's
			// moved_param_save_slots cleanup.
			if (
				param.is_moved &&
				param_struct?.is_class &&
				node.name !== "main" &&
				!param_is_consumed(node, param.name)
			) {
				const decl = new DeclarationNode(param.start, "private", "mov", pname, param.type);
				status.scoped_declarations.push(decl);
			}
		}
	}

	build_block_node(node, status, false);

	status.function_ref_params = old_ref_params;
	status.class_vars = old_class_vars;
	status.ref_class_params = old_ref_class_params;
	status.ref_class_param_types = old_ref_class_param_types;
	status.function_variadic_params = old_variadic_params;
	status.function_return_type = old_return_type;

	// Always run auto_free at function exit. Functions with explicit returns
	// already call build_auto_free at each return (which clears
	// scoped_declarations), so this is a no-op for those paths — but a void
	// function that has a CONDITIONAL early return still falls through to here,
	// and its fall-through declarations must be reclaimed. Without this, such
	// functions leak every declaration on the fall-through path.
	build_auto_free(status);

	// In audit mode, call echo_audit_check (from audit_runtime.c) at main exit.
	// It prints "LEAK: N allocation(s)" when the balanced malloc/free counter
	// (maintained by the echo_*_wrap allocators) is non-zero, which
	// check_output asserts against. Mirrors the aarch64 backend's audit hook.
	// The ad-hoc "Malloc balance" printf is gone — the C backend now routes
	// through the same audit_runtime.c as aarch64 instead of its own counter.
	//
	// If the pool was used (spawn was emitted), shut it down first so the
	// workers array is freed before the audit runs. Without this, the pool's
	// atexit handler fires after audit_check, and the workers array shows up
	// as a false positive leak.
	if (node.name.toLocaleLowerCase() === "main" && status.audit) {
		const has_pool = status.headers.includes("__echo_pool_submit");
		if (has_pool) {
			status.code += `\n__echo_pool_shutdown();\n`;
		}
		status.code += `\necho_audit_check();\n`;
	}

	status.code += `}\n\n`;

	leave_c_scope(status);
	status.scoped_declarations = old_scoped_declarations;
	status.deferred_frees = old_deferred_frees;
	status.c_borrow_only_strings = old_borrow_only;
}

function emit_nested_declarations(node: FunctionNode, status: BuildStatus) {
	const block = node as unknown as BlockNode;

	// Gather structs, traits, enums, bitsets
	for (let child of block.statements) {
		switch (child.node_type) {
			case "struct": {
				const struct = child as StructNode;
				status.structs.push(struct);
				break;
			}
			case "trait": {
				const trait = child as TraitNode;
				status.traits.push(trait);
				break;
			}
			case "enum": {
				status.enums.push(child as EnumNode);
				break;
			}
			case "bitset": {
				status.bitsets.push(child as BitsetNode);
				break;
			}
		}
	}

	// Emit struct forward declarations to headers
	for (let child of block.statements) {
		if (is_struct_node(child)) {
			const struct = child as StructNode;
			if (!struct.is_simple_type && !struct.is_generic) {
				status.headers += `struct ${struct.name};\n`;
			}
		}
	}

	// Pass 1: Emit struct bodies (skipped if already emitted at root level)
	for (let child of block.statements) {
		if (is_struct_node(child)) {
			build_struct_body(child as StructNode, status);
		}
	}

	// Pass 2: Build traits, enums, bitsets, struct functions, then functions
	for (let child of block.statements) {
		if (is_trait_node(child)) {
			build_trait_node(child, status);
		}
	}

	for (let child of block.statements) {
		if (child.node_type === "enum") {
			build_enum_node(child as EnumNode, status);
		}
	}

	for (let child of block.statements) {
		if (child.node_type === "bitset") {
			build_bitset_node(child as BitsetNode, status);
		}
	}

	for (let child of block.statements) {
		if (is_struct_node(child)) {
			build_struct_node(child, status);
		}
	}

	for (let child of block.statements) {
		if (is_function_node(child)) {
			build_function_node(child, status);
		}
	}
}

// Determine whether a `mov` class parameter's ownership escapes the function
// body — i.e. it is passed (as an argument or receiver) into some call/
// constructor whose result may outlive the function (stored into a returned
// container/struct), or it is a bare value used as an argument. In those
// cases the callee must NOT destroy it at exit (it would double-free / leave a
// dangling pointer in the escaping value). A bare reference that is only read
// (e.g. field access `x.value` or interpolation) does NOT consume it.
function param_is_consumed(root: any, name: string): boolean {
	let consumed = false;
	const refs_name = (n: any): boolean => !!n && n.node_type === "value" && n.value === name;
	// A `mov` class param's ownership escapes the function only when it is
	// placed into a value that can outlive the call: passed as a call/
	// constructor argument, used as a method-call RECEIVER (the callee may
	// store `self`), placed into an array literal, used as an assignment RHS,
	// or returned. Reads (field access `x.v`, comparisons `x != null`,
	// interpolation) do NOT consume it.
	const walk = (n: any): void => {
		if (!n || typeof n !== "object" || consumed) return;
		if (n.node_type === "func_call") {
			for (const p of n.params ?? []) if (refs_name(p)) consumed = true;
		}
		if (n.node_type === "access") {
			// Method call on the param (`x.foo(...)`) — the receiver may be
			// stored by the callee, so treat as consuming.
			if (n.access?.node_type === "access_func" && refs_name(n.target)) {
				consumed = true;
			}
			for (const p of n.access?.params ?? []) if (refs_name(p)) consumed = true;
		}
		if (n.node_type === "array") {
			for (const v of n.values ?? []) if (refs_name(v)) consumed = true;
		}
		if (n.node_type === "return" && refs_name(n.value)) consumed = true;
		if (n.node_type === "assign" && refs_name(n.right_value)) consumed = true;
		if (n.node_type === "declare" && refs_name(n.value)) consumed = true;
		for (const key of Object.keys(n)) {
			if (key === "node_type") continue;
			const v = (n as any)[key];
			if (Array.isArray(v)) {
				for (const item of v) walk(item);
			} else if (v && typeof v === "object") {
				walk(v);
			}
		}
	};
	for (const stmt of root.statements ?? []) walk(stmt);
	return consumed;
}
