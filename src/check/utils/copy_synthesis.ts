import { element_copy_struct } from "../../build_common/element_copy.ts";
import { direct_string_fields } from "../../build_common/has_string_fields.ts";
import { is_load_deep_copy_container, mono_struct_name } from "../../build_common/mono_name.ts";
import AccessFieldNode from "../../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import AssignmentNode from "../../nodes/AssignmentNode.ts";
import BaseNode from "../../nodes/BaseNode.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import ReturnNode from "../../nodes/ReturnNode.ts";
import StructNode from "../../nodes/StructNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type CheckStatus from "../CheckStatus.ts";
import { is_box_type } from "./box.ts";
import { destroy_releases, type_owns_heap } from "./ownership.ts";

/** Whether `type` is an `Array<T>` field that `Array.copy()` can copy: its
 *  elements are plain values or strings (mirrors the checker's `copy()`
 *  element gate in check_function_call — nested arrays and heap-owning
 *  elements would be shared). */
function heap_array_copyable(
	type: Type,
	status: CheckStatus,
	visited: Set<string> = new Set(),
): boolean {
	if (type.storage_kind !== "heap_array" || type.is_ref || type.is_view || type.is_nullable) {
		return false;
	}
	return array_elements_copyable(type, status, visited);
}

/** Whether `Array.copy()` on an array of `type` gives the copy its own
 *  memory: plain values byte-copy, strings get their own bytes, nested rows
 *  are copied level by level, and a value struct copies through its own
 *  `copy()` (present or synthesizable). Classes, traits, boxes, and structs
 *  with no copy story would be shared. */
export function array_elements_copyable(
	type: Type,
	status: CheckStatus,
	visited: Set<string> = new Set(),
): boolean {
	const name = type.name;
	if (!name || name === "string") return true;
	const elem = new Type(name);
	elem.type_args = type.type_args;
	if (!type_owns_heap(elem, status)) return true;
	if (is_box_type(name, status.structs)) return false;
	const st = status.structs.find((s) => s.name === name);
	if (!st || st.is_class || st.is_generic || st.is_simple_type) return false;
	if (element_copy_struct(name, status.structs)) return true;
	// A self-referential element (`Array<Node>` inside `Node`): the walk
	// is already deciding this struct.
	if (visited.has(name)) return false;
	return struct_is_copyable(st, status, new Set([...visited, name]));
}

function struct_has_function(struct: StructNode, name: string): boolean {
	return struct.functions.some((f) => f.name === name);
}

// --- AST builders for the synthesized `copy` body ---

function field_access(receiver: string, field_name: string): AccessNode {
	return new AccessNode(-1, new ValueNode(-1, receiver), new AccessFieldNode(-1, field_name));
}

function method_call(target: BaseNode, method_name: string): AccessNode {
	return new AccessNode(-1, target, new AccessFunctionCallNode(-1, method_name));
}

function self_param(struct: StructNode): ParameterNode {
	const param = new ParameterNode(-1, "self", new Type(struct.name));
	param.is_self_param = true;
	return param;
}

/**
 * Synthesize `pub func copy(self) -> Struct` for every eligible mv value
 * struct — the only remaining compiler-synthesized method (the trait-keyed
 * `to_string`/`eq`/`hash` derivations migrated onto `#for` reflection
 * defaults in core/System — see utils/trait_defaults.ts and the derive
 * traits' default bodies). `copy` is NOT trait-keyed: the declaration/
 * assignment copy-discipline errors direct users to `.copy()`, so it must
 * exist wherever it is sound (see struct_is_copyable).
 */
export function synthesize_copy_methods(status: CheckStatus): void {
	for (const struct of status.structs) {
		if (struct.is_generic || struct.is_simple_type) continue;
		synthesize_copy_method(struct, status);
	}
}

/**
 * Whether `struct` is eligible for a synthesized `copy` method: a value
 * struct whose every field is independently deep-copyable — direct string
 * fields (strdup'd), scalars/arrays (byte copies), `List<T>` fields whose
 * element is itself deep-copyable (the library `List.copy` deep-copies slots
 * via the mv store contract), and nested copyable structs (recursing
 * through their own `copy`). Class fields, enum-with-data fields (their
 * stores transfer payload ownership), class/trait-carrying `List` elements,
 * and resource-releasing `#destroy`s cannot be deep-copied by synthesis —
 * the copy stays unwritten (mv/swap remains the escape hatch) — and a
 * struct with nothing to deep-copy (no string, `List`, or nested-copyable
 * field) is already soundly byte-copyable, so it needs no method.
 */
export function struct_is_copyable(
	struct: StructNode,
	status: CheckStatus,
	visited?: Set<string>,
): boolean {
	if (struct.is_class || struct.is_generic || struct.is_simple_type) return false;
	// The visited set threads through the whole walk: a self-referential
	// inline field (illegal per B2's cycle detector, but the synthesis
	// pre-pass runs BEFORE that detector) would otherwise recurse forever.
	const seen = visited ?? new Set<string>();
	if (struct_owns_resource(struct, status, seen)) return false;
	if (!struct_needs_copy(struct, status)) return false;
	return struct_copy_ctor_args(struct) !== null;
}

/** Whether any field of `struct` actually needs the synthesized deep copy:
 *  a direct string field, a deep-copyable `List<T>` field, or a nested
 *  copyable struct field. A struct of flat values byte-copies soundly
 *  without a method. */
function struct_needs_copy(struct: StructNode, status: CheckStatus): boolean {
	if (direct_string_fields(struct).length > 0) return true;
	for (const field of struct.fields) {
		if (heap_array_copyable(field.type, status)) return true;
		if (field.type.is_ref || field.type.is_view || field.type.is_array) continue;
		if (field_copy_call(field.type, status)) return true;
	}
	return false;
}

/**
 * Whether `struct` owns a resource a synthesized copy CANNOT duplicate: a
 * `#destroy` that releases something (a raw block / foreign free), or a field
 * whose type has no deep-copy story (a class instance, a `List` of
 * class/trait elements, a nested struct with such a field). Fields that DO
 * have a deep-copy story (strings, nested copyables, copyable `List`s,
 * payload-copyable enums) don't block synthesis. Mirrors the old
 * `struct_owns_non_string_heap` gate but understands container deep copies.
 */
function struct_owns_resource(
	struct: StructNode,
	status: CheckStatus,
	visited: Set<string>,
): boolean {
	if (visited.has(struct.name)) return false;
	visited.add(struct.name);
	const destroy = struct.functions.find((f) => f.name === "#destroy");
	if (destroy && destroy_releases(destroy)) return true;
	for (const field of struct.fields) {
		if (field.type.is_ref || field.type.is_view) continue;
		if (field.type.name === "string" && !field.type.is_array) continue;
		// An `Array<T>` field of plain values or strings copies through
		// `Array.copy()`.
		if (heap_array_copyable(field.type, status, visited)) continue;
		if (field.type.is_nullable) return true;
		// STRUCT_PLAN_3 B2: a `Box<T>` field OWNS its pointee — the wrapper
		// destroy reclaims it — so the struct owns a resource and is never
		// auto-copyable. The Box_* mono is a CLASS: recursing into it would
		// walk the pointee type and (for a self-referential Box field, the
		// whole reason Box exists) never terminate.
		if (is_box_type(field.type.name, status.structs)) return true;
		if (!field_copyable(field.type, status, new Set([...visited, struct.name]))) return true;
	}
	return false;
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

/**
 * The element type args of a mv-container type (`List<T>` / `Buffer<T>` /
 * `Set<T>` / `Map<K,V>`), in either spelling: the generic annotation
 * (`Map<string, int>` — type_args on the type, the shape seen by the derive
 * pre-pass which runs before per-field mono rewriting) or the monomorphized
 * name (`Map_string_int` — the registered mono carries the flattened args).
 * Undefined for non-container types.
 */
function container_element_args(type: Type, status: CheckStatus): Type[] | undefined {
	if (!type.name || type.is_array || type.is_ref || type.is_view || type.is_nullable) {
		return undefined;
	}
	if (type.type_args?.length) {
		if (["List", "Buffer", "Set", "Map"].includes(type.name)) return type.type_args;
		return undefined;
	}
	const mono = status.structs.find((s) => s.name === type.name && !s.is_generic);
	if (mono && is_load_deep_copy_container(mono.name) && mono.source_type_args?.length) {
		return mono.source_type_args;
	}
	return undefined;
}

/** Whether `type` has (or will get) a deep-copy story: a struct with a
 *  synthesized `copy`, a `List<T>` whose element is deep-copyable (the
 *  library `List.copy` deep-copies slots via the mv store contract), or
 *  a primitive / plain (payload-free) enum. Order-independent: it
 *  re-evaluates the eligibility predicate instead of looking for an
 *  already-synthesized method, so an outer struct nested in the same
 *  pre-pass resolves a later-declared field struct. */
function field_copyable(type: Type, status: CheckStatus, visited?: Set<string>): boolean {
	if (!type.name || type.is_array || type.is_ref || type.is_view || type.is_nullable) return false;
	// A self-referential inline field: the B2 cycle detector rejects it, but
	// this walk runs first — cut the recursion here.
	if (visited?.has(type.name)) return false;
	// STRUCT_PLAN_3 B2: a `Box<T>` (a CLASS mono) has no deep-copy story —
	// treat it like the class instance it is. Checked BEFORE the struct
	// lookup: recursing into the wrapper would walk the pointee type and
	// (for a self-referential Box field — the whole reason Box exists) never
	// terminate.
	if (is_box_type(type.name, status.structs)) return false;
	// `List<T>`: deep-copyable iff the element is (the library copy rejects
	// class/trait elements — their stored instances would be shared).
	if (type.name === "List" && type.type_args?.length === 1) {
		return element_copyable(type.type_args[0], status);
	}
	// The other mv containers (Buffer/Set/Map, either spelling): the library
	// `copy` deep-copies via the same per-element contract (Map gates BOTH
	// its key and value args).
	const elem_args = container_element_args(type, status);
	if (elem_args) return elem_args.every((arg) => element_copyable(arg, status));
	const nested_struct = status.structs.find((s) => s.name === type.name);
	if (nested_struct) {
		// A simple type (int/float/bool/char-sized) is a flat value.
		if (nested_struct.is_simple_type) return true;
		const seen = visited ?? new Set<string>();
		if (seen.has(type.name)) return false;
		seen.add(type.name);
		return struct_is_copyable(nested_struct, status, seen);
	}
	// Enum-with-data fields BLOCK synthesis: the enum-field store path
	// transfers payload ownership (`c.e = self.e` moves the payloads out),
	// and there is no Nomen-level `.copy()` on enums to deep-copy them.
	const en = status.enums.find((e) => e.name === type.name);
	if (en) return !en.has_associated_data;
	// Traits have no copy story; primitives do.
	return !status.traits.some((t) => t.name === type.name);
}

/** Whether a `List<T>` element type is deep-copyable (see
 *  `field_copyable`). */
function element_copyable(type: Type, status: CheckStatus): boolean {
	if (!type.name || type.is_array || type.is_ref || type.is_view || type.is_nullable) return false;
	if (type.name === "string") return true;
	if (type.name === "List" && type.type_args?.length === 1) {
		return element_copyable(type.type_args[0], status);
	}
	// Buffer/Set/Map elements (either spelling) follow the same per-element
	// contract as List.
	const elem_args = container_element_args(type, status);
	if (elem_args) return elem_args.every((arg) => element_copyable(arg, status));
	const nested = status.structs.find((s) => s.name === type.name);
	if (nested) {
		if (nested.is_simple_type) return true;
		return !nested.is_class && struct_is_copyable(nested, status);
	}
	const en = status.enums.find((e) => e.name === type.name);
	if (en) return !en.has_associated_data;
	return !status.traits.some((t) => t.name === type.name);
}

/** Whether `build_copy` must route the field through a `.copy()` call (a
 *  nested copyable struct, or a `List<T>` field): everything else byte
 *  copies through plain field assignment (strings strdup via the field-write
 *  path, primitives/plain enums are flat values). */
function field_copy_call(type: Type, status: CheckStatus): boolean {
	if (!type.name || type.is_array || type.is_ref || type.is_view || type.is_nullable) return false;
	if (type.name === "List" && type.type_args?.length === 1) {
		return element_copyable(type.type_args[0], status);
	}
	// Buffer/Set/Map fields route the synthesized body through their library
	// `copy` (either spelling — see container_element_args).
	const elem_args = container_element_args(type, status);
	if (elem_args) return elem_args.every((arg) => element_copyable(arg, status));
	const nested_struct = status.structs.find((s) => s.name === type.name);
	return (
		!!nested_struct && !nested_struct.is_simple_type && struct_is_copyable(nested_struct, status)
	);
}

/** Whether a REQUIRED field's shell-ctor argument must be an OWNED deep
 *  copy (`self.<field>.copy()` — the sanctioned spelling the "cannot copy
 *  field ... by value" diagnostics prescribe) instead of the raw
 *  `self.<field>` borrow: a nested copyable STRUCT. The ctor seed
 *  byte-copies the argument's bytes (the documented mv-transfer convention
 *  — the fresh temp's own cleanup is suppressed), so `c.<field>` ends up
 *  owning fresh independent state and never aliases `self.<field>`; the
 *  per-field rewrite below is then unnecessary for these fields.
 *  Containers are excluded: their `.copy()` is legal only as a
 *  container-store RHS (the mv store contract), never in argument
 *  position — they keep the field-store route with the displaced-alias
 *  stamp. Tuples/anon monos are excluded too (their generated shape has no
 *  user-spellable copy story); Box fields are class-shaped and never
 *  copyable. */
function ctor_arg_deep_copy(type: Type, status: CheckStatus): boolean {
	if (!type.name || type.is_array || type.is_ref || type.is_view || type.is_nullable) return false;
	if (type.name === "string") return false;
	if (is_box_type(type.name, status.structs)) return false;
	const mono_name = mono_struct_name(type, status);
	if (is_load_deep_copy_container(mono_name)) return false;
	const nested = status.structs.find(
		(s) => s.name === mono_name && !s.is_simple_type && !s.is_class && !s.is_generic,
	);
	if (!nested) return false;
	if (nested.name.startsWith("_Tuple_") || nested.name.startsWith("_Anon_")) return false;
	return struct_has_function(nested, "copy") || struct_is_copyable(nested, status);
}

/**
 * Synthesize `pub func copy(self) -> Struct` for mv value structs: a
 * fresh `Struct()` whose every field is rewritten from `self` — string
 * field writes strdup the source (the backends' field-write path), nested
 * copyable structs recurse through their own `copy`, everything else byte
 * copies. A required nested-copyable-struct field passes an OWNED
 * `.copy()` temp as the shell-ctor argument instead of the borrow (see
 * ctor_arg_deep_copy), so its seed owns independent state and the store
 * below is skipped. `return c` hits the return-boundary normalization (all
 * fields recorded → transfer raw), so the caller receives a uniformly
 * heap-owned value with no extra copies.
 */
function build_copy(struct: StructNode, status: CheckStatus): FunctionNode {
	const ctor_args = struct_copy_ctor_args(struct) ?? [];
	const arg_copy_fields = new Set<string>();
	const call_args = ctor_args.map((name) => {
		const field = struct.fields.find((f) => f.name === name);
		if (
			field &&
			!field.value &&
			(ctor_arg_deep_copy(field.type, status) || heap_array_copyable(field.type, status))
		) {
			arg_copy_fields.add(name);
			return method_call(field_access("self", name), "copy");
		}
		return field_access("self", name);
	});
	// The shell constructor's field arguments are raw `self.<field>` borrows
	// for the shapes ctor_arg_deep_copy doesn't route through `.copy()`
	// (string fields strdup at the ctor, containers alias until the per-field
	// stores below overwrite them). The checker's field-copy rule must not
	// reject this generated shape — stamp it (mirrors the per-field store
	// stamps below).
	const ctor = new FunctionCallNode(-1, struct.name, new Type(struct.name), call_args);
	ctor.synthesized_copy_ctor = true;
	const statements: BaseNode[] = [
		new DeclarationNode(-1, "private", "var", "c", new Type(struct.name), ctor),
	];
	for (const field of struct.fields) {
		if (arg_copy_fields.has(field.name)) continue;
		if (heap_array_copyable(field.type, status)) {
			// A defaulted `Array<T>` field: the shell ctor seeded a fresh
			// default buffer, which the field store frees (no alias stamp).
			const assign = new AssignmentNode(
				-1,
				field_access("c", field.name),
				method_call(field_access("self", field.name), "copy"),
			);
			assign.synthesized_copy_store = true;
			statements.push(assign);
			continue;
		}
		const right = field_copy_call(field.type, status)
			? method_call(field_access("self", field.name), "copy")
			: field_access("self", field.name);
		const assign = new AssignmentNode(-1, field_access("c", field.name), right);
		assign.synthesized_copy_store = true;
		if (field_copy_call(field.type, status)) {
			// The shell constructor took this field as a byte-copied borrow
			// (`Mid(self.inner)` — struct/container ctor params alias their
			// argument), so the displaced seed shares `self.<field>`'s heap
			// state: the field-store paths must drop the alias, not reclaim
			// it (only string ctor params strdup — their displaced free is
			// valid and stays unstamped). Required nested-copyable-struct
			// fields no longer ride this path — their shell-ctor argument is
			// an owned `.copy()` temp (ctor_arg_deep_copy) — but container
			// and tuple/anon fields still do.
			assign.displaced_is_alias = true;
		}
		statements.push(assign);
	}
	statements.push(new ReturnNode(-1, new ValueNode(-1, "c")));
	const fn = new FunctionNode(
		-1,
		"pub",
		"copy",
		new Type(struct.name),
		[self_param(struct)],
		statements,
	);
	// Move-on-last-use for structs: the marker tells the build-time last-use
	// pass this `copy` is EXACTLY a fresh deep copy, so a call site that is
	// the receiver's last use may be rewritten to a transfer (`mv`).
	fn.is_synthesized_copy = true;
	return fn;
}

/**
 * Synthesize the `copy` method on `struct` when eligible and not already
 * present. Called from the block-level copy pre-pass (which runs before the
 * struct is checked, so the method's body is checked with it) AND from
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
