import { is_hashable_scalar } from "../../built_in_types.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import CastNode from "../../nodes/CastNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import ReturnNode from "../../nodes/ReturnNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";

function struct_has_function(struct: StructNode, name: string): boolean {
	return struct.functions.some((f) => f.name === name);
}

/**
 * Can a value of `type_name` be converted to a string? Primitives with a
 * `to_string` method qualify, as do structs that already define `to_string`
 * or conform to `Stringable` (in which case they will themselves receive an
 * auto-derived body). `visiting` breaks cycles between mutually-referential
 * types.
 */
function type_is_stringable(
	type_name: string,
	status: CheckStatus,
	visiting: Set<string>,
): boolean {
	const struct = status.structs.find((s) => s.name === type_name);
	if (!struct) return false;
	if (struct_has_function(struct, "to_string")) return true;
	if (struct.traits.includes("Stringable")) {
		if (visiting.has(type_name)) return true;
		visiting.add(type_name);
		return struct.fields.every((f) => field_is_stringable(f, status, visiting));
	}
	return false;
}

function field_is_stringable(
	field: { type: Type; name: string },
	status: CheckStatus,
	visiting: Set<string>,
): boolean {
	if (field.type.is_array || field.type.is_ref || field.type.is_view || field.type.is_nullable) {
		return false;
	}
	return type_is_stringable(field.type.name, status, visiting);
}

/**
 * Can a value of `type_name` be compared with `==`? Primitives have builtin
 * equality; structs qualify if they define `#op_eq`/`#op_ne` or conform to
 * `Equatable`.
 */
function type_is_equatable(type_name: string, status: CheckStatus, visiting: Set<string>): boolean {
	const struct = status.structs.find((s) => s.name === type_name);
	if (!struct) return false;
	if (struct.is_simple_type) return true;
	if (struct_has_function(struct, "eq") || struct_has_function(struct, "ne")) return true;
	if (struct.traits.includes("Equatable")) {
		if (visiting.has(type_name)) return true;
		visiting.add(type_name);
		return struct.fields.every((f) => field_is_equatable(f, status, visiting));
	}
	return false;
}

function field_is_equatable(
	field: { type: Type; name: string },
	status: CheckStatus,
	visiting: Set<string>,
): boolean {
	if (field.type.is_array || field.type.is_ref || field.type.is_view || field.type.is_nullable) {
		return false;
	}
	return type_is_equatable(field.type.name, status, visiting);
}

/**
 * Can a value of `type_name` be hashed? Integer/bool/char primitives cast to
 * `uint`; structs qualify if they define `hash` or conform to `Hashable`.
 */
function type_is_hashable(type_name: string, status: CheckStatus, visiting: Set<string>): boolean {
	if (is_hashable_scalar(type_name)) return true;
	const struct = status.structs.find((s) => s.name === type_name);
	if (!struct) return false;
	if (struct_has_function(struct, "hash")) return true;
	if (struct.traits.includes("Hashable")) {
		if (visiting.has(type_name)) return true;
		visiting.add(type_name);
		return struct.fields.every((f) => field_is_hashable(f, status, visiting));
	}
	return false;
}

function field_is_hashable(
	field: { type: Type; name: string },
	status: CheckStatus,
	visiting: Set<string>,
): boolean {
	if (field.type.is_array || field.type.is_ref || field.type.is_view || field.type.is_nullable) {
		return false;
	}
	return type_is_hashable(field.type.name, status, visiting);
}

// --- AST builders for the synthesized method bodies ---

function field_access(receiver: string, field_name: string): AccessNode {
	return new AccessNode(-1, new ValueNode(-1, receiver), new AccessFieldNode(-1, field_name));
}

function method_call(target: BaseNode, method_name: string): AccessNode {
	return new AccessNode(-1, target, new AccessFunctionCallNode(-1, method_name));
}

function to_string_call(field_name: string): AccessNode {
	return method_call(field_access("self", field_name), "to_string");
}

function hash_call(field_name: string): AccessNode {
	return method_call(field_access("self", field_name), "hash");
}

function string_literal(text: string): ValueNode {
	return new ValueNode(-1, `"${text}"`);
}

function concat(left: BaseNode, right: BaseNode): OperationNode {
	return new OperationNode(-1, "+", left, right);
}

function self_param(struct: StructNode): ParameterNode {
	const param = new ParameterNode(-1, "self", new Type(struct.name));
	param.is_self_param = true;
	return param;
}

/** Fold a non-empty list of expression segments with `+` (left-associative). */
function fold_concat(parts: BaseNode[]): BaseNode {
	return parts.reduce((acc, part) => concat(acc, part));
}

/**
 * Derive `to_string`, `#op_eq`, and `hash` for any struct that conforms to the
 * matching trait (`Stringable` / `Equatable` / `Hashable`) but does not already
 * supply the method, provided every field is itself derivable. Mirrors the
 * auto-generated `#init`: no opt-in keyword is needed beyond the trait
 * conformance, and a hand-written method always wins.
 *
 * Runs as a pre-pass (after every struct is gathered) so that a field whose
 * type is a later-declared struct resolves against that struct's own derived
 * method rather than the trait's default body.
 */
export function synthesize_auto_derived_methods(status: CheckStatus): void {
	for (const struct of status.structs) {
		if (struct.is_generic || struct.is_simple_type) continue;
		synthesize_for_struct(struct, status);
	}
}

function synthesize_for_struct(struct: StructNode, status: CheckStatus): void {
	const fields = struct.fields.filter((f) => f.type.name);

	if (
		struct.traits.includes("Stringable") &&
		!struct_has_function(struct, "to_string") &&
		fields.every((f) => field_is_stringable(f, status, new Set()))
	) {
		struct.functions.push(build_to_string(struct, fields));
	}

	if (
		struct.traits.includes("Equatable") &&
		!struct_has_function(struct, "eq") &&
		!struct_has_function(struct, "ne") &&
		fields.every((f) => field_is_equatable(f, status, new Set()))
	) {
		struct.functions.push(build_eq(struct, fields));
	}

	if (
		struct.traits.includes("Hashable") &&
		!struct_has_function(struct, "hash") &&
		fields.every((f) => field_is_hashable(f, status, new Set()))
	) {
		struct.functions.push(build_hash(struct, fields));
	}
}

function build_to_string(struct: StructNode, fields: { name: string }[]): FunctionNode {
	const parts: BaseNode[] = [string_literal(`${struct.name}(`)];
	for (let i = 0; i < fields.length; i++) {
		if (i > 0) parts.push(string_literal(", "));
		parts.push(string_literal(`${fields[i].name}=`));
		parts.push(to_string_call(fields[i].name));
	}
	parts.push(string_literal(")"));
	const expr = parts.length === 1 ? parts[0] : fold_concat(parts);
	const ret = new ReturnNode(-1, expr);
	return new FunctionNode(-1, "pub", "to_string", new Type("string"), [self_param(struct)], [ret]);
}

function build_eq(struct: StructNode, fields: { name: string }[]): FunctionNode {
	const other = new ParameterNode(-1, "other", new Type(struct.name));
	let expr: BaseNode;
	if (fields.length === 0) {
		expr = new ValueNode(-1, "true");
	} else {
		expr = fields
			.map(
				(f) =>
					new OperationNode(-1, "==", field_access("self", f.name), field_access("other", f.name)),
			)
			.reduce((acc, cmp) => new OperationNode(-1, "&&", acc, cmp));
	}
	const ret = new ReturnNode(-1, expr);
	return new FunctionNode(-1, "pub", "eq", new Type("bool"), [self_param(struct), other], [ret]);
}

function build_hash(struct: StructNode, fields: { name: string; type: Type }[]): FunctionNode {
	const field_hashes: BaseNode[] = fields.map((f) => {
		if (is_hashable_scalar(f.type.name)) {
			return new CastNode(-1, field_access("self", f.name), new Type("uint"));
		}
		return hash_call(f.name);
	});
	let expr: BaseNode;
	if (field_hashes.length === 0) {
		expr = new ValueNode(-1, "0");
	} else {
		// Combine with `acc * 31 + next` (left fold, starting from the first field).
		expr = field_hashes
			.slice(1)
			.reduce(
				(acc, h) =>
					new OperationNode(-1, "+", new OperationNode(-1, "*", acc, new ValueNode(-1, "31")), h),
				field_hashes[0],
			);
	}
	const ret = new ReturnNode(-1, expr);
	return new FunctionNode(-1, "pub", "hash", new Type("uint"), [self_param(struct)], [ret]);
}
