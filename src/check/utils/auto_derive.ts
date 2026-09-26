import { direct_string_fields } from "../../build_common/has_string_fields.ts";
import { is_hashable_scalar } from "../../built_in_types.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import AssignmentNode from "../../nodes/AssignmentNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import CastNode from "../../nodes/CastNode.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import OperationNode from "../../nodes/OperationNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import ReturnNode from "../../nodes/ReturnNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { struct_owns_non_string_heap } from "./ownership.ts";

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

	// A `copy` method for owning value structs — no trait opt-in: the
	// declaration/assignment copy-discipline errors direct users to
	// `.copy()`, so it must exist wherever it is sound (see
	// struct_is_copyable).
	synthesize_copy_method(struct, status);
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

// --- `copy` synthesis (owning value structs) ---

/**
 * Whether `struct` is eligible for a synthesized `copy` method: a value
 * struct whose only ownership is its DIRECT string fields — the same set
 * the pass-by-value argument convention covers. A struct that additionally
 * owns non-string heap (a resource-releasing `#destroy`, a class field, a
 * nested requiring-move struct) cannot be deep-copied by "byte copy +
 * strdup the strings" — its copy stays unwritten (move/swap remains the
 * escape hatch) — and a struct with no string fields is already soundly
 * byte-copyable, so it needs no method.
 */
export function struct_is_copyable(struct: StructNode, status: CheckStatus): boolean {
	if (struct.is_class || struct.is_generic || struct.is_simple_type) return false;
	if (direct_string_fields(struct).length === 0) return false;
	if (struct_owns_non_string_heap(struct, status, new Set())) return false;
	return struct_copy_ctor_args(struct) !== null;
}

/**
 * How a synthesized `copy` constructs the fresh value: the zero-argument
 * `#init` overload when one exists (auto or user), else the bodyless AUTO
 * `#init` whose params map 1:1 onto non-defaulted fields (pass
 * `self.<param>` for each). Null when neither shape exists — a user #init
 * with params only cannot be invoked without re-running its custom logic,
 * so no `copy` is synthesized.
 */
function struct_copy_ctor_args(struct: StructNode): string[] | null {
	const inits = struct.functions.filter((f) => f.name === "#init");
	if (inits.some((f) => f.params.filter((p) => !p.is_self_param).length === 0)) {
		return [];
	}
	const auto = inits.find((f) => !f.has_body);
	if (!auto) return null;
	return auto.params.filter((p) => !p.is_self_param).map((p) => p.name);
}

/** Whether `type` names a struct that has (or will get) a `copy` method.
 *  Order-independent: it re-evaluates the eligibility predicate instead of
 *  looking for an already-synthesized method, so an outer struct nested in
 *  the same pre-pass resolves a later-declared field struct. */
function field_type_is_copyable(type: Type, status: CheckStatus): boolean {
	if (!type.name || type.is_array || type.is_ref || type.is_view || type.is_nullable) return false;
	const nested = status.structs.find((s) => s.name === type.name);
	return !!nested && struct_is_copyable(nested, status);
}

/**
 * Synthesize `pub func copy(self) -> Struct` for owning value structs: a
 * fresh `Struct()` whose every field is rewritten from `self` — string
 * field writes strdup the source (the backends' field-write path), nested
 * copyable structs recurse through their own `copy`, everything else byte
 * copies. `return c` hits the return-boundary normalization (all fields
 * recorded → transfer raw), so the caller receives a uniformly heap-owned
 * value with no extra copies.
 */
function build_copy(struct: StructNode, status: CheckStatus): FunctionNode {
	const ctor_args = struct_copy_ctor_args(struct) ?? [];
	const ctor = new FunctionCallNode(
		-1,
		struct.name,
		new Type(struct.name),
		ctor_args.map((name) => field_access("self", name)),
	);
	const statements: BaseNode[] = [
		new DeclarationNode(-1, "private", "var", "c", new Type(struct.name), ctor),
	];
	for (const field of struct.fields) {
		const right = field_type_is_copyable(field.type, status)
			? method_call(field_access("self", field.name), "copy")
			: field_access("self", field.name);
		statements.push(new AssignmentNode(-1, field_access("c", field.name), right, "="));
	}
	statements.push(new ReturnNode(-1, new ValueNode(-1, "c")));
	return new FunctionNode(
		-1,
		"pub",
		"copy",
		new Type(struct.name),
		[self_param(struct)],
		statements,
	);
}

/**
 * Synthesize the `copy` method on `struct` when eligible and not already
 * present. Called from the block-level derive pre-pass (which runs before
 * the struct is checked, so the method's body is checked with it) AND from
 * `monomorphize` — a mono struct materializes mid-check, after that pre-pass
 * ran, so without this hook `Box<string>.copy()` — advertised by the
 * copy-discipline error messages — would resolve to "Function not found".
 * The caller is responsible for checking the synthesized body when no later
 * struct check will (see monomorphize).
 */
export function synthesize_copy_method(struct: StructNode, status: CheckStatus): void {
	if (struct_has_function(struct, "copy")) return;
	if (!struct_is_copyable(struct, status)) return;
	struct.functions.push(build_copy(struct, status));
}
