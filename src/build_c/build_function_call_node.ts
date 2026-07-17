import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import ValueNode from "../nodes/ValueNode.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_function_name from "./utils/c_function_name.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_function_call_node(node: FunctionCallNode, status: BuildStatus) {
	const is_struct = status.structs.find((s) => s.name === node.name && !s.is_simple_type);
	const func_name = is_struct ? `${node.name}_init` : c_function_name(node.name);
	status.code += `${func_name}(`;

	const variadic_idx = node.variadic_param_name
		? node.params.findIndex((p) => p.node_type === "array")
		: -1;

	for (let i = 0; i < node.params.length; i++) {
		if (i > 0) {
			status.code += ", ";
		}

		if (i === variadic_idx && node.params[i].node_type === "array") {
			const arr = node.params[i] as ArrayValuesNode;
			status.code += `${arr.values.length}, (${c_type(arr.type.name)}[]){`;
			for (let j = 0; j < arr.values.length; j++) {
				if (j > 0) status.code += ", ";
				build_node(arr.values[j], status);
			}
			status.code += "}";
			continue;
		}

		const param_type = type_from_value_node(node.params[i]);
		const is_ref_param = node.ref_param_indices?.includes(i);
		// Class-typed arguments are already pointers (the pointer IS the
		// value). They must NOT be passed by address — `&h1->content` would
		// produce a `struct Box**` instead of the intended `struct Box*`.
		const param_is_class = !!status.structs.find((s) => s.name === param_type.name && s.is_class);
		// A `ref` class param is a double pointer: pass the address of the
		// caller's pointer slot so the callee can reassign it (write-back).
		if (is_ref_param && param_is_class) {
			const arg = node.params[i];
			if (arg.node_type === "value" && status.ref_class_params?.has((arg as ValueNode).value)) {
				// Caller's arg is itself a ref class param (already `T **`);
				// forward as-is without re-taking its address.
				status.suppress_dereference = true;
				build_node(arg, status);
				status.suppress_dereference = false;
				continue;
			}
			status.code += `&`;
			status.suppress_dereference = true;
			build_node(arg, status);
			status.suppress_dereference = false;
			continue;
		}
		const wants_address =
			(!param_is_class &&
				!!status.structs.find((s) => s.name === param_type.name && !s.is_simple_type)) ||
			!!status.traits.find((t) => t.name === param_type.name) ||
			is_ref_param;
		if (wants_address) {
			// If the argument is itself a ref/var param or a class variable
			// (already a pointer), don't emit `&*x` — `x` (or its current
			// pointer value) is the correct address.
			if (
				node.params[i].node_type === "value" &&
				(status.function_ref_params?.has((node.params[i] as ValueNode).value) ||
					status.class_vars?.has((node.params[i] as ValueNode).value))
			) {
				// pass through; build_value_node would print `*x`, so suppress it
				status.suppress_dereference = true;
			} else if (is_ref_param) {
				status.code += `&`;
			} else {
				status.code += `(void *)&`;
			}
		} else if (param_is_class) {
			// Class-typed arg: the value is already a pointer. Suppress the
			// `*` deref that build_value_node would add for ref params.
			status.suppress_dereference = true;
		}

		build_node(node.params[i], status);
		status.suppress_dereference = false;
	}
	status.code += ")";

	if (node.name.startsWith("_string_interpolate_")) {
		status.interpolate_string_counts.add(node.params.length - 1);
	}

	if (node.swap_params?.size) {
		for (const [idx, swap_expr] of node.swap_params) {
			const source = node.params[idx];
			if (!source) continue;
			status.code += `; `;

			if (
				source.node_type === "access" &&
				(source as AccessNode).access.node_type === "access_field"
			) {
				const src_access = source as AccessNode;
				const src_field = (src_access.access as AccessFieldNode).name;
				// Determine if the target is a class var / ref param (needs `->`)
				const tgt_name =
					src_access.target.node_type === "value" ? (src_access.target as ValueNode).value : "";
				const tgt_is_ptr =
					!!status.function_ref_params?.has(tgt_name) || !!status.class_vars?.has(tgt_name);
				if (tgt_is_ptr) status.suppress_dereference = true;
				build_node(src_access.target, status);
				status.suppress_dereference = false;
				status.code += tgt_is_ptr ? `->${src_field} = ` : `.${src_field} = `;
				build_node(swap_expr, status);
			} else if (source.node_type === "value") {
				const src_name = (source as ValueNode).value;
				status.code += `${src_name} = `;
				build_node(swap_expr, status);
			}
		}
	}

	// mov parameter handling: when a class-typed variable (or a hoisted
	// temporary like `_param_N`) is passed with `mov`, ownership transfers
	// to the callee. Remove it from scoped_declarations so auto_free won't
	// free it at scope exit (would double-free or UAF).
	if (node.mov_param_indices) {
		for (const idx of node.mov_param_indices) {
			const param = node.params[idx];
			if (param?.node_type === "value") {
				const vname = (param as ValueNode).value;
				const di = status.scoped_declarations.findIndex((d) => d.name === vname);
				if (di !== -1) status.scoped_declarations.splice(di, 1);
				// Record that this variable's value has been moved out. A later
				// reassignment (`a = null` / `a = Box(2)`) must NOT reclaim the
				// old (already-transferred) value — the callee now owns it.
				if (!status.moved) status.moved = new Set();
				status.moved.add(vname);
			}
		}
	}
}
