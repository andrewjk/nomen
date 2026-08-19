import emit_field_overrides from "../build/emit_field_overrides.ts";
import { mono_type_name } from "../build_common/mono_name.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { build_vtable_target } from "./build_access_node.ts";
import { emit_struct_destroys, struct_needs_destroy_by_name } from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import { is_owned_heap_temp } from "./build_operation_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { find_decl_in_c_scopes, splice_decl_from_c_scopes } from "./utils/c_scope.ts";
import c_type from "./utils/c_type.ts";
import is_string_borrow from "./utils/is_string_borrow.ts";
import { is_nullable_struct_type } from "./utils/nullable_struct.ts";

let string_field_counter = 0;
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_assignment_node(node: AssignmentNode, status: BuildStatus) {
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
				build_node(node.right_value, status);
				status.code += `)`;

				return;
			}
		}
	}

	// Class field reassignment (`obj.field = rhs`) where the field is an
	// owned (mov) class slot: eagerly reclaim the field's old value before
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
			// Look up the field definition to check if it's `mov` (owned).
			// Only owned fields should be eagerly freed on reassignment.
			const target_type = type_from_value_node(access_lhs.target);
			const target_struct = target_type?.name
				? status.structs.find((s) => s.name === target_type.name && !s.is_simple_type)
				: null;
			const field_def = target_struct?.fields.find((f) => f.name === field_access_node.name);
			const field_is_owned = field_def?.declaration === "mov";
			if (field_is_owned) {
				// Capture the emitted field-access expression (e.g. `h->c`) by
				// building it into status.code then rolling back, so the normal
				// assignment path below re-emits it exactly once.
				const before_len = status.code.length;
				build_node(node.left_value, status);
				const field_access = status.code.substring(before_len);
				status.code = status.code.substring(0, before_len);
				if (field_type?.is_nullable) {
					status.code += `if (${field_access}) { ${field_struct.name}_destroy(${field_access}); free(${field_access}); }\n`;
				} else {
					status.code += `${field_struct.name}_destroy(${field_access}); free(${field_access});\n`;
				}
				// Ownership transfer: assigning a bare variable to an owned
				// (`mov`) class field moves ownership from the source variable
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

	// A plain `string` field assignment (`obj.field = rhs`): the field keeps a
	// heap-owned value. For CLASS targets the field is always heap (`_init`
	// strdup's defaults; <Class>_destroy frees unconditionally), so the old
	// value is freed eagerly here. For VALUE-struct targets construction may
	// leave a static literal in the field — free the old value only when a
	// previous assignment recorded it, and record the field so auto_free (or
	// the mov-site release) reclaims the final value. A fresh-heap RHS
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
		const old_was_heap = !!target_struct?.is_class || !!status.heap_string_fields?.has(tracked_key);
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
			// Capture the field-access expression (e.g. `b->text`) by building
			// it then rolling back, so it can be referenced multiple times.
			const before_len = status.code.length;
			build_node(node.left_value, status);
			const field_access = status.code.substring(before_len);
			status.code = status.code.substring(0, before_len);
			const temp = `_nomen_strfield_${string_field_counter++}`;
			status.code += `{\nchar* ${temp} = `;
			if (fresh_heap) {
				build_node(node.right_value, status);
			} else {
				status.code += `strdup(`;
				build_node(node.right_value, status);
				status.code += `)`;
			}
			status.code += `;\n`;
			if (old_was_heap) {
				status.code += `free(${field_access});\n`;
			}
			status.code += `${field_access} = ${temp};\n}\n`;
			if (!target_struct.is_class) {
				if (!status.heap_string_fields) status.heap_string_fields = new Set<string>();
				status.heap_string_fields.add(tracked_key);
			}
			return;
		}
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
			const was_borrow = !!status.string_borrow_vars?.has(lhs_name);
			if (!status.string_borrow_vars) status.string_borrow_vars = new Set();
			status.string_borrow_vars.add(lhs_name);
			if (!was_borrow) {
				if (lhs_hit) lhs_hit.frame.splice(lhs_hit.index, 1);
				status.code += `free(${lhs_name});\n`;
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
		const lhs_decl = status.scoped_declarations.find((d) => d.name === lhs_name);
		// class_vars persists across scopes (unlike scoped_declarations), so
		// we can detect class vars from outer scopes too.
		const lhs_in_class_vars = !!status.class_vars?.has(lhs_name);
		const lhs_type = lhs_decl?.type || status.variable_types?.get(lhs_name);
		const lhs_struct = lhs_type ? status.structs.find((s) => s.name === lhs_type.name) : null;
		const lhs_is_string = lhs_type?.name === "string";
		const lhs_is_class = !!lhs_struct?.is_class || lhs_in_class_vars;
		// A trait-typed class local (`var Speaker s = Dog(); s = Cat()`)
		// reclaims its old instance via the trait's `<Trait>_destroy` shim
		// (the concrete type at runtime may differ from the initializer's
		// after a prior reassignment), then stores the new pointer. The RHS
		// is cast to `void *` so any conforming class pointer assigns.
		const lhs_trait_class = status.trait_class_locals?.get(lhs_name);
		if (lhs_trait_class !== undefined && !node.operator) {
			const rhs = node.right_value;
			const rhs_is_bare_value = rhs.node_type === "value";
			// Compute a non-bare RHS into a temp first to avoid use-after-free
			// when it references the LHS.
			if (!rhs_is_bare_value) {
				const id = (status.label_counter = (status.label_counter ?? 0) + 1);
				const temp = `_treassign_${id}`;
				status.code += `void *${temp} = (void *)`;
				build_node(rhs, status);
				status.code += `;\n`;
				if (lhs_type?.is_nullable) {
					status.code += `if (${lhs_name}) { ${lhs_trait_class}_destroy(${lhs_name}); free(${lhs_name}); }\n`;
				} else {
					status.code += `${lhs_trait_class}_destroy(${lhs_name}); free(${lhs_name});\n`;
				}
				status.code += `${lhs_name} = ${temp};\n`;
			} else {
				if (lhs_type?.is_nullable) {
					status.code += `if (${lhs_name}) { ${lhs_trait_class}_destroy(${lhs_name}); free(${lhs_name}); }\n`;
				} else {
					status.code += `${lhs_trait_class}_destroy(${lhs_name}); free(${lhs_name});\n`;
				}
				status.code += `${lhs_name} = (void *)`;
				build_node(rhs, status);
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
				build_node(node.right_value, status);
				status.code += `;\n`;
				return;
			}
			if (ref_param_type.is_nullable) {
				status.code += `if (*${lhs_name}) { ${destroy_struct.name}_destroy(*${lhs_name}); free(*${lhs_name}); }\n`;
			} else {
				status.code += `${destroy_struct.name}_destroy(*${lhs_name}); free(*${lhs_name});\n`;
			}
			status.code += `*${lhs_name} = `;
			build_node(node.right_value, status);
			status.code += `;\n`;
			return;
		}
		// If the LHS was previously moved out (`take(mov a)`), its old value is
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
			} else {
				// For a string with a non-bare RHS that may reference the LHS
				// (e.g. `s = f(s)` or `s = s + "x"`), compute the RHS into a
				// temp BEFORE freeing the old value to avoid use-after-free.
				if (lhs_is_string && !rhs_is_bare_value) {
					const id = (status.label_counter = (status.label_counter ?? 0) + 1);
					const temp = `_reassign_${id}`;
					status.code += `char* ${temp} = `;
					build_node(node.right_value, status);
					status.code += `;\nfree(${lhs_name});\n${lhs_name} = ${temp};\n`;
					return;
				}
				status.code += `free(${lhs_name});\n`;
			}

			if (rhs_is_bare_value) {
				// RHS is a bare variable (alias). For classes, transfer
				// ownership: remove the SOURCE from whichever scope frame holds
				// it so it won't be freed at its scope exit (the LHS now owns
				// it). For strings, remove the LHS so it won't be freed (string
				// aliases don't own — the source does via its own copy).
				if (lhs_is_class) {
					// `a = b swap Box(0)`: `b`'s current value transfers to `a`,
					// but `b` is revalidated with a fresh instance (the swap
					// expr), so it KEEPS ownership of that new value and must
					// stay registered for reclamation. Only remove the source
					// when there is no swap (a plain alias-move `a = b`).
					if (!node.swap) {
						splice_decl_from_c_scopes(status, (rhs as ValueNode).value);
					}
				} else {
					// String: LHS is now an alias, remove it
					if (lhs_decl) splice_decl_from_c_scopes(status, lhs_name);
				}
			}
			// Fall through: the normal path emits `lhs = rhs`.
		}
	}

	// Struct (non-class, non-string) variable reassignment. Two cases:
	// 1. `b = mov a` — ownership transfers from a to b. Remove the source `a`
	//    from scoped_declarations so it won't be destroyed at scope exit (b
	//    owns the data now and is destroyed instead).
	// 2. `k = k.new(1)` (no mov) — the result may alias the source's buffer
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
				if (rhs.node_type === "value" && (rhs as ValueNode).is_moved) {
					// `b = mov a` — ownership transfers from `a` to `b`. The OLD
					// `b` value is being discarded, so eagerly reclaim its
					// resources (e.g. `b`'s old Buffer) first. Then remove the
					// SOURCE `a` from whichever scope frame holds it (it may be
					// declared in an OUTER scope) so it won't be freed at its
					// own scope exit (b owns the data now and is freed instead).
					// Mirrors aarch64's mov-ownership transfer.
					const mov_struct_type = lhs_mono_struct ?? lhs_struct;
					if (mov_struct_type && struct_needs_destroy_by_name(mov_struct_type.name, status)) {
						emit_struct_destroys(status, mov_struct_type, lhs_name);
					}
					splice_decl_from_c_scopes(status, (rhs as ValueNode).value);
				} else {
					// Non-mov struct reassignment.
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
			build_node(node.right_value, status);
			status.code += `;\n${flag} = 1`;
		}
		return;
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

	build_node(node.left_value, status);
	if (node.operator) {
		status.code += ` ${node.operator.slice(0, -1)}= `;
	} else {
		status.code += " = ";
	}
	build_node(node.right_value, status);
	// `x = T(...) + [ ... ]`: apply the named-field overrides to the LHS
	// after the construction. Only a simple variable LHS is handled here;
	// field-target overrides in assignment are an edge case.
	if (
		node.left_value.node_type === "value" &&
		node.right_value.node_type === "func_call" &&
		(node.right_value as FunctionCallNode).field_overrides?.length
	) {
		const lname = (node.left_value as ValueNode).value;
		emit_field_overrides(lname, node.right_value, build_node, status, ";\n", ";\n");
	}

	if (node.swap) {
		status.code += `;\n`;
		status.code += `{ `;
		build_node(node.right_value, status);
		status.code += ` = `;
		build_node(node.swap, status);
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
