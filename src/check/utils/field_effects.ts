import add_error from "../../add_error.ts";
import { struct_needs_destroy } from "../../build_common/destroy_analysis.ts";
import { resolve_struct_type } from "../../build_common/mono_name.ts";
import { SCALAR_TYPES, SIMPLE_TYPES } from "../../built_in_types.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import { child_nodes } from "../../nodes/child_nodes.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { is_class_type } from "./ownership.ts";

/**
 * Declared field sets (FIELD_EFFECTS.md).
 *
 * A `ref` parameter may declare the fields of the aliased variable it may
 * displace: `ref Item item { name }` (or `{}` for none). The declaration is
 * verified locally against the body — three rules, no body scans, no
 * call-graph:
 *   1. a write through the parameter (`item.name = …`) must target a
 *      declared field, unless the field is pure value storage;
 *   2. a mutator call on a field of the parameter (`item.items.push(…)`)
 *      requires that field to be declared;
 *   3. forwarding the parameter to another `ref` parameter (or calling a
 *      `ref self` method on the parameter itself) requires the callee's
 *      declared set to be a subset of the caller's.
 * An un-annotated `ref` parameter is a wildcard: every declared-set rule
 * passes (today's whole-owner invalidation), and the only consequence is a
 * lint warning when the body actually mutates a heap-bearing field through
 * it — the hook the editor quick fix uses to offer a set.
 *
 * The same tracking answers the idle-ref lint: a `ref` parameter that is
 * never written through (not even by a forwarded mutable borrow) has no
 * reason to be a reference.
 */

/**
 * A structured edit the editor can apply to add or extend the field set on a
 * parameter. Offsets are source offsets, same coordinate space as
 * `CompileError.start`.
 */
export interface FieldSetQuickFix {
	title: string;
	/** The parameter this edit modifies (its first token's offset). */
	param_start: number;
	/** Insert `insert_text` at this offset (creating a new set). */
	insert_offset?: number;
	insert_text?: string;
	/** Replace [replace_start, replace_end) with `replace_text`. */
	replace_start?: number;
	replace_end?: number;
	replace_text?: string;
}
interface CompileErrorWithFix {
	message: string;
	start: number;
	line: number;
	column: number;
	quick_fix?: FieldSetQuickFix;
}

/** Per-`ref`-parameter write tracking, keyed by parameter identity. */
export interface RefParamWrite {
	param: ParameterNode;
	func_name: string;
	/** Concrete heap-bearing fields written (for the wildcard warning). */
	fields: Set<string>;
	/** An unknown effect: a wildcard callee may change any field. */
	whole: boolean;
	/**
	 * The unknown effect came from an un-annotated LIBRARY method. The design
	 * accepts coarse library mutators, so no lint is emitted for the caller
	 * (it also blocks the `{}` suggestion — nothing is proven).
	 */
	library_unknown?: boolean;
	/** ANY write through the alias (scalar writes included) — idle-ref lint. */
	wrote: boolean;
	/** The owning function is System-library code — never linted. */
	is_library: boolean;
}
export type RefParamWrites = Map<string, RefParamWrite>;

function param_write_key(param: ParameterNode): string {
	return `${param.start}:${param.name}`;
}

/** Get (or create) the write-tracking entry for a `ref` parameter. */
export function ensure_ref_param_write(
	status: CheckStatus,
	param: ParameterNode,
	func_name: string,
): RefParamWrite {
	if (!status.ref_param_writes) status.ref_param_writes = new Map();
	const key = param_write_key(param);
	let entry = status.ref_param_writes.get(key);
	if (!entry) {
		entry = {
			param,
			func_name,
			fields: new Set(),
			whole: false,
			wrote: false,
			is_library: !!status.current_function?.is_library,
		};
		status.ref_param_writes.set(key, entry);
	}
	return entry;
}

/**
 * Mark the parameter as written through — any assignment/compound write,
 * mutator call, or forwarded `ref` argument. Feeds the idle-ref lint.
 */
export function mark_param_written(
	status: CheckStatus,
	param: ParameterNode,
	func_name: string,
): void {
	ensure_ref_param_write(status, param, func_name).wrote = true;
}

/**
 * Record a write through an UN-ANNOTATED `ref` parameter, so the warning
 * pass can offer the field set that would narrow it. `field` is undefined
 * for a bare-receiver wildcard mutator call (no concrete field to name).
 */
export function record_undeclared_write(
	status: CheckStatus,
	param: ParameterNode,
	func_name: string,
	field: string | undefined,
	library_unknown = false,
): void {
	const entry = ensure_ref_param_write(status, param, func_name);
	entry.wrote = true;
	if (field === undefined) {
		entry.whole = true;
		if (library_unknown) entry.library_unknown = true;
	} else {
		entry.fields.add(field);
	}
}

/** The function whose body is currently being checked. */
export function current_function(status: CheckStatus): FunctionNode | undefined {
	return status.current_function;
}

/**
 * The current function's `ref` parameter named `root`, if the innermost
 * binding of that name really is the parameter (a shadowing local breaks the
 * identification and disables the verification).
 */
export function current_ref_param(status: CheckStatus, root: string): ParameterNode | undefined {
	const func = status.current_function;
	if (!func) return undefined;
	const param = func.params.find((p) => p.name === root);
	if (!param) return undefined;
	const innermost = status.values.findLast((v) => v.name === root);
	if (innermost && !(innermost.is_param && innermost.name === root)) return undefined;
	return param;
}

/** Whether the parameter declares a field set (including the empty set). */
export function has_field_set(param: ParameterNode): boolean {
	return param.field_set !== undefined;
}

/** Render a declared set for error messages (`an empty field set` / `{ a, b }`). */
export function display_field_set(fields: string[]): string {
	return fields.length ? `{ ${fields.join(", ")} }` : "an empty field set";
}

/**
 * Whether writing a field of this type can free or displace heap state —
 * the value-type exemption (FIELD_EFFECTS.md): an `int` (or bool, char, a
 * fixed array of such scalars) has no heap interior, so writing it neither
 * frees nor displaces anything and never needs declaring. Everything that
 * owns or points at heap storage (string, class/trait, containers, nested
 * destroy-worthy structs, func fields, views, ref links) counts as
 * displace-capable. Unresolvable types conservatively count too.
 */
export function field_can_displace(type: Type | undefined, status: CheckStatus): boolean {
	if (!type) return true;
	if (type.is_view || type.is_ref || type.is_pointer) return true;
	if (type.name === "string") return true;
	if (type.name === "func" || type.func_params) return true;
	if (type.is_array) {
		// A heap `Array<T>` owns its slab; a fixed stack array displaces only
		// what its element type displaces.
		if (type.storage_kind === "heap_array") return true;
		return field_can_displace(type.type_args?.[0] ?? type.elem, status);
	}
	if (type.name && SCALAR_TYPES.includes(type.name)) return false;
	if (type.name && is_class_type(type.name, status)) return true;
	if (type.name && status.traits.find((t) => t.name === type.name)) return true;
	const struct = resolve_struct_type(type, status);
	if (!struct) return !type.name || !SIMPLE_TYPES.includes(type.name);
	if (struct.is_class) return true;
	if (struct.is_simple_type) return false;
	if (struct.is_generic) return true;
	return struct_needs_destroy(struct, status);
}

/** The type of a named field of a (possibly monomorphized) struct type. */
function field_type_of(
	owner: Type | undefined,
	field: string,
	status: CheckStatus,
): Type | undefined {
	if (!owner?.name) return undefined;
	const struct = resolve_struct_type(owner, status);
	if (!struct) return undefined;
	return struct.fields.find((f) => f.name === field)?.type;
}

/** Whether the parameter's type is a field-bearing struct (not a scalar). */
function is_struct_type(type: Type | undefined, status: CheckStatus): boolean {
	if (!type?.name) return false;
	const struct = resolve_struct_type(type, status);
	return !!struct && !struct.is_simple_type;
}

/**
 * Validate a declared field set against the aliased type: a non-struct `ref`
 * parameter has no fields to narrow, and every named field must exist on the
 * struct (trait-declared fields included). Generic templates are skipped —
 * their monomorphized clones re-run this against the concrete struct.
 */
export function validate_field_set(param: ParameterNode, status: CheckStatus): void {
	const set = param.field_set;
	if (set === undefined) return;
	const type = param.type;
	if (!type?.name) return;
	const start = param.field_set_span?.start ?? param.start;
	if (
		SCALAR_TYPES.includes(type.name) ||
		type.name === "string" ||
		type.name === "func" ||
		type.func_params
	) {
		add_error(
			status,
			`a field set requires a struct-typed ref parameter — '${param.name}' is '${type.name}'`,
			start,
		);
		return;
	}
	const struct = resolve_struct_type(type, status);
	if (!struct) return;
	const known = new Set(struct.fields.map((f) => f.name));
	for (const trait_name of struct.traits ?? []) {
		const trait = status.traits.find((t) => t.name === trait_name);
		for (const field of trait?.fields ?? []) known.add(field.name);
	}
	for (const field of set) {
		if (!known.has(field)) {
			add_error(status, `'${type.name}' has no field '${field}'`, start);
		}
	}
}

/** Whether the parameter's type has any field that can displace heap state. */
export function param_has_displaceable_field(param: ParameterNode, status: CheckStatus): boolean {
	const struct = resolve_struct_type(param.type, status);
	if (!struct) return false;
	return struct.fields.some((f) => field_can_displace(f.type, status));
}

/** Build the structured edit that adds `fields` to the parameter's set. */
export function field_set_quick_fix(param: ParameterNode, fields: string[]): FieldSetQuickFix {
	const rendered = fields.length ? `{ ${fields.join(", ")} }` : "{}";
	const title = has_field_set(param)
		? `Add ${fields.map((f) => `'${f}'`).join(", ")} to the field set`
		: `Declare \`${rendered}\``;
	const fix: FieldSetQuickFix = { title, param_start: param.start };
	if (param.field_set !== undefined && param.field_set_span) {
		const span = param.field_set_span;
		if (param.field_set.length > 0) {
			// Inside the braces: `, f1, f2` after the last field name.
			fix.insert_offset = span.end;
			fix.insert_text = `, ${fields.join(", ")}`;
		} else if (span.start === span.end) {
			// Empty braces: insert the fields inside them.
			fix.insert_offset = span.start;
			fix.insert_text = ` ${fields.join(", ")} `;
		} else {
			// Unreachable in the bare-brace grammar, kept for robustness:
			// replace a non-empty span with a braced set.
			fix.replace_start = span.start;
			fix.replace_end = span.end;
			fix.replace_text = `{ ${fields.join(", ")} }`;
		}
		return fix;
	}
	// No set yet: insert one right after the parameter name (before any
	// constraint / default / comma). A `ref self` parameter's name token is
	// the `ref` keyword; its text is exactly `ref self`.
	const name_end =
		param.is_self_param && !param.name_start
			? param.start + "ref self".length
			: (param.name_start ?? param.start) + param.name.length;
	fix.insert_offset = name_end;
	fix.insert_text = fields.length ? ` { ${fields.join(", ")} }` : " {}";
	return fix;
}

/**
 * The edit that turns an un-annotated `ref self` receiver into a bare `self`
 * (a method that never writes through the receiver is a reader).
 */
export function drop_ref_self_quick_fix(param: ParameterNode): FieldSetQuickFix {
	return {
		title: "Use bare `self`",
		param_start: param.start,
		replace_start: param.start,
		replace_end: param.start + "ref self".length,
		replace_text: "self",
	};
}

function add_field_effects_error(
	status: CheckStatus,
	message: string,
	start: number,
	fix: FieldSetQuickFix | undefined,
): void {
	const error = { message, start, line: 0, column: 0 } as CompileErrorWithFix;
	if (fix) error.quick_fix = fix;
	status.errors.push(error);
}

/**
 * Dotted field path of an access expression after its root variable —
 * `item.name` → ["name"], `item.inner.list` → ["inner", "list"], a bare
 * variable → []. The root name is returned too.
 */
export function root_and_path_of(node: BaseNode): { root: string; path: string[] } | undefined {
	const path: string[] = [];
	let cursor = node;
	while (cursor.node_type === "access") {
		const access = cursor as AccessNode;
		if (access.access.node_type !== "access_field") return undefined;
		path.unshift((access.access as AccessFieldNode).name);
		cursor = access.target;
	}
	if (cursor.node_type !== "value") return undefined;
	const root = (cursor as ValueNode).value;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(root)) return undefined;
	return { root, path };
}

/** Whether any value node inside `node` names `name` (index writes etc.). */
function mentions_value(node: BaseNode, name: string): boolean {
	const stack: BaseNode[] = [node];
	while (stack.length) {
		const current = stack.pop()!;
		if (current.node_type === "value" && (current as ValueNode).value === name) return true;
		for (const child of child_nodes(current)) stack.push(child);
	}
	return false;
}

/**
 * Rule 1 (direct displacement): a write `param.X = …` (plain or `mv`) on a
 * `ref` parameter with a declared set requires X in the set, unless X is
 * value-type storage. On an un-annotated parameter the write is allowed
 * (wildcard) but recorded, so the warning pass can offer the set. Every
 * write through the alias also marks the parameter as used-as-a-reference.
 */
export function verify_field_effects_at_assignment(
	left_value: BaseNode,
	status: CheckStatus,
	start: number,
): void {
	const located = root_and_path_of(left_value);
	if (!located) {
		// An index/compound target (`item.list[i] = …`) — not a field-path
		// write the set can describe, but still a write through the alias.
		for (const param of status.current_function?.params ?? []) {
			if (!(param.is_ref || param.type.is_ref)) continue;
			if (mentions_value(left_value, param.name)) {
				mark_param_written(status, param, status.current_function?.name ?? "");
			}
		}
		return;
	}
	const param = current_ref_param(status, located.root);
	if (!param) return;
	const func_name = status.current_function?.name ?? "";
	mark_param_written(status, param, func_name);
	const declared = param.field_set;

	if (!located.path.length) {
		// A whole-value reassignment through the alias (`item = …`) writes
		// every field; a narrowed set cannot describe it.
		if (declared === undefined || !is_struct_type(param.type, status)) return;
		add_field_effects_error(
			status,
			`'${func_name}' declares ${display_field_set(declared)}, but the body reassigns '${located.root}' — a whole-value write replaces every field; drop the set to allow it`,
			start,
			undefined,
		);
		return;
	}

	const field = located.path[0];
	const displaceable = field_can_displace(field_type_of(param.type, field, status), status);
	if (declared === undefined) {
		if (displaceable) {
			record_undeclared_write(status, param, func_name, field);
		}
		return;
	}
	if (declared.includes(field) || !displaceable) return;
	add_field_effects_error(
		status,
		`'${func_name}' declares ${display_field_set(declared)}, but the body writes ${located.root}.${located.path.join(".")}`,
		start,
		field_set_quick_fix(param, [field]),
	);
}

/**
 * Rules 2 and 3 for a mutator (`ref self`) method call whose receiver is
 * rooted at the current function's `ref` parameter:
 *  - `param.X.m(…)` — X must be declared (any mutator on the param.X
 *    receiver threatens X; nothing about m's body is needed);
 *  - `param.m(…)` — m's declared set must be a subset of the caller's.
 * Un-annotated parameters pass both (wildcard) and record a lint entry.
 */
export function verify_field_effects_at_receiver_call(
	receiver: BaseNode,
	callee: FunctionNode,
	status: CheckStatus,
	start: number,
): void {
	const located = root_and_path_of(receiver);
	if (!located) return;
	const param = current_ref_param(status, located.root);
	if (!param) return;
	const func_name = status.current_function?.name ?? "";
	mark_param_written(status, param, func_name);
	const declared = param.field_set;
	const callee_self = callee.params[0];
	const callee_set = callee_self?.is_self_param ? callee_self.field_set : undefined;

	if (located.path.length) {
		const field = located.path[0];
		const displaceable = field_can_displace(field_type_of(param.type, field, status), status);
		if (declared === undefined) {
			if (displaceable) {
				record_undeclared_write(status, param, func_name, field);
			}
			return;
		}
		if (declared.includes(field) || !displaceable) return;
		add_field_effects_error(
			status,
			`'${func_name}' declares ${display_field_set(declared)}, but the body calls a mutating method on ${located.root}.${located.path.join(".")}`,
			start,
			field_set_quick_fix(param, [field]),
		);
		return;
	}

	// Bare parameter receiver (`param.m(…)`): the callee mutates within the
	// parameter itself, so its declared set must be a subset of the caller's.
	if (declared === undefined) {
		// Wildcard caller — allowed; record the callee's effect so the lint can
		// name the fields (a `{}` callee displaces nothing; a wildcard callee
		// is unknown).
		if (callee_set === undefined) {
			record_undeclared_write(status, param, func_name, undefined, !!callee.is_library);
		} else {
			for (const field of callee_set) {
				record_undeclared_write(status, param, func_name, field);
			}
		}
		return;
	}
	if (callee_set === undefined) {
		add_field_effects_error(
			status,
			`calling '${callee.name}' may change any field of '${located.root}' — the receiver declares no field set, but '${func_name}' narrows '${located.root}' to ${display_field_set(declared)}; declare a set on the receiver's parameter or widen this one`,
			start,
			undefined,
		);
		return;
	}
	const outside = callee_set.filter((f) => !declared.includes(f));
	if (!outside.length) return;
	add_field_effects_error(
		status,
		`'${callee.name}' may change ${outside.map((f) => `'${f}'`).join(", ")} through '${located.root}', which '${func_name}' does not declare`,
		start,
		field_set_quick_fix(param, outside),
	);
}

/**
 * Rule 3 at a `ref` argument: forwarding the current function's set-bound
 * parameter (or a field path into it) to another `ref` parameter requires
 * the callee's declared set to be a subset of the caller's. Wildcard callers
 * (un-annotated) pass everything.
 */
export function verify_field_effects_at_ref_arg(
	argument: BaseNode,
	callee_param: ParameterNode | undefined,
	callee_func: FunctionNode | undefined,
	status: CheckStatus,
	start: number,
): void {
	if (!callee_param) return;
	const located = root_and_path_of(argument);
	if (!located) return;
	const param = current_ref_param(status, located.root);
	if (!param) return;
	const func_name = status.current_function?.name ?? "";
	mark_param_written(status, param, func_name);
	// A direct self-recursive call (`f(ref state)` inside f) has exactly the
	// enclosing function's effects — recording it as an UNKNOWN callee would
	// deadlock the lint (the function's own unresolved set). Its eventual
	// declared set trivially covers itself, so skip the effect recording.
	if (callee_func && callee_func === status.current_function) return;
	const declared = param.field_set;
	if (declared === undefined) {
		// Wildcard caller: record the callee's effect so the lint can name it
		// (a `{}` callee displaces nothing; a wildcard callee is unknown).
		if (located.path.length) {
			if (callee_param.field_set === undefined || callee_param.field_set.length > 0) {
				record_undeclared_write(status, param, func_name, located.path[0]);
			}
		} else if (callee_param.field_set === undefined) {
			record_undeclared_write(status, param, func_name, undefined, !!callee_func?.is_library);
		} else {
			for (const field of callee_param.field_set) {
				record_undeclared_write(status, param, func_name, field);
			}
		}
		return;
	}

	if (located.path.length) {
		// `f(ref item.inner)` — the callee mutates within item.X: X must be
		// declared, same shape as rule 2.
		const field = located.path[0];
		if (declared.includes(field)) return;
		if (!field_can_displace(field_type_of(param.type, field, status), status)) return;
		add_field_effects_error(
			status,
			`'${func_name}' declares ${display_field_set(declared)}, but the body passes ${located.root}.${located.path.join(".")} by reference`,
			start,
			field_set_quick_fix(param, [field]),
		);
		return;
	}

	if (callee_param.field_set === undefined) {
		add_field_effects_error(
			status,
			`passing '${located.root}' to ref parameter '${callee_param.name}' escapes this function's declared fields — the callee declares no field set, so it may change any field of '${located.root}' ('${func_name}' narrows it to ${display_field_set(declared)}); declare a set on '${callee_param.name}' or widen this one`,
			start,
			undefined,
		);
		return;
	}
	const outside = callee_param.field_set.filter((f) => !declared.includes(f));
	if (!outside.length) return;
	add_field_effects_error(
		status,
		`'${callee_param.name}' may change ${outside.map((f) => `'${f}'`).join(", ")} through '${located.root}', which '${func_name}' does not declare`,
		start,
		field_set_quick_fix(param, outside),
	);
}
