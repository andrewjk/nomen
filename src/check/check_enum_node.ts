import add_error from "../add_error.ts";
import EnumNode from "../nodes/EnumNode.ts";
import type CheckStatus from "./CheckStatus.ts";
import { type_owns_heap } from "./utils/ownership.ts";
import { struct_has_view_fields } from "./utils/view_fields.ts";

export default function check_enum_node(node: EnumNode, status: CheckStatus) {
	node.is_generic = node.type_params.length > 0;

	// STRUCT_PLAN_3 B1 full cutover — a generated anonymous enum cannot be
	// spelled `mv`; re-derive its ownership at statement-check time
	// (mirrors the tuple/anon-struct re-derive in check_struct_node).
	if (node.name.startsWith("_AnonEnum_")) {
		node.is_owning = node.cases.some((c) => c.params.some((p) => type_owns_heap(p.type, status)));
	}

	// STRUCT_PLAN_3 B1a + B1 full cutover — the Copyable verifier: a bare
	// `enum` with a case payload typed an OWNING type (`type_owns_heap` —
	// `string` (D3), a declared-`mv` struct/enum, a struct the inferred
	// walk flags, or an enum whose payloads are mv) cannot be Copyable —
	// case construction transfers the payload, and a value copy of the enum
	// would alias it. Name the fix. GENERATED monos (`template_name` set) are
	// exempt: their ownership is derived from the substituted payloads at
	// materialization (enum_mono stamps is_owning), and a generated enum
	// cannot be spelled `mv`.
	if (!node.is_owning && !node.template_name) {
		for (const c of node.cases) {
			for (const p of c.params) {
				if (type_owns_heap(p.type, status)) {
					add_error(
						status,
						`'${node.name}' cannot be Copyable — case '.${c.name}' owns heap memory (its '${p.name}' payload is \`mv\`) --> mark it \`mv enum ${node.name}\``,
						p.start || node.start,
					);
				}
			}
		}
	}

	for (let i = 0; i < node.cases.length; i++) {
		for (let j = i + 1; j < node.cases.length; j++) {
			if (node.cases[i].name === node.cases[j].name) {
				add_error(
					status,
					`Duplicate enum case: ${node.cases[j].name}`,
					node.cases[j].params[0]?.start || node.start,
				);
			}
		}
	}

	for (const tp of node.type_params) {
		if (node.type_params.filter((t) => t === tp).length > 1) {
			add_error(status, `Duplicate type parameter: ${tp}`, node.start);
		}
	}

	for (let c of node.cases) {
		for (let p of c.params) {
			// Views are second-class (SPEC Slicing): a payload is stored
			// inside the enum's tagged union — a stored borrow the checker
			// cannot track through match/copy sites, and not a scope-local
			// context either. Both a `view T` payload AND a payload typed a
			// struct carrying `view` fields are rejected: the enum wrapper
			// would ferry the bundle past every scope-local boundary ban.
			if (p.type.is_view) {
				add_error(
					status,
					`enum case payloads cannot be 'view' — materialize the value ('.to_string()') or re-slice from the source on use`,
					p.start || node.start,
				);
			} else if (p.type.name && struct_has_view_fields(p.type.name, status)) {
				add_error(
					status,
					`enum case payloads cannot be '${p.type.name}' — structs with 'view' fields are scope-local; store the fields (the views) instead`,
					p.start || node.start,
				);
			}
			// A generic enum's own type params are valid payload types (e.g.
			// `T value` in `enum Result<T, E>`); they resolve at
			// monomorphization.
			if (node.type_params.includes(p.type.name)) continue;
			if (!status.types.includes(p.type.name)) {
				add_error(status, `Unknown type: ${p.type.name}`, p.start);
			}
		}
	}

	if (!status.types.includes(node.name)) {
		status.types.push(node.name);
	}
	if (!status.enums.find((e) => e.name === node.name)) {
		status.enums.push(node);
	}
}
