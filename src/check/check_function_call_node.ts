import add_error from "../add_error.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import clone_node from "../nodes/clone_node.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import RawNode from "../nodes/RawNode.ts";
import RootNode from "../nodes/RootNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import check_function_call from "./check_function_call.ts";
import check_function_node from "./check_function_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import type_from_value from "./utils/type_from_value.ts";

export default function check_function_call_node(
	node: FunctionCallNode,
	status: CheckStatus,
): boolean {
	let func = status.functions.findLast((f) => f.name === node.name);

	if (!func) {
		const struct = status.structs.findLast((s) => s.name === node.name);
		if (struct) {
			if (struct.type_params.length > 0 && node.type_args?.length) {
				const mono = monomorphize(struct, node.type_args, status);
				if (mono) {
					func = mono.functions.find((f) => f.name === "#init");
					if (func) {
						const type = new Type(struct.name);
						type.type_args = node.type_args;
						node.type = type;
						node.name = mono.name;
					}
				}
			} else {
				func = struct.functions.find((f) => f.name === "#init");
				if (func) {
					const type = new Type(struct.name);
					type.type_args = node.type_args;
					node.type = type;
				}
			}
		}
	}

	if (!func && node.name.startsWith("_string_interpolate_")) {
		const length = parseInt(node.name.substring("_string_interpolate_".length));
		func = new FunctionNode(0, "pub", node.name, node.type, [
			new ParameterNode(0, "pattern"),
			...Array.from({ length }, (_, i) => new ParameterNode(0, `arg${i + 1}`)),
		]);
	}

	if (!func) {
		const param_value = status.values.findLast((v) => v.name === node.name);
		if (param_value?.type.name === "func") {
			func = new FunctionNode(
				0,
				"pub",
				node.name,
				param_value.type.func_return_type || param_value.type,
			);
			const param = status.stack
				.flatMap((n: any) => n.params || [])
				.find((p: any) => p.name === node.name);
			if (param?.func_params) {
				func.params = param.func_params;
			} else if (param_value.type.func_params) {
				func.params = param_value.type.func_params;
			}
			if (param?.func_return_type) {
				func.return_type = param.func_return_type;
			} else if (param_value.type.func_return_type) {
				func.return_type = param_value.type.func_return_type;
			}
			node.is_func_param = true;
		}
	}

	if (!func) {
		// Inside a generic struct's body, a constructor call like Buffer<T>()
		// can't be monomorphized yet (T is unresolved). Defer it: the enclosing
		// generic will be monomorphized later, which substitutes the field value.
		if (status.type_params.length > 0) {
			return false;
		}
		add_error(status, `Function not found: ${node.name}`, node.start);
		return false;
	}

	if (func.is_generic) {
		const specialized = specialize_function(func, node, status);
		if (specialized) {
			node.name = specialized.name;
			return check_function_call(node, status, specialized);
		}
		return false;
	}

	return check_function_call(node, status, func);
}

export function monomorphize(
	generic_struct: StructNode,
	type_args: Type[],
	status: CheckStatus,
): StructNode | null {
	if (type_args.length !== generic_struct.type_params.length) {
		add_error(
			status,
			`Expected ${generic_struct.type_params.length} type arguments for ${generic_struct.name}, got ${type_args.length}`,
			generic_struct.start,
		);
		return null;
	}

	// If any type argument is an unresolved type parameter (e.g. we are inside
	// the body of a generic struct like Tree<T> checking its Buffer<T> field),
	// don't materialize a phantom `Buffer_T` — it will be created later when
	// the enclosing generic is itself monomorphized with concrete type args.
	if (type_args.some((t) => status.type_params.includes(t.name))) {
		return null;
	}

	const mono_name = generic_struct.name + "_" + type_args.map((t) => t.name).join("_");

	const existing = status.structs.find((s) => s.name === mono_name);
	if (existing) return existing;

	const substitution = new Map<string, string>();
	for (let i = 0; i < generic_struct.type_params.length; i++) {
		substitution.set(generic_struct.type_params[i], type_args[i].name);
	}

	const mono_fields = generic_struct.fields.map((field) => {
		const resolved_type = substitute_type(field.type, substitution);
		const mono_field = new DeclarationNode(
			field.start,
			field.visibility,
			field.declaration,
			field.name,
			resolved_type,
			field.value ? (clone_node(field.value) as BaseNode) : undefined,
		);
		// Substitute type params in field default values (e.g. Buffer<T>()
		// becomes Buffer_int() when Tree<T> is monomorphized to Tree_int).
		if (mono_field.value) {
			substitute_raw_in_node(mono_field.value, substitution, status.structs);
		}
		return mono_field;
	});

	// Compile-time class-ness: a `Buffer<Elem>` field resolves to ClassBuffer<Elem>
	// when Elem is a class (frees elements on destroy, forbids store_int(0)), else
	// Buffer<Elem>. The field type AND its default constructor are rewritten to
	// the monomorphized name (e.g. ClassBuffer_Animal / Buffer_int) so types match
	// and every build path resolves against the concrete buffer directly.
	for (const field of mono_fields) {
		const elem = field.type.name === "Buffer" ? field.type.type_args?.[0] : undefined;
		if (!elem?.name) continue;
		const elem_is_class = !!status.structs.find((s) => s.name === elem.name && s.is_class);
		const generic = status.structs.find(
			(s) => s.name === (elem_is_class ? "ClassBuffer" : "Buffer"),
		);
		if (!generic) continue;
		const buf_mono = monomorphize(generic, [elem], status);
		if (!buf_mono) continue;
		field.type.name = buf_mono.name;
		field.type.type_args = undefined;
		if (field.value?.node_type === "func_call") {
			const dv = field.value as FunctionCallNode;
			dv.name = buf_mono.name;
			dv.type_args = undefined;
		}
	}

	const mono_struct = new StructNode(
		generic_struct.start,
		generic_struct.visibility,
		mono_name,
		generic_struct.traits,
		mono_fields,
		[],
	);

	for (const func of generic_struct.functions) {
		if (func.name === "#init") continue;
		const cloned = clone_node(func) as FunctionNode;
		substitute_raw_types(cloned, substitution, status.structs);
		rename_local_labels(cloned, mono_name);
		cloned.return_type = substitute_type(cloned.return_type, substitution);
		for (const param of cloned.params) {
			param.type = substitute_type(param.type, substitution);
			if (param.constraint) {
				substitute_raw_in_node(param.constraint, substitution, status.structs);
			}
		}
		cloned.checked = true;
		mono_struct.functions.push(cloned);
	}

	const init_params: ParameterNode[] = [];
	for (const field of mono_fields) {
		if (!field.value) {
			const param = new ParameterNode(field.start, field.name, field.type);
			// For mov fields: keep mov only if resolved type is class, otherwise convert to var
			if (field.declaration === "mov") {
				const field_is_class = !!status.structs.find(
					(s) => s.name === field.type.name && s.is_class,
				);
				if (field_is_class) {
					param.is_moved = true;
				} else {
					param.declaration = "var";
				}
			}
			init_params.push(param);
		}
	}
	const init_return_type = new Type(generic_struct.name);
	init_return_type.type_args = type_args.map((t) => {
		const copy = new Type(t.name, t.is_static, t.is_array, t.length);
		copy.is_ref = t.is_ref;
		copy.is_nullable = t.is_nullable;
		return copy;
	});
	const init_func = new FunctionNode(
		generic_struct.start,
		"pub",
		"#init",
		init_return_type,
		init_params,
	);
	mono_struct.functions.push(init_func);

	status.structs.push(mono_struct);
	status.types.push(mono_name);

	const root = status.stack[0] as RootNode;
	const already_in_root = root.statements.some(
		(s) => s.node_type === "struct" && (s as StructNode).name === mono_name,
	);
	if (!already_in_root) {
		root.statements.push(mono_struct);
	}

	return mono_struct;
}

function substitute_type(type: Type, substitution: Map<string, string>): Type {
	const resolved_name = substitution.get(type.name) || type.name;
	const new_type = new Type(resolved_name, type.is_static, type.is_array, type.length);
	new_type.is_ref = type.is_ref;
	new_type.is_nullable = type.is_nullable;
	if (resolved_name !== type.name) {
		new_type.type_args = undefined;
	} else {
		new_type.type_args = type.type_args?.map((t) => substitute_type(t, substitution));
	}
	new_type.func_params = type.func_params;
	new_type.func_return_type = type.func_return_type
		? substitute_type(type.func_return_type, substitution)
		: undefined;
	return new_type;
}

function substitute_raw_types(
	func: FunctionNode,
	substitution: Map<string, string>,
	structs: StructNode[],
) {
	// Compute params whose type resolves to a non-simple struct: in the C
	// backend those are passed by pointer (`struct T *value`), but raw C
	// blocks were written assuming pass-by-value. Dereference them in raw
	// blocks so `_data[i] = value` becomes `_data[i] = (*value)`.
	const deref_params = new Set<string>();
	for (const param of func.params) {
		const resolved = substitution.get(param.type.name);
		if (!resolved) continue;
		if (param.is_self_param) continue;
		const s = structs.find((x) => x.name === resolved);
		// Dereference struct params in raw blocks (they're passed by pointer
		// but the raw C code assumes pass-by-value). Skip class params —
		// classes are heap pointers, so the pointer IS the value and must
		// NOT be dereferenced.
		if (s && !s.is_simple_type && !s.is_class) {
			deref_params.add(param.name);
		}
	}
	for (const stmt of func.statements) {
		substitute_raw_in_node(stmt, substitution, structs, deref_params);
	}
}

function rename_local_labels(node: BaseNode, prefix: string) {
	if (node.node_type === "raw") {
		const raw = node as RawNode;
		raw.value = raw.value.replace(/\.L(\w+)/g, `.L${prefix}_$1`);
		return;
	}
	const any_node = node as any;
	if (any_node.statements && Array.isArray(any_node.statements)) {
		for (const child of any_node.statements) {
			if (child && typeof child === "object" && "node_type" in child) {
				rename_local_labels(child, prefix);
			}
		}
	}
	if (any_node.value && any_node.value.node_type) {
		rename_local_labels(any_node.value, prefix);
	}
	if (any_node.left_value?.node_type) {
		rename_local_labels(any_node.left_value, prefix);
	}
	if (any_node.right_value?.node_type) {
		rename_local_labels(any_node.right_value, prefix);
	}
	if (any_node.constraint?.node_type) {
		rename_local_labels(any_node.constraint, prefix);
	}
}

function raw_type_size(name: string, structs: StructNode[]): number {
	switch (name) {
		case "bool":
		case "int8":
		case "uint8":
		case "char":
			return 1;
		case "int16":
		case "uint16":
			return 2;
		case "int32":
		case "uint32":
			return 4;
	}
	// User-defined value struct: VT_SIZE prefix (8) + sum of field sizes.
	// Classes are always 8 (a heap pointer); simple types are 8 (word-aligned).
	const struct = structs.find((s) => s.name === name);
	if (!struct || struct.is_simple_type || struct.is_class) return 8;
	let size = 8;
	for (const field of struct.fields) {
		size += raw_type_size(field.type.name, structs);
	}
	return size;
}

/**
 * Map an Echo type name to its C representation for substitution inside raw C
 * blocks. `string` is not a C type, so it must become `char*` (making `T*`
 * become `char**`). Other built-in scalars happen to share their C name.
 */
function raw_c_type_name(name: string): string {
	switch (name) {
		case "string":
			return "char*";
		default:
			return name;
	}
}

function substitute_raw_in_node(
	node: BaseNode,
	substitution: Map<string, string>,
	structs: StructNode[],
	deref_params: Set<string> = new Set(),
) {
	if (node.node_type === "raw") {
		const raw = node as RawNode;
		let value = raw.value;
		for (const [param, type] of substitution) {
			// In raw C blocks, T must become a valid C type name.
			// - `string` is not a C type → substitute `char*`
			// - Non-simple struct types need `struct T` prefix (the typedef
			//   may not be in scope, especially in headers)
			// - Class types need `struct T*` (they're heap-allocated pointers)
			const struct_node = structs.find((s) => s.name === type && !s.is_simple_type);
			let c_type_name: string;
			if (struct_node?.is_class) {
				c_type_name = `struct ${type} *`;
			} else if (struct_node) {
				c_type_name = `struct ${type}`;
			} else {
				c_type_name = raw_c_type_name(type);
			}
			value = value.replace(new RegExp(`\\b${param}\\b`, "g"), c_type_name);
			// Also substitute T_SIZE placeholder with element byte size
			const size = raw_type_size(type, structs);
			value = value.replace(new RegExp(`\\b${param}_SIZE\\b`, "g"), String(size));
			// Substitute T_destroy placeholder with the monomorphized element's
			// destroy symbol (e.g. ClassBuffer<Animal>.#destroy calls Animal_destroy).
			value = value.replace(new RegExp(`\\b${param}_destroy\\b`, "g"), `${type}_destroy`);
		}
		// Dereference struct params: the C backend passes them as pointers,
		// but raw blocks were written assuming pass-by-value. Replace bare
		// param references with `(*param)`. Skip occurrences already prefixed
		// with `&` or `*` to avoid `&(*x)` / `*(*x)`.
		for (const pname of deref_params) {
			value = value.replace(
				new RegExp(`(?<![&*.>\\w])\\b${pname}\\b(?![\\w])`, "g"),
				`(*${pname})`,
			);
		}
		raw.value = value;
		return;
	}
	// Substitute type arguments on call nodes (e.g. `Buffer<TK>()` inside a
	// generic method) and rewrite a func_call constructor's name to its
	// monomorphized symbol so the build keys `_init` correctly.
	const any_node = node as any;
	if (node.node_type === "func_call" && any_node.type_args?.length) {
		any_node.type_args = any_node.type_args.map((t: Type) => substitute_type(t, substitution));
		any_node.name = any_node.name + "_" + any_node.type_args.map((t: Type) => t.name).join("_");
	} else if (node.node_type === "access_func" && any_node.type_args?.length) {
		any_node.type_args = any_node.type_args.map((t: Type) => substitute_type(t, substitution));
	}
	if (node.node_type === "access" && any_node.access?.type_args?.length) {
		any_node.access.type_args = any_node.access.type_args.map((t: Type) =>
			substitute_type(t, substitution),
		);
	}
	// Substitute declared types on local declarations inside a generic body
	// (e.g. `var Buffer<TK> old_keys` becomes `var Buffer_int old_keys` when
	// the enclosing struct is monomorphized). Without this, the build resolves
	// method calls on the local against the unresolved `Buffer_TK` symbol.
	if (node.node_type === "declare" && any_node.type?.name) {
		any_node.type = substitute_type(any_node.type, substitution);
		if (any_node.func_return_type?.name) {
			any_node.func_return_type = substitute_type(any_node.func_return_type, substitution);
		}
	}
	// Recursively walk common container nodes
	if (any_node.statements && Array.isArray(any_node.statements)) {
		for (const child of any_node.statements) {
			if (child && typeof child === "object" && "node_type" in child) {
				substitute_raw_in_node(child, substitution, structs, deref_params);
			}
		}
	}
	if (any_node.params && Array.isArray(any_node.params)) {
		for (const child of any_node.params) {
			if (child && typeof child === "object" && "node_type" in child) {
				substitute_raw_in_node(child, substitution, structs, deref_params);
			}
		}
	}
	if (any_node.value && any_node.value.node_type) {
		substitute_raw_in_node(any_node.value, substitution, structs, deref_params);
	}
	if (any_node.left_value?.node_type) {
		substitute_raw_in_node(any_node.left_value, substitution, structs, deref_params);
	}
	if (any_node.right_value?.node_type) {
		substitute_raw_in_node(any_node.right_value, substitution, structs, deref_params);
	}
	if (any_node.target?.node_type) {
		substitute_raw_in_node(any_node.target, substitution, structs, deref_params);
	}
	if (any_node.access?.node_type) {
		substitute_raw_in_node(any_node.access, substitution, structs, deref_params);
	}
	if (any_node.swap?.node_type) {
		substitute_raw_in_node(any_node.swap, substitution, structs, deref_params);
	}
}

function specialize_function(
	generic_func: FunctionNode,
	call_node: FunctionCallNode,
	status: CheckStatus,
): FunctionNode | null {
	const substitution = new Map<string, string>();
	const suffix_parts: string[] = [];

	for (let i = 0; i < generic_func.params.length; i++) {
		const param = generic_func.params[i];
		const generic_struct = status.structs.findLast((s) => s.name === param.type.name);
		if (!generic_struct?.is_generic) continue;

		const arg = call_node.params[i];
		if (!arg) continue;

		let type_args_for_struct: Type[] = [];

		if (arg.node_type === "anon_struct") {
			type_args_for_struct = infer_from_anon_struct(
				arg as import("../nodes/AnonStructNode.ts").default,
				generic_struct,
				status,
				substitution,
			);
		} else {
			const arg_type = infer_arg_type(arg, status);
			if (arg_type.type_args?.length) {
				type_args_for_struct = arg_type.type_args;
				for (let j = 0; j < generic_struct.type_params.length; j++) {
					if (j < arg_type.type_args.length) {
						substitution.set(generic_struct.type_params[j], arg_type.type_args[j].name);
					}
				}
				if (param.type.type_args?.length) {
					for (let j = 0; j < param.type.type_args.length; j++) {
						if (j < arg_type.type_args.length) {
							substitution.set(param.type.type_args[j].name, arg_type.type_args[j].name);
						}
					}
				}
			} else if (arg_type.name !== param.type.name) {
				const mono_struct = status.structs.findLast((s) => s.name === arg_type.name);
				if (mono_struct) {
					for (let j = 0; j < generic_struct.type_params.length; j++) {
						const field = mono_struct.fields[j];
						if (field) {
							substitution.set(generic_struct.type_params[j], field.type.name);
						}
					}
				}
			}
		}

		if (type_args_for_struct.length === 0) {
			type_args_for_struct = generic_struct.type_params.map(
				(tp) => new Type(substitution.get(tp) || tp),
			);
		}
		const mono_name = generic_struct.name + "_" + type_args_for_struct.map((t) => t.name).join("_");
		substitution.set(generic_struct.name, mono_name);
		suffix_parts.push(mono_name);
	}

	if (substitution.size === 0) {
		add_error(
			status,
			`Cannot infer type arguments for generic function: ${generic_func.name}`,
			call_node.start,
		);
		return null;
	}

	for (let i = 0; i < generic_func.params.length; i++) {
		const param = generic_func.params[i];
		const generic_struct = status.structs.findLast((s) => s.name === param.type.name);
		if (!generic_struct?.is_generic) continue;
		const type_args = generic_struct.type_params.map((tp) => {
			const resolved = substitution.get(tp);
			return new Type(resolved || tp);
		});
		monomorphize(generic_struct, type_args, status);
	}

	const specialized_name = generic_func.name + "_" + suffix_parts.join("_");

	const existing = status.functions.findLast((f) => f.name === specialized_name);
	if (existing) return existing;

	const cloned = clone_node(generic_func) as FunctionNode;
	cloned.name = specialized_name;
	cloned.is_generic = false;

	for (const param of cloned.params) {
		param.type = substitute_type(param.type, substitution);
	}
	if (cloned.return_type.name) {
		cloned.return_type = substitute_type(cloned.return_type, substitution);
	}

	if (generic_func.type_params.length > 0) {
		substitute_body_types(cloned.statements, substitution);
	}

	cloned.type_params = [];

	const root = status.stack[0] as RootNode;
	root.statements.push(cloned);

	const root_status: CheckStatus = {
		stack: [root],
		scope_depth: status.scope_depth,
		types: status.types.slice(),
		values: [],
		structs: status.structs,
		traits: status.traits,
		enums: status.enums,
		bitsets: status.bitsets,
		functions: status.functions,
		allocations: [],
		var_name_counter: status.var_name_counter,
		type_params: [],
		errors: status.errors,
	};

	check_function_node(cloned, root_status);

	return status.functions.findLast((f) => f.name === specialized_name) || null;
}

function infer_arg_type(node: import("../nodes/BaseNode.ts").default, status: CheckStatus): Type {
	if (node.node_type === "value") {
		const vn = node as import("../nodes/ValueNode.ts").default;
		if (vn.type?.name) return vn.type;
		return type_from_value(vn.value, status);
	}
	if (node.node_type === "func_call") {
		return (node as FunctionCallNode).type;
	}
	if (node.node_type === "access") {
		const access = node as import("../nodes/AccessNode.ts").default;
		const inner = access.access;
		if (inner.node_type === "access_field") {
			return (inner as import("../nodes/AccessFieldNode.ts").default).type || new Type("");
		}
	}
	return new Type("");
}

function infer_from_anon_struct(
	anon: import("../nodes/AnonStructNode.ts").default,
	generic_struct: StructNode,
	status: CheckStatus,
	substitution: Map<string, string>,
): Type[] {
	for (const field of anon.fields) {
		const struct_field = generic_struct.fields.find((f) => f.name === field.name);
		if (!struct_field) continue;
		const type_param_name = struct_field.type.name;
		if (!generic_struct.type_params.includes(type_param_name)) continue;
		if (substitution.has(type_param_name)) continue;
		const val_type = infer_arg_type(field.value, status);
		if (val_type.name) {
			substitution.set(type_param_name, val_type.name);
		}
	}
	return generic_struct.type_params.map((tp) => new Type(substitution.get(tp) || tp));
}

function substitute_body_types(
	statements: import("../nodes/BaseNode.ts").default[],
	substitution: Map<string, string>,
) {
	for (const stmt of statements) {
		substitute_node_types(stmt, substitution);
	}
}

function substitute_node_types(
	node: import("../nodes/BaseNode.ts").default,
	substitution: Map<string, string>,
) {
	if (!node) return;

	switch (node.node_type) {
		case "declare": {
			const n = node as import("../nodes/DeclarationNode.ts").default;
			n.type = substitute_type(n.type, substitution);
			if (n.value) substitute_node_types(n.value, substitution);
			if (n.func_return_type)
				n.func_return_type = substitute_type(n.func_return_type, substitution);
			break;
		}
		case "return": {
			const n = node as import("../nodes/ReturnNode.ts").default;
			if (n.value) substitute_node_types(n.value, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "let": {
			const n = node as import("../nodes/LetNode.ts").default;
			if (n.value) substitute_node_types(n.value, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "assign": {
			const n = node as import("../nodes/AssignmentNode.ts").default;
			substitute_node_types(n.left_value, substitution);
			substitute_node_types(n.right_value, substitution);
			break;
		}
		case "if": {
			const n = node as import("../nodes/IfElseNode.ts").default;
			substitute_node_types(n.condition, substitution);
			if (n.if_branch) substitute_body_types(n.if_branch.statements, substitution);
			if (n.else_branch) substitute_body_types(n.else_branch.statements, substitution);
			if (n.return_type) n.return_type = substitute_type(n.return_type, substitution);
			break;
		}
		case "match": {
			const n = node as import("../nodes/MatchNode.ts").default;
			substitute_node_types(n.value, substitution);
			for (const c of n.cases) {
				substitute_node_types(c.match_value, substitution);
				substitute_body_types(c.branch.statements, substitution);
			}
			if (n.else_branch) substitute_body_types(n.else_branch.statements, substitution);
			if (n.return_type) n.return_type = substitute_type(n.return_type, substitution);
			break;
		}
		case "switch": {
			const n = node as import("../nodes/SwitchNode.ts").default;
			for (const c of n.cases) {
				substitute_node_types(c.condition, substitution);
				substitute_body_types(c.branch.statements, substitution);
			}
			if (n.else_branch) substitute_body_types(n.else_branch.statements, substitution);
			if (n.return_type) n.return_type = substitute_type(n.return_type, substitution);
			break;
		}
		case "for": {
			const n = node as import("../nodes/ForLoopNode.ts").default;
			substitute_node_types(n.item, substitution);
			substitute_node_types(n.list, substitution);
			substitute_body_types(n.statements, substitution);
			if (n.update) substitute_node_types(n.update, substitution);
			break;
		}
		case "while": {
			const n = node as import("../nodes/WhileLoopNode.ts").default;
			substitute_node_types(n.condition, substitution);
			substitute_body_types(n.statements, substitution);
			if (n.update) substitute_node_types(n.update, substitution);
			break;
		}
		case "func_call": {
			const n = node as FunctionCallNode;
			for (const p of n.params) substitute_node_types(p, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "access": {
			const n = node as import("../nodes/AccessNode.ts").default;
			substitute_node_types(n.target, substitution);
			substitute_node_types(n.access, substitution);
			break;
		}
		case "access_func": {
			const n = node as import("../nodes/AccessFunctionCallNode.ts").default;
			for (const p of n.params) substitute_node_types(p, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "access_field": {
			const n = node as import("../nodes/AccessFieldNode.ts").default;
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "op": {
			const n = node as import("../nodes/OperationNode.ts").default;
			substitute_node_types(n.left_value, substitution);
			substitute_node_types(n.right_value, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "grouped": {
			const n = node as import("../nodes/GroupedNode.ts").default;
			substitute_node_types(n.value, substitution);
			break;
		}
		case "cast": {
			const n = node as import("../nodes/CastNode.ts").default;
			substitute_node_types(n.value, substitution);
			n.target_type = substitute_type(n.target_type, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "value":
		case "break":
		case "continue":
		case "panic":
		case "todo":
		case "raw":
		case "import":
			break;
	}
}
