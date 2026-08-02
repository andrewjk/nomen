import DeclarationNode from "../../nodes/DeclarationNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import RootNode from "../../nodes/RootNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import type CheckStatus from "../CheckStatus.ts";
import { clone_type, sanitize_type_name } from "./tuple_struct.ts";

/**
 * Canonical, order-independent name for an auto-generated anonymous struct
 * with the given named fields. Fields are sorted by name so that
 * `[ a = 1, b = 2 ]` and `[ b = 2, a = 1 ]` produce the same type
 * (structural identity, mirroring how tuples dedupe by element types).
 */
export function anon_struct_name(fields: { name: string; type: Type }[]): string {
	const sorted = [...fields].sort((a, b) => a.name.localeCompare(b.name));
	return "_Anon_" + sorted.map((f) => `${f.name}_${sanitize_type_name(f.type)}`).join("__");
}

/**
 * Materialize an anonymous struct (a `[ field = value, ... ]` literal used as
 * a standalone value) into an auto-generated struct, returning the struct.
 * The struct has one field per entry (named, with the inferred type) and an
 * auto-generated `#init`. Reuses an existing struct if one with the same
 * field names and types was already created.
 */
export function get_or_create_anon_struct(
	fields: { name: string; type: Type }[],
	status: CheckStatus,
): StructNode {
	const sorted = [...fields].sort((a, b) => a.name.localeCompare(b.name));

	const name = anon_struct_name(sorted);
	const existing = status.structs.find((s) => s.name === name);
	if (existing) return existing;

	const struct_fields = sorted.map(
		(f) => new DeclarationNode(0, "pub", "var", f.name, clone_type(f.type)),
	);

	const struct = new StructNode(0, "private", name, [], struct_fields, []);

	// Build #init params: self + one param per field, in field order.
	const self_param = new ParameterNode(0, "self", new Type(name));
	self_param.is_self_param = true;
	self_param.declaration = "var";
	const init_params: ParameterNode[] = [self_param];
	for (const field of struct_fields) {
		init_params.push(new ParameterNode(0, field.name, field.type));
	}
	const init_func = new FunctionNode(0, "pub", "#init", new Type(name), init_params);
	init_func.is_static = false;
	struct.functions.push(init_func);

	status.structs.push(struct);
	status.types.push(name);

	// Register with root so the build phase emits the struct.
	const root = status.stack[0] as RootNode;
	if (root) {
		root.statements.push(struct);
	}

	return struct;
}
