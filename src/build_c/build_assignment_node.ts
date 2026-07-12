import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import AssignmentNode from "../nodes/AssignmentNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import { is_nullable_struct_type } from "./utils/nullable_struct.ts";
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
				// TODO: Cast to the correct function definition
				// TODO: Use the correct variable name
				// TODO: Pass parameters
				const type = c_type(traitField.type.name);
				const cast = `(void (*)(void *, ${type}))`;
				// TODO: Figure out when to use & here (pass need_pointer into build_node?):
				status.code += `(${cast}_get_trait_func((void *)`;
				build_node(accessNode.target, status);
				const traitIndex = status.traits.indexOf(trait);
				const fieldIndex = trait.functions.length + trait.fields.indexOf(traitField) * 2 + 1;
				status.code += `, ${traitIndex}, ${fieldIndex}))(`;
				build_node(accessNode.target, status);
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
					status.code += `if (${field_access}) { ${field_struct.name}_destroy(${field_access}); free(${field_access}); malloc_count--; }\n`;
				} else {
					status.code += `${field_struct.name}_destroy(${field_access}); free(${field_access}); malloc_count--;\n`;
				}
				// Ownership transfer: assigning a bare variable to an owned
				// (`mov`) class field moves ownership from the source variable
				// to the field. Remove the source from scoped_declarations so
				// it is NOT freed at scope exit (the field's container destroy
				// reclaims it). Without this, the source and the field alias
				// the same instance and both get freed -> use-after-free.
				// Mirrors aarch64's mark_moved_if_struct.
				if (node.right_value.node_type === "value") {
					const rhs_name = (node.right_value as ValueNode).value;
					const rhs_idx = status.scoped_declarations.findIndex((d) => d.name === rhs_name);
					if (rhs_idx !== -1) status.scoped_declarations.splice(rhs_idx, 1);
				}
			}
		}
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
		if ((lhs_decl || lhs_in_class_vars) && (lhs_is_string || lhs_is_class)) {
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
				// Skip free — alias still references the old value.
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
				status.code += `free(${lhs_name});\nmalloc_count--;\n`;
			}

			if (rhs_is_bare_value) {
				// RHS is a bare variable (alias). For classes, transfer
				// ownership: remove the SOURCE from scoped_declarations so
				// it won't be freed at its scope exit (the LHS now owns it).
				// For strings, remove the LHS so it won't be freed (string
				// aliases don't own — the source does via its own copy).
				if (lhs_is_class) {
					const rhs_name = (rhs as ValueNode).value;
					const rhs_idx = status.scoped_declarations.findIndex((d) => d.name === rhs_name);
					if (rhs_idx !== -1) status.scoped_declarations.splice(rhs_idx, 1);
				} else {
					// String: LHS is now an alias, remove it
					if (lhs_decl) {
						const idx = status.scoped_declarations.indexOf(lhs_decl);
						if (idx !== -1) status.scoped_declarations.splice(idx, 1);
					}
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
		const lhs_decl = status.scoped_declarations.find((d) => d.name === lhs_name);
		if (lhs_decl) {
			const lhs_struct = lhs_decl.type?.name
				? status.structs.find(
						(s) => s.name === lhs_decl.type.name && !s.is_simple_type && !s.is_class,
					)
				: null;
			const lhs_mono = lhs_decl.type?.type_args?.length
				? `${lhs_decl.type.name}_${lhs_decl.type.type_args.map((t) => t.name).join("_")}`
				: lhs_decl.type?.name;
			const lhs_mono_struct = lhs_mono
				? status.structs.find(
						(s) => s.name === lhs_mono && !s.is_simple_type && !s.is_class && !s.is_generic,
					)
				: null;
			if (lhs_struct || lhs_mono_struct) {
				const rhs = node.right_value;
				if (rhs.node_type === "value" && (rhs as ValueNode).is_moved) {
					const rhs_name = (rhs as ValueNode).value;
					const rhs_idx = status.scoped_declarations.findIndex((d) => d.name === rhs_name);
					if (rhs_idx !== -1) status.scoped_declarations.splice(rhs_idx, 1);
				} else {
					const idx = status.scoped_declarations.indexOf(lhs_decl);
					if (idx !== -1) status.scoped_declarations.splice(idx, 1);
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

	build_node(node.left_value, status);
	if (node.operator) {
		status.code += ` ${node.operator.slice(0, -1)}= `;
	} else {
		status.code += " = ";
	}
	build_node(node.right_value, status);

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
