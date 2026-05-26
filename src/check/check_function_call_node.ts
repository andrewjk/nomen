import add_error from "../add_error.ts";
import built_in_types from "../built_in_types.ts";
import clone_node from "../nodes/clone_node.ts";
import DeclarationNode from "../nodes/DeclarationNode.ts";
import FunctionCallNode from "../nodes/FunctionCallNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import RootNode from "../nodes/RootNode.ts";
import StructNode from "../nodes/StructNode.ts";
import Type from "../nodes/Type.ts";
import check_function_call from "./check_function_call.ts";
import check_function_node from "./check_function_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import type_from_value from "./utils/type_from_value.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

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

	if (func.is_generic) {
		const specialized = specialize_function(func, node, status);
		if (specialized) {
			node.name = specialized.name;
			return check_function_call(node, status, specialized);
		}
		return false;
	}

	return check_function_call(node, status, func);
}

export function monomorphize(
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

	const mono_name = generic_struct.name + "_" + type_args.map((t) => t.name).join("_");

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
	if (resolved_name !== type.name) {
		new_type.type_args = undefined;
	} else {
		new_type.type_args = type.type_args?.map((t) => substitute_type(t, substitution));
	}
	new_type.func_params = type.func_params;
	new_type.func_return_type = type.func_return_type
		? substitute_type(type.func_return_type, substitution)
		: undefined;
	return new_type;
}

function specialize_function(
	generic_func: FunctionNode,
	call_node: FunctionCallNode,
	status: CheckStatus,
): FunctionNode | null {
	const substitution = new Map<string, string>();
	const suffix_parts: string[] = [];

	for (let i = 0; i < generic_func.params.length; i++) {
		const param = generic_func.params[i];
		const generic_struct = status.structs.findLast((s) => s.name === param.type.name);
		if (!generic_struct?.is_generic) continue;

		const arg = call_node.params[i];
		if (!arg) continue;

		let type_args_for_struct: Type[] = [];

		if (arg.node_type === "anon_struct") {
			type_args_for_struct = infer_from_anon_struct(
				arg as import("../nodes/AnonStructNode.ts").default,
				generic_struct,
				status,
				substitution,
			);
		} else {
			const arg_type = infer_arg_type(arg, status);
			if (arg_type.type_args?.length) {
				type_args_for_struct = arg_type.type_args;
				for (let j = 0; j < generic_struct.type_params.length; j++) {
					if (j < arg_type.type_args.length) {
						substitution.set(generic_struct.type_params[j], arg_type.type_args[j].name);
					}
				}
				if (param.type.type_args?.length) {
					for (let j = 0; j < param.type.type_args.length; j++) {
						if (j < arg_type.type_args.length) {
							substitution.set(param.type.type_args[j].name, arg_type.type_args[j].name);
						}
					}
				}
			} else if (arg_type.name !== param.type.name) {
				const mono_struct = status.structs.findLast((s) => s.name === arg_type.name);
				if (mono_struct) {
					for (let j = 0; j < generic_struct.type_params.length; j++) {
						const field = mono_struct.fields[j];
						if (field) {
							substitution.set(generic_struct.type_params[j], field.type.name);
						}
					}
				}
			}
		}

		if (type_args_for_struct.length === 0) {
			type_args_for_struct = generic_struct.type_params.map(
				(tp) => new Type(substitution.get(tp) || tp),
			);
		}
		const mono_name = generic_struct.name + "_" + type_args_for_struct.map((t) => t.name).join("_");
		substitution.set(generic_struct.name, mono_name);
		suffix_parts.push(mono_name);
	}

	if (substitution.size === 0) {
		add_error(
			status,
			`Cannot infer type arguments for generic function: ${generic_func.name}`,
			call_node.start,
		);
		return null;
	}

	for (let i = 0; i < generic_func.params.length; i++) {
		const param = generic_func.params[i];
		const generic_struct = status.structs.findLast((s) => s.name === param.type.name);
		if (!generic_struct?.is_generic) continue;
		const type_args = generic_struct.type_params.map((tp) => {
			const resolved = substitution.get(tp);
			return new Type(resolved || tp);
		});
		monomorphize(generic_struct, type_args, status);
	}

	const specialized_name = generic_func.name + "_" + suffix_parts.join("_");

	const existing = status.functions.findLast((f) => f.name === specialized_name);
	if (existing) return existing;

	const cloned = clone_node(generic_func) as FunctionNode;
	cloned.name = specialized_name;
	cloned.is_generic = false;

	for (const param of cloned.params) {
		param.type = substitute_type(param.type, substitution);
	}
	if (cloned.return_type.name) {
		cloned.return_type = substitute_type(cloned.return_type, substitution);
	}

	if (generic_func.type_params.length > 0) {
		substitute_body_types(cloned.statements, substitution);
	}

	cloned.type_params = [];

	const root = status.stack[0] as RootNode;
	root.statements.push(cloned);

	const root_status: CheckStatus = {
		stack: [root],
		types: status.types.slice(),
		values: [],
		structs: status.structs,
		traits: status.traits,
		enums: status.enums,
		bitsets: status.bitsets,
		functions: status.functions,
		allocations: [],
		var_name_counter: status.var_name_counter,
		type_params: [],
		errors: status.errors,
	};

	check_function_node(cloned, root_status);

	return status.functions.findLast((f) => f.name === specialized_name) || null;
}

function infer_arg_type(node: import("../nodes/BaseNode.ts").default, status: CheckStatus): Type {
	if (node.node_type === "value") {
		const vn = node as import("../nodes/ValueNode.ts").default;
		if (vn.type?.name) return vn.type;
		return type_from_value(vn.value, status);
	}
	if (node.node_type === "func_call") {
		return (node as FunctionCallNode).type;
	}
	if (node.node_type === "access") {
		const access = node as import("../nodes/AccessNode.ts").default;
		const inner = access.access;
		if (inner.node_type === "access_field") {
			return (inner as import("../nodes/AccessFieldNode.ts").default).type || new Type("");
		}
	}
	return new Type("");
}

function infer_from_anon_struct(
	anon: import("../nodes/AnonStructNode.ts").default,
	generic_struct: StructNode,
	status: CheckStatus,
	substitution: Map<string, string>,
): Type[] {
	for (const field of anon.fields) {
		const struct_field = generic_struct.fields.find((f) => f.name === field.name);
		if (!struct_field) continue;
		const type_param_name = struct_field.type.name;
		if (!generic_struct.type_params.includes(type_param_name)) continue;
		if (substitution.has(type_param_name)) continue;
		const val_type = infer_arg_type(field.value, status);
		if (val_type.name) {
			substitution.set(type_param_name, val_type.name);
		}
	}
	return generic_struct.type_params.map((tp) => new Type(substitution.get(tp) || tp));
}

function substitute_body_types(
	statements: import("../nodes/BaseNode.ts").default[],
	substitution: Map<string, string>,
) {
	for (const stmt of statements) {
		substitute_node_types(stmt, substitution);
	}
}

function substitute_node_types(
	node: import("../nodes/BaseNode.ts").default,
	substitution: Map<string, string>,
) {
	if (!node) return;

	switch (node.node_type) {
		case "declare": {
			const n = node as import("../nodes/DeclarationNode.ts").default;
			n.type = substitute_type(n.type, substitution);
			if (n.value) substitute_node_types(n.value, substitution);
			if (n.func_return_type)
				n.func_return_type = substitute_type(n.func_return_type, substitution);
			break;
		}
		case "return": {
			const n = node as import("../nodes/ReturnNode.ts").default;
			if (n.value) substitute_node_types(n.value, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "let": {
			const n = node as import("../nodes/LetNode.ts").default;
			if (n.value) substitute_node_types(n.value, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "assign": {
			const n = node as import("../nodes/AssignmentNode.ts").default;
			substitute_node_types(n.left_value, substitution);
			substitute_node_types(n.right_value, substitution);
			break;
		}
		case "if": {
			const n = node as import("../nodes/IfElseNode.ts").default;
			substitute_node_types(n.condition, substitution);
			if (n.if_branch) substitute_body_types(n.if_branch.statements, substitution);
			if (n.else_branch) substitute_body_types(n.else_branch.statements, substitution);
			if (n.return_type) n.return_type = substitute_type(n.return_type, substitution);
			break;
		}
		case "match": {
			const n = node as import("../nodes/MatchNode.ts").default;
			substitute_node_types(n.value, substitution);
			for (const c of n.cases) {
				substitute_node_types(c.match_value, substitution);
				substitute_body_types(c.branch.statements, substitution);
			}
			if (n.else_branch) substitute_body_types(n.else_branch.statements, substitution);
			if (n.return_type) n.return_type = substitute_type(n.return_type, substitution);
			break;
		}
		case "switch": {
			const n = node as import("../nodes/SwitchNode.ts").default;
			for (const c of n.cases) {
				substitute_node_types(c.condition, substitution);
				substitute_body_types(c.branch.statements, substitution);
			}
			if (n.else_branch) substitute_body_types(n.else_branch.statements, substitution);
			if (n.return_type) n.return_type = substitute_type(n.return_type, substitution);
			break;
		}
		case "for": {
			const n = node as import("../nodes/ForLoopNode.ts").default;
			substitute_node_types(n.item, substitution);
			substitute_node_types(n.list, substitution);
			substitute_body_types(n.statements, substitution);
			if (n.update) substitute_node_types(n.update, substitution);
			break;
		}
		case "while": {
			const n = node as import("../nodes/WhileLoopNode.ts").default;
			substitute_node_types(n.condition, substitution);
			substitute_body_types(n.statements, substitution);
			if (n.update) substitute_node_types(n.update, substitution);
			break;
		}
		case "func_call": {
			const n = node as FunctionCallNode;
			for (const p of n.params) substitute_node_types(p, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "access": {
			const n = node as import("../nodes/AccessNode.ts").default;
			substitute_node_types(n.target, substitution);
			substitute_node_types(n.access, substitution);
			break;
		}
		case "access_func": {
			const n = node as import("../nodes/AccessFunctionCallNode.ts").default;
			for (const p of n.params) substitute_node_types(p, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "access_field": {
			const n = node as import("../nodes/AccessFieldNode.ts").default;
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "access_index": {
			const n = node as import("../nodes/AccessIndexNode.ts").default;
			substitute_node_types(n.index, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "op": {
			const n = node as import("../nodes/OperationNode.ts").default;
			substitute_node_types(n.left_value, substitution);
			substitute_node_types(n.right_value, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "grouped": {
			const n = node as import("../nodes/GroupedNode.ts").default;
			substitute_node_types(n.value, substitution);
			break;
		}
		case "cast": {
			const n = node as import("../nodes/CastNode.ts").default;
			substitute_node_types(n.value, substitution);
			n.target_type = substitute_type(n.target_type, substitution);
			if (n.type) n.type = substitute_type(n.type, substitution);
			break;
		}
		case "value":
		case "break":
		case "continue":
		case "panic":
		case "todo":
		case "raw":
		case "import":
			break;
	}
}
