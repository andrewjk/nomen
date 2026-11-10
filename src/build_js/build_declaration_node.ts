import { get_built_in_type } from "../built_in_types.ts";
import type DeclarationNode from "../nodes/DeclarationNode.ts";
import type Type from "../nodes/Type.ts";
import { emit, expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { js_name } from "./names.ts";
import { copy_if_value_struct, wrap_for_type } from "./types.ts";

/** Emit a `var`/`const` declaration. Uninitialized locals get the type's
 *  zero value (JS `let x;` would be `undefined`, which no Nomen value is). */
export default function build_declaration_node(node: DeclarationNode, status: BuildStatus): void {
	const keyword = node.declaration === "const" ? "const" : "let";
	const name = js_name(node.name);
	const raw = node.value ? expr(node.value, status) : zero_value(node.type);
	const copied = node.value ? copy_if_value_struct(raw, node.type?.name, status) : raw;
	const value = node.value ? wrap_for_type(copied, node.type) : copied;
	emit(status, `${keyword} ${name} = ${value};`);
}

function zero_value(type: Type | undefined): string {
	if (!type) return "null";
	if (type.is_array) return "[]";
	const info = get_built_in_type(type.name);
	switch (info?.kind) {
		case "int":
			return "0n";
		case "float":
			return "0";
		case "bool":
			return "false";
		case "char":
		case "string":
			return '""';
		default:
			return "null";
	}
}
