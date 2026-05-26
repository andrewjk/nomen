import add_error from "../add_error.ts";
import AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import AnonStructNode from "../nodes/AnonStructNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import { monomorphize } from "./check_function_call_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import check_type_and_value_match from "./utils/check_type_and_value_match.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";
import value_from_value_node from "./utils/value_from_value_node.ts";

export default function check_function_call(
	node: FunctionCallNode | AccessFunctionCallNode,
	status: CheckStatus,
	func: FunctionNode,
	target_type?: Type,
): boolean {
	if (
		func.visibility === "priv" &&
		!status.structs.find((s) => s.name === target_type?.name)?.privates_visible
	) {
		add_error(status, `Can't access priv function: ${node.name}`, node.start);
		return false;
	}

	node.type = func.return_type;
	node.is_static = func.is_static;

	let required_param_count = 0;
	for (const param of func.params) {
		if (!param.default_value) {
			required_param_count++;
		}
	}
	if (func.params[0]?.is_self_param) {
		required_param_count -= 1;
	}
	if (node.params.length > func.params.length) {
		add_error(status, `Too many parameters for function: ${node.name}`, node.start);
		return false;
	} else if (node.params.length < required_param_count) {
		add_error(status, `Parameters missing for function: ${node.name}`, node.start);
		return false;
	}

	while (node.params.length < func.params.length) {
		const missing_param = func.params[node.params.length];
		if (missing_param.default_value) {
			node.params.push(missing_param.default_value);
		} else {
			break;
		}
	}

	status.stack.push(node);

	const self_offset = func.params[0]?.is_self_param ? 1 : 0;

	for (let i = 0; i < node.params.length; i++) {
		const param = node.params[i];
		if (param.node_type !== "anon_struct") continue;
		const func_param = func.params[i + self_offset];
		if (!func_param) continue;
		let struct = status.structs.findLast((s) => s.name === func_param.type.name);
		if (!struct) {
			add_error(status, `Unknown struct type: ${func_param.type.name}`, param.start);
			continue;
		}
		const anon = param as AnonStructNode;

		if (struct.is_generic && !func_param.type.type_args?.length) {
			const type_map = new Map<string, Type>();
			for (const af of anon.fields) {
				if (!check_node(af.value, status)) continue;
				const val_type = type_from_value_node(af.value, status);
				const struct_field = struct.fields.find((f) => f.name === af.name);
				if (struct_field && struct.type_params.includes(struct_field.type.name)) {
					if (!type_map.has(struct_field.type.name)) {
						type_map.set(struct_field.type.name, val_type);
					}
				}
			}
			if (type_map.size > 0) {
				const inferred_args = struct.type_params.map((tp) => type_map.get(tp) || new Type(tp));
				const mono_name = struct.name + "_" + inferred_args.map((t) => t.name).join("_");
				let mono = status.structs.find((s) => s.name === mono_name);
				if (!mono) {
					mono = monomorphize(struct, inferred_args, status) ?? undefined;
				}
				if (mono) {
					struct = mono;
				}
			}
		}

		const init_func = struct.functions.find((f) => f.name === "init");
		if (!init_func) {
			add_error(status, `Struct ${struct.name} has no init`, param.start);
			continue;
		}
		const args: BaseNode[] = [];
		for (const init_param of init_func.params) {
			const field = anon.fields.find((f) => f.name === init_param.name);
			if (field) {
				args.push(field.value);
			} else if (init_param.default_value) {
				args.push(init_param.default_value);
			} else {
				add_error(status, `Missing field '${init_param.name}' in anonymous struct`, param.start);
			}
		}
		for (const field of anon.fields) {
			if (!init_func.params.find((p) => p.name === field.name)) {
				add_error(
					status,
					`Unknown field '${field.name}' in anonymous struct for ${struct.name}`,
					param.start,
				);
			}
		}
		const constructor = new FunctionCallNode(param.start, struct.name);
		constructor.params = args;
		constructor.type = new Type(struct.name);
		node.params.splice(i, 1, constructor);
	}

	for (let [i, param] of node.params.entries()) {
		if (!check_node(param, status)) {
			continue;
		}

		const param_type = type_from_value_node(param, status);
		const param_value = value_from_value_node(param);
		const func_param = func.params[i + self_offset];
		const has_ref_keyword = node.ref_param_indices?.includes(i) ?? false;
		if (func_param.type.is_ref && !has_ref_keyword) {
			add_error(
				status,
				`Missing 'ref' keyword for ref parameter '${func_param.name}'`,
				param.start,
			);
		} else if (!func_param.type.is_ref && has_ref_keyword) {
			add_error(
				status,
				`Unexpected 'ref' keyword for non-ref parameter '${func_param.name}'`,
				param.start,
			);
		}
		check_type_and_value_match(
			func_param.type,
			param_type,
			param_value,
			status,
			param.start,
			"param",
		);

		if (param_type.is_array && param_type.length && !func_param.type.length) {
			func_param.type.length = param_type.length;
		}

		if (param.node_type !== "value" && !has_ref_keyword) {
			const declaration_name = `_param_${status.var_name_counter.value++}`;
			status.allocations.push(
				new DeclarationNode(param.start, "priv", "const", declaration_name, param_type, param),
			);
			node.params.splice(i, 1, new ValueNode(param.start, declaration_name, param_type));
		}
	}

	status.stack.pop();

	return true;
}
