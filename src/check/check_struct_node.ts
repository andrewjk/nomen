import add_error from "../add_error.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import check_declaration_node from "./check_declaration_node.ts";
import { monomorphize } from "./check_function_call_node.ts";
import check_function_node from "./check_function_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import { is_class_type } from "./utils/ownership.ts";

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
		// default value or custom `#init` was accepted (cve-rs probe).
		if (decl.type.is_ref || decl.type.is_view) {
			add_error(
				status,
				`${struct.is_class ? "class" : "struct"} fields cannot be '${
					decl.type.is_view ? "view" : "ref"
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
	if (!struct.is_generic) {
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
