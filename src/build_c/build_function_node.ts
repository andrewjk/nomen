import emission_label from "../build_common/emission_label.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import { has_flag_name, is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import { moved_param_is_consumed } from "../build_common/scan_moved_param_consumed.ts";
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
import array_struct_name from "./utils/array_struct.ts";
import c_function_name from "./utils/c_function_name.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import { set_c_thin_strings } from "./utils/c_type.ts";
import { emit_raw_string_adapter, raw_string_abi_needed } from "./utils/raw_string_abi.ts";
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

	// A raw-only body written against the thin char* string ABI (String.nm,
	// *_to_string, File/Http FFI...) is emitted under a `_raw_` label with
	// thin string types, followed by a compiler-generated fat adapter (see
	// raw_string_abi.ts). The adapter synthesizes the length exactly once,
	// at the creation boundary.
	const raw_thin =
		!is_main_with_init && raw_string_abi_needed(node, undefined, status.platform ?? "");
	if (raw_thin) set_c_thin_strings(true);

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
			} else if (node.return_type.is_view) {
				// A `view T` return is the universal non-owning (ptr, len)
				// slice, returned by value.
				status.code += `nomen_view `;
			} else {
				// Monomorphize generic return types: `List<int>` → `List_int`.
				// The type_args are already present on node.return_type from the
				// check pass; fold them into the C name so the signature matches
				// the specialized struct definition.
				const mono_return_name = mono_type_name(node.return_type);
				// TODO: Set is_struct / is_trait on type when checking
				const return_is_class = !!status.structs.find(
					(s) => s.name === mono_return_name && s.is_class,
				);
				if (
					status.structs.find((s) => s.name === mono_return_name && !s.is_simple_type) ||
					status.structs.find((s) => s.name === node.return_type.name && !s.is_simple_type) ||
					status.traits.find((t) => t.name === node.return_type.name)
				) {
					// Struct/trait return uses the `struct Tag` form (the tag is
					// never mangled, only the typedef is); emit the plain name
					// rather than `struct ` + c_type (which would mangle the tag
					// on GUI builds).
					status.code += `struct ${mono_return_name}`;
				} else {
					status.code += `${c_type(mono_return_name)}`;
				}
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
		status.code += `${raw_thin ? "_raw_" : ""}${c_function_name(emission_label(node))}(`;
	}
	if (!is_main_with_init) {
		let first_param = true;
		for (let i = 0; i < node.params.length; i++) {
			if (!first_param) {
				status.code += ", ";
			}
			first_param = false;
			if (node.params[i].is_variadic) {
				status.code += `long _${node.params[i].name}_len, `;
			}
			build_parameter_node(node.params[i], status);
			// A nullable struct value parameter (`T? p`, T a non-class struct)
			// is lowered as TWO C parameters: the struct pointer (built above)
			// plus a sibling `unsigned char <name>_has` flag the caller
			// forwards alongside. The body reads the flag through the param
			// name directly (build_nullable_has emits `<name>_has`).
			if (is_nullable_struct_type(node.params[i].type, status) && !node.params[i].is_self_param) {
				status.code += `, unsigned char ${has_flag_name(c_function_name(node.params[i].name))}`;
			}
		}
		// A nullable struct RETURN type (`func f(...) out T?`) adds a hidden
		// `unsigned char *_ret_has` out-parameter after the regular params: the
		// callee writes 0 (null) or 1 (value) so the caller can materialise
		// both the struct value and its companion flag (C can't return both as
		// a single by-value struct).
		if (is_nullable_struct_type(node.return_type, status)) {
			if (!first_param) status.code += ", ";
			status.code += `unsigned char *_ret_has`;
		}
		status.code += `)`;
	}

	// TODO: Only if top-level
	if (raw_thin) {
		// The thin body is TU-local: prototype it in the code stream (not the
		// shared headers) as static, ahead of its definition, so the adapter
		// below can call it.
		const sig_text = status.code.substring(func_start);
		status.code = status.code.substring(0, func_start) + `static ${sig_text};\n` + sig_text;
	} else {
		status.headers += `${status.code.substring(func_start)};\n\n`;
	}

	status.code += `\n{\n`;

	if (is_main_with_init) {
		const pname = c_function_name(node.params[0].name);
		status.code += `struct Init _nomen_init_data;\n`;
		status.code += `struct Init *${pname} = &_nomen_init_data;\n`;
		status.code += `${pname}->_vt = 0;\n`;
		status.code += `${pname}->argc = argc;\n`;
		// args is a fat nomen_string[16]; argv entries are thin char* —
		// measure each once at startup (the only strlen on this path).
		status.code += `for (int _nomen_i = 0; _nomen_i < argc && _nomen_i < 16; _nomen_i++) ${pname}->args[_nomen_i] = (nomen_string){ argv[_nomen_i], (long)strlen(argv[_nomen_i]) };\n`;
		status.code += `${pname}->is_tty = isatty(1);\n`;
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
	const old_view_params = status.function_view_params;
	status.function_view_params = new Set<string>();
	const old_return_type = status.function_return_type;
	status.function_return_type = node.return_type;
	const old_nullable_ret_has = status.nullable_ret_has_param;
	if (is_nullable_struct_type(node.return_type, status)) {
		status.nullable_ret_has_param = "_ret_has";
	} else {
		status.nullable_ret_has_param = undefined;
	}
	const old_function_name = status.current_function_name;
	status.current_function_name = emission_label(node);
	// Raw-block shim registry: by-value fat-string params (see build_raw_node).
	// A raw-THIN function (raw_string_abi_needed) emits its whole body with
	// thin char* params — there is nothing to shim, and shimming would emit
	// `.ptr` accesses on plain char* (compile error).
	status.fat_string_params = new Set<string>();
	for (let param of node.params) {
		if (
			!raw_thin &&
			param.type.name === "string" &&
			!param.type.is_view &&
			!param.type.is_array &&
			!param.is_ref &&
			!param.type.is_ref
		) {
			status.fat_string_params.add(c_function_name(param.name));
		}
		if (param.is_variadic) {
			status.function_variadic_params.add(c_function_name(param.name));
		}
		// A `view T` param lowers to a by-value nomen_view — record its name
		// so call sites / declarations inside this body recognize bare uses
		// as view VALUES (no owned→view re-wrap).
		if (param.type.is_view && !param.is_self_param) {
			status.function_view_params.add(c_function_name(param.name));
		}
		// An `Array<T>` parameter lowers to `struct Array_<T>*` when the mono
		// struct exists (see build_parameter_node). Register it in
		// `heap_array_vars` so the access/value/for-loop paths treat it as a
		// struct pointer with a length header (dispatching `.length`/`.at`/
		// `.set` to the monomorphized `Array_<T>` methods), exactly like a
		// heap-allocated local from `Array.with(...)`. When the struct does
		// NOT exist (raw iteration only), the param stays a raw pointer and is
		// not registered here. Params are not in scoped_declarations, so
		// build_auto_free will not free them (the caller owns the buffer) —
		// this purely steers access dispatch. Mirrors the aarch64 backend.
		const param_arr_struct = !param.is_variadic ? array_struct_name(param.type, status) : undefined;
		if (param_arr_struct) {
			const pname = c_function_name(param.name);
			if (!status.heap_array_vars) status.heap_array_vars = new Set();
			status.heap_array_vars.add(pname);
			if (param.type?.name) {
				if (!status.variable_types) status.variable_types = new Map();
				status.variable_types.set(pname, param.type);
			}
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
				// An `Array<T>` struct param is already registered in
				// `heap_array_vars` above and lowers to a single
				// `struct Array_<T>*` (mutation via `.set` is in place, no
				// write-back). It must NOT also be in `function_ref_params`,
				// which would make every use emit `*name` (dereferencing the
				// struct pointer to a by-value struct).
				if (!status.heap_array_vars?.has(pname)) {
					status.function_ref_params.add(pname);
				}
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
				!moved_param_is_consumed(node, param.name)
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
	status.function_view_params = old_view_params;
	status.function_return_type = old_return_type;
	status.nullable_ret_has_param = old_nullable_ret_has;
	status.current_function_name = old_function_name;

	// Always run auto_free at function exit. Functions with explicit returns
	// already call build_auto_free at each return (which clears
	// scoped_declarations), so this is a no-op for those paths — but a void
	// function that has a CONDITIONAL early return still falls through to here,
	// and its fall-through declarations must be reclaimed. Without this, such
	// functions leak every declaration on the fall-through path.
	build_auto_free(status);

	// In audit mode, call nomen_audit_check (from audit_runtime.c) at main exit.
	// It prints "LEAK: N allocation(s)" when the balanced malloc/free counter
	// (maintained by the nomen_*_wrap allocators) is non-zero, which
	// check_output asserts against. Mirrors the aarch64 backend's audit hook.
	// The ad-hoc "Malloc balance" printf is gone — the C backend now routes
	// through the same audit_runtime.c as aarch64 instead of its own counter.
	//
	// If the pool was used (spawn was emitted), shut it down first so the
	// workers array is freed before the audit runs. Without this, the pool's
	// atexit handler fires after audit_check, and the workers array shows up
	// as a false positive leak.
	if (node.name.toLocaleLowerCase() === "main" && status.audit) {
		const has_pool = status.headers.includes("__nomen_pool_submit");
		if (has_pool) {
			status.code += `\n__nomen_pool_shutdown();\n`;
		}
		status.code += `\nnomen_audit_check();\n`;
	}

	// C's main returns int. A Nomen main with no explicit return falls through
	// to here; emit `return 0;` so clang doesn't reject the fall-through.
	if (node.name.toLocaleLowerCase() === "main") {
		status.code += `return 0;\n`;
	}

	status.code += `}\n\n`;

	if (raw_thin) {
		set_c_thin_strings(false);
		emit_raw_string_adapter(
			node,
			c_function_name(emission_label(node)),
			status,
			build_parameter_node,
		);
		status.code += `\n`;
	}

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
