import add_error from "../../add_error.ts";
import { in_place_arg_tree_ok } from "../../build_common/in_place_push.ts";
import { mono_type_name } from "../../build_common/mono_name.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import DeclarationNode from "../../nodes/DeclarationNode.ts";
import EnumNode from "../../nodes/EnumNode.ts";
import type FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import ParameterNode from "../../nodes/ParameterNode.ts";
import RootNode from "../../nodes/RootNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import { flatten_nested_generic_arg } from "../check_function_call_node.ts";
import type CheckStatus from "../CheckStatus.ts";
import { materialize_anon_enum_type } from "./anon_enum.ts";
import { borrow_depth_of } from "./borrow.ts";
import { type_owns_heap } from "./ownership.ts";
import { clone_type, materialize_tuple_type } from "./tuple_struct.ts";

/**
 * Monomorphize a generic enum (`enum Result<T, E>`) applied to concrete type
 * args, mirroring struct monomorphization: the mono name is derived via
 * `mono_type_name` (`Result<int, string>` → `Result_int_string`), case
 * payload types are substituted and resolved to emitted types (nested
 * generics flattened to their mono names, tuples/anonymous enums
 * materialized), and the result is registered in `status.enums`/
 * `status.types` and appended to the root so the build phase emits it.
 * Reuses an existing mono when one was already created.
 */
export function monomorphize_enum(
	generic_enum: EnumNode,
	type_args: Type[],
	status: CheckStatus,
): EnumNode | null {
	if (type_args.length !== generic_enum.type_params.length) {
		add_error(
			status,
			`Expected ${generic_enum.type_params.length} type arguments for ${generic_enum.name}, got ${type_args.length}`,
			generic_enum.start,
		);
		return null;
	}

	const flat_args = type_args.map((t) => flatten_nested_generic_arg(t, status));
	const mono_name = mono_type_name(generic_enum.name, flat_args);

	const existing =
		status.enums.find((e) => e.name === mono_name) || find_root_enum(status, mono_name);
	if (existing) {
		if (!status.enums.includes(existing)) {
			status.enums.push(existing);
		}
		return existing;
	}

	const substitution = new Map<string, Type>();
	for (let i = 0; i < generic_enum.type_params.length; i++) {
		substitution.set(generic_enum.type_params[i], flat_args[i]);
	}

	const cases = generic_enum.cases.map((c) => ({
		name: c.name,
		params: c.params.map((p) => {
			const direct = substitution.get(p.type.name);
			// A bare type-param payload (`T value`) becomes the concrete arg.
			if (direct && !p.type.type_args?.length && !p.type.tuple_types?.length) {
				return new ParameterNode(p.start, p.name, clone_type(direct));
			}
			// Composite payloads: substitute nested param references, then
			// resolve to a concrete emitted type (mirroring the payload
			// preparation in get_or_create_anon_enum).
			const substituted = clone_type(p.type);
			if (substituted.type_args?.length) {
				substituted.type_args = substituted.type_args.map((a) =>
					substitute_payload(a, substitution),
				);
				return new ParameterNode(
					p.start,
					p.name,
					clone_type(flatten_nested_generic_arg(substituted, status)),
				);
			}
			const resolved = substitute_payload(substituted, substitution);
			if (resolved.name === "tuple" && resolved.tuple_types?.length) {
				return new ParameterNode(p.start, p.name, materialize_tuple_type(resolved, status) as Type);
			}
			if (resolved.name === "anon_enum" && resolved.enum_cases?.length) {
				return new ParameterNode(p.start, p.name, materialize_anon_enum_type(resolved, status));
			}
			return new ParameterNode(p.start, p.name, resolved);
		}),
	}));

	const mono = new EnumNode(generic_enum.start, generic_enum.visibility, mono_name, cases);
	mono.is_generic = false;
	// STRUCT_PLAN_3 B1a + B1 full cutover: a mono's ownership is DERIVED from
	// its substituted payloads — an instantiation with a mv payload
	// (`Option<Box>`, `Result<int, string>` — string is mv per D3) is
	// move-only like a spelled `mv enum`. The generated mono cannot be
	// spelled `mv`, so the derivation IS the declaration (and the
	// Copyable verifier skips generated monos).
	mono.is_owning =
		generic_enum.is_owning ||
		cases.some((c) => c.params.some((p) => type_owns_heap(p.type, status)));
	// A checked generic enum's instantiations stay checked — the discard check
	// looks the concrete type up by its mono name. The template name/args are
	// kept so diagnostics can render `Result<int, string>` instead of the
	// monomorphized spelling.
	mono.checked = generic_enum.checked;
	mono.template_name = generic_enum.name;
	mono.template_args = flat_args.map(clone_type);
	// NOTE: deliberately NOT inheriting is_library. A mono enum is
	// auto-generated per use, so it belongs in the user TU (mirroring
	// `_Tuple_` structs in is_system_definition) — the precompiled system.o
	// cannot know which instantiations user code needs.

	status.enums.push(mono);
	if (!status.types.includes(mono_name)) {
		status.types.push(mono_name);
	}

	const root = status.stack[0] as RootNode;
	if (
		root &&
		!root.statements.some((s) => s.node_type === "enum" && (s as EnumNode).name === mono_name)
	) {
		root.statements.push(mono);
	}

	return mono;
}

/**
 * Find an enum registered at the root by name — a mono may already have been
 * emitted to root.statements from a different (cloned) check scope whose
 * status.enums copy we don't share.
 */ function find_root_enum(status: CheckStatus, name: string): EnumNode | undefined {
	const root = status.stack[0] as RootNode | undefined;
	if (!root) return undefined;
	return root.statements.find((s) => s.node_type === "enum" && (s as EnumNode).name === name) as
		| EnumNode
		| undefined;
}

/**
 * Find a concrete (monomorphized) enum by exact name, recovering monos that
 * were created inside a cloned check scope: a clone's `status.enums` dies with
 * the scope, but the mono node it appended to `root.statements` survives.
 * Re-registers a recovered mono into the current status so downstream lookups
 * (match exhaustiveness, build emission) see it.
 */
export function find_mono_enum(name: string, status: CheckStatus): EnumNode | undefined {
	const in_status = status.enums.find((e) => e.name === name && !e.is_generic);
	if (in_status) return in_status;
	const from_root = find_root_enum(status, name);
	if (from_root && !from_root.is_generic && !status.enums.includes(from_root)) {
		status.enums.push(from_root);
	}
	return from_root;
}

/**
 * Substitute type params inside a composite payload type (recursively through
 * type args, tuple elements, and anonymous enum case payloads).
 */
function substitute_payload(t: Type, substitution: Map<string, Type>): Type {
	const direct = substitution.get(t.name);
	if (direct && !t.type_args?.length && !t.tuple_types?.length && !t.enum_cases?.length) {
		return clone_type(direct);
	}
	if (t.type_args?.length) {
		const copy = clone_type(t);
		copy.type_args = t.type_args.map((a) => substitute_payload(a, substitution));
		return copy;
	}
	if (t.tuple_types?.length) {
		const copy = clone_type(t);
		copy.tuple_types = t.tuple_types.map((a) => substitute_payload(a, substitution));
		return copy;
	}
	if (t.enum_cases?.length) {
		const copy = clone_type(t);
		copy.enum_cases = t.enum_cases.map((c) => ({
			name: c.name,
			types: c.types.map((a) => substitute_payload(a, substitution)),
		}));
		return copy;
	}
	return clone_type(t);
}

/**
 * Enforce the ownership contract for CLASS/TRAIT case payloads at an enum
 * case construction (`Option<Box>.some(x)` / `.some(x)`).
 *
 * A class/trait payload is an OWNING slot: the tagged union stores the
 * instance pointer raw and the enum value's scope exit destroys + frees it —
 * the same single-ownership contract ClassBuffer<T> slots follow. A borrowed
 * argument would leave two owners (the payload and the borrow's source) — a
 * double free — so it is rejected here, mirroring mv-field stores. Fresh
 * constructions transfer soundly; an owned LOCAL is moved implicitly
 * (recorded in the node's move_param_indices so the build suppresses its own
 * scope-exit reclaim); an explicit `mv` arrives already recorded.
 */
export function enforce_case_payload_ownership(
	case_name: string,
	case_params: ParameterNode[],
	args: BaseNode[],
	node: { move_param_indices?: number[] },
	status: CheckStatus,
): void {
	for (let i = 0; i < args.length; i++) {
		const case_param = case_params[i];
		if (!case_param?.type.name || case_param.type.is_array) continue;
		// An OWNING payload slot: a class/trait reference (the tagged union
		// stores the pointer) or a mv-STRUCT value (the payload owns its
		// heap state). A borrowed argument would leave two owners — a double
		// free — so it is rejected here, mirroring mv-field stores.
		const payload_struct = status.structs.find((s) => s.name === case_param.type.name);
		const is_ref_payload =
			!!payload_struct?.is_class ||
			!!status.traits.find((t) => t.name === case_param.type.name) ||
			!!payload_struct?.is_owning;
		if (!is_ref_payload) continue;
		const arg = args[i];
		if (arg.node_type === "value" && (arg as import("../../nodes/ValueNode.ts").default).is_moved) {
			continue;
		}
		// A bare FIELD READ of a mv payload (`Option.some(self.item)`)
		// is a copy of the field's value — the payload would share the
		// field's owned state. Same rule as the declaration side: transfer
		// with `mv ... swap`, or construct fresh.
		if (
			arg.node_type === "access" &&
			(arg as import("../../nodes/AccessNode.ts").default).access.node_type === "access_field"
		) {
			add_error(
				status,
				`cannot pass a field read to case '.${case_name}' — the case payload takes ownership; construct a fresh instance or mv the field out with a swap`,
				arg.start,
			);
			continue;
		}
		if (borrow_depth_of(arg, status) !== undefined) {
			add_error(
				status,
				`cannot pass a borrowed value to case '.${case_name}' — the case payload takes ownership; construct a fresh instance or pass an owned local with 'mv'`,
				arg.start,
			);
			continue;
		}
		if (arg.node_type === "value") {
			if (!node.move_param_indices) node.move_param_indices = [];
			if (!node.move_param_indices.includes(i)) node.move_param_indices.push(i);
		}
	}
}

/**
 * Hoist a COMPUTED string argument (`s.copy()`, a concat) at an enum
 * case construction into a scoped `_param_N` temp — the same mechanism
 * `check_function_call` applies to ordinary call arguments.
 *
 * A string payload is an OWNED copy: the case ctor strdups the (ptr, len)
 * pair the argument builds (build_enum_node / emit_enum_payload_arg_store),
 * so the argument's own storage stays caller-owned. A bare local/param/field
 * rides that contract directly (its scope-exit free fires); a COMPUTED
 * expression has no owner — inline it leaks. The hoisted const is freed at
 * scope exit, balancing the ctor's strdup. `mv`-spelled args arrive as value
 * nodes with move records and skip this entirely.
 *
 * Indices named by `skip_indices` (the in-place payload stamp — see
 * stamp_in_place_enum_payloads) are NOT hoisted: the case store claims the
 * producing call's fresh buffer directly, so a hoisted temp would both
 * double-free and hide the win.
 */
export function hoist_case_string_arg_temp(
	case_params: ParameterNode[],
	args: BaseNode[],
	status: CheckStatus,
	skip_indices?: number[],
): void {
	for (let i = 0; i < args.length; i++) {
		const case_param = case_params[i];
		const t = case_param?.type;
		if (!t || t.name !== "string" || t.is_view || t.is_array) continue;
		if (skip_indices?.includes(i)) continue;
		const arg = args[i];
		if (arg.node_type === "value") continue;
		const declaration_name = `_param_${status.var_name_counter.value++}`;
		status.allocations.push(
			new DeclarationNode(arg.start, "private", "const", declaration_name, t, arg),
		);
		args.splice(i, 1, new ValueNode(arg.start, declaration_name, t));
	}
}

/**
 * Stamp the in-place construction guarantee's enum-payload tranche (PERF_PLAN
 * item 7) on an enum case construction: an argument that is a DIRECT CALL of
 * the payload type constructs straight into the payload slot instead of
 * hoisting a `_param_N` temp and strdup/struct-copying it in.
 *
 * The payload classes the guarantee is for — the ones today's store pays a
 * copy for — are the owned `string` (the case ctor strdups the pair) and the
 * value struct (the case store struct-copies it). A class/trait payload rides
 * as a bare handle (nothing to elide); a scalar stores its width straight
 * from the producing call's register (no temp exists).
 *
 * Soundness rests on the same facts the in-place push stamps against (see
 * build_common/in_place_push.ts): the callee must have a body (a value-struct
 * ctor of the payload type is sanctioned — its emission is unconditional and
 * both backends construct it into the preset destination), no `ref`
 * arguments, no field overrides, no spawn/weak construction flavors, and
 * every argument of the argument call an approved tree (a `bl` inside is
 * fine; a struct-returning nested call or a lambda is not — its own
 * suppressed `_call_ret_`/sret preset would collide with the payload
 * destination window).
 *
 * THE STAMP IS WHOLE-SITE for string payloads: a case whose string payloads
 * are not ALL direct calls is stamped not at all. The C backend lowers a
 * stamped construction with a `_take` variant of the case ctor, which claims
 * EVERY string argument's buffer — a hoisted temp or borrowed string at the
 * same site would be double-owned. Non-string payloads are unconstrained.
 * Both construction spellings (`.case(args)` access calls and the rewritten
 * `Enum_case(args)` shorthand) run this right before
 * `hoist_case_string_arg_temp`, whose skip list is the stamp.
 */
export function stamp_in_place_enum_payloads(
	enum_case: { params: ParameterNode[] },
	args: BaseNode[],
	node: { in_place_payload_indices?: number[] },
	status: CheckStatus,
): void {
	const is_string_payload = (t: Type | undefined): boolean =>
		!!t?.name && t.name === "string" && !t.is_view && !t.is_array;
	const is_struct_payload = (t: Type | undefined): boolean =>
		!!t?.name &&
		t.name !== "string" &&
		!t.is_view &&
		!t.is_array &&
		!t.is_ref &&
		!t.is_nullable &&
		!!status.structs.find(
			(s) => s.name === t.name && !s.is_simple_type && !s.is_class && !s.is_generic,
		);
	const in_place_call_ok = (call: FunctionCallNode): boolean => {
		// The callee's result must BE the payload value: a ctor of a
		// value-struct payload is the sanctioned shape (its `#init` emits
		// unconditionally); every other callee must have a body — foreign
		// callees keep the hoisted path.
		const payload_ctor = !!status.structs.find(
			(s) => s.name === call.name && !s.is_simple_type && !s.is_class && !s.is_generic,
		);
		if (!payload_ctor && !call.resolved_function?.has_body) return false;
		if (call.ref_param_indices?.length) return false;
		if (call.field_overrides?.length) return false;
		if (call.is_thread_ctor || call.is_fiber_ctor || call.is_awaitable_ctor || call.is_weak_ctor) {
			return false;
		}
		return call.params.every((a) => in_place_arg_tree_ok(a, status.structs));
	};
	const indices: number[] = [];
	for (let i = 0; i < enum_case.params.length; i++) {
		const payload_type = enum_case.params[i]?.type;
		if (!is_string_payload(payload_type) && !is_struct_payload(payload_type)) continue;
		const arg = args[i];
		if (arg?.node_type !== "func_call") continue;
		const call = arg as FunctionCallNode;
		// The argument call's own result type must match the payload type
		// exactly (a `string` payload takes a string-producing call).
		if (call.type?.name !== payload_type!.name) continue;
		if (!in_place_call_ok(call)) continue;
		indices.push(i);
	}
	// Whole-site rule: every string payload's argument must have stamped —
	// the take-variant claims all of them (see the doc comment).
	for (let i = 0; i < enum_case.params.length; i++) {
		if (is_string_payload(enum_case.params[i]?.type) && !indices.includes(i)) return;
	}
	if (indices.length) node.in_place_payload_indices = indices;
}
