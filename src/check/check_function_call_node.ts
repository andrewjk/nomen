import add_error from "../add_error.ts";
import built_in_types from "../built_in_types.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import RootNode from "../nodes/RootNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import check_function_call from "./check_function_call.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_function_call_node(
	node: FunctionCallNode,
	status: CheckStatus,
): boolean {
	let func = status.functions.findLast((f) => f.name === node.name);

	if (!func) {
		const struct = status.structs.findLast((s) => s.name === node.name);
		if (struct) {
			if (struct.type_params.length > 0 && node.type_args?.length) {
				const mono = monomorphize(struct, node.type_args, status);
				if (mono) {
					func = mono.functions.find((f) => f.name === "init");
					if (func) {
						const type = new Type(struct.name);
						type.type_args = node.type_args;
						node.type = type;
						node.name = mono.name;
					}
				}
			} else {
				func = struct.functions.find((f) => f.name === "init");
				if (func) {
					const type = new Type(struct.name);
					type.type_args = node.type_args;
					node.type = type;
				}
			}
		}
	}

	if (!func && node.name.startsWith("_string_interpolate_")) {
		const length = parseInt(node.name.substring("_string_interpolate_".length));
		func = new FunctionNode(0, "pub", node.name, node.type, [
			new ParameterNode(0, "pattern"),
			...Array.from({ length }, (_, i) => new ParameterNode(0, `arg${i + 1}`)),
		]);
	}

	if (!func) {
		const param_value = status.values.findLast((v) => v.name === node.name);
		if (param_value?.type.name === "func") {
			func = new FunctionNode(
				0,
				"pub",
				node.name,
				param_value.type.func_return_type || param_value.type,
			);
			const param = status.stack
				.flatMap((n: any) => n.params || [])
				.find((p: any) => p.name === node.name);
			if (param?.func_params) {
				func.params = param.func_params;
			} else if (param_value.type.func_params) {
				func.params = param_value.type.func_params;
			}
			if (param?.func_return_type) {
				func.return_type = param.func_return_type;
			} else if (param_value.type.func_return_type) {
				func.return_type = param_value.type.func_return_type;
			}
			node.is_func_param = true;
		}
	}

	if (!func) {
		add_error(status, `Function not found: ${node.name}`, node.start);
		return false;
	}

	return check_function_call(node, status, func);
}

function monomorphize(
	generic_struct: StructNode,
	type_args: Type[],
	status: CheckStatus,
): StructNode | null {
	if (type_args.length !== generic_struct.type_params.length) {
		add_error(
			status,
			`Expected ${generic_struct.type_params.length} type arguments for ${generic_struct.name}, got ${type_args.length}`,
			generic_struct.start,
		);
		return null;
	}

	const mono_name =
		generic_struct.name + "_" + type_args.map((t) => t.name).join("_");

	const existing = status.structs.find((s) => s.name === mono_name);
	if (existing) return existing;

	const substitution = new Map<string, string>();
	for (let i = 0; i < generic_struct.type_params.length; i++) {
		substitution.set(generic_struct.type_params[i], type_args[i].name);
	}

	const mono_fields = generic_struct.fields.map((field) => {
		const resolved_type = substitute_type(field.type, substitution);
		const mono_field = new DeclarationNode(
			field.start,
			field.visibility,
			field.declaration,
			field.name,
			resolved_type,
			field.value,
		);
		return mono_field;
	});

	const mono_struct = new StructNode(
		generic_struct.start,
		generic_struct.visibility,
		mono_name,
		generic_struct.traits,
		mono_fields,
		[],
	);

	const init_params: ParameterNode[] = [];
	for (const field of mono_fields) {
		if (!field.value) {
			init_params.push(new ParameterNode(field.start, field.name, field.type));
		}
	}
	const init_return_type = new Type(generic_struct.name);
	init_return_type.type_args = type_args.map((t) => {
		const copy = new Type(t.name, t.is_static, t.is_array, t.length);
		copy.is_ref = t.is_ref;
		copy.is_nullable = t.is_nullable;
		return copy;
	});
	const init_func = new FunctionNode(
		generic_struct.start,
		"pub",
		"init",
		init_return_type,
		init_params,
	);
	mono_struct.functions.push(init_func);

	status.structs.push(mono_struct);
	status.types.push(mono_name);

	const root = status.stack[0] as RootNode;
	root.statements.push(mono_struct);

	return mono_struct;
}

function substitute_type(type: Type, substitution: Map<string, string>): Type {
	const resolved_name = substitution.get(type.name) || type.name;
	const new_type = new Type(resolved_name, type.is_static, type.is_array, type.length);
	new_type.is_ref = type.is_ref;
	new_type.is_nullable = type.is_nullable;
	new_type.type_args = type.type_args?.map((t) => substitute_type(t, substitution));
	new_type.func_params = type.func_params;
	new_type.func_return_type = type.func_return_type
		? substitute_type(type.func_return_type, substitution)
		: undefined;
	return new_type;
}
