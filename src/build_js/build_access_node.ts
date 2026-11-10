import type AccessFunctionCallNode from "../nodes/AccessFunctionCallNode.ts";
import type AccessNode from "../nodes/AccessNode.ts";
import type BaseNode from "../nodes/BaseNode.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { enum_case_value } from "./enums.ts";
import { method_label } from "./names.ts";
import { kind_of, type_name_of } from "./types.ts";

/**
 * Emit a JS expression for a member access:
 *  - field access → `obj.field`;
 *  - static library calls (`Console.write`, `Format.pad`, …) → runtime helpers;
 *  - string/array builtins → the native JS equivalents;
 *  - user struct methods → `<Struct>_<method>(self, args…)`.
 * Anything outside the supported subset becomes a loud runtime error.
 */
export default function build_access_node(node: AccessNode, status: BuildStatus): string {
	const access = node.access;
	if (access.node_type === "access_field") {
		// A tag-only enum case used as a value (`Dir.north`).
		const enum_node = status.enums.find((e) => e.name === type_name_of(node.target));
		if (enum_node) {
			const case_index = enum_node.cases.findIndex((c) => c.name === access.name);
			if (case_index !== -1) return enum_case_value(enum_node, case_index, []);
		}
		return `${expr(node.target, status)}.${access.name}`;
	}
	return build_method_call(node.target, access as AccessFunctionCallNode, status);
}

function build_method_call(
	target: BaseNode,
	access: AccessFunctionCallNode,
	status: BuildStatus,
): string {
	const name = access.name;
	const args = access.params.map((p) => expr(p, status));
	const target_type = type_name_of(target);
	const target_kind = kind_of(target);

	if (access.is_static) {
		if (target_type === "Console") return `Console_${name}(${args.join(", ")})`;
		if (target_type === "Format") return `Format_${name}(${args.join(", ")})`;
		const enum_node = status.enums.find((e) => e.name === target_type);
		if (enum_node) {
			const case_index = enum_node.cases.findIndex((c) => c.name === name);
			if (case_index !== -1) return enum_case_value(enum_node, case_index, args);
		}
		const struct = status.structs.find((s) => s.name === target_type);
		if (struct) return `${method_label(target_type, name)}(${args.join(", ")})`;
		return unsupported(`${target_type}.${name}`);
	}

	if (target_kind === "string" || target_kind === "char") {
		const text = expr(target, status);
		switch (name) {
			case "to_string":
				return text;
			case "length":
				return `${text}.length`;
			case "at":
				return `${text}.at(Number(${args[0]}))`;
			case "slice":
				return `${text}.slice(Number(${args[0]}), Number(${args[1]}))`;
			case "copy":
				return text;
			case "trim":
				return `${text}.trim()`;
		}
		return unsupported(`string.${name}`);
	}

	if (target_kind === "array") {
		const list = expr(target, status);
		switch (name) {
			case "length":
				return `${list}.length`;
			case "at":
				return `${list}[Number(${args[0]})]`;
			case "set":
				return `(${list}[Number(${args[0]})] = ${args[1]})`;
			case "push":
				return `${list}.push(${args[0]})`;
			case "pop":
				return `${list}.pop()`;
			case "copy":
				return `${list}.slice()`;
		}
		return unsupported(`array.${name}`);
	}

	if (name === "to_string") {
		return `__to_string(${expr(target, status)})`;
	}

	const struct = status.structs.find((s) => s.name === target_type);
	if (struct) {
		return `${method_label(target_type, name)}(${[expr(target, status), ...args].join(", ")})`;
	}
	return unsupported(`${target_type}.${name}`);
}

function unsupported(what: string): string {
	return `__unsupported(${JSON.stringify(what)})`;
}
