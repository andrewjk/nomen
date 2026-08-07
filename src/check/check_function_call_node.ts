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
import check_node from "./check_node.ts";
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
			} else if (
				struct.type_params.length > 0 &&
				struct.functions.some((f) => f.name === "#init" && f.has_body)
			) {
				// Generic struct with a custom #init, called without explicit
				// type args (e.g. `Map(["a", 1], ["b", 2])`). Infer the type
				// args from the variadic-tuple constructor's first argument.
				const inferred = infer_init_type_args(struct, node, status);
				if (inferred) {
					const mono = monomorphize(struct, inferred, status);
					if (mono) {
						func = mono.functions.find((f) => f.name === "#init");
						if (func) {
							const type = new Type(struct.name);
							type.type_args = inferred;
							node.type = type;
							node.name = mono.name;
							node.type_args = inferred;
						}
					}
				}
				if (!func) {
					func = struct.functions.find((f) => f.name === "#init");
					if (func) {
						const type = new Type(struct.name);
						node.type = type;
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

	// `T(args) + [ field = value, ... ]` is collapsed onto the call at parse
	// time as `field_overrides`. Validate them against the struct's fields:
	// each must name a real field that is NOT an #init param (set positionally)
	// and HAS a declared default (required fields are owned by #init). This
	// keeps the overlay from becoming a back door around construction.
	if (node.field_overrides?.length) {
		const override_struct = status.structs.findLast((s) => s.name === node.name);
		if (override_struct && func) {
			validate_field_overrides(node, override_struct, func, status);
		} else {
			add_error(
				status,
				"`[ ... ]` field overrides can only follow a struct constructor call",
				node.start,
			);
			node.field_overrides = undefined;
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
		// Shorthand enum case constructor with args: `.case(arg1, arg2)`.
		// Resolve via the expected type (an enum), rewrite the call's name to
		// the mangled `Enum_case` form, and mark it so the build lowers it as
		// an enum constructor (mirroring `Enum.case(args)` access calls).
		if (node.name.startsWith(".") && node.name.length > 1) {
			const case_name = node.name.substring(1);
			const expected = status.expected_type;
			if (!expected?.name) {
				add_error(status, `Cannot resolve .${case_name} without a type hint`, node.start);
				return false;
			}
			const enum_node = status.enums.find((e) => e.name === expected.name);
			if (!enum_node) {
				add_error(status, `Type ${expected.name} is not an enum`, node.start);
				return false;
			}
			const enum_case = enum_node.cases.find((c) => c.name === case_name);
			if (!enum_case) {
				add_error(status, `Unknown enum case: .${case_name} on ${expected.name}`, node.start);
				return false;
			}
			if (enum_case.params.length !== node.params.length) {
				add_error(
					status,
					`Enum case .${case_name} expects ${enum_case.params.length} arguments, got ${node.params.length}`,
					node.start,
				);
				return false;
			}
			for (const param of node.params) {
				const old_expected = status.expected_type;
				// Bind each call arg against the corresponding case param type
				// so e.g. `.fixed(int pixels)` checks `50` against `int`.
				const idx = node.params.indexOf(param);
				if (enum_case.params[idx]) {
					status.expected_type = enum_case.params[idx].type;
				}
				check_node(param, status);
				status.expected_type = old_expected;
			}
			node.type = new Type(enum_node.name);
			node.is_static = true;
			node.name = `${enum_node.name}_${case_name}`;
			node.is_enum_shorthand = true;
			return true;
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

	// Enforce trait bounds on type params (`struct Container<T: Control>`):
	// each concrete type arg must conform to every bound declared on its
	// param. A bound is satisfied when the arg is a struct/class whose
	// `traits` include the bound trait name. Primitives and non-conforming
	// structs are rejected here, at the point the generic is instantiated.
	const bounds_parallel =
		generic_struct.type_param_bounds.length === generic_struct.type_params.length;
	for (let i = 0; i < generic_struct.type_params.length; i++) {
		const bounds = bounds_parallel ? generic_struct.type_param_bounds[i] : [];
		if (!bounds || bounds.length === 0) continue;
		const arg_name = type_args[i].name;
		const arg_struct = status.structs.findLast((s) => s.name === arg_name);
		for (const bound of bounds) {
			const conforms = !!arg_struct && arg_struct.traits.includes(bound);
			if (!conforms) {
				add_error(
					status,
					`Type argument '${arg_name}' does not conform to bound '${bound}' for type parameter '${generic_struct.type_params[i]}' of ${generic_struct.name}`,
					generic_struct.start,
				);
			}
		}
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

	// Compile-time class-ness OR trait-ness: a `Buffer<Elem>` field resolves
	// to ClassBuffer<Elem> when Elem is a class OR a trait (both are stored as
	// 8-byte owned pointers and freed per-element on destroy — a trait-typed
	// slot dispatches destroy via the vtable). Otherwise Elem is a value type
	// and we keep Buffer<Elem>. The field type AND its default constructor are
	// rewritten to the monomorphized name (e.g. ClassBuffer_Animal /
	// ClassBuffer_Speaker / Buffer_int) so types match and every build path
	// resolves against the concrete buffer directly.
	for (const field of mono_fields) {
		const elem = field.type.name === "Buffer" ? field.type.type_args?.[0] : undefined;
		if (!elem?.name) continue;
		const elem_is_class = !!status.structs.find((s) => s.name === elem.name && s.is_class);
		const elem_is_trait = !!status.traits.find((t) => t.name === elem.name);
		const generic = status.structs.find(
			(s) => s.name === (elem_is_class || elem_is_trait ? "ClassBuffer" : "Buffer"),
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
	mono_struct.source_type_args = type_args;
	mono_struct.is_class = generic_struct.is_class;
	mono_struct.is_library = generic_struct.is_library;

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

	const init_return_type = new Type(generic_struct.name);
	init_return_type.type_args = type_args.map((t) => {
		const copy = new Type(t.name, t.is_static, t.is_array, t.length);
		copy.is_ref = t.is_ref;
		copy.is_nullable = t.is_nullable;
		return copy;
	});

	const custom_init = generic_struct.functions.find((f) => f.name === "#init" && f.has_body);
	// Only treat a custom #init as the monomorphized constructor when its
	// body is real Nomen code. A raw-`#arch`-only #init (e.g. Array<T>'s) is
	// a hand-written primitive that assumes a pointer `self` and is never
	// invoked through the normal constructor path — keep the old behaviour
	// of synthesizing a field-based #init for those.
	const custom_init_is_nomen =
		!!custom_init && custom_init.statements.some((s) => s.node_type !== "raw");
	if (custom_init && custom_init_is_nomen) {
		// A generic struct with a custom #init (e.g. Map<K,V>'s variadic-tuple
		// constructor) is cloned + type-substituted + re-checked here, so its
		// variadic tuple param materializes against the concrete type args and
		// its body resolves self.method() against the monomorphized struct.
		const cloned = clone_node(custom_init) as FunctionNode;
		substitute_raw_types(cloned, substitution, status.structs);
		rename_local_labels(cloned, mono_name);
		cloned.return_type = new Type(mono_name);
		cloned.type_params = [];
		for (const param of cloned.params) {
			param.type = substitute_type(param.type, substitution);
			if (param.constraint) {
				substitute_raw_in_node(param.constraint, substitution, status.structs);
			}
		}
		// The self param's type was the generic struct name (e.g. "Map"); it
		// must resolve to the monomorphized struct so the body's
		// self.method() calls bind to the cloned methods instead of
		// re-triggering monomorphization of the same generic struct.
		const cloned_self = cloned.params.find((p) => p.is_self_param);
		if (cloned_self) {
			cloned_self.type = new Type(mono_name);
		}
		// Register the mono struct BEFORE re-checking the cloned #init body,
		// so lookups (self's type, method resolution) find it instead of
		// recursing through monomorphize again.
		status.structs.push(mono_struct);
		status.types.push(mono_name);
		mono_struct.functions.push(cloned);
		const root_status: CheckStatus = {
			stack: status.stack,
			scope_depth: status.scope_depth,
			types: status.types,
			values: [],
			function_value_base: 0,
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
	} else {
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
		const init_func = new FunctionNode(
			generic_struct.start,
			"pub",
			"#init",
			init_return_type,
			init_params,
		);
		mono_struct.functions.push(init_func);
	}

	// Note: when the generic struct has a custom Nomen #init, the mono struct
	// was already pushed to status.structs/types before re-checking the clone
	// (see custom_init branch above). Otherwise push it now.
	if (!custom_init_is_nomen) {
		status.structs.push(mono_struct);
		status.types.push(mono_name);
	}

	const root = status.stack[0] as RootNode;
	const already_in_root = root.statements.some(
		(s) => s.node_type === "struct" && (s as StructNode).name === mono_name,
	);
	if (!already_in_root) {
		root.statements.push(mono_struct);
	}

	return mono_struct;
}

/**
 * Synthesize per-conformer default-method overrides for generic traits.
 *
 * A generic trait's default-method body references its type params (e.g.
 * `trait Box<T> { var T item; func get = (self, out T) { return self.item } }`),
 * so a single trait-level emission can't work — `T` is unresolved. Instead,
 * for each conforming struct we clone the trait's default bodies, substitute
 * the trait's `type_params` for the struct's concrete `trait_args`, retype
 * `self` to the struct, and append the clone as a struct method. The existing
 * struct-method + vtable-override machinery then emits it on both backends,
 * and the per-trait default-body emission is skipped for generic traits
 * (build_trait_node.ts / build_aarch64 build_trait_functions).
 *
 * Abstract methods (no body) are left alone — conformers must override them
 * (validated elsewhere), and concrete overrides already work. Methods the
 * struct already provides are likewise skipped.
 */
export function synthesize_generic_trait_defaults(struct: StructNode, status: CheckStatus) {
	for (let i = 0; i < struct.traits.length; i++) {
		const trait = status.traits.find((t) => t.name === struct.traits[i]);
		if (!trait || trait.type_params.length === 0) continue;
		const args = struct.trait_args[i];
		if (!args || args.length !== trait.type_params.length) continue;

		const substitution = new Map<string, string>();
		for (let j = 0; j < trait.type_params.length; j++) {
			substitution.set(trait.type_params[j], args[j].name);
		}

		for (const trait_func of trait.functions) {
			// Only default bodies need per-conformer synthesis; abstract
			// methods are fulfilled by the struct's own override.
			if (!trait_func.has_body) continue;
			if (trait_func.name === "#init" || trait_func.name === "#destroy") continue;
			// Skip if the struct already provides an override.
			if (struct.functions.find((f) => f.name === trait_func.name)) continue;

			const cloned = clone_node(trait_func) as FunctionNode;
			// The trait default is `private` (trait functions default to
			// private), but as a struct method it must be callable through the
			// struct like any other method (struct methods default to pub).
			// The later `func.scope = struct` assignment in check_struct_node
			// would otherwise gate a private trait-clone to struct-local scope.
			cloned.visibility = "pub";
			cloned.return_type = substitute_type(cloned.return_type, substitution);
			for (const param of cloned.params) {
				param.type = substitute_type(param.type, substitution);
			}
			// The trait's `self` param is typed as the trait name (e.g. `Box`);
			// the synthesized method belongs to the struct, so field access on
			// `self` must resolve against the struct's storage.
			const self_param = cloned.params.find((p) => p.is_self_param);
			if (self_param) {
				self_param.type = new Type(struct.name);
			}
			substitute_body_types(cloned.statements, substitution);
			// The cloned body's `self` ValueNodes retain the trait's type (e.g.
			// `Box`) from when the default body was checked against the trait.
			// The builder reads ValueNode.type directly to decide struct-vs-
			// trait field access, so without retying, `self.item` would route
			// through the trait vtable with an unresolved `T`. Repoint every
			// `self` reference at the conforming struct so field access lowers
			// directly (and matches a hand-written struct method).
			retype_self_references(cloned.statements, struct.name);
			// Leave `scope` undefined (as on the trait function): a trait default
			// method is callable wherever the trait is visible, and the
			// visibility check treats an undefined scope as globally visible.
			// The builder keys field access off `status.current_struct`, not
			// `func.scope`, so the synthesized override resolves `self.field`
			// against the struct regardless.
			cloned.checked = true;
			struct.functions.push(cloned);
		}
	}
}

/**
 * Recursively retype every `self` ValueNode in `nodes` to `struct_name`. The
 * trait default body was checked with `self` typed as the trait; the builder
 * reads ValueNode.type verbatim, so a stale trait type would send field access
 * through the vtable. Used only by synthesize_generic_trait_defaults.
 */
function retype_self_references(nodes: BaseNode[], struct_name: string) {
	for (const node of nodes) {
		retype_self_in_node(node, struct_name);
	}
}

function retype_self_in_node(node: BaseNode | undefined | null, struct_name: string) {
	if (!node) return;
	const any_node = node as any;
	if (node.node_type === "value" && any_node.value === "self") {
		any_node.type = new Type(struct_name);
	}
	if (any_node.statements && Array.isArray(any_node.statements)) {
		for (const child of any_node.statements) {
			if (child && typeof child === "object" && "node_type" in child) {
				retype_self_in_node(child, struct_name);
			}
		}
	}
	if (any_node.params && Array.isArray(any_node.params)) {
		for (const child of any_node.params) {
			if (child && typeof child === "object" && "node_type" in child) {
				retype_self_in_node(child, struct_name);
			}
		}
	}
	if (any_node.cases && Array.isArray(any_node.cases)) {
		for (const c of any_node.cases) {
			if (c.branch?.statements) retype_self_in_node(c.branch, struct_name);
			if (c.match_value) retype_self_in_node(c.match_value, struct_name);
			if (c.condition) retype_self_in_node(c.condition, struct_name);
		}
	}
	if (any_node.value?.node_type) retype_self_in_node(any_node.value, struct_name);
	if (any_node.left_value?.node_type) retype_self_in_node(any_node.left_value, struct_name);
	if (any_node.right_value?.node_type) retype_self_in_node(any_node.right_value, struct_name);
	if (any_node.target?.node_type) retype_self_in_node(any_node.target, struct_name);
	if (any_node.access?.node_type) retype_self_in_node(any_node.access, struct_name);
	if (any_node.condition?.node_type) retype_self_in_node(any_node.condition, struct_name);
	if (any_node.if_branch?.node_type) retype_self_in_node(any_node.if_branch, struct_name);
	if (any_node.else_branch?.node_type) retype_self_in_node(any_node.else_branch, struct_name);
	if (any_node.item?.node_type) retype_self_in_node(any_node.item, struct_name);
	if (any_node.list?.node_type) retype_self_in_node(any_node.list, struct_name);
	if (any_node.constraint?.node_type) retype_self_in_node(any_node.constraint, struct_name);
}

export function substitute_type(type: Type, substitution: Map<string, string>): Type {
	const resolved_name = substitution.get(type.name) || type.name;
	const new_type = new Type(resolved_name, type.is_static, type.is_array, type.length);
	new_type.is_ref = type.is_ref;
	new_type.is_view = type.is_view;
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
	// Substitute type params inside tuple types (e.g. `...[TK, TV]` →
	// `...[string, int]` when monomorphizing Map<string, int>). Keep
	// tuple_types on the (still-unmaterialized) tuple type so the re-check
	// in monomorphize can materialize the now-concrete tuple struct.
	new_type.tuple_types = type.tuple_types?.map((t) => substitute_type(t, substitution));
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
 * Map an Nomen type name to its C representation for substitution inside raw C
 * blocks. This MUST agree with build_c/utils/c_type.ts so that, e.g., `T*`
 * expands to `long*` for an `int` element (Nomen `int` is 64-bit, i.e. C
 * `long`, not C `int`). `string` is not a C type, so it becomes `char*`
 * (making `T*` become `char**`).
 */
function raw_c_type_name(name: string): string {
	switch (name) {
		case "string":
			return "char*";
		case "bool":
			return "unsigned char";
		case "int":
			return "long";
		case "uint":
			return "unsigned long";
		case "int8":
			return "char";
		case "uint8":
			return "unsigned char";
		case "int16":
			return "short";
		case "uint16":
			return "unsigned short";
		case "int32":
			return "int";
		case "uint32":
			return "unsigned int";
		case "int64":
			return "long long";
		case "uint64":
			return "unsigned long long";
		case "float":
		case "ufloat32":
			return "float";
		case "float64":
		case "ufloat":
			return "double";
		case "char":
			return "char";
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
			// T_NEEDS_STRDUP: 1 when T is `string` (a `char*` literal pointer that
			// must be heap-copied per slot when stored into an owning container,
			// e.g. `Array.with("x", n)` storing the literal in n slots), 0
			// otherwise. Raw blocks use it to guard a per-element strdup so the
			// scope-exit auto_free can soundly free each slot.
			value = value.replace(
				new RegExp(`\\b${param}_NEEDS_STRDUP\\b`, "g"),
				type === "string" ? "1" : "0",
			);
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
			if (mono_struct?.source_type_args?.length) {
				type_args_for_struct = mono_struct.source_type_args;
				for (let j = 0; j < generic_struct.type_params.length; j++) {
					if (j < mono_struct.source_type_args.length) {
						substitution.set(generic_struct.type_params[j], mono_struct.source_type_args[j].name);
					}
				}
				if (param.type.type_args?.length) {
					for (let j = 0; j < param.type.type_args.length; j++) {
						if (j < mono_struct.source_type_args.length) {
							substitution.set(param.type.type_args[j].name, mono_struct.source_type_args[j].name);
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
		function_value_base: 0,
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
		const fc = node as FunctionCallNode;
		if (fc.type?.name) return fc.type;
		// A constructor call with explicit type args (e.g. `Box<int>(42)`)
		// may be used as an argument to a generic function before it has been
		// checked, so its `.type` is still empty. Synthesize the type from the
		// call's explicit type_args so generic inference can substitute T.
		if (fc.type_args?.length) {
			const t = new Type(fc.name);
			t.type_args = fc.type_args;
			return t;
		}
		return fc.type;
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

/**
 * Infer the type arguments for a generic struct's custom #init when the
 * constructor is called without explicit type args (e.g.
 * `Map(["a", 1], ["b", 2])` → `<string, int>`). Only handles a custom #init
 * whose signature is a single variadic tuple param (`...[TK, TV]`); the type
 * args are read off the first variadic argument's inferred tuple element
 * types. Returns null if inference isn't possible (no args, non-tuple arg,
 * or the type params can't all be resolved).
 *
 * Read-only: it must not mutate the call args, since check_function_call
 * re-checks them afterwards against the materialized param types.
 */
function infer_init_type_args(
	struct: StructNode,
	node: FunctionCallNode,
	status: CheckStatus,
): Type[] | null {
	const init = struct.functions.find((f) => f.name === "#init" && f.has_body);
	if (!init) return null;
	const variadic_idx = init.params.findIndex((p) => p.is_variadic);
	if (variadic_idx < 0) return null;
	const tuple_types = init.params[variadic_idx].type.tuple_types;
	if (!tuple_types?.length) return null;

	const variadic_args = node.params.slice(variadic_idx);
	if (variadic_args.length === 0) return null;

	const elem_types = infer_tuple_element_types(variadic_args[0], status);
	if (!elem_types) return null;

	const substitution = new Map<string, string>();
	for (let i = 0; i < tuple_types.length && i < elem_types.length; i++) {
		if (struct.type_params.includes(tuple_types[i].name) && elem_types[i].name) {
			substitution.set(tuple_types[i].name, elem_types[i].name);
		}
	}
	if (substitution.size === 0) return null;

	const type_args = struct.type_params.map((tp) => new Type(substitution.get(tp) || tp));
	// Refuse if any type param went unresolved.
	if (type_args.some((t) => !t.name || struct.type_params.includes(t.name))) return null;
	return type_args;
}

/**
 * Best-effort, read-only inference of a tuple value's element types, used to
 * drive generic-struct constructor inference. Recognizes:
 *  - heterogeneous array literals (`["a", 1]` → [string, int])
 *  - values already carrying a tuple struct type (`_Tuple_...`)
 */
function infer_tuple_element_types(
	arg: import("../nodes/BaseNode.ts").default,
	status: CheckStatus,
): Type[] | null {
	const any_arg = arg as any;
	if (any_arg.node_type === "array") {
		const values: BaseNode[] = any_arg.values ?? [];
		if (!values.length) return null;
		const types = values.map((v) => infer_scalar_type(v, status));
		if (types.some((t) => !t.name)) return null;
		return types;
	}
	const t = infer_scalar_type(arg, status);
	if (t.tuple_types?.length) return t.tuple_types;
	if (t.name?.startsWith("_Tuple_")) {
		const s = status.structs.findLast((s) => s.name === t.name);
		if (s) return s.fields.map((f) => f.type);
	}
	return null;
}

function infer_scalar_type(node: BaseNode, status: CheckStatus): Type {
	const any_node = node as any;
	if (any_node.node_type === "value") {
		if (any_node.type?.name) return any_node.type;
		return type_from_value(any_node.value, status);
	}
	if (any_node.node_type === "func_call") {
		return any_node.type?.name ? any_node.type : new Type("");
	}
	if (any_node.node_type === "access") {
		const inner = any_node.access;
		if (inner?.node_type === "access_field") {
			return inner.type?.name ? inner.type : new Type("");
		}
	}
	if (any_node.node_type === "array") {
		// Nested array literal: infer a sub-tuple's element types and surface
		// the materialized tuple type via its tuple_types payload.
		const sub = infer_tuple_element_types(node, status);
		if (sub) {
			const t = new Type("tuple");
			t.tuple_types = sub;
			return t;
		}
	}
	return new Type("");
}

function validate_field_overrides(
	node: FunctionCallNode,
	struct: StructNode,
	init_func: FunctionNode,
	status: CheckStatus,
) {
	const validated: { name: string; value: BaseNode; type: Type }[] = [];
	const seen = new Set<string>();
	const saved_expected = status.expected_type;
	for (const override of node.field_overrides!) {
		if (seen.has(override.name)) {
			add_error(
				status,
				`Duplicate field '${override.name}' in [ ... ] overrides`,
				override.value.start,
			);
			continue;
		}
		seen.add(override.name);
		// #init params are supplied positionally — repeating one here is a
		// likely typo, not an override.
		if (init_func.params.some((p) => p.name === override.name)) {
			add_error(
				status,
				`'${override.name}' is a ${struct.name}(...) parameter, not a [ ... ] override`,
				override.value.start,
			);
			continue;
		}
		const field = struct.fields.find((f) => f.name === override.name);
		if (!field) {
			add_error(
				status,
				`Unknown field '${override.name}' in [ ... ] overrides for ${struct.name}`,
				override.value.start,
			);
			continue;
		}
		// Only defaulted fields may be overridden: a field without a default
		// is established by #init (possibly computed, e.g. `sum = x + y`) and
		// must not be clobbered after construction.
		if (!field.value) {
			add_error(
				status,
				`Field '${override.name}' has no default; set it in ${struct.name}(...)`,
				override.value.start,
			);
			continue;
		}
		status.expected_type = field.type;
		check_node(override.value, status);
		validated.push({ name: override.name, value: override.value, type: field.type });
	}
	status.expected_type = saved_expected;
	node.field_overrides = validated;
}

export function substitute_body_types(
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
