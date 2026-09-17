import add_error from "../add_error.ts";
import { fold_asm_constants } from "../build_common/fold_asm_constants.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import { get_built_in_type } from "../built_in_types.ts";
import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import clone_node from "../nodes/clone_node.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import OperationNode from "../nodes/OperationNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import RawNode from "../nodes/RawNode.ts";
import RootNode from "../nodes/RootNode.ts";
import { set_resolved_function } from "../nodes/set_resolved_function.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_function_call from "./check_function_call.ts";
import check_function_node from "./check_function_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { monomorphize_enum, enforce_case_payload_ownership } from "./utils/enum_mono.ts";
import {
	collect_return_bounds,
	collect_return_length,
	substitute_constraint,
} from "./utils/flow_bounds.ts";
import {
	find_function_by_params,
	is_overloaded,
	mangled_label,
} from "./utils/function_overload.ts";
import { is_class_type, is_owning_struct_type_requiring_move } from "./utils/ownership.ts";
import { resolve_declared_struct } from "./utils/resolve_declared_type.ts";
import type_from_value from "./utils/type_from_value.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

/**
 * Find a plain (free) function by name. `status.functions` also holds every
 * struct/trait METHOD (check_function_node registers them all), so a plain
 * `func_call` name must prefer the non-method match: a method named like a
 * free function would otherwise steal the call and mismatch on its `self` +
 * receiver params (e.g. an `Arena.free(ref self, ArenaRef<T>)` method vs the
 * extern `free(uint64)` that `Buffer`'s `#destroy` calls). Methods are
 * identified by their leading `self` parameter; the fallback keeps the old
 * resolution for a name that only exists as a method (a call that is already
 * an error either way).
 */
function find_free_function(status: CheckStatus, name: string): FunctionNode | undefined {
	const is_method = (f: FunctionNode) => !!f.params?.[0]?.is_self_param;
	return (
		status.functions.findLast((f) => f.name === name && !is_method(f)) ??
		status.functions.findLast((f) => f.name === name)
	);
}

export default function check_function_call_node(
	node: FunctionCallNode,
	status: CheckStatus,
): boolean {
	// `Thread(fn(args))` — the compiler-special spawn constructor (see
	// ASYNC_PLAN.md). A user-declared function or struct named `Thread`
	// shadows it: the special form only applies when the name resolves to
	// nothing else. The wrapped call is resolved here (so both consumers see
	// its return type); Sendable validation and Task<T> stamping live with
	// the consumers — `.start()` on the result, or a nursery's
	// `.start(Thread(fn(args)))` escape hatch — which know whether the spawn
	// is direct or nursery-registered.
	if (
		node.name === "Thread" &&
		node.params.length === 1 &&
		node.params[0].node_type === "func_call" &&
		!find_free_function(status, "Thread") &&
		!resolve_declared_struct("Thread", status)
	) {
		return check_thread_ctor(node, status);
	}

	let func = find_free_function(status, node.name);

	if (!func) {
		// Resolve the constructed type's declaration by its SOURCE name,
		// honouring scope (a nested type on a colliding name carries a
		// scope-unique emission `name` plus its `source_name`).
		const struct = resolve_declared_struct(node.name, status) as StructNode | undefined;
		if (struct) {
			const arg_types = node.params.map((p) => type_from_value_node(p, status));
			if (struct.type_params.length > 0 && node.type_args?.length) {
				const mono = monomorphize(struct, node.type_args, status);
				if (mono) {
					func = find_function_by_params(mono.functions, "#init", arg_types);
					if (func) {
						const type = new Type(struct.name);
						type.type_args = node.type_args;
						node.type = type;
						node.name = mono.name;
						if (is_overloaded(mono, "#init")) {
							node.mangled_name = mangled_label(func, mono.name);
						}
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
						func = find_function_by_params(mono.functions, "#init", arg_types);
						if (func) {
							const type = new Type(struct.name);
							type.type_args = inferred;
							node.type = type;
							node.name = mono.name;
							node.type_args = inferred;
							if (is_overloaded(mono, "#init")) {
								node.mangled_name = mangled_label(func, mono.name);
							}
						}
					}
				}
				if (!func) {
					func = find_function_by_params(struct.functions, "#init", arg_types);
					if (func) {
						const type = new Type(struct.name);
						node.type = type;
						node.name = struct.name;
					}
				}
			} else {
				func = find_function_by_params(struct.functions, "#init", arg_types);
				if (func) {
					const type = new Type(struct.name);
					type.type_args = node.type_args;
					node.type = type;
					// Point the call at the resolved declaration's emission
					// name so the build emits `<label>_init`, not a same-named
					// sibling's.
					node.name = struct.name;
					if (is_overloaded(struct, "#init")) {
						node.mangled_name = mangled_label(func, struct.name);
					}
				}
			}
		}
	}

	// `T(args) + [ field = value, ... ]` (retired) and a base-bearing
	// `[ .. T(args), ... ]` literal both arrive as `field_overrides` on the
	// call. Validate them against the struct's fields: each must name a real
	// field that is NOT an #init param (set positionally) and HAS a declared
	// default (required fields are owned by #init). This keeps the overlay
	// from becoming a back door around construction.
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
		// A func-typed value: either the type is literally `func`, or the
		// declaration carried a signature (func_params). The latter covers
		// `out`-returning signatures, whose StackValue type is the RETURN
		// type (`var func (int, out bool) f2` stores type bool) and would
		// otherwise miss this branch entirely ("Function not found").
		const is_func_value =
			!!param_value && (param_value.type.name === "func" || !!param_value.func_params?.length);
		if (is_func_value && param_value) {
			func = new FunctionNode(
				0,
				"pub",
				node.name,
				param_value.func_return_type || param_value.type,
			);
			// The signature may live on the declaration (StackValue) or on
			// the type — check both, preferring the declaration's.
			const param = status.stack
				.flatMap((n: any) => n.params || [])
				.find((p: any) => p.name === node.name);
			const sig_params =
				param?.func_params ?? param_value.func_params ?? param_value.type.func_params;
			if (sig_params) {
				func.params = sig_params;
			}
			const sig_return =
				param?.func_return_type ??
				param_value.func_return_type ??
				param_value.type.func_return_type;
			if (sig_return) {
				func.return_type = sig_return;
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
			let enum_node = status.enums.find((e) => e.name === expected.name);
			if (enum_node?.is_generic) {
				// A generic enum as the expected type resolves through its
				// concrete instantiation (`.ok(5)` against `Result<int, string>`
				// → the `Result_int_string` mono).
				const mono =
					expected.type_args?.length === enum_node.type_params.length
						? monomorphize_enum(enum_node, expected.type_args, status)
						: null;
				if (!mono) {
					add_error(
						status,
						`Cannot resolve .${case_name}: generic enum ${enum_node.name} requires concrete type arguments`,
						node.start,
					);
					return false;
				}
				enum_node = mono;
			}
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
			// A CLASS/TRAIT case payload is an OWNING slot — enforce the
			// ownership contract (see enforce_case_payload_ownership).
			enforce_case_payload_ownership(case_name, enum_case.params, node.params, node, status);
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
	// Recursive, so `Wrapper<List<T>>` inside `Outer<T>` defers too (the inner
	// arg still references T even though the outer arg names a real generic).
	if (type_args.some((t) => type_contains_unresolved_param(t, status))) {
		return null;
	}

	// Nested generic instantiation (`Wrapper<List<int>>`): a type argument
	// that is itself an instantiated generic. Recursively materialize the
	// inner mono (`List_int`) and carry its FLATTENED name as the type
	// argument, so the name-only substitution below resolves every use of
	// the type param to a real, emitted struct — never the bare generic
	// (which has no emitted body and previously hung the checker).
	const flat_args = type_args.map((t) => flatten_nested_generic_arg(t, status));

	const mono_name = mono_type_name(generic_struct.name, flat_args);

	const existing = status.structs.find((s) => s.name === mono_name);
	if (existing) return existing;

	const substitution = new Map<string, string>();
	for (let i = 0; i < generic_struct.type_params.length; i++) {
		substitution.set(generic_struct.type_params[i], flat_args[i].name);
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
		const arg_name = flat_args[i].name;
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
			substitute_raw_in_node(
				mono_field.value,
				substitution,
				status.structs,
				undefined,
				status.traits,
				status.enums,
			);
		}
		mono_field.is_library = field.is_library;
		mono_field.is_readonly = field.is_readonly;
		mono_field.is_view_keyword = field.is_view_keyword;
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
	// The flattened args (nested generics already resolved to their mono
	// names) so downstream consumers — e.g. specialize_function's inference
	// substitution — see concrete, resolvable type names.
	mono_struct.source_type_args = flat_args;
	mono_struct.is_class = generic_struct.is_class;
	mono_struct.is_library = generic_struct.is_library;

	// Register the mono struct BEFORE processing methods, so the
	// re-derivation pass (and the custom #init re-check below) can resolve
	// self's type and field/method accesses against it.
	status.structs.push(mono_struct);
	status.types.push(mono_name);

	const cloned_methods: FunctionNode[] = [];
	for (const func of generic_struct.functions) {
		if (func.name === "#init") continue;
		const cloned = clone_node(func) as FunctionNode;
		substitute_raw_types(cloned, substitution, status.structs, status.traits, status.enums);
		fold_substituted_constant_ifs(cloned.statements);
		rename_local_labels(cloned, mono_name);
		// Checker-hoisted call-argument temps (`const _param_N = <arg>` in
		// func.allocations) are built as declarations ahead of the body — and
		// their value trees carry the SAME generic node types the statements
		// do. Every retype pass below must therefore walk the allocations
		// alongside the statements, or a hoisted `self.value` (T field) keeps
		// `self: Box` + `T` and the backends lower the load as a scalar (the
		// len half of the mono fat-string field left as garbage).
		const retype_roots: BaseNode[] = [
			...cloned.statements,
			...((cloned.allocations ?? []) as BaseNode[]),
		];
		// Substitute type-param names on body node `.type` fields (T -> Pt), so
		// the builder lowers struct-typed locals/args/fields correctly. self is
		// handled separately below (its type is the struct name, not a type
		// param). Mirrors the trait-default retype pattern.
		for (const stmt of retype_roots) substitute_node_types(stmt, substitution);
		materialize_mono_enum_types(cloned.statements, substitution, status);
		// Repoint every `self` reference at the monomorphised struct (e.g.
		// Box -> Box_Pt). The cloned body's `self` ValueNodes keep the generic
		// struct name, and the builder reads ValueNode.type directly to decide
		// inline-struct-vs-pointer field access — without this, `self.item`
		// (item: T) resolves through the generic struct and the stale type
		// param, lowering a struct field as a pointer. Mirrors the trait-default
		// retype at the trait-method clone site.
		retype_self_references(retype_roots, mono_name);
		cloned.return_type = substitute_type(cloned.return_type, substitution);
		if (cloned.return_type.type_args?.length) {
			cloned.return_type = materialize_generic_enum_type(cloned.return_type, status);
		}
		for (const param of cloned.params) {
			param.type = substitute_type(param.type, substitution);
			substitute_param_signature(param, substitution);
			if (param.type.type_args?.length) {
				param.type = materialize_generic_enum_type(param.type, status);
			}
			if (param.constraint) {
				substitute_raw_in_node(
					param.constraint,
					substitution,
					status.structs,
					undefined,
					status.traits,
					status.enums,
				);
			}
		}
		// Retype body ValueNodes that reference a (non-self) param to that
		// param's now-substituted type (e.g. `value: T` -> Pt). Must run AFTER
		// the param-type substitution above. The mono body is not re-checked,
		// so without this the builder sees an empty type on struct param uses
		// and lowers them as scalars (wrong arg passing / storing). Sufficient
		// for List<T>, whose only struct-typed value is the element param.
		retype_param_references(retype_roots, cloned.params);
		retype_local_references(retype_roots);
		// Unsafe-body index nodes: the generic body was checked AFTER this
		// clone was made (user code triggers monomorphization first), so the
		// checker's stamps (element type, array-target flag) are absent.
		// Re-derive them now that every type on the clone is concrete.
		restamp_index_nodes(retype_roots, mono_name);
		resolve_mono_equality_ops(cloned.statements, status);
		// Re-resolve plain free-function calls (see resolve_free_func_calls —
		// extern callees must emit through their `extern_<name>` adapter).
		resolve_free_func_calls(retype_roots, status);
		// Re-derive check-phase annotations on AccessFunctionCallNodes.
		// The mono body is cloned from the unchecked generic body and never
		// re-checked (cloned.checked = true below), so annotations the
		// checker normally sets — owned_return, mangled_name,
		// nullable_param_indices, variadic_param_index, return-contract
		// bounds, nursery.spawn recognition — are absent. This pass resolves
		// each call's receiver type by tracing the access chain (using the
		// concrete types set by the substitution passes above) and derives
		// the annotations from the resolved method's signature and contracts.
		rederive_access_func_annotations(retype_roots, status);
		cloned.checked = true;
		cloned_methods.push(cloned);
		mono_struct.functions.push(cloned);
	}

	// Second re-derivation sweep over the cloned method bodies. The loop
	// above builds the mono struct's method list incrementally, so a call to
	// a sibling method declared LATER in the generic (e.g. Map.get →
	// self.find_slot, which Map.nm declares after get/set/has) found no
	// target during the in-loop pass. With every method now cloned onto the
	// mono struct, re-run the pass so those calls derive their annotations
	// from the fully-substituted signatures. Idempotent: every annotation is
	// either guarded or a pure overwrite with the same value.
	for (const cloned of cloned_methods) {
		rederive_access_func_annotations(cloned.statements, status);
	}

	const init_return_type = new Type(generic_struct.name);
	init_return_type.type_args = flat_args.map((t) => {
		const copy = new Type(t.name, t.is_static, t.is_array, t.length);
		copy.is_ref = t.is_ref;
		copy.is_nullable = t.is_nullable;
		return copy;
	});

	const custom_inits = generic_struct.functions.filter((f) => f.name === "#init" && f.has_body);
	// A variadic-tuple #init (`...[TK, TV] pairs`) whose tuple contains a
	// CLASS/TRAIT element cannot be cloned for a reference-typed
	// instantiation: the pair materializes as a value struct with a
	// trait/class-typed field (rejected — byte-copy shares the reference),
	// and the body's borrowed pair element can't feed a `move TV` param (the
	// ownership chain breaks at the variadic boundary). Skip that init
	// (per-overload) so the remaining overloads still clone and
	// `Map<string, SomeTrait>()` + `set()` works fully; passing pairs is
	// rejected at the call site with targeted guidance (see
	// reject_variadic_pairs_on_reference_map).
	// The concrete type args are in scope here (flat_args) — check THOSE,
	// not the generic declaration's unresolved TK/TV params.
	const variadic_init_unsupported = (init: FunctionNode) =>
		init.params.some((p) => p.is_variadic && p.type.tuple_types?.length) &&
		flat_args.some(
			(arg) =>
				status.traits.some((tr) => tr.name === arg.name) ||
				status.structs.some((s) => s.name === arg.name && s.is_class),
		);
	// Only treat a custom #init as the monomorphized constructor when its
	// body is real Nomen code. A raw-`#arch`-only #init (e.g. Array<T>'s) is
	// a hand-written primitive that assumes a pointer `self` and is never
	// invoked through the normal constructor path — keep the old behaviour
	// of synthesizing a field-based #init for those. Every Nomen overload
	// clones so an overloaded constructor template instantiates all of its
	// signatures.
	let cloned_custom_init = false;
	for (const generic_init of custom_inits) {
		if (variadic_init_unsupported(generic_init)) continue;
		if (!generic_init.statements.some((s) => s.node_type !== "raw")) continue;
		// A generic struct with a custom #init (e.g. Map<K,V>'s variadic-tuple
		// constructor) is cloned + type-substituted + re-checked here, so its
		// variadic tuple param materializes against the concrete type args and
		// its body resolves self.method() against the monomorphized struct.
		const cloned = clone_node(generic_init) as FunctionNode;
		substitute_raw_types(cloned, substitution, status.structs, status.traits, status.enums);
		fold_substituted_constant_ifs(cloned.statements);
		rename_local_labels(cloned, mono_name);
		cloned.return_type = new Type(mono_name);
		cloned.type_params = [];
		for (const param of cloned.params) {
			param.type = substitute_type(param.type, substitution);
			substitute_param_signature(param, substitution);
			if (param.constraint) {
				substitute_raw_in_node(
					param.constraint,
					substitution,
					status.structs,
					undefined,
					status.traits,
					status.enums,
				);
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
		// recursing through monomorphize again. (Already pushed above, before
		// the method loop.)
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
			function_emission_names: status.function_emission_names,
			// Preserve the trusted-internal opt-in across the clone check.
			allow_internal: status.allow_internal,
			library_boundary: status.library_boundary,
		};
		check_function_node(cloned, root_status);
		cloned_custom_init = true;
	}
	if (!cloned_custom_init) {
		const init_params: ParameterNode[] = [];
		for (const field of mono_fields) {
			if (!field.value) {
				const param = new ParameterNode(field.start, field.name, field.type);
				// The synthesized init byte-copies each param into its field,
				// so a field whose (substituted) type is a class OR an owning
				// value struct (List<...>/Buffer/…/anything owning heap) must
				// take it by `move` — a plain by-value pass would leave the
				// field and the caller's variable co-owning the same storage
				// (double-free at scope exit). Mirrors
				// mark_owning_auto_init_params for non-generic structs.
				if (
					!field.type.is_nullable &&
					field.type.name &&
					(is_class_type(field.type.name, status) ||
						is_owning_struct_type_requiring_move(field.type, status))
				) {
					param.is_moved = true;
				} else if (field.declaration === "move") {
					param.declaration = "var";
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

	// The mono struct was registered in status.structs/types above, before
	// the method loop (so the re-derivation pass and custom #init re-check
	// could resolve self's type).

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
 * Whether a type (recursively through its type args) references an
 * unresolved type param of the enclosing generic context — e.g. the `T` in
 * `List<T>` inside `struct Outer<T>`. Such a type can't be monomorphized
 * yet; the enclosing generic's own monomorphization substitutes it later.
 */
function type_contains_unresolved_param(type: Type, status: CheckStatus): boolean {
	if (status.type_params.includes(type.name)) return true;
	return type.type_args?.some((t) => type_contains_unresolved_param(t, status)) ?? false;
}

/**
 * Flatten a nested generic type argument (`List<int>` inside
 * `Wrapper<List<int>>`) to a copy whose name is the inner instantiation's
 * monomorphized struct name (`List_int`), recursively materializing the
 * inner mono first. Non-generic args and args whose inner args are still
 * unresolved type params are returned unchanged.
 */
export function flatten_nested_generic_arg(t: Type, status: CheckStatus): Type {
	if (!t.type_args?.length) return t;
	const inner_generic = status.structs.findLast((s) => s.name === t.name && s.is_generic);
	if (!inner_generic || inner_generic.type_params.length !== t.type_args.length) return t;
	if (type_contains_unresolved_param(t, status)) return t;
	const inner_mono = monomorphize(inner_generic, t.type_args, status);
	if (!inner_mono) return t;
	const flat = new Type(inner_mono.name, t.is_static, t.is_array, t.length);
	flat.storage_kind = t.storage_kind;
	flat.is_ref = t.is_ref;
	flat.is_const_ref = t.is_const_ref;
	flat.is_nullable = t.is_nullable;
	return flat;
}

/**
 * Materialize the monomorphized form of a generic-struct type that carries
 * concrete type args (e.g. `List<string>` -> `List_string`), so the downstream
 * build/codegen can resolve it. A generic container that appears ONLY as a
 * parameter, return, or local-declaration type — with no `List<T>()`
 * construction site elsewhere — would otherwise never be monomorphized, and the
 * generated signature would reference a bare incomplete `struct List` instead
 * of `struct List_string` (clang then rejects `xs->length` on the incomplete
 * type). No-op for non-generic types, generics inside a generic context
 * (unresolved type params), and mismatched arg counts.
 */
export function instantiate_generic_type(type: Type, status: CheckStatus) {
	const args = type.type_args;
	if (args?.length) {
		const generic = status.structs.findLast((s) => s.name === type.name);
		if (generic?.is_generic) {
			if (generic.type_params.length !== args.length) return;
			// Recursive: a nested arg (`Wrapper<List<T>>` inside a generic) still
			// references T through the inner instantiation — defer the whole thing.
			if (args.some((t) => type_contains_unresolved_param(t, status))) return;
			monomorphize(generic, args, status);
			return;
		}
		// Generic enums (`Result<int, string>`): monomorphize and REWRITE the
		// annotation's name to the mono (`Result_int_string`), keeping
		// `type_args` for reference. Unlike structs (whose method resolution
		// goes through the bare name + args), enum shorthand resolution and
		// match typing key off `status.enums` by bare name, so the rewritten
		// name is what makes `.ok(5)`, `match`, and exhaustiveness resolve
		// against the concrete case payloads. Deferred when an arg still
		// references an unresolved type param (inside a generic context).
		const generic_enum = status.enums.findLast((e) => e.name === type.name);
		if (
			generic_enum?.is_generic &&
			generic_enum.type_params.length === args.length &&
			!args.some((t) => type_contains_unresolved_param(t, status))
		) {
			const mono = monomorphize_enum(generic_enum, args, status);
			if (mono) {
				// Rewrite the annotation to the mono name and CLEAR the type
				// args: build-side signature emission derives names via
				// `mono_type_name(name, args)`, so keeping args would produce
				// a doubled name (`Result_int_string_int_string`).
				type.name = mono.name;
				type.type_args = undefined;
			}
		}
		return;
	}
	// `Array<T>` (parse-rewritten to `{name: T, is_array: true, is_array_heap:
	// true}`): materialize the mono `Array_<elem>` struct so the build can
	// always lower it to `struct Array_<T>*` — no reliance on a `.with`/`.at`
	// call elsewhere having instantiated it (the old order-dependent gate). This
	// is the deterministic counterpart of the generic-struct instantiation above.
	if (type.is_array_heap) {
		const array_struct = status.structs.find((s) => s.name === "Array");
		if (array_struct?.is_generic) {
			monomorphize(array_struct, [new Type(type.name)], status);
		}
	}
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
				substitute_param_signature(param, substitution);
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
 * through the vtable. Used by synthesize_generic_trait_defaults and the
 * generic-struct monomorphization loop.
 */
function retype_self_references(nodes: BaseNode[], struct_name: string) {
	retype_value_nodes(nodes, (name) => (name === "self" ? new Type(struct_name) : undefined));
}

/**
 * Retype ValueNodes that reference a (non-self) parameter to that param's
 * type. A monomorphised method body is not re-checked, so its ValueNodes
 * carry no type for param uses; the builder reads ValueNode.type directly to
 * decide scalar-vs-struct arg passing, so without this a struct param (e.g.
 * `value: T` in List.push) is treated as a scalar and passed/stored wrong.
 */
function retype_param_references(nodes: BaseNode[], params: ParameterNode[]) {
	const map = new Map<string, Type>();
	for (const p of params) {
		if (p.name && !p.is_self_param && p.type?.name) map.set(p.name, p.type);
	}
	if (!map.size) return;
	retype_value_nodes(nodes, (name) => {
		const t = map.get(name);
		return t ? new Type(t.name, t.is_static, t.is_array, t.length) : undefined;
	});
}

/**
 * Retype ValueNodes that reference a LOCAL DECLARATION to that declaration's
 * (already-substituted) type. Mirrors retype_param_references: a
 * monomorphised method body is not re-checked, so a bare local reference
 * (e.g. `v` in `dst.push(v)` or `return dst` inside List<T>.copy) carries no
 * type; both backends read ValueNode.type to decide struct-vs-scalar argument
 * passing and return-ownership transfer, so an untyped local reference
 * mis-lowers (a struct arg passed by value instead of by address, a returned
 * owning struct destroyed after its sret copy). Only names declared as locals
 * in the body are retyped — globals and field names are untouched.
 */
function retype_local_references(nodes: BaseNode[]) {
	const map = new Map<string, Type>();
	for (const node of nodes) collect_local_decl_types(node, map);
	if (!map.size) return;
	retype_value_nodes(nodes, (name) => {
		const t = map.get(name);
		if (!t) return undefined;
		const copy = new Type(t.name, t.is_static, t.is_array, t.length);
		if (t.type_args) copy.type_args = t.type_args.map((a) => new Type(a.name));
		return copy;
	});
}

function collect_local_decl_types(node: BaseNode | undefined | null, map: Map<string, Type>) {
	if (!node) return;
	const any_node = node as any;
	if (node.node_type === "declare" && any_node.name && any_node.type?.name) {
		map.set(any_node.name, any_node.type);
	}
	if (any_node.statements && Array.isArray(any_node.statements)) {
		for (const child of any_node.statements) {
			if (child && typeof child === "object" && "node_type" in child) {
				collect_local_decl_types(child, map);
			}
		}
	}
	if (any_node.value?.node_type) collect_local_decl_types(any_node.value, map);
	if (any_node.left_value?.node_type) collect_local_decl_types(any_node.left_value, map);
	if (any_node.right_value?.node_type) collect_local_decl_types(any_node.right_value, map);
	if (any_node.target?.node_type) collect_local_decl_types(any_node.target, map);
	if (any_node.access?.node_type) collect_local_decl_types(any_node.access, map);
	if (any_node.condition?.node_type) collect_local_decl_types(any_node.condition, map);
	if (any_node.if_branch?.node_type) collect_local_decl_types(any_node.if_branch, map);
	if (any_node.else_branch?.node_type) collect_local_decl_types(any_node.else_branch, map);
	if (any_node.constraint?.node_type) collect_local_decl_types(any_node.constraint, map);
}

function retype_value_nodes(nodes: BaseNode[], resolver: (name: string) => Type | undefined) {
	for (const node of nodes) retype_value_in_node(node, resolver);
}

function retype_value_in_node(
	node: BaseNode | undefined | null,
	resolver: (name: string) => Type | undefined,
) {
	if (!node) return;
	const any_node = node as any;
	if (node.node_type === "value") {
		const t = resolver(any_node.value);
		if (t) any_node.type = t;
	}
	if (any_node.statements && Array.isArray(any_node.statements)) {
		for (const child of any_node.statements) {
			if (child && typeof child === "object" && "node_type" in child) {
				retype_value_in_node(child, resolver);
			}
		}
	}
	if (any_node.params && Array.isArray(any_node.params)) {
		for (const child of any_node.params) {
			if (child && typeof child === "object" && "node_type" in child) {
				retype_value_in_node(child, resolver);
			}
		}
	}
	if (any_node.cases && Array.isArray(any_node.cases)) {
		for (const c of any_node.cases) {
			if (c.branch?.statements) retype_value_in_node(c.branch, resolver);
			if (c.match_value) retype_value_in_node(c.match_value, resolver);
			if (c.condition) retype_value_in_node(c.condition, resolver);
		}
	}
	if (any_node.value?.node_type) retype_value_in_node(any_node.value, resolver);
	if (any_node.left_value?.node_type) retype_value_in_node(any_node.left_value, resolver);
	if (any_node.right_value?.node_type) retype_value_in_node(any_node.right_value, resolver);
	if (any_node.target?.node_type) retype_value_in_node(any_node.target, resolver);
	if (any_node.access?.node_type) retype_value_in_node(any_node.access, resolver);
	if (any_node.condition?.node_type) retype_value_in_node(any_node.condition, resolver);
	if (any_node.if_branch?.node_type) retype_value_in_node(any_node.if_branch, resolver);
	if (any_node.else_branch?.node_type) retype_value_in_node(any_node.else_branch, resolver);
	if (any_node.item?.node_type) retype_value_in_node(any_node.item, resolver);
	if (any_node.list?.node_type) retype_value_in_node(any_node.list, resolver);
	if (any_node.constraint?.node_type) retype_value_in_node(any_node.constraint, resolver);
	// Checker-hoisted call-argument temps ride on the call node itself
	// (`func_call.allocations`), not in the statements list — their value
	// trees carry the same generic types and must be retyped with the body.
	if (Array.isArray(any_node.allocations)) {
		for (const child of any_node.allocations) {
			if (child && typeof child === "object" && "node_type" in child) {
				retype_value_in_node(child, resolver);
			}
		}
	}
}

/**
 * Resolve `==`/`!=` operators on a monomorphised method body that were left
 * as builtin comparisons during the generic-body check (the operands were
 * type-parameter-typed, so the checker couldn't tell whether the concrete
 * type defines a custom `eq`/`ne`). After monomorphisation + retype_param_
 * references, the concrete operand types are known — so a `string == string`
 * inside `Map<string, _>` now dispatches to `string_eq` (strcmp) rather than
 * a pointer comparison. Primitive types (int, etc.) have no `eq`/`ne` and
 * correctly stay builtin.
 */
function resolve_mono_equality_ops(nodes: BaseNode[], status: CheckStatus) {
	for (const node of nodes) resolve_eq_ops_in_node(node, status);
}

function resolve_eq_ops_in_node(node: BaseNode | undefined | null, status: CheckStatus) {
	if (!node) return;
	const any_node = node as any;

	if (node.node_type === "op") {
		const op = node as OperationNode;
		if ((op.op === "==" || op.op === "!=") && !op.operator_func) {
			const left_name = operand_type_name(op.left_value);
			const right_name = operand_type_name(op.right_value);
			const type_name = status.structs.find((s) => s.name === left_name)
				? left_name
				: status.structs.find((s) => s.name === right_name)
					? right_name
					: "";
			if (type_name) {
				const struct = status.structs.find((s) => s.name === type_name);
				const target = op.op === "==" ? "eq" : "ne";
				const dual = op.op === "==" ? "ne" : "eq";
				let func = struct?.functions.find((f) => f.name === target);
				let invert = false;
				if (!func && struct) {
					func = struct.functions.find((f) => f.name === dual);
					invert = !!func;
				}
				if (func && struct) {
					op.operator_func = {
						struct_name: struct.name,
						func_name: func.name,
						invert,
					};
				}
			}
		}
	}

	if (any_node.statements && Array.isArray(any_node.statements)) {
		for (const child of any_node.statements) {
			if (child && typeof child === "object" && "node_type" in child) {
				resolve_eq_ops_in_node(child, status);
			}
		}
	}
	if (any_node.params && Array.isArray(any_node.params)) {
		for (const child of any_node.params) {
			if (child && typeof child === "object" && "node_type" in child) {
				resolve_eq_ops_in_node(child, status);
			}
		}
	}
	if (any_node.cases && Array.isArray(any_node.cases)) {
		for (const c of any_node.cases) {
			if (c.branch?.statements) resolve_eq_ops_in_node(c.branch, status);
			if (c.match_value) resolve_eq_ops_in_node(c.match_value, status);
			if (c.condition) resolve_eq_ops_in_node(c.condition, status);
		}
	}
	if (any_node.value?.node_type) resolve_eq_ops_in_node(any_node.value, status);
	if (any_node.left_value?.node_type) resolve_eq_ops_in_node(any_node.left_value, status);
	if (any_node.right_value?.node_type) resolve_eq_ops_in_node(any_node.right_value, status);
	if (any_node.target?.node_type) resolve_eq_ops_in_node(any_node.target, status);
	if (any_node.access?.node_type) resolve_eq_ops_in_node(any_node.access, status);
	if (any_node.condition?.node_type) resolve_eq_ops_in_node(any_node.condition, status);
	if (any_node.if_branch?.node_type) resolve_eq_ops_in_node(any_node.if_branch, status);
	if (any_node.else_branch?.node_type) resolve_eq_ops_in_node(any_node.else_branch, status);
	if (any_node.item?.node_type) resolve_eq_ops_in_node(any_node.item, status);
	if (any_node.list?.node_type) resolve_eq_ops_in_node(any_node.list, status);
	if (any_node.constraint?.node_type) resolve_eq_ops_in_node(any_node.constraint, status);
}

/** Best-effort type-name extraction from an operand value node. */
function operand_type_name(node: BaseNode | undefined | null): string {
	if (!node) return "";
	const any_node = node as any;
	if (node.node_type === "value") return any_node.type?.name || "";
	if (node.node_type === "access") return operand_type_name(any_node.access);
	if (node.node_type === "access_func") return any_node.type?.name || "";
	if (node.node_type === "access_field") return any_node.type?.name || "";
	if (node.node_type === "grouped") return operand_type_name(any_node.value);
	if (node.node_type === "cast") return any_node.target_type?.name || "";
	return any_node.type?.name || "";
}

/**
 * Resolve the concrete type name of an AST node that appears as the receiver
 * (target) of an access chain in a monomorphised method body. Traces through
 * ValueNodes (type set by retype_self_references / retype_param_references),
 * AccessNodes (field/function), and grouped nodes — using the mono struct
 * table to resolve field types that weren't set on the node itself (the body
 * is not re-checked, so AccessFieldNode.type is typically empty).
 */
function resolve_receiver_type_name(
	node: BaseNode | undefined | null,
	status: CheckStatus,
): string {
	if (!node) return "";
	const any_node = node as any;
	if (node.node_type === "value") return any_node.type?.name || "";
	if (node.node_type === "grouped") return resolve_receiver_type_name(any_node.value, status);
	if (node.node_type === "cast") return any_node.target_type?.name || "";
	if (node.node_type === "access_func") return any_node.type?.name || "";
	if (node.node_type === "access") {
		const target_type = resolve_receiver_type_name(any_node.target, status);
		if (!target_type) return any_node.access?.type?.name || "";
		if (any_node.access?.node_type === "access_field") {
			// Field type isn't on the node (unchecked body); look it up on
			// the resolved struct. Handles mono names (Buffer_string, etc.)
			// and generic-arg rewriting (Buffer<T> → Buffer_string).
			const field_name = any_node.access.name as string;
			const struct = status.structs.find((s) => s.name === target_type);
			const field = struct?.fields.find((f) => f.name === field_name);
			return field?.type?.name || any_node.access.type?.name || "";
		}
		return any_node.access?.type?.name || "";
	}
	return any_node.type?.name || "";
}

/**
 * Walk a monomorphised method body and re-derive check-phase annotations on
 * AccessFunctionCallNodes. The body is cloned from the (unchecked) generic
 * body, type-substituted, but never re-checked — so annotations that
 * check_access_node would normally set are absent. This pass resolves each
 * call's receiver type (by tracing the access chain through the concrete
 * types set by the substitution passes) and derives the annotations from the
 * resolved method's signature.
 *
 * Sets: owned_return, mangled_name, nullable_param_indices,
 * variadic_param_index, variadic_param_name, the call's result type (when
 * the generic-body check left it unset), return-contract annotations
 * (return_bounds / inferred_array_length, evaluated from the resolved
 * method's `out` contract with `self` and the params substituted by the
 * call-site expressions), and nursery.spawn recognition (is_nursery_spawn
 * / owned_return / function_return_type / Task<T> typing + Task<T>
 * monomorphization, mirroring check_nursery_spawn). Deliberately still
 * unset: skip_bounds_check (no constraint checking runs on mono bodies)
 * and is_statement (a build-phase decision).
 */
function rederive_access_func_annotations(nodes: BaseNode[], status: CheckStatus) {
	for (const node of nodes) rederive_annotations_in_node(node, status);
}

/**
 * Re-resolve PLAIN free-function calls (`calloc(...)`, `memset(...)`) in a
 * monomorphized clone. The generic body is checked AFTER the mono clone is
 * made (user code triggers monomorphization before the library struct's own
 * statement is reached), so the cloner copies an unresolved call — and the
 * build then emits the bare name instead of the callee's emission label
 * (fatal for `extern` callees, whose adapter lives under `extern_<name>`).
 * Method calls don't need this (rederive_access_func_annotations re-derives
 * them from the receiver type); only bare calls do.
 */
function resolve_free_func_calls(nodes: BaseNode[], status: CheckStatus) {
	for (const node of nodes) resolve_free_calls_in_node(node, status);
}

function resolve_free_calls_in_node(node: BaseNode | undefined | null, status: CheckStatus) {
	if (!node) return;
	const any_node = node as any;
	if (node.node_type === "func_call" && !any_node.resolved_function) {
		const name = (node as import("../nodes/FunctionCallNode.ts").default).name;
		// A monomorphised clone of the compiler-special Thread(fn(args))
		// constructor needs its annotations re-derived (the clone is never
		// re-checked) — mirrors the nursery.start rederivation.
		if (name === "Thread") {
			rederive_thread_ctor_annotations(
				node as import("../nodes/FunctionCallNode.ts").default,
				status,
			);
		}
		const func = find_free_function(status, name);
		if (func) set_resolved_function(node as import("../nodes/FunctionCallNode.ts").default, func);
	}
	if (any_node.statements && Array.isArray(any_node.statements)) {
		for (const child of any_node.statements) {
			if (child && typeof child === "object" && "node_type" in child) {
				resolve_free_calls_in_node(child, status);
			}
		}
	}
	if (any_node.params && Array.isArray(any_node.params)) {
		for (const child of any_node.params) {
			if (child && typeof child === "object" && "node_type" in child) {
				resolve_free_calls_in_node(child, status);
			}
		}
	}
	if (any_node.value?.node_type) resolve_free_calls_in_node(any_node.value, status);
	if (any_node.left_value?.node_type) resolve_free_calls_in_node(any_node.left_value, status);
	if (any_node.right_value?.node_type) resolve_free_calls_in_node(any_node.right_value, status);
	if (any_node.target?.node_type) resolve_free_calls_in_node(any_node.target, status);
	if (any_node.index?.node_type) resolve_free_calls_in_node(any_node.index, status);
	if (any_node.access?.node_type) resolve_free_calls_in_node(any_node.access, status);
	if (any_node.condition?.node_type) resolve_free_calls_in_node(any_node.condition, status);
	if (any_node.if_branch?.statements) {
		for (const child of any_node.if_branch.statements) resolve_free_calls_in_node(child, status);
	}
	if (any_node.else_branch?.statements) {
		for (const child of any_node.else_branch.statements) resolve_free_calls_in_node(child, status);
	}
	if (any_node.cases && Array.isArray(any_node.cases)) {
		for (const c of any_node.cases) {
			if (c?.branch?.statements) {
				for (const child of c.branch.statements) resolve_free_calls_in_node(child, status);
			}
			if (c?.match_value?.node_type) resolve_free_calls_in_node(c.match_value, status);
			if (c?.condition?.node_type) resolve_free_calls_in_node(c.condition, status);
		}
	}
}

function rederive_annotations_in_node(node: BaseNode | undefined | null, status: CheckStatus) {
	if (!node) return;
	const any_node = node as any;

	// An AccessFunctionCallNode is always the inner `access` of an
	// AccessNode: `target.access_func`. Derive annotations from the
	// resolved method on the target's type.
	if (node.node_type === "access" && any_node.access?.node_type === "access_func") {
		derive_annotations_for_access_func(any_node, any_node.access, status);
	}

	// Recurse into children (mirrors retype_value_in_node / resolve_eq_ops_in_node).
	if (any_node.statements && Array.isArray(any_node.statements)) {
		for (const child of any_node.statements) {
			if (child && typeof child === "object" && "node_type" in child) {
				rederive_annotations_in_node(child, status);
			}
		}
	}
	if (any_node.params && Array.isArray(any_node.params)) {
		for (const child of any_node.params) {
			if (child && typeof child === "object" && "node_type" in child) {
				rederive_annotations_in_node(child, status);
			}
		}
	}
	if (any_node.cases && Array.isArray(any_node.cases)) {
		for (const c of any_node.cases) {
			if (c.branch?.statements) {
				for (const s of c.branch.statements) rederive_annotations_in_node(s, status);
			}
			if (c.match_value) rederive_annotations_in_node(c.match_value, status);
			if (c.condition) rederive_annotations_in_node(c.condition, status);
		}
	}
	if (any_node.value?.node_type) rederive_annotations_in_node(any_node.value, status);
	if (any_node.left_value?.node_type) rederive_annotations_in_node(any_node.left_value, status);
	if (any_node.right_value?.node_type) rederive_annotations_in_node(any_node.right_value, status);
	if (any_node.target?.node_type) rederive_annotations_in_node(any_node.target, status);
	if (any_node.access?.node_type) rederive_annotations_in_node(any_node.access, status);
	if (any_node.condition?.node_type) rederive_annotations_in_node(any_node.condition, status);
	if (any_node.if_branch?.node_type) rederive_annotations_in_node(any_node.if_branch, status);
	if (any_node.else_branch?.node_type) rederive_annotations_in_node(any_node.else_branch, status);
	if (any_node.item?.node_type) rederive_annotations_in_node(any_node.item, status);
	if (any_node.list?.node_type) rederive_annotations_in_node(any_node.list, status);
	if (any_node.constraint?.node_type) rederive_annotations_in_node(any_node.constraint, status);
}

function derive_annotations_for_access_func(
	access_node: any,
	fc: AccessFunctionCallNode,
	status: CheckStatus,
) {
	const receiver_type = resolve_receiver_type_name(access_node.target, status);
	if (!receiver_type) return;
	// `name.start(Thread(fn(args)))` is compiler-special-cased
	// (check_access_node), not a regular method on Nursery — recognize it
	// before method resolution, which would otherwise find no `start`
	// function and bail.
	if (receiver_type === "Nursery" && fc.name === "start") {
		rederive_nursery_spawn_annotations(fc, status);
		return;
	}
	// `Thread(fn(args)).start()` is compiler-special-cased the same way —
	// there is no Thread struct, so method resolution would bail.
	if (receiver_type === "Thread" && fc.name === "start") {
		rederive_thread_start_annotations(access_node, fc, status);
		return;
	}
	const struct = status.structs.find((s) => s.name === receiver_type);
	if (!struct) return;
	const func = struct.functions.find((f) => f.name === fc.name);
	if (!func) return;

	// Derive the call's RESULT type when the generic-body check left it unset
	// (a type-parameter return like `out T` may never have been recorded).
	// The mono method's return type is already substituted, so this recovers
	// e.g. `Person` for `self.at(i)` inside List_Person.copy — the build's
	// declaration/call paths read it to decide sret setup for struct results.
	if (!fc.type?.name && func.return_type?.name) {
		const rt = new Type(func.return_type.name, func.return_type.is_static);
		rt.is_array = func.return_type.is_array;
		fc.type = rt;
	}

	if (func.returns_move) {
		fc.owned_return = true;
	}
	if (is_overloaded(struct, fc.name)) {
		fc.mangled_name = mangled_label(func, struct.name);
	}

	// variadic_param_index / variadic_param_name
	const variadic_param_idx = func.params.findIndex((p) => p.is_variadic);
	if (variadic_param_idx >= 0) {
		fc.variadic_param_name = func.params[variadic_param_idx].name;
		// The self param offset: variadic_param_index in the call's args is
		// the variadic param's position minus the self offset (if any).
		const self_offset = func.params.findIndex((p) => p.is_self_param);
		fc.variadic_param_index = variadic_param_idx - (self_offset >= 0 ? self_offset + 1 : 0);
	}

	// nullable_param_indices: which call args correspond to nullable struct
	// value params (T? where T is a non-class struct).
	const self_offset = func.params.findIndex((p) => p.is_self_param);
	const nullable_indices: number[] = [];
	for (let i = 0; i < func.params.length; i++) {
		const p = func.params[i];
		if (p.is_self_param) continue;
		if (!p.type?.is_nullable) continue;
		if (status.structs.find((s) => s.name === p.type.name && !s.is_class)) {
			// Map callee param index to call arg index (skip self).
			nullable_indices.push(i - (self_offset >= 0 ? self_offset + 1 : 0));
		}
	}
	if (nullable_indices.length > 0) {
		fc.nullable_param_indices = nullable_indices;
	}

	// Return-contract evaluation: substitute `out`, `self`, and the callee's
	// param names with the call-site expressions and collect the resulting
	// bounds onto the node — mirroring check_function_call's return_bounds /
	// inferred_array_length derivation, which is unreachable for a
	// never-re-checked mono body. An enclosing body (e.g. a custom #init
	// clone, the one mono body that IS re-checked) can then verify parameter
	// constraints against this call's result, and a literal `out.length == N`
	// clause feeds the result type's `.length` stamping below.
	if (func.return_constraint && !fc.return_bounds) {
		const param_to_arg = new Map<string, BaseNode>();
		// Map `self` onto the receiver expression so contracts referencing
		// self.X (e.g. `out < self.count`) resolve against the receiver path
		// (check_function_call maps it to path_to_node(self_path) — the same
		// expression reconstructed; passing the actual node is equivalent
		// and avoids re-deriving the path string).
		param_to_arg.set("self", access_node.target);
		for (let i = 0; i < fc.params.length; i++) {
			const fp = func.params[i + (self_offset >= 0 ? self_offset + 1 : 0)];
			if (fp?.name) {
				param_to_arg.set(fp.name, fc.params[i]);
			}
		}
		const substituted = substitute_constraint(func.return_constraint, "_return", param_to_arg);
		fc.return_bounds = collect_return_bounds(substituted, status);
		const ret_len = collect_return_length(substituted);
		if (ret_len !== undefined && fc.inferred_array_length === undefined) {
			fc.inferred_array_length = ret_len;
			// Mirror check_access_node's post-check stamping: carry the
			// literal length onto the result type so the build's inline
			// literal-length paths fire. Clone first — fc.type may alias the
			// mono method's shared return_type.
			if (fc.type?.is_array) {
				const t = fc.type;
				const clone = new Type(t.name, t.is_static, t.is_array, t.length);
				clone.is_ref = t.is_ref;
				clone.type_args = t.type_args;
				clone.length = new ValueNode(-1, ret_len, new Type("int"));
				fc.type = clone;
			}
		}
	}
}

/**
 * Re-derive the annotations for a `name.spawn(fn(args))` call inside a
 * monomorphised body — mirroring check_nursery_spawn (check_access_node),
 * which is unreachable here because the mono body is never re-checked. The
 * build gates its spawn-trampoline emission on is_nursery_spawn (without it
 * the call falls through to method resolution, which finds no `spawn`) and
 * the declaration-ownership analysis on owned_return (the Task a spawn
 * yields is a fresh heap allocation). Also types the call as Task<T>,
 * records function_return_type for the trampoline's result capture, and
 * triggers Task<T> monomorphization so the struct body is emitted.
 */
/**
 * Check the compiler-special `Thread(fn(args))` constructor. Resolves the
 * wrapped call (function resolution, argument types, return type) and stamps
 * the construction with type `Thread` plus the wrapped function's return
 * type. Sendable validation and Task<T> stamping happen at the consumers:
 * `.start()` (check_access_node.check_thread_start) or a nursery's
 * `.start(Thread(fn(args)))` (check_nursery_spawn). A `Thread` construction
 * that is never consumed is inert — nothing is spawned; see FOLLOWUP.md.
 */
function check_thread_ctor(node: FunctionCallNode, status: CheckStatus): boolean {
	const call = node.params[0] as FunctionCallNode;
	if (!check_function_call_node(call, status)) {
		add_error(status, `Spawned call '${call.name}' did not resolve`, node.start);
		return false;
	}
	node.is_thread_ctor = true;
	node.function_return_type = call.type;
	node.type = new Type("Thread");
	return true;
}

/**
 * Re-derive the check annotations for a `Thread(fn(args))` constructor inside a
 * monomorphised body. The mono body is cloned from the unchecked generic body
 * and never re-checked, so the clone's constructor lacks is_thread_ctor / the
 * wrapped return type. Mirrors check_thread_ctor without re-running call
 * resolution (resolve_free_calls_in_node has stamped the wrapped call).
 */
function rederive_thread_ctor_annotations(fc: FunctionCallNode, status: CheckStatus) {
	if (fc.is_thread_ctor) return;
	if (fc.params.length !== 1 || fc.params[0].node_type !== "func_call") return;
	const call = fc.params[0] as FunctionCallNode;
	let return_type = call.type;
	if (!return_type?.name) {
		const func = find_free_function(status, call.name);
		if (func) {
			return_type = func.return_type;
			call.type = func.return_type;
		}
	}
	fc.is_thread_ctor = true;
	fc.function_return_type = return_type;
	if (!fc.type?.name) {
		fc.type = new Type("Thread");
	}
}

function rederive_nursery_spawn_annotations(fc: AccessFunctionCallNode, status: CheckStatus) {
	fc.is_nursery_spawn = true;
	fc.owned_return = true;
	if (fc.params.length !== 1 || fc.params[0].node_type !== "func_call") return;
	// New syntax: the parameter is the compiler-special Thread(fn(args))
	// constructor — unwrap it to the wrapped call.
	const ctor = fc.params[0] as FunctionCallNode;
	rederive_thread_ctor_annotations(ctor, status);
	if (!ctor.is_thread_ctor) return;
	const call = ctor.params[0] as FunctionCallNode;
	// The spawned function's return type: reuse the inner call's type when
	// the clone already carried it (source body was checked before cloning),
	// else resolve it from the function table (free functions carry their
	// declared return type regardless of check order).
	let return_type = call.type;
	if (!return_type?.name) {
		const func = find_free_function(status, call.name);
		if (func) {
			return_type = func.return_type;
			call.type = func.return_type;
		}
	}
	fc.function_return_type = return_type;
	const result_type_arg =
		return_type && return_type.name && return_type.name !== "void" && return_type.name !== "?"
			? new Type(return_type.name)
			: new Type("uint64");
	if (!fc.type?.name) {
		const task_type = new Type("Task");
		task_type.type_args = [result_type_arg];
		fc.type = task_type;
	}
	const task_struct = status.structs.find((s) => s.name === "Task");
	if (task_struct && task_struct.type_params.length > 0) {
		monomorphize(task_struct, [result_type_arg], status);
	}
}

/**
 * Re-derive the annotations for a `Thread(fn(args)).start()` call inside a
 * monomorphised body — mirroring check_thread_start (check_access_node).
 * The build gates its spawn-trampoline emission on is_thread_start (without
 * it the call falls through to method resolution, which finds no `start`)
 * and the declaration-ownership analysis on owned_return (the Task a spawn
 * yields is a fresh heap allocation, not a borrow).
 */
function rederive_thread_start_annotations(
	access_node: any,
	fc: AccessFunctionCallNode,
	status: CheckStatus,
) {
	// The Thread(fn(args)) constructor is the AccessNode's target; the
	// rederive walk visits it first (rederive_annotations_in_node recurses
	// into .target), so its annotations are already re-derived here.
	const ctor = access_node?.target as FunctionCallNode | undefined;
	if (!ctor || ctor.node_type !== "func_call" || !ctor.is_thread_ctor) return;
	fc.is_thread_start = true;
	fc.owned_return = true;
	const call = ctor.params[0] as FunctionCallNode;
	let return_type = ctor.function_return_type ?? call.type;
	if (!return_type?.name) {
		const func = find_free_function(status, call.name);
		if (func) return_type = func.return_type;
	}
	fc.function_return_type = return_type;
	const result_type_arg =
		return_type && return_type.name && return_type.name !== "void" && return_type.name !== "?"
			? new Type(return_type.name)
			: new Type("uint64");
	if (!fc.type?.name) {
		const task_type = new Type("Task");
		task_type.type_args = [result_type_arg];
		fc.type = task_type;
	}
	const task_struct = status.structs.find((s) => s.name === "Task");
	if (task_struct && task_struct.type_params.length > 0) {
		monomorphize(task_struct, [result_type_arg], status);
	}
}

/**
 * Substitute type-param names through a function-typed parameter's nested
 * signature (`func (T, out T)` on a generic struct method or generic free
 * function). The signature hangs off the ParameterNode itself (`func_params`
 * / `func_return_type`), which the per-param `substitute_type(param.type)`
 * loops never visit — without this, the monomorphized clone keeps the bare
 * `T` and the C backend emits an unresolved type in the function-pointer
 * signature (`T (*f)(T)`).
 */
function substitute_param_signature(param: ParameterNode, substitution: Map<string, string>): void {
	param.type = substitute_type(param.type, substitution);
	param.func_params = substitute_func_params(param.func_params, substitution);
	param.func_return_type = param.func_return_type
		? substitute_type(param.func_return_type, substitution)
		: undefined;
}

function substitute_func_params(
	params: ParameterNode[] | undefined,
	substitution: Map<string, string>,
): ParameterNode[] | undefined {
	return params?.map((p) => {
		const copy = clone_node(p) as ParameterNode;
		substitute_param_signature(copy, substitution);
		return copy;
	});
}

export function substitute_type(type: Type, substitution: Map<string, string>): Type {
	const resolved_name = substitution.get(type.name) || type.name;
	const new_type = new Type(resolved_name, type.is_static, type.is_array, type.length);
	new_type.is_ref = type.is_ref;
	new_type.is_view = type.is_view;
	new_type.is_const_ref = type.is_const_ref;
	new_type.is_pointer = type.is_pointer;
	new_type.is_nullable = type.is_nullable;
	if (resolved_name !== type.name) {
		new_type.type_args = undefined;
	} else {
		new_type.type_args = type.type_args?.map((t) => substitute_type(t, substitution));
	}
	new_type.func_params = substitute_func_params(type.func_params, substitution);
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

/**
 * A type annotation naming a GENERIC ENUM with concrete type args (e.g.
 * `Option<T>` inside a generic body, after substitution → `Option<string>`):
 * materialize the monomorphized enum and rename the type to it. Bodies are
 * not re-checked after monomorphization, so without this the clone keeps the
 * bare template name and the backends emit `Option` (an unknown C symbol) or
 * lower case payloads with the unresolved param type (a missed owned-string
 * dup, then an invalid free at scope exit).
 */
function materialize_generic_enum_type(type: Type, status: CheckStatus): Type {
	if (!type?.name || !type.type_args?.length) return type;
	const generic_enum = status.enums.find((e) => e.name === type.name && e.is_generic);
	if (!generic_enum || generic_enum.type_params.length !== type.type_args.length) return type;
	if (type.type_args.some((t) => !t.name || generic_enum.type_params.includes(t.name))) {
		return type;
	}
	const mono = monomorphize_enum(generic_enum, type.type_args, status);
	if (!mono) return type;
	const out = new Type(mono.name, type.is_static, type.is_array, type.length);
	out.is_ref = type.is_ref;
	out.is_view = type.is_view;
	out.is_const_ref = type.is_const_ref;
	out.is_pointer = type.is_pointer;
	out.is_nullable = type.is_nullable;
	out.type_args = undefined;
	return out;
}

/**
 * Sweep a monomorphized body and repoint every generic-enum mention at its
 * materialized mono: type annotations (`var Option<T> none = ...`) and bare
 * enum-name references (`Option<T>.some(...)` — the checker deferred the case
 * construction because T was unresolved). Runs after substitute_node_types,
 * which renames type args but leaves the generic enum's own name alone.
 */
function materialize_mono_enum_types(
	statements: BaseNode[],
	substitution: Map<string, string>,
	status: CheckStatus,
) {
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (key === "parent" || key === "scope") continue;
			const v = record[key];
			if (v instanceof Type) {
				record[key] = materialize_generic_enum_type(v as Type, status);
			} else if (Array.isArray(v)) {
				for (let i = 0; i < v.length; i++) {
					const item = v[i];
					if (item instanceof Type) {
						v[i] = materialize_generic_enum_type(item as Type, status);
					} else {
						visit(item);
					}
				}
			} else if (v && typeof v === "object" && !(v instanceof Type)) {
				visit(v);
			}
		}
		const value_node = node as unknown as {
			node_type?: string;
			value?: string;
			type?: Type;
			type_args?: Type[];
		};
		if (value_node.node_type === "value" && value_node.value && status) {
			// A generic-enum NAME reference (`Option<T>.some(...)`): the enum
			// name sits in .value, with type args either on the node or on
			// .type. The checker deferred the case construction (T was
			// unresolved) and may have left .type.name empty, so look the enum
			// up by the value's name directly. The type args may also be
			// unsubstituted ([T]) — substitute_node_types only rewrites .type —
			// so substitute them here before materializing.
			const type_args = value_node.type_args ?? value_node.type?.type_args;
			const generic_enum = type_args
				? status.enums.find((e) => e.name === value_node.value && e.is_generic)
				: undefined;
			if (generic_enum && generic_enum.type_params.length === type_args!.length) {
				const concrete = type_args!.map((t) => substitute_type(t, substitution));
				const all_concrete = concrete.every(
					(t) => t.name && !generic_enum.type_params.includes(t.name),
				);
				if (all_concrete) {
					const base =
						value_node.type?.name === value_node.value
							? value_node.type
							: new Type(value_node.value);
					base.type_args = concrete;
					const materialized = materialize_generic_enum_type(base, status);
					if (materialized !== base) {
						value_node.type = materialized;
						value_node.value = materialized.name;
						value_node.type_args = undefined;
					}
				}
			}
		}
	};
	for (const stmt of statements) visit(stmt);
}

/**
 * After the monomorphizer substituted `T_NEEDS_STRDUP`/`T_FAT` with literal
 * `true`/`false`, delete the dead arm of every `if` they guard. The generic
 * body could not type-check both arms (a representation-specific arm touches
 * fields only `string` elements have, e.g. `.ptr`), so the checker skips
 * those arms; folding here means the surviving arm is the only thing the
 * re-derivation passes and both backends ever see.
 */
function fold_substituted_constant_ifs(statements: BaseNode[]) {
	for (let i = statements.length - 1; i >= 0; i--) {
		const stmt = statements[i];
		// An `unsafe { ... }` wrapper (the library convention: unsafe-ness is
		// an implementation detail, so bodies nest the constant-if inside the
		// block) — fold inside its statement list in place.
		if (stmt.node_type === "unsafe") {
			fold_substituted_constant_ifs(
				(stmt as import("../nodes/UnsafeBlockNode.ts").default).statements,
			);
			continue;
		}
		if (stmt.node_type !== "if") continue;
		const if_else = stmt as import("../nodes/IfElseNode.ts").default;
		if (if_else.if_branch) fold_substituted_constant_ifs(if_else.if_branch.statements);
		if (if_else.else_branch) fold_substituted_constant_ifs(if_else.else_branch.statements);
		const cond = if_else.condition;
		if (cond?.node_type !== "value") continue;
		const v = (cond as ValueNode).value;
		if (v !== "true" && v !== "false") continue;
		const keep = v === "true" ? if_else.if_branch : if_else.else_branch;
		const kept: BaseNode[] = keep ? [...keep.statements] : [];
		// Preserve any allocations the checker hoisted onto the if node.
		if (if_else.allocations?.length) {
			const target = kept[0];
			if (target) {
				target.allocations ??= [];
				target.allocations.push(...if_else.allocations);
			}
		}
		statements.splice(i, 1, ...kept);
	}
}

function substitute_raw_types(
	func: FunctionNode,
	substitution: Map<string, string>,
	structs: StructNode[],
	traits: { name: string }[],
	enums: {
		name: string;
		has_associated_data?: boolean;
		is_generic?: boolean;
		cases: { params: { type: { name: string } }[] }[];
	}[],
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
		substitute_raw_in_node(stmt, substitution, structs, deref_params, traits, enums);
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

function raw_type_alignment(name: string): number {
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
	return 8;
}

function raw_align_to(offset: number, alignment: number): number {
	return Math.ceil(offset / alignment) * alignment;
}

function raw_type_size(
	name: string,
	structs: StructNode[],
	enums?: {
		name: string;
		has_associated_data?: boolean;
		is_generic?: boolean;
		cases: { params: { type: { name: string } }[] }[];
	}[],
): number {
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
	// A concrete enum-with-data is `tag word + max case payload`, tail-padded
	// to 8 — byte-for-byte get_enum_size in build_aarch64/utils/struct_layout.ts.
	// A raw T-generic slab stride (`mov x3, #T_SIZE`) must agree with the real
	// element layout, or every slot past the first is misaligned. Simple enums
	// (no associated data) are a single tag word (8).
	const enum_node = enums?.find((e) => e.name === name && !e.is_generic);
	if (enum_node) {
		if (!enum_node.has_associated_data) return 8;
		let max_payload = 0;
		for (const c of enum_node.cases) {
			let case_size = 0;
			for (const p of c.params) case_size += raw_type_size(p.type.name, structs, enums);
			max_payload = Math.max(max_payload, case_size);
		}
		return 8 + Math.ceil(max_payload / 8) * 8;
	}
	// User-defined value struct: VT_SIZE prefix (8), each field aligned to
	// its natural width (a nullable struct field carries an extra 8-byte
	// `_has` flag), tail-padded to 8 — byte-for-byte the aarch64 layout in
	// build_aarch64/utils/struct_layout.ts (get_struct_size). A mismatch
	// desynchronizes slab strides (mov x3, #T_SIZE) from the real element
	// layout, so every element past the first reads misaligned garbage.
	// Classes are always 8 (a heap pointer); `string` is the fat 16-byte
	// { char* ptr; long len; } value (aarch64 slot layout agrees — see
	// aarch64_size.ts); other simple types are 8 (word-aligned).
	const struct = structs.find((s) => s.name === name);
	if (name === "string") return 16;
	if (!struct || struct.is_simple_type || struct.is_class) return 8;
	let size = 8;
	for (const field of struct.fields) {
		size = raw_align_to(size, raw_type_alignment(field.type.name));
		// A `view T` field is the universal 16-byte (ptr, len) pair,
		// regardless of its element type (matches get_type_size in
		// build_aarch64/utils/struct_layout.ts and C's sizeof(nomen_view)).
		if (field.type.is_view) {
			size += 16;
			continue;
		}
		size += raw_type_size(field.type.name, structs, enums);
		if (
			field.type.is_nullable &&
			structs.find((s) => s.name === field.type.name && !s.is_simple_type && !s.is_class)
		) {
			size += 8;
		}
	}
	return raw_align_to(size, 8);
}

/**
 * Map an Nomen type name to its C representation for substitution inside raw C
 * blocks. Delegates to the shared type table (built_in_types.ts c_type column)
 * — the SAME source build_c/utils/c_type.ts uses for declarations and struct
 * fields — so a raw body's view of `T` always agrees with the emitted layout
 * (e.g. Nomen floats lower to C `double`, matching their 8-byte storage; they
 * historically drifted to 4-byte `float` here). `string` expands to the fat
 * nomen_string value — a raw T-generic body (Buffer_<T>/Array_<T> slots) then
 * gets 16-byte struct slots and `sizeof(T)` slab strides. Every raw body sees
 * the same fat value (there is no thin ABI): a C `char*` there is an explicit
 * `.ptr` (see docs/MEMORY.md).
 */
function raw_c_type_name(name: string): string {
	if (name === "string") return "nomen_string";
	return get_built_in_type(name)?.c_type ?? name;
}

/**
 * Whether a raw block's content is pure aarch64 assembly (`#arch: aarch64`).
 * asm immediates (`mov x3, #T_SIZE`) need the compiler's numeric layout
 * size; every other target (`#arch: c`, `aarch64_use_c`, or untagged) is C
 * source, where the size must be `sizeof(T)` — C lays out structs with
 * natural alignment (tail padding), so the compiler's unpadded numeric size
 * would disagree with C's own `sizeof`/pointer-arithmetic strides and
 * undersize heap slabs (heap-buffer-overflow on wide-struct elements).
 */
function raw_block_is_pure_asm(value: string): boolean {
	for (const line of value.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith("#arch:")) {
			const arches = trimmed
				.substring(6)
				.split(",")
				.map((a) => a.trim())
				.filter((a) => a.length > 0);
			return arches.length > 0 && arches.every((a) => a === "aarch64");
		}
		if (trimmed.startsWith("#platform:") || trimmed.startsWith("#scope:")) continue;
		break;
	}
	return false;
}

function is_reference_type_arg(
	t: Type,
	structs: StructNode[],
	traits: { name: string }[],
): boolean {
	return (
		!!traits.some((tr) => tr.name === t.name) ||
		!!structs.find((s) => s.name === t.name && s.is_class)
	);
}

function substitute_raw_in_node(
	node: BaseNode,
	substitution: Map<string, string>,
	structs: StructNode[],
	deref_params: Set<string> = new Set(),
	traits: { name: string }[] = [],
	enums: {
		name: string;
		has_associated_data?: boolean;
		is_generic?: boolean;
		cases: { params: { type: { name: string } }[] }[];
	}[] = [],
) {
	// `unsafe` Nomen bodies use the same per-instantiation constants the raw
	// blocks do — `T_SIZE` (element byte size), `T_NEEDS_STRDUP`/`T_FAT`
	// (string representation flags). In a Nomen body they are ValueNodes, so
	// substitute them with real literals (numeric / true / false); a follow-up
	// pass (fold_substituted_constant_ifs) then deletes the dead arm of any
	// `if` they guard, which is how the generic body could type-check only
	// the representation-independent statements.
	if (node.node_type === "value") {
		const vn = node as ValueNode;
		for (const [param, type] of substitution) {
			if (vn.value === `${param}_SIZE`) {
				vn.value = String(raw_type_size(type, structs, enums));
				vn.type = new Type("int", true);
				return;
			}
			if (vn.value === `${param}_NEEDS_STRDUP` || vn.value === `${param}_FAT`) {
				vn.value = type === "string" ? "true" : "false";
				vn.type = new Type("bool", true);
				return;
			}
		}
	}
	if (node.node_type === "index") {
		const idx = node as import("../nodes/IndexNode.ts").default;
		if (idx.type) idx.type = substitute_type(idx.type, substitution);
	}
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
			// Also substitute T_SIZE placeholder with element byte size.
			// Numeric only for pure-asm blocks; C blocks get sizeof(T) so
			// slab sizing agrees with C struct layout (tail padding).
			const size = raw_type_size(type, structs, enums);
			const size_expr = raw_block_is_pure_asm(value) ? String(size) : `sizeof(${c_type_name})`;
			value = value.replace(new RegExp(`\\b${param}_SIZE\\b`, "g"), size_expr);
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
			// T_FAT: 1 when T is `string` (the fat 16-byte {ptr, len} value),
			// 0 otherwise. Raw bodies use it to guard representation-specific
			// code paths — in C via `#if T_FAT` (the preprocessor removes the
			// branch before parsing, so the text may reference T's fat fields
			// even when they wouldn't compile for scalar T), and in pure-asm
			// blocks via a `mov xN, #T_FAT / cmp / b.cond` dispatch that
			// fold_asm_constants folds to a constant branch after substitution.
			value = value.replace(new RegExp(`\\b${param}_FAT\\b`, "g"), type === "string" ? "1" : "0");
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
		// Pure-asm blocks now have literal T_SIZE/T names: fold the runtime
		// width dispatches they were written with (cmp/b.eq chains against a
		// constant `mov xN, #T_SIZE`) and power-of-two stride multiplies
		// (madd/mul → lsl). C-source blocks are left alone — the C compiler
		// folds them itself.
		if (raw_block_is_pure_asm(value)) {
			value = fold_asm_constants(value);
		}
		raw.value = value;
		return;
	}
	// Substitute type arguments on call nodes (e.g. `Buffer<TK>()` inside a
	// generic method) and rewrite a func_call constructor's name to its
	// monomorphized symbol so the build keys `_init` correctly.
	const any_node = node as any;
	// Reference-typed element routing: a `Buffer<T>` whose (substituted) type
	// arg resolves to a CLASS or TRAIT must lower as `ClassBuffer<T>` — the
	// field-level rewrite in monomorphize does this for struct FIELDS, but a
	// constructor call inside a generic BODY (e.g. Map.rehash's
	// `swap Buffer<TV>()`) only passes through here. Without the swap, the
	// name still reads `Buffer_Animal` while the field is `ClassBuffer_Animal`
	// — mismatched types, undeclared functions.
	const route_reference_elem = (base: string, args: Type[]): string =>
		base === "Buffer" && args.length === 1 && is_reference_type_arg(args[0], structs, traits)
			? "ClassBuffer"
			: base;
	if (node.node_type === "func_call" && any_node.type_args?.length) {
		const old_args = any_node.type_args as Type[];
		any_node.type_args = old_args.map((t: Type) => substitute_type(t, substitution));
		// Strip a mono suffix the check phase may already have appended to
		// the name: a constructor call with CONCRETE args inside a generic
		// body (e.g. `List<int>()` in `Wrapper<T>`) is monomorphized and
		// renamed to `List_int` at check time while keeping its type_args —
		// re-appending without stripping would double the suffix
		// (`List_int_int`).
		const old_suffix = "_" + old_args.map((t) => mono_type_name(t)).join("_");
		const base_name = any_node.name.endsWith(old_suffix)
			? any_node.name.slice(0, any_node.name.length - old_suffix.length)
			: any_node.name;
		any_node.name = mono_type_name(
			route_reference_elem(base_name, any_node.type_args),
			any_node.type_args,
		);
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
		// Route Buffer<X> -> ClassBuffer<X> when X is a class/trait, matching
		// the field rewrite (e.g. Map.rehash's `var Buffer<TV> old_values`).
		if (
			any_node.type.name === "Buffer" &&
			any_node.type.type_args?.length === 1 &&
			is_reference_type_arg(any_node.type.type_args[0] as Type, structs, traits)
		) {
			any_node.type.name = "ClassBuffer";
		}
		if (any_node.func_return_type?.name) {
			any_node.func_return_type = substitute_type(any_node.func_return_type, substitution);
		}
	}
	// Recursively walk common container nodes
	if (any_node.allocations && Array.isArray(any_node.allocations)) {
		for (const child of any_node.allocations) {
			if (child && typeof child === "object" && "node_type" in child) {
				substitute_raw_in_node(child, substitution, structs, deref_params, traits, enums);
			}
		}
	}
	if (any_node.statements && Array.isArray(any_node.statements)) {
		for (const child of any_node.statements) {
			if (child && typeof child === "object" && "node_type" in child) {
				substitute_raw_in_node(child, substitution, structs, deref_params, traits, enums);
			}
		}
	}
	if (any_node.params && Array.isArray(any_node.params)) {
		for (const child of any_node.params) {
			if (child && typeof child === "object" && "node_type" in child) {
				substitute_raw_in_node(child, substitution, structs, deref_params, traits, enums);
			}
		}
	}
	if (any_node.value && any_node.value.node_type) {
		substitute_raw_in_node(any_node.value, substitution, structs, deref_params, traits, enums);
	}
	if (any_node.left_value?.node_type) {
		substitute_raw_in_node(any_node.left_value, substitution, structs, deref_params, traits, enums);
	}
	if (any_node.right_value?.node_type) {
		substitute_raw_in_node(
			any_node.right_value,
			substitution,
			structs,
			deref_params,
			traits,
			enums,
		);
	}
	if (any_node.target?.node_type) {
		substitute_raw_in_node(any_node.target, substitution, structs, deref_params, traits, enums);
	}
	if (any_node.access?.node_type) {
		substitute_raw_in_node(any_node.access, substitution, structs, deref_params, traits, enums);
	}
	if (any_node.swap?.node_type) {
		substitute_raw_in_node(any_node.swap, substitution, structs, deref_params, traits, enums);
	}
	if (any_node.condition?.node_type) {
		substitute_raw_in_node(any_node.condition, substitution, structs, deref_params, traits, enums);
	}
	if (any_node.index?.node_type) {
		substitute_raw_in_node(any_node.index, substitution, structs, deref_params, traits, enums);
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
			// A nested generic arg type (`Wrapper<List<int>>` passed to a
			// param of `Wrapper<W>`) flattens to the inner mono name so the
			// name-only substitution stays concrete (`W` -> `List_int`, not
			// the bare generic `List`).
			type_args_for_struct = arg_type.type_args.map((t) => flatten_nested_generic_arg(t, status));
			for (let j = 0; j < generic_struct.type_params.length; j++) {
				if (j < type_args_for_struct.length) {
					substitution.set(generic_struct.type_params[j], type_args_for_struct[j].name);
				}
			}
			if (param.type.type_args?.length) {
				for (let j = 0; j < param.type.type_args.length; j++) {
					if (j < type_args_for_struct.length) {
						substitution.set(param.type.type_args[j].name, type_args_for_struct[j].name);
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
		const mono_name = mono_type_name(generic_struct.name, type_args_for_struct);
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
		substitute_param_signature(param, substitution);
	}
	if (cloned.return_type.name) {
		cloned.return_type = substitute_type(cloned.return_type, substitution);
	}

	if (generic_func.type_params.length > 0) {
		substitute_body_types(cloned.statements, substitution);
		materialize_mono_enum_types(cloned.statements, substitution, status);
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
		function_emission_names: status.function_emission_names,
		// Trusted-internal opt-in must survive monomorphization: a generic
		// user function's cloned body is checked here with a fresh status.
		allow_internal: status.allow_internal,
		library_boundary: status.library_boundary,
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
	const init =
		// Prefer the variadic-tuple overload — the inference reads its tuple
		// element types; with a single #init this is the same function.
		struct.functions.find(
			(f) => f.name === "#init" && f.has_body && f.params.some((p) => p.is_variadic),
		) ?? struct.functions.find((f) => f.name === "#init" && f.has_body);
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

export function validate_field_overrides(
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
		validated.push({
			name: override.name,
			value: override.value,
			type: field.type,
		});
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
	status?: CheckStatus,
) {
	if (!node) return;

	switch (node.node_type) {
		case "declare": {
			const n = node as import("../nodes/DeclarationNode.ts").default;
			n.type = substitute_type(n.type, substitution);
			if (status) n.type = materialize_generic_enum_type(n.type, status);
			if (n.value) substitute_node_types(n.value, substitution, status);
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
			// Hoisted-argument temps attached to the call (n.allocations) are
			// declarations too — substitute their types with the body.
			if (Array.isArray(n.allocations)) {
				for (const alloc of n.allocations) substitute_node_types(alloc, substitution, status);
			}
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
		case "index": {
			const n = node as import("../nodes/IndexNode.ts").default;
			substitute_node_types(n.target, substitution);
			substitute_node_types(n.index, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "unsafe": {
			const n = node as import("../nodes/UnsafeBlockNode.ts").default;
			substitute_body_types(n.statements, substitution);
			break;
		}
		case "value": {
			// ValueNode.type carries the resolved type from checking (e.g. `T`
			// for a generic param use). The builder reads it directly to decide
			// scalar-vs-struct arg passing / field access, so it must be
			// substituted alongside the rest of the body.
			const n = node as import("../nodes/ValueNode.ts").default;
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "break":
		case "continue":
		case "panic":
		case "todo":
		case "raw":
		case "import":
			break;
	}
}

/**
 * Re-stamp `p[i]` index nodes in monomorphized clones whose checker stamps
 * are missing (the clone was taken before the generic body was checked).
 * - Inside `Array_<elem>` method bodies, `self[i]` targets the inline
 *   element storage → is_array_target + element type from the mono name.
 * - Any other unstamped index resolves its element type from the (now
 *   concrete) target type: a `ptr T` value's name IS the element type.
 */
function restamp_index_nodes(nodes: BaseNode[], mono_struct_name: string) {
	for (const node of nodes) restamp_index_in_node(node, mono_struct_name);
}

function restamp_index_in_node(node: BaseNode | undefined | null, mono_struct_name: string) {
	if (!node) return;
	const any_node = node as any;
	if (node.node_type === "index") {
		const idx = node as import("../nodes/IndexNode.ts").default;
		if (!idx.type) {
			const target = idx.target;
			const target_is_self = target.node_type === "value" && (target as ValueNode).value === "self";
			if (target_is_self && mono_struct_name.startsWith("Array_")) {
				idx.is_array_target = true;
				idx.type = new Type(mono_struct_name.slice("Array_".length));
			} else {
				const elem = restamp_resolve_type(target);
				if (elem?.name) idx.type = new Type(elem.name);
			}
		}
	}
	if (Array.isArray(any_node.statements)) {
		for (const child of any_node.statements) {
			if (child && typeof child === "object" && "node_type" in child) {
				restamp_index_in_node(child, mono_struct_name);
			}
		}
	}
	if (Array.isArray(any_node.params)) {
		for (const child of any_node.params) {
			if (child && typeof child === "object" && "node_type" in child) {
				restamp_index_in_node(child, mono_struct_name);
			}
		}
	}
	if (any_node.if_branch?.statements) {
		for (const child of any_node.if_branch.statements)
			restamp_index_in_node(child, mono_struct_name);
	}
	if (any_node.else_branch?.statements) {
		for (const child of any_node.else_branch.statements)
			restamp_index_in_node(child, mono_struct_name);
	}
	if (any_node.value?.node_type) restamp_index_in_node(any_node.value, mono_struct_name);
	if (any_node.left_value?.node_type) restamp_index_in_node(any_node.left_value, mono_struct_name);
	if (any_node.right_value?.node_type)
		restamp_index_in_node(any_node.right_value, mono_struct_name);
	if (any_node.target?.node_type) restamp_index_in_node(any_node.target, mono_struct_name);
	if (any_node.index?.node_type) restamp_index_in_node(any_node.index, mono_struct_name);
	if (any_node.condition?.node_type) restamp_index_in_node(any_node.condition, mono_struct_name);
}

/** Minimal type resolver for index-target expressions after substitution. */
function restamp_resolve_type(node: BaseNode): Type | undefined {
	const any_node = node as any;
	if (node.node_type === "value") return any_node.type;
	if (node.node_type === "cast") return any_node.target_type;
	if (node.node_type === "grouped") return restamp_resolve_type(any_node.value);
	return undefined;
}
