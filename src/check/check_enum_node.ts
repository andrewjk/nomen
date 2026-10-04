import add_error from "../add_error.ts";
import EnumNode from "../nodes/EnumNode.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_enum_node(node: EnumNode, status: CheckStatus) {
	node.is_generic = node.type_params.length > 0;

	// STRUCT_PLAN_3 B1a — the Copyable verifier (declared-flag subset): a
	// bare `enum` with a case payload typed a DECLARED-owning struct (or a
	// declared-owning enum) cannot be Copyable — case construction transfers
	// the payload, and a value copy of the enum would alias it. Name the fix.
	if (!node.is_owning) {
		for (const c of node.cases) {
			for (const p of c.params) {
				if (!p.type.name || p.type.is_ref) continue;
				const owns =
					status.structs.find((st) => st.name === p.type.name && st.is_owning) ||
					status.enums.find((e) => e.name === p.type.name && e.is_owning);
				if (owns) {
					add_error(
						status,
						`'${node.name}' cannot be Copyable — case '.${c.name}' owns heap memory (its '${p.name}' payload is \`owning\`) --> mark it \`owning enum ${node.name}\``,
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
