import DeclarationNode from "../../nodes/DeclarationNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import RootNode from "../../nodes/RootNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";

/**
 * Returns the canonical name used for an auto-generated tuple struct
 * with the given element types.
 */
export function tuple_struct_name(tuple_types: Type[]): string {
	return "_Tuple_" + tuple_types.map((t) => sanitize_type_name(t)).join("_");
}

export function sanitize_type_name(t: Type): string {
	if (t.is_array) {
		return "Arr_" + sanitize_type_name(new Type(t.name));
	}
	if (t.tuple_types?.length) {
		return "Tup_" + t.tuple_types.map(sanitize_type_name).join("_");
	}
	let n = t.name.replace(/[^A-Za-z0-9]/g, "_");
	if (t.type_args?.length) {
		n += "_" + t.type_args.map(sanitize_type_name).join("_");
	}
	if (t.is_nullable) n += "_opt";
	return n;
}

export function clone_type(t: Type): Type {
	const new_t = new Type(t.name, t.is_static, t.is_array, t.length);
	new_t.is_ref = t.is_ref;
	new_t.is_nullable = t.is_nullable;
	new_t.is_return_type = t.is_return_type;
	new_t.type_args = t.type_args?.map(clone_type);
	new_t.tuple_types = t.tuple_types?.map(clone_type);
	new_t.func_params = t.func_params;
	new_t.func_return_type = t.func_return_type ? clone_type(t.func_return_type) : undefined;
	return new_t;
}

/**
 * Materialize a tuple type into an anonymous struct, returning the struct name.
 * The struct has fields `_0`, `_1`, ... and an auto-generated `#init`.
 * Reuses an existing struct if one with the same element types was already created.
 */
export function get_or_create_tuple_struct(tuple_types: Type[], status: CheckStatus): StructNode {
	// Recursively materialize any nested tuple types first
	for (const t of tuple_types) {
		if (t.tuple_types?.length) {
			get_or_create_tuple_struct(t.tuple_types, status);
		}
	}

	const name = tuple_struct_name(tuple_types);
	const existing = status.structs.find((s) => s.name === name);
	if (existing) return existing;

	// Create fields `_0`, `_1`, ... with materialized element types.
	// Nested tuple elements must be materialized so the generated struct
	// has concrete field types (e.g. `_Tuple_int_string`, not `tuple`).
	const fields = tuple_types.map((t, i) => {
		const field_type =
			t.name === "tuple" && t.tuple_types?.length
				? materialize_tuple_type(t, status)
				: clone_type(t);
		return new DeclarationNode(0, "pub", "var", `_${i}`, field_type);
	});

	const struct = new StructNode(0, "private", name, [], fields, []);

	// Build #init params: self + one param per field, matching positions
	const self_param = new ParameterNode(0, "self", new Type(name));
	self_param.is_self_param = true;
	self_param.declaration = "var";
	const init_params: ParameterNode[] = [self_param];
	for (const field of fields) {
		init_params.push(new ParameterNode(0, field.name, field.type));
	}
	const init_func = new FunctionNode(0, "pub", "#init", new Type(name), init_params);
	init_func.is_static = false;
	struct.functions.push(init_func);

	status.structs.push(struct);
	status.types.push(name);

	// Register with root so the build phase emits the struct
	const root = status.stack[0] as RootNode;
	if (root) {
		root.statements.push(struct);
	}

	return struct;
}

/**
 * Convert a tuple Type (name === "tuple") into its materialized struct Type.
 * Returns a new Type whose name is the auto-generated tuple struct name.
 */
export function materialize_tuple_type(type: Type, status: CheckStatus): Type {
	if (type.name !== "tuple" || !type.tuple_types?.length) return type;
	const struct = get_or_create_tuple_struct(type.tuple_types, status);
	const new_type = new Type(struct.name);
	new_type.is_nullable = type.is_nullable;
	new_type.is_array = type.is_array;
	new_type.is_ref = type.is_ref;
	// Preserve tuple_types (materialized) for callers that need element types.
	// Recursively materialize nested tuple element types so that downstream
	// checks (e.g. tuple value matching) compare materialized struct names
	// instead of raw "tuple" types.
	new_type.tuple_types = type.tuple_types.map((t) => materialize_tuple_type(t, status));
	return new_type;
}
