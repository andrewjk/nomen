import emit_field_overrides, {
	has_field_overrides,
	hoist_field_overrides,
} from "../build/emit_field_overrides.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import { is_nullable_struct_type } from "../build_common/nullable_struct.ts";
import { is_string_borrow } from "../build_common/string_return_analysis.ts";
import { move_on_last_use_enabled } from "../check/utils/last_use.ts";
import type { NirExpr } from "../nir/nir.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { build_vtable_target } from "./build_access_node.ts";
import {
	emit_struct_destroys,
	release_recorded_string_fields,
	struct_needs_destroy_by_name,
} from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import { is_owned_heap_temp } from "./build_operation_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { emit_expr_from_nir } from "./emit_nir.ts";
import c_function_name from "./utils/c_function_name.ts";
import { find_decl_in_c_scopes, splice_decl_from_c_scopes } from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import { c_materialize_view_string, c_view_string_arg, is_view_value } from "./utils/view_value.ts";

let string_field_counter = 0;

/** Per-build reset: builds must be deterministic per process (the NIR
 *  byte-identity tests build the same program twice). */
export function reset_string_field_counter() {
	string_field_counter = 0;
}

/**
 * Emit an assignment RHS. Under NIR-driven emission the lowered `NirExpr`
 * rides in and descends through `emit_expr_from_nir` (the expression seam);
 * without one — or if the lowered expr doesn't carry this exact AST node
 * (from_ast is 1:1, so that can't happen) — it is exactly the historical
 * `build_node(rhs)`. Every semantic decision (reclamation, aliasing, move
 * marks, strdup rules, swap marshalling) stays on the AST node in the
 * builder.
 */
function emit_rhs_value(rhs: BaseNode, nir: NirExpr | null | undefined, status: BuildStatus): void {
	if (nir && nir.node === rhs) {
		emit_expr_from_nir(nir, status);
		return;
	}
	build_node(rhs, status);
}

export default function build_assignment_node(
	node: AssignmentNode,
	status: BuildStatus,
	nir_rhs?: NirExpr | null,
	nir_swap?: NirExpr | null,
) {
	// Evaluate override values into temporaries before the base lands in the
	// destination, so an override reading the destination (`m = [ .. x,
	// node_type = m.node_type ]`) sees the pre-assignment value.
	hoist_field_overrides(
		node.right_value,
		build_node,
		status,
		";\n",
		node.left_value.node_type === "value" ? (node.left_value as ValueNode).value : undefined,
	);
	// Check whether this is an access of a field from a trait rather than a concrete type
	// HACK: This needs to be much more comprehensive, e.g. to handle access
	// chains where something in the middle is a trait
	if (node.left_value.node_type === "access") {
		const accessNode = node.left_value as AccessNode;
		if (accessNode.target.node_type === "value") {
			const traitName = type_from_value_node(accessNode.target as ValueNode).name;
			const trait = status.traits.find((t) => t.name === traitName);
			if (trait) {
				const traitField = trait.fields.find((f) => f.name == accessNode.access.name)!;
				// Struct field types need the `struct` tag in C; scalars/strings
				// lower via c_type directly. Multi-word struct trait fields are
				// passed by value to the set accessor. The tag (plain name) is
				// never mangled — only the typedef is.
				const field_is_struct = !!status.structs.find(
					(s) => s.name === traitField.type.name && !s.is_simple_type,
				);
				const type = field_is_struct
					? `struct ${traitField.type.name}`
					: c_type(traitField.type.name);
				const cast = `(void (*)(void *, ${type}))`;
				// The vtable lives at offset 0 of the struct, so _get_trait_func
				// and the accessor both need a POINTER to the receiver. Use
				// build_vtable_target so a value-struct trait-typed local is
				// passed as `&p` (a ref/class/trait param is already a pointer).
				status.code += `(${cast}_get_trait_func((void *)`;
				build_vtable_target(accessNode.target, status);
				const traitIndex = status.traits.indexOf(trait);
				const fieldIndex = trait.functions.length + trait.fields.indexOf(traitField) * 2 + 1;
				status.code += `, ${traitIndex}, ${fieldIndex}))(`;
				build_vtable_target(accessNode.target, status);
				status.code += `, `;
				emit_rhs_value(node.right_value, nir_rhs, status);
				status.code += `)`;

				return;
			}
		}
	}

	// Class field reassignment (`obj.field = rhs`) where the field is an
	// owned (move) class slot: eagerly reclaim the field's old value before
	// overwriting it. At scope exit only the container's `<Container>_destroy`
	// runs, which frees the field's *current* value — any value displaced by
	// this assignment would otherwise leak (and its #destroy would never run).
	if (
		!node.operator &&
		node.left_value.node_type === "access" &&
		(node.left_value as AccessNode).access.node_type === "access_field"
	) {
		const access_lhs = node.left_value as AccessNode;
		const field_access_node = access_lhs.access as AccessFieldNode;
		const field_type = field_access_node.type;
		const field_struct = field_type?.name
			? status.structs.find((s) => s.name === field_type.name && s.is_class)
			: null;
		if (field_struct) {
			// Look up the field definition to check if it's `move` (owned).
			// Only owned fields should be eagerly freed on reassignment.
			const target_type = type_from_value_node(access_lhs.target);
			const target_struct = target_type?.name
				? status.structs.find((s) => s.name === target_type.name && !s.is_simple_type)
				: null;
			const field_def = target_struct?.fields.find((f) => f.name === field_access_node.name);
			const field_is_owned = field_def?.declaration === "move";
			if (field_is_owned) {
				// A custom `#init`'s first write to a `self.<field>` overwrites
				// garbage (fresh malloc — no displaced value to reclaim). Later
				// writes in the same init DO displace a real instance and
				// reclaim normally.
				const init_target_is_self =
					access_lhs.target.node_type === "value" &&
					(access_lhs.target as ValueNode).value === "self" &&
					status.current_function?.name === "#init";
				const init_field_key = `self.${field_access_node.name}`;
				const first_init_write =
					init_target_is_self && !status.init_assigned_fields?.has(init_field_key);
				if (init_target_is_self && status.init_assigned_fields) {
					status.init_assigned_fields.add(init_field_key);
				}
				// Capture the emitted field-access expression (e.g. `h->c`) by
				// building it into status.code then rolling back, so the normal
				// assignment path below re-emits it exactly once.
				const before_len = status.code.length;
				build_node(node.left_value, status);
				const field_access = status.code.substring(before_len);
				status.code = status.code.substring(0, before_len);
				if (!first_init_write) {
					if (field_type?.is_nullable) {
						status.code += `if (${field_access}) { ${field_struct.name}_destroy(${field_access}); free(${field_access}); }\n`;
					} else {
						status.code += `${field_struct.name}_destroy(${field_access}); free(${field_access});\n`;
					}
				}
				// Ownership transfer: assigning a bare variable to an owned
				// (`move`) class field moves ownership from the source variable
				// to the field. Remove the source from whichever scope frame
				// holds it (the source may be declared in an OUTER scope when
				// the assignment sits inside an if/loop branch) so it is NOT
				// freed at scope exit (the field's container destroy reclaims
				// it). Without this, the source and the field alias the same
				// instance and both get freed -> use-after-free.
				// Mirrors aarch64's mark_moved_if_struct.
				if (node.right_value.node_type === "value") {
					splice_decl_from_c_scopes(status, (node.right_value as ValueNode).value);
				}
			}
		}
	}

	// A `field = move local` store into a VALUE-struct field (List/Map/Buffer
	// …): ownership transfers from the local to the field. The plain store
	// shallow-copies the struct, so WITHOUT the splice the source local's
	// scope-exit destroy frees the buffer the field now points at (dangling
	// field — UAF at first use). Splice the source from its scope frame and
	// reclaim the displaced field value before the store. (`field = move c
	// swap T()` was the sound workaround; this makes the plain form work.)
	if (
		!node.operator &&
		node.left_value.node_type === "access" &&
		(node.left_value as AccessNode).access.node_type === "access_field" &&
		node.right_value.node_type === "value" &&
		(node.right_value as ValueNode).is_moved
	) {
		const access_lhs = node.left_value as AccessNode;
		const field_type = (access_lhs.access as AccessFieldNode).type;
		const field_struct =
			field_type?.name && !field_type.is_view && !field_type.is_array
				? status.structs.find(
						(s) => s.name === field_type.name && !s.is_simple_type && !s.is_class,
					)
				: undefined;
		if (field_struct) {
			// Transfer: the source local (possibly declared in an OUTER scope
			// when the assignment sits inside an if/loop branch) must not be
			// destroyed at its scope exit.
			splice_decl_from_c_scopes(status, (node.right_value as ValueNode).value);
			const before_len = status.code.length;
			build_node(node.left_value, status);
			const field_access = status.code.substring(before_len);
			status.code = status.code.substring(0, before_len);
			// Reclaim the field's displaced value (its current buffer/payloads)
			// — the store overwrites them. A custom `#init`'s first write to a
			// `self.<field>` overwrites garbage — nothing valid to destroy.
			const field_key = `self.${(access_lhs.access as AccessFieldNode).name}`;
			const first_init_write =
				access_lhs.target.node_type === "value" &&
				(access_lhs.target as ValueNode).value === "self" &&
				status.current_function?.name === "#init" &&
				!status.init_assigned_fields?.has(field_key);
			if (access_lhs.target.node_type === "value" &&
				(access_lhs.target as ValueNode).value === "self" &&
				status.current_function?.name === "#init") {
				if (!status.init_assigned_fields) status.init_assigned_fields = new Set();
				status.init_assigned_fields.add(field_key);
			}
			if (!first_init_write && struct_needs_destroy_by_name(field_struct.name, status)) {
				emit_struct_destroys(status, field_struct, field_access);
			}
			status.code += `${field_access} = `;
			emit_rhs_value(node.right_value, nir_rhs, status);
			status.code += `;\n`;
			return;
		}
	}

	// A `view T` field assignment (`obj.field = rhs`): the field is a
	// non-owning (ptr, len) pair — store it raw. Nothing is duplicated and
	// the displaced pair owns nothing, so there is no free / strdup /
	// ownership bookkeeping (unlike an owned string field). The RHS goes
	// through c_view_string_arg: a view value passes through; an owned fat
	// string wraps into the (nomen_view){ ptr, len } form.
	if (
		!node.operator &&
		node.left_value.node_type === "access" &&
		(node.left_value as AccessNode).access.node_type === "access_field" &&
		(node.left_value as AccessNode).access.type?.is_view
	) {
		const before_len = status.code.length;
		build_node(node.left_value, status);
		const field_access = status.code.substring(before_len);
		status.code = status.code.substring(0, before_len);
		status.code += `${field_access} = `;
		c_view_string_arg(node.right_value, status);
		status.code += `;\n`;
		return;
	}

	// A plain `string` field assignment (`obj.field = rhs`): the field keeps a
	// heap-owned value. For CLASS targets the field is always heap (`_init`
	// strdup's defaults; <Class>_destroy frees unconditionally), so the old
	// value is freed eagerly here. For VALUE-struct targets construction may
	// leave a static literal in the field — free the old value only when a
	// previous assignment recorded it, and record the field so auto_free (or
	// the move-site release) reclaims the final value. A fresh-heap RHS
	// (is_owned_heap_temp — the C backend strdup's every string return) is
	// stored directly; anything else is strdup'd so the field owns a copy.
	if (
		!node.operator &&
		node.left_value.node_type === "access" &&
		(node.left_value as AccessNode).access.node_type === "access_field" &&
		(node.left_value as AccessNode).access.type?.name === "string" &&
		!(node.left_value as AccessNode).access.type?.is_ref &&
		!(node.left_value as AccessNode).access.type?.is_array
	) {
		const access_lhs = node.left_value as AccessNode;
		const field_access_node = access_lhs.access as AccessFieldNode;
		let target_type = type_from_value_node(access_lhs.target);
		// The implicit `self` param may carry no type on its ValueNode —
		// resolve it against the struct being built (mirrors build_access_node).
		if (
			!target_type?.name &&
			access_lhs.target.node_type === "value" &&
			(access_lhs.target as ValueNode).value === "self" &&
			status.current_struct
		) {
			target_type = new Type(status.current_struct.name);
		}
		const target_struct = target_type?.name
			? status.structs.find((s) => s.name === target_type.name && !s.is_simple_type)
			: null;
		const target_var =
			access_lhs.target.node_type === "value" ? (access_lhs.target as ValueNode).value : "";
		const self_target = target_var === "self";
		const tracked_key = `${target_var}.${field_access_node.name}`;
		// A custom `#init`'s first write to a `self.<field>` overwrites
		// garbage — no displaced string to free (see init_assigned_fields).
		const first_init_write =
			self_target &&
			status.current_function?.name === "#init" &&
			!status.init_assigned_fields?.has(tracked_key);
		if (self_target && status.current_function?.name === "#init") {
			if (!status.init_assigned_fields) status.init_assigned_fields = new Set();
			status.init_assigned_fields.add(tracked_key);
		}
		const old_was_heap =
			(!!target_struct?.is_class && !first_init_write) ||
			!!status.heap_string_fields?.has(tracked_key);
		// A `self.field = …` write inside a VALUE-struct method writes through
		// to the caller's storage (ownership is tracked by the CALLER via
		// heap_string_fields, dropped at the call site by
		// drop_self_written_string_field_records) — strdup'ing here would
		// leave an untracked heap copy, so it keeps the raw store. A CLASS
		// `self.field = …` is always-heap (`_init` strdup's defaults,
		// `<Class>_destroy` frees unconditionally), so it gets the
		// ownership-normalized lowering like any other class target —
		// otherwise the field ends up holding a borrow (a rodata literal or a
		// caller-owned heap string) that destroy invalidly frees. Mirrors the
		// aarch64 backend's `target_is_class ||` gate.
		if (target_struct && target_var && (!self_target || target_struct.is_class)) {
			const fresh_heap = is_owned_heap_temp(node.right_value, status);
			// A literal `null` RHS zero-initializes the nullable field's pair
			// (a bare `0` inside nomen_str_dup(...) would be a C type error;
			// the NULL `.ptr` keeps the free paths no-op-safe). The displaced
			// old value is still reclaimed below.
			const rhs_is_null_value =
				node.right_value.node_type === "value" && (node.right_value as ValueNode).value === "null";
			// Capture the field-access expression (e.g. `b->text`) by building
			// it then rolling back, so it can be referenced multiple times.
			const before_len = status.code.length;
			build_node(node.left_value, status);
			const field_access = status.code.substring(before_len);
			status.code = status.code.substring(0, before_len);
			const temp = `_nomen_strfield_${string_field_counter++}`;
			status.code += `{\nnomen_string ${temp} = `;
			if (rhs_is_null_value) {
				status.code += `(nomen_string){0, 0}`;
			} else if (fresh_heap) {
				emit_rhs_value(node.right_value, nir_rhs, status);
			} else {
				status.code += `nomen_str_dup(`;
				emit_rhs_value(node.right_value, nir_rhs, status);
				status.code += `)`;
			}
			status.code += `;\n`;
			if (old_was_heap) {
				status.code += `free(${field_access}.ptr);\n`;
			}
			status.code += `${field_access} = ${temp};\n}\n`;
			if (!target_struct.is_class) {
				if (!status.heap_string_fields) status.heap_string_fields = new Set<string>();
				status.heap_string_fields.add(tracked_key);
			}
			return;
		}
	}

	// Enum-with-data FIELD assignment (`obj.field = rhs`): the field owns its
	// active case's payloads, so the displaced value's payloads are freed
	// (tag-guarded) before the store. The RHS transfers ownership by value
	// (case construction strdups its string args; a call result owns its
	// payloads), matching the local-enum reassignment below. Reference
	// payloads are released too via the enum's helper.
	if (
		!node.operator &&
		node.left_value.node_type === "access" &&
		(node.left_value as AccessNode).access.node_type === "access_field"
	) {
		const field_type = (node.left_value as AccessNode).access.type;
		const field_enum =
			field_type?.name && !field_type.is_ref
				? status.enums.find((e) => e.name === field_type.name && e.has_associated_data)
				: undefined;
		if (field_enum) {
			const before_len = status.code.length;
			build_node(node.left_value, status);
			const field_access = status.code.substring(before_len);
			status.code = status.code.substring(0, before_len);
			// A custom `#init`'s first write to a `self.<field>` overwrites
			// garbage — there are no valid payloads to free.
			const enum_target = (node.left_value as AccessNode).target;
			const enum_field_key = `self.${field_access_node_name(node)}`;
			const enum_first_init_write =
				enum_target.node_type === "value" &&
				(enum_target as ValueNode).value === "self" &&
				status.current_function?.name === "#init" &&
				!status.init_assigned_fields?.has(enum_field_key);
			if (
				enum_target.node_type === "value" &&
				(enum_target as ValueNode).value === "self" &&
				status.current_function?.name === "#init"
			) {
				if (!status.init_assigned_fields) status.init_assigned_fields = new Set();
				status.init_assigned_fields.add(enum_field_key);
			}
			if (!enum_first_init_write) {
				status.code += `${field_enum.name}_free_payloads(&${field_access});\n`;
			}
			status.code += `${field_access} = `;
			emit_rhs_value(node.right_value, nir_rhs, status);
			status.code += `;\n`;
			return;
		}
	}

	/**
 * The field name of a `self.<field>` assignment LHS, for the
 * `init_assigned_fields` bookkeeping in paths that don't bind `access_lhs`.
 */
function field_access_node_name(node: AssignmentNode): string {
	const access = (node.left_value as AccessNode).access as AccessFieldNode;
	return access.name;
}

// Borrowed string RHS (e.g. `filename = init.args.at(1)`): the LHS gives up
	// ownership — `args.at()` returns a pointer into argv (or a container's
	// storage), which must not be freed. Record the LHS in string_borrow_vars so
	// auto_free — which runs in the variable's *declaration* scope, possibly an
	// outer scope we can't reach from here — skips it. Reclaim the LHS's OLD
	// owned value now (its current pointer, before the overwrite) so it doesn't
	// leak — but only if the LHS isn't already itself a borrow (a second borrow
	// reassignment must not free the prior borrow).
	if (
		!node.operator &&
		node.left_value.node_type === "value" &&
		is_string_borrow(node.right_value)
	) {
		const lhs_name = (node.left_value as ValueNode).value;
		// Search every scope frame: the LHS may be declared in an outer scope
		// (e.g. reassigned inside an if branch), and the displaced owned value
		// must still be reclaimed eagerly.
		const lhs_hit = find_decl_in_c_scopes(status, lhs_name);
		const lhs_decl = lhs_hit ? lhs_hit.frame[lhs_hit.index] : undefined;
		const lhs_type = lhs_decl?.type || status.variable_types?.get(lhs_name);
		// Only string-typed LHS need borrow handling — an int/struct element
		// access like `first = p.at(0)` (int array) is a plain value copy with
		// no ownership to manage, and freeing it would be invalid.
		if (lhs_type?.name === "string") {
			// Force-heap target (the scan proved it receives a heap value
			// somewhere later): the variable must own heap on EVERY path, so
			// the borrow reception is strdup'd into an owned copy instead of
			// the raw borrow store. The variable stays a FULL owner — its decl
			// is never spliced and string_borrow_vars is never joined — so a
			// later reassignment (`b = t`, possibly conditionally) takes the
			// owned-string path and frees the displaced copy validly.
			// Temp-first: the borrow expression may read the LHS.
			if (status.force_heap_strings?.has(lhs_name)) {
				const id = (status.label_counter = (status.label_counter ?? 0) + 1);
				const temp = `_borrow_dup_${id}`;
				status.code += `nomen_string ${temp} = nomen_str_dup(`;
				emit_rhs_value(node.right_value, nir_rhs, status);
				status.code += `);\n`;
				status.code += `free(${lhs_name}.ptr);\n`;
				status.code += `${lhs_name} = ${temp};\n`;
				if (!status.heap_strings) status.heap_strings = new Set();
				status.heap_strings.add(lhs_name);
				return;
			}
			const was_borrow = !!status.string_borrow_vars?.has(lhs_name);
			if (!status.string_borrow_vars) status.string_borrow_vars = new Set();
			status.string_borrow_vars.add(lhs_name);
			if (!was_borrow) {
				if (lhs_hit) lhs_hit.frame.splice(lhs_hit.index, 1);
				status.code += `free(${lhs_name}.ptr);\n`;
			}
		}

		// Fall through to the generic `lhs = rhs` emission below.
	}

	// String/class variable reassignment: eagerly free the old heap value
	// (so it doesn't leak), then decide whether the variable still owns a
	// heap value. If the RHS is a fresh allocation (function call, operation,
	// method result), the variable owns the new value — keep it in
	// scoped_declarations so auto_free frees it at scope exit. If the RHS is
	// a bare variable (alias) or a literal (not heap), remove it from
	// scoped_declarations so auto_free skips it (matches aarch64's
	// heap_strings / class-anchor tracking).
	// For class vars: the RHS source variable transfers ownership to the LHS
	// (removed from scoped_declarations so it won't be double-freed).
	if (!node.operator && node.left_value.node_type === "value") {
		const lhs_name = (node.left_value as ValueNode).value;
		// Resolve the LHS's declaration through every scope frame (innermost
		// first) so a trait-typed local declared in an OUTER scope is found
		// from inside a loop/if body, and a shadowing inner declaration never
		// inherits the outer one's trait record.
		const lhs_scope_hit = find_decl_in_c_scopes(status, lhs_name);
		const lhs_decl = status.scoped_declarations.find((d) => d.name === lhs_name);
		// class_vars is copy-on-enter per scope (enter_c_scope), so entries
		// from enclosing scopes stay visible here, while a sibling scope's
		// same-named entry never leaks in.
		const lhs_in_class_vars = !!status.class_vars?.has(lhs_name);
		const lhs_type = lhs_decl?.type || status.variable_types?.get(lhs_name);
		const lhs_struct = lhs_type ? status.structs.find((s) => s.name === lhs_type.name) : null;
		const lhs_is_string = lhs_type?.name === "string";
		const lhs_is_class = !!lhs_struct?.is_class || lhs_in_class_vars;
		// A trait-typed class local (`var Speaker s = Dog(); s = Cat()`)
		// reclaims its old instance via the trait's `<Trait>_destroy` shim
		// (the concrete type at runtime may differ from the initializer's
		// after a prior reassignment), then stores the new pointer. The RHS
		// is cast to `void *` so any conforming class pointer assigns. The
		// trait name comes from the LHS's own declaration (scope-correct),
		// never a body-global name map.
		const lhs_trait_class = lhs_scope_hit
			? lhs_scope_hit.frame[lhs_scope_hit.index].trait_class_trait
			: undefined;
		if (lhs_trait_class !== undefined && !node.operator) {
			const rhs = node.right_value;
			const rhs_is_bare_value = rhs.node_type === "value";
			// Alias safety (two-tier trait copies): a slot that is itself an
			// ALIAS of a class-backed trait local (`var Rule b = a`) owns
			// nothing — reassignment overwrites the pointer without
			// reclaiming (the source still owns the instance). And when THIS
			// slot has live aliases, the displaced instance is still shared —
			// skip the destroy (bounded leak) rather than dangle them.
			const lhs_is_alias_copy = !!status.class_alias_vars?.has(lhs_name);
			const lhs_has_alias = !!status.aliased_class_sources?.has(lhs_name);
			const reclaim = !lhs_is_alias_copy && !lhs_has_alias;
			// Compute a non-bare RHS into a temp first to avoid use-after-free
			// when it references the LHS.
			if (!rhs_is_bare_value) {
				const id = (status.label_counter = (status.label_counter ?? 0) + 1);
				const temp = `_treassign_${id}`;
				status.code += `void *${temp} = (void *)`;
				emit_rhs_value(rhs, nir_rhs, status);
				status.code += `;\n`;
				if (reclaim) {
					if (lhs_type?.is_nullable) {
						status.code += `if (${lhs_name}) { ${lhs_trait_class}_destroy(${lhs_name}); free(${lhs_name}); }\n`;
					} else {
						status.code += `${lhs_trait_class}_destroy(${lhs_name}); free(${lhs_name});\n`;
					}
				}
				status.code += `${lhs_name} = ${temp};\n`;
			} else {
				if (reclaim) {
					if (lhs_type?.is_nullable) {
						status.code += `if (${lhs_name}) { ${lhs_trait_class}_destroy(${lhs_name}); free(${lhs_name}); }\n`;
					} else {
						status.code += `${lhs_trait_class}_destroy(${lhs_name}); free(${lhs_name});\n`;
					}
				}
				status.code += `${lhs_name} = (void *)`;
				emit_rhs_value(rhs, nir_rhs, status);
				status.code += `;\n`;
			}
			return;
		}
		// An owned string may be declared in an outer scope (`var s = ""`) and
		// reassigned inside a loop body, where scoped_declarations has been
		// reset (so lhs_decl is undefined). owned_string_vars persists across
		// scope resets, so use it to still reclaim the displaced value.
		const lhs_is_owned_string =
			lhs_is_string &&
			!!status.owned_string_vars?.has(lhs_name) &&
			!status.string_borrow_vars?.has(lhs_name);
		// `ref` class param reassignment (`h = Holder(...)` where h is a
		// double-pointer `struct T **`): eagerly destroy+free the caller's OLD
		// instance (`*h`), then write the new instance back through the slot
		// (`*h = ...`). Mirrors aarch64's ref_class_slots write-back. This is
		// the caller's memory; no borrows of the old value survive across the
		// call boundary, so eager reclamation is safe.
		const ref_param_type = status.ref_class_param_types?.get(lhs_name);
		if (status.ref_class_params?.has(lhs_name) && ref_param_type) {
			const mono = mono_type_name(ref_param_type);
			const destroy_struct =
				status.structs.find((s) => s.name === mono && !s.is_generic) ??
				status.structs.find((s) => s.name === ref_param_type.name);
			if (!destroy_struct) {
				status.code += `*${lhs_name} = `;
				emit_rhs_value(node.right_value, nir_rhs, status);
				status.code += `;\n`;
				return;
			}
			if (ref_param_type.is_nullable) {
				status.code += `if (*${lhs_name}) { ${destroy_struct.name}_destroy(*${lhs_name}); free(*${lhs_name}); }\n`;
			} else {
				status.code += `${destroy_struct.name}_destroy(*${lhs_name}); free(*${lhs_name});\n`;
			}
			status.code += `*${lhs_name} = `;
			emit_rhs_value(node.right_value, nir_rhs, status);
			status.code += `;\n`;
			return;
		}
		// If the LHS was previously moved out (`take(move a)`), its old value is
		// owned by the callee and must NOT be reclaimed here. Just overwrite —
		// the fall-through path emits `a = <rhs>` — and clear the moved flag so
		// the new value is tracked normally again.
		if (status.moved?.has(lhs_name) && lhs_is_class) {
			status.moved.delete(lhs_name);
			// Re-register the slot so the NEW value is reclaimed at scope exit,
			// unless the RHS is `null` or a bare alias (both are value-nodes and
			// don't create a new owned instance here). The original decl was
			// spliced when the var was moved out, so reconstruct one from the
			// known LHS type.
			if (node.right_value.node_type !== "value" && lhs_type) {
				const decl =
					lhs_decl ?? new DeclarationNode(node.start, "private", "var", lhs_name, lhs_type);
				if (!status.scoped_declarations.some((d) => d.name === lhs_name)) {
					status.scoped_declarations.push(decl);
				}
			}
			// Fall through to the normal `lhs = rhs` emission below.
		} else if (
			(lhs_decl || lhs_in_class_vars || lhs_is_owned_string) &&
			(lhs_is_string || lhs_is_class)
		) {
			const rhs = node.right_value;
			const rhs_is_bare_value = rhs.node_type === "value";

			// Eagerly reclaim the old owned value before overwriting (it
			// would otherwise leak — auto_free only runs at scope exit and
			// would miss this intermediate value). For a class var that
			// genuinely owns its current value, run the class's
			// `<Class>_destroy` first (it may print / free owned sub-fields);
			// nullable slots may be null, so guard with `if`. Object-level
			// aliases (`var q = p`, recorded in class_alias_vars) do NOT own
			// their current value — destroying it would reclaim the shared
			// instance — so for those keep the historical plain free() that
			// the existing alias tests rely on. An owner is detected via
			// scoped_declarations (current scope) OR class_vars (outer scope,
			// e.g. a loop body that resets scoped_declarations).
			//
			// BUT: if the LHS has itself been aliased (`var Box b = a; a =
			// ...`), the old value is still referenced by the alias `b`.
			// Eagerly freeing it would cause a use-after-free when the alias
			// is used next. Skip the free entirely — the old value leaks
			// (the C backend has no deferred-reclamation mechanism like
			// aarch64's anchor slots), but the alias remains valid.
			const lhs_is_alias = !!status.class_alias_vars?.has(lhs_name);
			const lhs_has_alias = !!status.aliased_class_sources?.has(lhs_name);
			if (lhs_has_alias) {
				// The old value is still referenced by an alias (`var Box b =
				// a; a = Box(99)`), so it must NOT be freed here. Transfer
				// ownership of the old instance to the alias(es): re-add their
				// declarations to scoped_declarations so the old value is
				// destroyed/freed exactly once at scope exit (the alias, being
				// in class_alias_vars, is otherwise never freed). Mirrors
				// aarch64's mark_anchor_destroy on the alias.
				const aliases = status.class_alias_source_map?.get(lhs_name) ?? [];
				for (const alias_decl of aliases) {
					const already = status.scoped_declarations.some((d) => d.name === alias_decl.name);
					if (!already) status.scoped_declarations.push(alias_decl);
					// Ownership of the old instance now rests with the alias:
					// set its runtime owns-flag so the (flag-guarded) scope-exit
					// destroy actually fires.
					const alias_flag = status.c_alias_owns_flags?.get(alias_decl.name);
					if (alias_flag !== undefined) {
						status.code += `${alias_flag} = 1;\n`;
					}
				}
			} else if (lhs_is_class && lhs_struct && !lhs_is_alias && (lhs_decl || lhs_in_class_vars)) {
				// Deferred reclamation: capture the old instance into a temp
				// and destroy+free it at scope exit (build_auto_free emits the
				// deferred frees). Freeing eagerly here would invalidate
				// borrows of the old value's fields — e.g.
				// `var Box b = h.c; h = Holder(...)` must keep `b` pointing at
				// the old Box until the scope ends. Mirrors aarch64's
				// anchor-slot deferred reclamation. The temp is a plain local
				// C pointer in this scope's block (not in scoped_declarations,
				// so it is freed exactly once via deferred_frees).
				const id = (status.label_counter = (status.label_counter ?? 0) + 1);
				const temp = `_deferred_${id}`;
				status.code += `struct ${lhs_struct.name}* ${temp} = ${lhs_name};\n`;
				if (!status.deferred_frees) status.deferred_frees = [];
				status.deferred_frees.push({
					temp,
					struct_name: lhs_struct.name,
					is_nullable: !!lhs_type?.is_nullable,
				});
			} else if (lhs_is_class && lhs_is_alias && status.c_alias_owns_flags?.has(lhs_name)) {
				// Alias reassignment to a fresh instance (`q = R(3)` where
				// `var R q = p`): the alias only owns its value AFTER its first
				// reassignment, so free the old instance only when the runtime
				// owns-flag is set (a loop reassigning the alias reclaims every
				// former instance from iteration 2 on; iteration 1 leaves the
				// shared original for its owner). Then flag the alias as owning
				// and register its scope-exit destroy in the frame that DECLARED
				// it (not the current one — the reassignment may sit in a loop
				// body). Mirrors aarch64's alias_owns_flag + mark_anchor_destroy.
				// A TRAIT slot uses the trait's `<Trait>_destroy` shim (the
				// concrete type may vary); it has no `lhs_struct` (traits
				// aren't structs), so take the name from the declared type.
				// A REBORROWING RHS (a non-`owned_return` accessor like
				// `.at(i)`) keeps the alias a borrow: the new value is owned by
				// its container, so the owns-flag is left at 0 and the
				// flag-guarded scope-exit destroy never fires (an earlier
				// owned-reassignment registration stays, harmlessly guarded).
				const alias_destroy_name = lhs_struct?.name ?? lhs_type?.name;
				const rhs_is_reborrow =
					node.right_value.node_type === "access" &&
					(node.right_value as AccessNode).access.node_type === "access_func" &&
					!((node.right_value as AccessNode).access as AccessFunctionCallNode).owned_return;
				if (alias_destroy_name) {
					const flag = status.c_alias_owns_flags.get(lhs_name)!;
					status.code += `if (${flag}) { ${alias_destroy_name}_destroy(${lhs_name}); free(${lhs_name}); }\n`;
					status.code += `${flag} = ${rhs_is_reborrow ? 0 : 1};\n`;
					if (!rhs_is_reborrow) {
						const frame = status.alias_decl_frames?.get(lhs_name) ?? status.scoped_declarations;
						if (!frame.some((d) => d.name === lhs_name)) {
							const decl =
								lhs_decl ?? new DeclarationNode(node.start, "private", "var", lhs_name, lhs_type!);
							// The registration must carry the trait record so
							// auto_free's trait branch reclaims through the shim.
							if (!lhs_struct) decl.trait_class_trait = lhs_type?.name;
							frame.push(decl);
						}
					}
				}
			} else if (lhs_is_string) {
				// For a string with a non-bare RHS that may reference the LHS
				// (e.g. `s = f(s)` or `s = s + "x"`), compute the RHS into a
				// temp BEFORE freeing the old value to avoid use-after-free.
				if (lhs_is_string && !rhs_is_bare_value) {
					const id = (status.label_counter = (status.label_counter ?? 0) + 1);
					const temp = `_reassign_${id}`;
					// View RHS into an owned slot: value semantics —
					// materialize a length-bounded owned copy (a raw pair
					// store would alias borrowed memory, and clang rejects
					// nomen_view → nomen_string anyway).
					const rhs_is_view = is_view_value(node.right_value, status);
					// A match/switch/if lowers to a C `switch` STATEMENT — it
					// cannot ride as an initializer expression. Lower it the
					// way the declaration path does: declare the temp, let the
					// branches assign it through the return_assign join, then
					// free the displaced value and move the temp in. Every
					// branch is forced to produce an owned copy (the temp may
					// receive a literal/borrow branch value, and the LHS stays
					// registered as an owning string for auto_free).
					const rhs_is_branching =
						node.right_value.node_type === "match" ||
						node.right_value.node_type === "switch" ||
						node.right_value.node_type === "if";
					if (rhs_is_branching && !rhs_is_view) {
						status.code += `nomen_string ${temp};\n`;
						const old_return_assign = status.return_assign;
						const old_join_owned = status.join_needs_owned_string;
						status.return_assign = temp;
						status.join_needs_owned_string = true;
						build_node(node.right_value, status);
						status.join_needs_owned_string = old_join_owned;
						status.return_assign = old_return_assign;
						status.code += `free(${lhs_name}.ptr);\n${lhs_name} = ${temp};\n`;
						if (!status.heap_strings) status.heap_strings = new Set();
						status.heap_strings.add(lhs_name);
						return;
					}
					status.code += `nomen_string ${temp} = `;
					if (rhs_is_view) {
						c_materialize_view_string(node.right_value, status);
					} else {
						emit_rhs_value(node.right_value, nir_rhs, status);
					}
					status.code += `;\nfree(${lhs_name}.ptr);\n${lhs_name} = ${temp};\n`;
					if (rhs_is_view) {
						if (!status.heap_strings) status.heap_strings = new Set();
						status.heap_strings.add(lhs_name);
					}
					return;
				}
				status.code += `free(${lhs_name}.ptr);\n`;
			}

			// A bare string LITERAL reassignment (`s = "abc"`): the variable keeps
			// owning a heap value — strdup the literal (mirroring the declaration
			// path's `var string s = "abc"` lowering) so the scope-exit auto_free
			// stays valid. The displaced old owned value was already freed above.
			// Without this, the raw rodata pointer is stored while auto_free still
			// frees it at scope exit (an invalid free / abort).
			const rhs_is_string_literal =
				lhs_is_string &&
				!node.swap &&
				rhs_is_bare_value &&
				(rhs as ValueNode).value.length >= 2 &&
				(rhs as ValueNode).value.startsWith('"') &&
				(rhs as ValueNode).value.endsWith('"');
			if (rhs_is_string_literal) {
				status.code += `${lhs_name} = nomen_str_dup(`;
				emit_rhs_value(node.right_value, nir_rhs, status);
				status.code += `);\n`;
				return;
			}

			if (rhs_is_bare_value) {
				// RHS is a bare variable (alias). For classes, transfer
				// ownership: remove the SOURCE from whichever scope frame holds
				// it so it won't be freed at its scope exit (the LHS now owns
				// it). For strings this is ASSIGNMENT VALUE SEMANTICS: the LHS
				// receives an owned copy of the source's bytes (the old alias
				// lowering left the two variables sharing one heap block — the
				// source's scope-exit free dangled the LHS, and writes through
				// either name showed up in the other). The displaced old value
				// was already freed above; the LHS's declaration stays
				// registered and `heap_strings` marks it as owning so
				// auto_free frees the copy at scope exit.
				// Move-on-last-use: when the checker proved the source is
				// never read or written again, transfer the pair instead and
				// suppress the source's auto_free via moved_string_vars —
				// exactly one owner frees the bytes.
				if (lhs_is_class) {
					// `a = b swap Box(0)`: `b`'s current value transfers to `a`,
					// but `b` is revalidated with a fresh instance (the swap
					// expr), so it KEEPS ownership of that new value and must
					// stay registered for reclamation. Only remove the source
					// when there is no swap (a plain alias-move `a = b`).
					if (!node.swap) {
						splice_decl_from_c_scopes(status, (rhs as ValueNode).value);
					}
				} else if (
					lhs_is_string &&
					!node.swap &&
					rhs.node_type === "value" &&
					is_view_value(rhs, status)
				) {
					// `s = v` (view into owned string slot): value semantics —
					// materialize a length-bounded owned copy. Must precede
					// the `is_moved` transfer below: a moved view owns nothing
					// to transfer. The old value was already freed above.
					status.code += `${lhs_name} = `;
					c_materialize_view_string(rhs, status);
					status.code += `;\n`;
					if (!status.heap_strings) status.heap_strings = new Set();
					status.heap_strings.add(lhs_name);
					return;
				} else if (!node.swap && (rhs as ValueNode).is_moved) {
					// `s = move t` (string): EXPLICIT ownership transfer. Splice
					// the source's decl from whichever scope frame holds it so
					// its scope-exit free is suppressed — the assignee owns the
					// bytes now (its own displaced value was already freed
					// above). Only when the source actually OWNS heap: a
					// literal-only/borrow-held source owns nothing, and marking
					// the assignee as owner would free rodata/container memory
					// at scope exit. Mirrors aarch64's heap_strings
					// delete(source)/add(target).
					const src_name = (rhs as ValueNode).value;
					if (string_var_owns_heap(status, src_name)) {
						splice_decl_from_c_scopes(status, src_name);
						if (!status.heap_strings) status.heap_strings = new Set();
						status.heap_strings.add(lhs_name);
					}
					// Fall through: the plain `lhs = rhs` pair store completes
					// the transfer.
				} else if (should_value_copy_string_assign(node)) {
					const src_value = rhs as ValueNode;
					const src_can_move =
						(node as AssignmentNode).last_use_move === true &&
						move_on_last_use_enabled() &&
						string_var_owns_heap(status, src_value.value);
					status.code += `${lhs_name} = `;
					if (src_can_move) {
						if (!status.moved_string_vars) status.moved_string_vars = new Set();
						status.moved_string_vars.add(src_value.value);
						status.code += `${c_function_name(src_value.value)};\n`;
					} else {
						status.code += `nomen_str_dup(${c_function_name(src_value.value)});\n`;
					}
					if (!status.heap_strings) status.heap_strings = new Set();
					status.heap_strings.add(lhs_name);
					return;
				}
			}
			// Fall through: the normal path emits `lhs = rhs`.
		}
	}

	// Struct (non-class, non-string) variable reassignment. Two cases:
	// 1. `b = move a` — ownership transfers from a to b. Remove the source `a`
	//    from scoped_declarations so it won't be destroyed at scope exit (b
	//    owns the data now and is destroyed instead).
	// 2. `k = k.new(1)` (no move) — the result may alias the source's buffer
	//    due to the self-vs-_self struct-by-value bug (methods modify through
	//    the pointer, not the local copy). Remove the LHS from
	//    scoped_declarations to avoid destroying a potentially-corrupted
	//    buffer at scope exit. This leaks but is safe.
	if (!node.operator && node.left_value.node_type === "value") {
		const lhs_name = (node.left_value as ValueNode).value;
		// Search every scope frame — the LHS may be declared in an outer
		// scope when the reassignment sits inside an if/loop branch.
		const lhs_hit = find_decl_in_c_scopes(status, lhs_name);
		const lhs_decl = lhs_hit ? lhs_hit.frame[lhs_hit.index] : undefined;
		if (lhs_decl) {
			const lhs_struct = lhs_decl.type?.name
				? status.structs.find(
						(s) => s.name === lhs_decl.type.name && !s.is_simple_type && !s.is_class,
					)
				: null;
			const lhs_mono = lhs_decl.type ? mono_type_name(lhs_decl.type) : undefined;
			const lhs_mono_struct = lhs_mono
				? status.structs.find(
						(s) => s.name === lhs_mono && !s.is_simple_type && !s.is_class && !s.is_generic,
					)
				: null;
			if (lhs_struct || lhs_mono_struct) {
				const rhs = node.right_value;
				// A base-seeded struct literal (`m = [ .. move x, f = v ]`) is a
				// FRESH value (a copy of the base + overrides) — it discards the
				// old `m` exactly like a fresh constructor, and its synthesized
				// override assignments run through the field-write paths below
				// the copy.
				const rhs_is_base_literal =
					rhs.node_type === "anon_struct" ||
					(rhs.node_type === "func_call" &&
						!!(rhs as import("../nodes/FunctionCallNode.ts").default).field_overrides?.length);
				if (rhs.node_type === "value" && (rhs as ValueNode).is_moved) {
					// `b = move a` — ownership transfers from `a` to `b`. The OLD
					// `b` value is being discarded, so eagerly reclaim its
					// resources (e.g. `b`'s old Buffer) first. Then remove the
					// SOURCE `a` from whichever scope frame holds it (it may be
					// declared in an OUTER scope) so it won't be freed at its
					// own scope exit (b owns the data now and is freed instead).
					// Mirrors aarch64's move-ownership transfer.
					const move_struct_type = lhs_mono_struct ?? lhs_struct;
					if (move_struct_type) {
						release_recorded_string_fields(status, move_struct_type, lhs_name);
						if (struct_needs_destroy_by_name(move_struct_type.name, status)) {
							emit_struct_destroys(status, move_struct_type, lhs_name);
						}
					}
					splice_decl_from_c_scopes(status, (rhs as ValueNode).value);
				} else if (rhs_is_base_literal) {
					// The literal's bytes overwrite `m` without ever flowing
					// through a constructor call, so the displaced value's
					// recorded heap string fields must be released here (and the
					// records dropped — the post-copy field values are the
					// base's, and a stale record would free rodata at the next
					// displaced-free or at scope exit). `m` stays registered so
					// the NEW value's fields are reclaimed at scope exit.
					const struct_type = lhs_mono_struct ?? lhs_struct;
					if (struct_type) {
						release_recorded_string_fields(status, struct_type, lhs_name);
					}
				} else {
					// Non-move struct reassignment.
					//
					// When the RHS is a FRESH constructor (`a = List<int>()`,
					// `Box(5)`) — a call that allocates a brand-new instance and
					// does NOT alias another variable's buffer — the OLD value is
					// genuinely discarded, so eagerly reclaim its resources here
					// and KEEP the variable in scoped_declarations so its (new)
					// final value is freed at scope exit. This mirrors aarch64's
					// eager reclaim on non-borrow reassignment and fixes the
					// cross-instance replacement leak.
					//
					// Otherwise (method calls, including `a = a.new(...)` and
					// `k = k2.new(3)`) the returned struct is a by-value copy of
					// the receiver's buffer, which ALIASES that variable's
					// backing store. Freeing it at scope exit would double-free
					// the shared buffer, so DROP the variable from
					// scoped_declarations (the original safe behaviour): the
					// aliased source owns and frees the buffer, and the method's
					// internal realloc frees any intermediate block. This trades
					// a (safe) leak for avoiding a crash.
					const struct_type = lhs_mono_struct ?? lhs_struct;
					const needs_destroy = struct_type
						? struct_needs_destroy_by_name(struct_type.name, status)
						: false;
					// A plain free-function call (`list = make_list()`) — a
					// func_call node with no receiver — returns a FRESH owned
					// value (a factory result), not an alias of another
					// variable's buffer. Treat it like a fresh constructor:
					// eagerly reclaim the discarded old value and KEEP the
					// variable so its new value is freed at scope exit.
					const rhs_is_free_factory =
						node.right_value.node_type === "func_call" && !rhs_references_var(node, lhs_name);
					if (is_fresh_constructor(node, status) || rhs_is_free_factory) {
						// Fresh constructor / factory: eagerly reclaim the
						// discarded old value, then keep the variable for a
						// scope-exit free of the new value.
						if (struct_type) {
							release_recorded_string_fields(status, struct_type, lhs_name);
						}
						if (needs_destroy) emit_struct_destroys(status, struct_type!, lhs_name);
					} else if (is_self_method_call(node, lhs_name)) {
						// `a = a.new(...)`: the method reuses/reallocs the
						// variable's own buffer in place, so KEEP the variable
						// (no eager free — that would be a use-after-free) and
						// let scope-exit free the final buffer once.
					} else if (!rhs_references_var(node, lhs_name)) {
						// Method/func call on ANOTHER variable whose result does
						// NOT reference `lhs` (`k = k2.new(3)`): the old `lhs`
						// value is genuinely discarded (the new value aliases the
						// OTHER variable's buffer), so eagerly reclaim the old
						// value, then DROP `lhs` from its scope frame so
						// scope-exit doesn't double-free the shared (aliased)
						// buffer.
						if (needs_destroy) emit_struct_destroys(status, struct_type!, lhs_name);
						if (lhs_hit) lhs_hit.frame.splice(lhs_hit.index, 1);
					} else {
						// Method/func call that references `lhs` as an argument
						// (`k = f(k)` returning `k` by value): eagerly freeing the
						// old value would be a use-after-free (the RHS reads it).
						// Drop the variable (original safe behaviour) — the
						// result aliases `lhs`'s buffer, so no scope-exit free.
						if (lhs_hit) lhs_hit.frame.splice(lhs_hit.index, 1);
					}
				}
			}
		}
	}

	status.code += ``;

	// Assignment to a nullable struct slot (local var or struct field): write
	// the value (if non-null) and update the companion `<slot>_has` flag.
	const lhs_nullable_type = lhs_nullable_struct_type(node, status);
	if (!node.operator && lhs_nullable_type) {
		const lhs_expr = capture_build(node.left_value, status);
		const flag = `${lhs_expr}_has`;
		const rhs_is_null =
			node.right_value.node_type === "value" && (node.right_value as ValueNode).value === "null";
		if (rhs_is_null) {
			status.code += `${flag} = 0`;
		} else {
			status.code += `${lhs_expr} = `;
			emit_rhs_value(node.right_value, nir_rhs, status);
			status.code += `;\n${flag} = 1`;
		}
		return;
	}

	// A `ref string` param reassignment (`s = …` inside `func f = (ref string
	// s)`) writes through to the CALLER's storage, whose ownership tracking
	// (scoped_declarations / auto_free) assumes the slot may own a heap value
	// and frees it at scope exit. Storing a non-owning value (a rodata literal
	// or another variable's string) would make that free invalid. Mirror the
	// struct-string-field lowering: a fresh-heap RHS (every string-returning
	// call on this backend) is stored directly; anything else is strdup'd so
	// the slot keeps owning a heap copy. The displaced old value leaks — the
	// callee can't know whether the caller's slot was owned (conditional
	// writes make an eager free unsound), mirroring
	// drop_self_written_string_field_records' convention.
	if (!node.operator && !node.swap && node.left_value.node_type === "value") {
		const lhs_name = (node.left_value as ValueNode).value;
		const lhs_type = type_from_value_node(node.left_value);
		const lhs_is_ref_string_param =
			lhs_type?.name === "string" &&
			!lhs_type.is_array &&
			!!status.function_ref_params?.has(lhs_name) &&
			!status.ref_class_params?.has(lhs_name);
		if (lhs_is_ref_string_param) {
			const fresh_heap = is_owned_heap_temp(node.right_value, status);
			build_node(node.left_value, status);
			status.code += ` = `;
			if (!fresh_heap) {
				status.code += `nomen_str_dup(`;
			}
			emit_rhs_value(node.right_value, nir_rhs, status);
			if (!fresh_heap) {
				status.code += `)`;
			}
			status.code += `;\n`;
			return;
		}
	}

	// Ref-local reassignment (`current = otherVar`): repoint the pointer
	// rather than writing through it. A `var ref` local is emitted as a C
	// pointer, so `current = &otherVar` makes it alias the new variable.
	if (
		!node.operator &&
		node.left_value.node_type === "value" &&
		status.ref_local_vars?.has((node.left_value as ValueNode).value)
	) {
		const lhs_name = (node.left_value as ValueNode).value;
		status.code += `${lhs_name} = &`;
		build_node(node.right_value, status);
		status.code += `;\n`;
		return;
	}

	// Reassignment of an enum-with-data LOCAL with string payloads: the old
	// value's payload is an owned heap string — free it (tag-guarded) before
	// the store overwrites it. Scope-exit auto-free only reclaims the FINAL
	// value, so a displaced payload would otherwise leak. Enum fields inside
	// containers are not covered (their destroy doesn't walk payloads yet).
	if (!node.operator && !node.swap && node.left_value.node_type === "value") {
		const lhs_name = (node.left_value as ValueNode).value;
		const rhs_is_same_var =
			node.right_value.node_type === "value" && (node.right_value as ValueNode).value === lhs_name;
		const decl = status.scoped_declarations.find((d) => d.name === lhs_name);
		const lhs_type = decl?.type || status.variable_types?.get(lhs_name);
		const enum_node =
			lhs_type && !lhs_type.is_array
				? status.enums.find((e) => e.name === lhs_type.name)
				: undefined;
		if (!rhs_is_same_var && enum_node?.has_associated_data) {
			const cname = c_function_name(lhs_name);
			for (const c of enum_node.cases) {
				for (const p of c.params) {
					if (p.type.name !== "string") continue;
					status.code += `if (${cname}.tag == ${enum_node.name}_${c.name}) { free(${cname}._data._${c.name}.${p.name}.ptr); }\n`;
				}
			}
		}
	}

	build_node(node.left_value, status);
	if (node.operator) {
		status.code += ` ${node.operator.slice(0, -1)}= `;
	} else {
		status.code += " = ";
	}
	// A literal `null` stored into a fat string slot zero-initializes the
	// pair (the checker only accepts `null` for a nullable type, so `.ptr`
	// is NULL and every free stays a valid no-op). Matches the declaration
	// path's `= {0, 0}` and the return path's `(nomen_string){0,0}`: a bare
	// `0` would be a C type error (nomen_string is a struct).
	const null_store_lhs_type =
		node.left_value.node_type === "value"
			? status.scoped_declarations.find((d) => d.name === (node.left_value as ValueNode).value)
					?.type || status.variable_types?.get((node.left_value as ValueNode).value)
			: undefined;
	const rhs_is_null_string_store =
		!node.operator &&
		node.right_value.node_type === "value" &&
		(node.right_value as ValueNode).value === "null" &&
		null_store_lhs_type?.name === "string" &&
		!null_store_lhs_type.is_view &&
		!null_store_lhs_type.is_array;
	if (rhs_is_null_string_store) {
		status.code += `(nomen_string){0, 0}`;
	} else {
		emit_rhs_value(node.right_value, nir_rhs, status);
	}
	// `x = T(...) + [ ... ]`: apply the named-field overrides to the LHS
	// after the construction. Only a simple variable LHS is handled here;
	// field-target overrides in assignment are an edge case.
	if (node.left_value.node_type === "value" && has_field_overrides(node.right_value)) {
		const lname = (node.left_value as ValueNode).value;
		emit_field_overrides(lname, node.right_value, build_node, status, ";\n", ";\n");
	}

	if (node.swap) {
		status.code += `;\n`;
		status.code += `{ `;
		build_node(node.right_value, status);
		status.code += ` = `;
		emit_rhs_value(node.swap, nir_swap, status);
		status.code += `; }\n`;
	}
}

/** Build a node into status.code, then return the emitted text and roll back. */
function capture_build(node: any, status: BuildStatus): string {
	const before = status.code.length;
	build_node(node, status);
	const expr = status.code.substring(before);
	status.code = status.code.substring(0, before);
	return expr;
}

/** The nullable-struct type of an assignment LHS, or undefined if it isn't one. */
function lhs_nullable_struct_type(node: AssignmentNode, status: BuildStatus): boolean {
	if (node.left_value.node_type === "value") {
		const name = (node.left_value as ValueNode).value;
		const decl = status.scoped_declarations.find((d) => d.name === name);
		const t = decl?.type || status.variable_types?.get(name);
		return is_nullable_struct_type(t, status);
	}
	if (
		node.left_value.node_type === "access" &&
		(node.left_value as AccessNode).access.node_type === "access_field"
	) {
		const field_type = (node.left_value as AccessNode).access.type;
		return is_nullable_struct_type(field_type, status);
	}
	return false;
}

/**
 * Whether a reassignment's RHS is a FRESH constructor call — one that
 * allocates a brand-new instance and does NOT alias another variable's buffer
 * (`a = List<int>()`, `Box(5)`, `BigInt()`). Such a call discards the old
 * value, so it is safe to eagerly reclaim the old value AND keep the variable
 * in scoped_declarations for a scope-exit free of the fresh value.
 *
 * Returns false for method calls (`a.new(...)`, `k2.new(3)`) and access
 * results, whose by-value return aliases the receiver's backing store — those
 * must NOT be eagerly freed (would be a use-after-free) nor kept for scope-exit
 * free (would double-free the shared buffer).
 */
/** Whether a reassignment's RHS references the named variable (as a self
 * receiver, an access target, or an argument), so eagerly freeing the old LHS
 * value before building the RHS would be a use-after-free. */
function rhs_references_var(node: AssignmentNode, name: string): boolean {
	const rhs = node.right_value;
	if (rhs.node_type === "access") {
		const target = (rhs as AccessNode).target;
		if (target.node_type === "value" && (target as ValueNode).value === name) return true;
	}
	if (rhs.node_type === "func_call") {
		const call = rhs as import("../nodes/FunctionCallNode.ts").default;
		for (const p of call.params ?? []) {
			if (p.node_type === "value" && (p as ValueNode).value === name) return true;
			if (p.node_type === "access") {
				const target = (p as AccessNode).target;
				if (target.node_type === "value" && (target as ValueNode).value === name) return true;
			}
		}
	}
	return false;
}

function is_fresh_constructor(node: AssignmentNode, status: BuildStatus): boolean {
	const rhs = node.right_value;
	if (rhs.node_type !== "func_call") return false;
	const call = rhs as import("../nodes/FunctionCallNode.ts").default;
	// The called function must be a struct constructor (not a free function).
	const is_ctor = !!status.structs.find((s) => s.name === call.name && !s.is_simple_type);
	if (!is_ctor) return false;
	// No parameter may reference a variable (access on a var, or a bare var
	// name) — a `ref self`/borrow param means the result aliases that
	// variable's buffer. A plain literal arg (e.g. `Box(5)`) is fine.
	for (const p of call.params ?? []) {
		if (p.node_type === "access") return false;
		if (p.node_type === "value" && status.variable_types?.has((p as ValueNode).value)) return false;
	}
	return true;
}

/**
 * Whether a reassignment's RHS is a method call on the SAME variable
 * (`a = a.new(...)`, `a = a.method()`). Such a call takes `ref self` and
 * reuses/reallocs the variable's existing buffer in place, so the variable
 * must be KEPT in scoped_declarations (scope-exit frees the final buffer) and
 * must NOT be eagerly freed (would be a use-after-free).
 */
function is_self_method_call(node: AssignmentNode, lhs_name: string): boolean {
	const rhs = node.right_value;
	if (rhs.node_type === "access") {
		const target = (rhs as AccessNode).target;
		return target.node_type === "value" && (target as ValueNode).value === lhs_name;
	}
	if (rhs.node_type === "func_call") {
		const call = rhs as import("../nodes/FunctionCallNode.ts").default;
		const first = call.params?.[0];
		if (!first) return false;
		if (first.node_type === "access") {
			const target = (first as AccessNode).target;
			return target.node_type === "value" && (target as ValueNode).value === lhs_name;
		}
		if (first.node_type === "value") {
			return (first as ValueNode).value === lhs_name;
		}
	}
	return false;
}

/**
 * Whether this plain assignment is a bare owned-string variable RHS
 * (`s = t`, no explicit move, no swap): assignment value semantics apply —
 * the target receives its own copy of the source's bytes. Literals (raw
 * rodata stores), explicitly moved sources (`s = move t`, owned by the move
 * transfer path), and view-typed sources (non-owning pair stores) are
 * excluded.
 */
function should_value_copy_string_assign(node: AssignmentNode): boolean {
	const rhs = node.right_value;
	if (node.swap || node.operator || rhs.node_type !== "value") return false;
	const vn = rhs as ValueNode;
	if (typeof vn.value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(vn.value)) return false;
	if (vn.value === "true" || vn.value === "false" || vn.value === "null") return false;
	if (vn.is_moved) return false;
	const type = vn.type;
	return !!type && type.name === "string" && !type.is_view && !type.is_array;
}

/**
 * Whether the named string variable currently OWNS its heap bytes (and would
 * free them at scope exit). The move-on-last-use transfer may only suppress
 * the source's free when the source actually owns: a literal-only, borrow-
 * holding, or already-moved source owns nothing, and suppressing its
 * (nonexistent) free would hand the target rodata/container memory that the
 * target's auto_free would then free.
 */
function string_var_owns_heap(status: BuildStatus, name: string): boolean {
	if (status.string_borrow_vars?.has(name)) return false;
	if (status.moved_string_vars?.has(name)) return false;
	if (status.heap_strings?.has(name)) return true;
	const hit = find_decl_in_c_scopes(status, name);
	const decl = hit ? hit.frame[hit.index] : undefined;
	if (!decl) return false;
	const type = decl.type;
	if (!type || type.name !== "string" || type.is_view || type.is_array) return false;
	if (is_string_borrow(decl.value)) return false;
	const value = decl.value;
	if (!value) return false;
	// Mirror free_scoped_declarations' ownership classification for the
	// initializer shapes: a `var` literal or a call/method result was
	// strdup'd or produced fresh heap at the declare. A bare-variable init
	// (`var u = t`) owns only when the declare strdup'd/transferred it, which
	// the declare site records in heap_strings (checked above); reaching the
	// bare-value branch without the mark means u aliases its source's storage
	// (const source, borrow-only literal, or a source outside the declare's
	// scope frame) → refuse. Anything else may still point at static storage.
	if (value.node_type === "value") {
		const v = value as ValueNode;
		if (
			decl.declaration === "var" &&
			typeof v.value === "string" &&
			v.value.length >= 2 &&
			v.value.startsWith('"') &&
			v.value.endsWith('"')
		) {
			return true;
		}
		// A bare-variable initializer (`var u = t`): the declare strdup'd (or
		// transferred) an owned copy into u, and the declare site recorded that
		// in heap_strings — handled by the heap_strings check above. Reaching
		// here without the mark means the declare did NOT dup (a const, a
		// borrow-only literal, or a source outside the declare's scope frame —
		// u aliases its source's storage) → refuse.
		return false;
	}
	return value.node_type === "access" || value.node_type === "func_call";
}
