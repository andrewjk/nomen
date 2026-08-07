import add_error from "../add_error.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_declaration_node from "./check_declaration_node.ts";
import {
	monomorphize,
	substitute_type,
	synthesize_generic_trait_defaults,
} from "./check_function_call_node.ts";
import check_function_node from "./check_function_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { is_class_type } from "./utils/ownership.ts";
import type_from_value from "./utils/type_from_value.ts";

function params_differ(a: FunctionNode, b: FunctionNode): boolean {
	const a_params = a.params.filter((p) => !p.is_self_param);
	const b_params = b.params.filter((p) => !p.is_self_param);
	if (a_params.length !== b_params.length) return true;
	for (let i = 0; i < a_params.length; i++) {
		if (a_params[i].type.name !== b_params[i].type.name) return true;
	}
	return false;
}

export default function check_struct_node(struct: StructNode, status: CheckStatus) {
	for (let i = 0; i < struct.traits.length; i++) {
		const trait_name = struct.traits[i];
		const trait = status.traits.find((t) => t.name === trait_name);
		if (!trait) {
			add_error(status, `Unknown trait: ${trait_name}`, struct.start);
			continue;
		}
		// Validate generic-trait conformance arity: `struct Users: Viewable<User>`
		// must supply exactly as many type args as the trait declares type
		// params. Missing args on a generic trait, or extra args on a plain
		// trait, are compile errors.
		const args = struct.trait_args[i];
		if (trait.type_params.length > 0 && !args) {
			add_error(
				status,
				`Trait '${trait_name}' expects ${trait.type_params.length} type argument(s) <${trait.type_params.join(", ")}>, got none`,
				struct.start,
			);
		} else if (args && args.length !== trait.type_params.length) {
			add_error(
				status,
				`Trait '${trait_name}' expects ${trait.type_params.length} type argument(s), got ${args.length}`,
				struct.start,
			);
		}
	}

	// Synthesize per-conformer default-method overrides for generic traits
	// (e.g. `trait Box<T> { func get = (self, out T) { return self.item } }`
	// cloned with T→int onto each `struct IB: Box<int>`). Must run after the
	// arity validation above so an invalid conformance doesn't synthesize
	// against missing args.
	synthesize_generic_trait_defaults(struct, status);

	// Enforce trait conformance: every required (bodyless) trait method must
	// be implemented, and any override must match the trait's signature.
	// Runs after synthesize_generic_trait_defaults (so generic-trait default
	// clones are present) and after the block-level auto-derive pre-pass
	// (so auto-derived to_string/eq/hash satisfy their traits).
	check_trait_conformance(struct, status);

	for (let i = 0; i < struct.fields.length; i++) {
		for (let j = i + 1; j < struct.fields.length; j++) {
			if (struct.fields[i].name === struct.fields[j].name) {
				add_error(
					status,
					`Field already declared: ${struct.fields[j].name}`,
					struct.fields[j].start,
				);
			}
		}
	}

	for (let i = 0; i < struct.functions.length; i++) {
		for (let j = i + 1; j < struct.functions.length; j++) {
			if (struct.functions[i].name === struct.functions[j].name) {
				if (!params_differ(struct.functions[i], struct.functions[j])) {
					add_error(
						status,
						`Function already declared: ${struct.functions[j].name}`,
						struct.functions[j].start,
					);
				}
			}
		}
	}

	const types_length_before = status.types.length;
	status.types.push(...struct.type_params);

	const type_params_length_before = status.type_params.length;
	status.type_params.push(...struct.type_params);

	// Validate trait bounds on type params: `struct Container<T: Control>`
	// requires each named bound to be a known trait. The actual conformance
	// check (that a concrete type arg conforms to the bound) happens at
	// monomorphization, once the type args are known.
	const bounds_parallel = struct.type_param_bounds.length === struct.type_params.length;
	for (let i = 0; i < struct.type_params.length; i++) {
		const bounds = bounds_parallel ? struct.type_param_bounds[i] : [];
		for (const bound of bounds) {
			if (!status.traits.find((t) => t.name === bound)) {
				add_error(status, `Unknown trait bound: ${bound}`, struct.start);
			}
		}
	}

	const values_length_before_fields = status.values.length;
	for (let decl of struct.fields) {
		decl.scope = struct;
		// A `ref`/`view` field would be a non-owning borrow stored in a struct,
		// which could outlive its target (UAF). Reject it at the field level —
		// this matches `MEMORY.md` and closes the gap where a `ref` field with a
		// default value or custom `#init` was accepted (cve-rs probe). The
		// `view` keyword form (`view v = ...`) is rejected here too, since its
		// type only becomes a view after inference (the type-level check below
		// would miss it).
		if (decl.type.is_ref || decl.type.is_view || decl.declaration === "view") {
			add_error(
				status,
				`${struct.is_class ? "class" : "struct"} fields cannot be '${
					decl.type.is_view || decl.declaration === "view" ? "view" : "ref"
				}'`,
				decl.start,
			);
			continue;
		}
		if (!struct.is_class && is_class_type(decl.type.name, status)) {
			add_error(status, `struct fields cannot be class types, use a class instead`, decl.start);
		} else {
			check_declaration_node(decl, status);
		}
	}
	status.values.length = values_length_before_fields;

	// Resolve generic field types on non-generic structs (e.g. Buffer<T> →
	// Buffer_T or ClassBuffer_T). Generic structs get this rewrite inside
	// monomorphize(); non-generic structs need it here so that downstream
	// build phases (especially the C companion typedef) see the concrete
	// monomorphized name rather than the unresolved generic.
	rewrite_generic_buffer_fields(struct, status);

	status.types.push(struct.name);
	status.structs.push(struct);

	for (let func of struct.functions) {
		func.scope = struct;
		// A generic struct's custom #init is a template: its variadic tuple
		// params reference type params (e.g. `...[TK, TV]`) that can't be
		// materialized until monomorphization. Skip checking it here — the
		// cloned init is checked inside monomorphize() once the concrete type
		// args are known.
		if (struct.is_generic && func.name === "#init" && func.has_body) {
			func.checked = true;
			continue;
		}
		check_function_node(func, status);
	}

	status.type_params.length = type_params_length_before;
	status.types.length = types_length_before;
	status.types.push(struct.name);
}

/**
 * Rewrite `Buffer<Elem>` field types on a non-generic struct to their
 * monomorphized name (Buffer_Elem / ClassBuffer_Elem), including the field's
 * default constructor call. Generic structs get this rewrite inside
 * monomorphize() instead. Shared between check_struct_node (statement-order)
 * and the upfront resolve_struct_field_types pass so the rewrite runs exactly
 * once regardless of which fires first.
 */
function rewrite_generic_buffer_fields(struct: StructNode, status: CheckStatus) {
	if (struct.is_generic) return;
	for (const field of struct.fields) {
		if (field.type.name !== "Buffer" || !field.type.type_args?.length) continue;
		const elem = field.type.type_args[0];
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
}

/**
 * Infer the type of a struct-field initializer whose annotation was elided
 * (e.g. `var digits = Buffer<int>()`). Constructor calls resolve to the named
 * struct (plus any type args); literals resolve via type_from_value. Returns
 * null for initializers that can't be typed structurally (free-function calls,
 * complex expressions) — those fall back to the lazy inference inside
 * check_struct_node.
 */
function infer_field_type_from_value(
	value: import("../nodes/BaseNode.ts").default,
	status: CheckStatus,
): Type | null {
	if (value.node_type === "func_call") {
		const call = value as FunctionCallNode;
		// Only infer when the call names a registered struct (a constructor);
		// a free-function initializer can't be typed without checking it.
		if (status.structs.find((s) => s.name === call.name)) {
			const t = new Type(call.name);
			if (call.type_args?.length) t.type_args = call.type_args;
			return t;
		}
		return null;
	}
	if (value.node_type === "value") {
		return type_from_value((value as ValueNode).value, status);
	}
	return null;
}

/**
 * Eagerly resolve inferred struct field types (e.g. `var buf = Buffer<int>()`)
 * before any function bodies are checked.
 *
 * Field type inference normally happens lazily inside check_struct_node, which
 * runs in statement order. The System library source is appended after user
 * code, so user functions are checked BEFORE library structs — a field whose
 * type is inferred from its initializer (no explicit annotation) would still
 * have an empty type when user code accesses it, surfacing as "Unknown target".
 * Resolving inferred field types upfront (right after gather_structs registers
 * every struct) makes them visible regardless of declaration order.
 *
 * Only non-generic structs are handled here, mirroring check_struct_node's own
 * field-type rewrite. The inference is structural to avoid re-running the full
 * declaration check and its side effects; check_struct_node later skips
 * already-resolved fields, so each field is resolved exactly once.
 */
export function resolve_struct_field_types(status: CheckStatus) {
	for (const struct of status.structs) {
		if (struct.is_generic) continue;
		for (const field of struct.fields) {
			if (field.type.name) continue;
			if (!field.value) continue;
			const t = infer_field_type_from_value(field.value, status);
			if (t?.name) field.type = t;
		}
		rewrite_generic_buffer_fields(struct, status);
	}
}

/**
 * Enforce trait conformance for a struct. For each declared trait:
 *
 *  - A required (bodyless) trait method must be implemented by the struct.
 *  - Any struct method that overrides a trait method (required or default)
 *    must match the trait's signature — parameter count, parameter types
 *    and return type — after substituting a generic trait's type params
 *    with the struct's conformance type args.
 *
 * A trait method with a default body need not be overridden; if it isn't,
 * the default is inherited (and, for generic traits, already synthesized
 * onto the struct by synthesize_generic_trait_defaults). `#init` and
 * `#destroy` are lifecycle hooks, not contract methods, so they're skipped.
 */
function check_trait_conformance(struct: StructNode, status: CheckStatus) {
	for (let i = 0; i < struct.traits.length; i++) {
		const trait = status.traits.find((t) => t.name === struct.traits[i]);
		if (!trait) continue;

		const args = struct.trait_args[i];
		// A generic trait whose conformance arity is wrong already produced
		// an error above; skip it here to avoid a cascade of spurious
		// signature mismatches from the unresolved type params.
		if (trait.type_params.length > 0 && (!args || args.length !== trait.type_params.length)) {
			continue;
		}
		const substitution = new Map<string, string>();
		if (args && trait.type_params.length === args.length) {
			for (let j = 0; j < trait.type_params.length; j++) {
				substitution.set(trait.type_params[j], args[j].name);
			}
		}

		for (const trait_func of trait.functions) {
			if (trait_func.name === "#init" || trait_func.name === "#destroy") continue;

			const overrides = struct.functions.filter((f) => f.name === trait_func.name);

			if (overrides.length === 0) {
				if (!trait_func.has_body) {
					add_error(
						status,
						`Type '${struct.name}' does not conform to trait '${trait.name}': missing required method '${trait_func.name}'`,
						struct.start,
					);
				}
				continue;
			}

			// An override exists — at least one overload must satisfy the
			// trait signature.
			const matches = overrides.some((ov) => signature_matches(ov, trait_func, substitution));
			if (!matches) {
				add_error(
					status,
					`Type '${struct.name}' does not conform to trait '${trait.name}': method '${trait_func.name}' does not match the trait signature`,
					overrides[0].start,
				);
			}
		}
	}
}

/**
 * Compare a struct method against a trait method signature, ignoring `self`
 * (which is trait-typed on the trait and struct-typed on the conformer).
 * The trait method's types are substituted with `substitution` first, so a
 * generic trait like `trait Box<T> { func get = (self, out T) }` is compared
 * against `func get = (self, out int)` once T→int is applied.
 */
function signature_matches(
	struct_func: FunctionNode,
	trait_func: FunctionNode,
	substitution: Map<string, string>,
): boolean {
	const trait_params = trait_func.params.filter((p) => !p.is_self_param);
	const struct_params = struct_func.params.filter((p) => !p.is_self_param);
	if (trait_params.length !== struct_params.length) return false;
	for (let k = 0; k < trait_params.length; k++) {
		const expected = substitute_type(trait_params[k].type, substitution);
		if (!types_match(expected, struct_params[k].type)) return false;
	}
	return types_match(
		substitute_type(trait_func.return_type, substitution),
		struct_func.return_type,
	);
}

function types_match(a: Type, b: Type): boolean {
	return (
		a.name === b.name &&
		!!a.is_ref === !!b.is_ref &&
		!!a.is_view === !!b.is_view &&
		!!a.is_array === !!b.is_array
	);
}
