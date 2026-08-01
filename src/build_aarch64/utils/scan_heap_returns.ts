import BaseNode from "../../nodes/BaseNode.ts";
import FunctionCallNode from "../../nodes/FunctionCallNode.ts";
import FunctionNode from "../../nodes/FunctionNode.ts";
import ReturnNode from "../../nodes/ReturnNode.ts";
import StructNode from "../../nodes/StructNode.ts";

const KNOWN_HEAP_RETURNING = new Set([
	"int_to_string",
	"uint_to_string",
	"int8_to_string",
	"uint8_to_string",
	"int16_to_string",
	"uint16_to_string",
	"int32_to_string",
	"uint32_to_string",
	"int64_to_string",
	"uint64_to_string",
	"float_to_string",
	"float32_to_string",
	"float64_to_string",
	"bool_to_string",
	"char_to_string",
	"File_readAll",
	"File_readLine",
	"File_readChunk",
	"File_read_all",
	"Directory_list",
	"Console_read_line",
	"Console_platform",
	"Json_serialize",
	"Json_deserialize",
	"Regex_match",
]);

export function scan_heap_returning_functions(root: BaseNode): Set<string> {
	const result = new Set<string>(KNOWN_HEAP_RETURNING);
	scan_statements((root as any).statements ?? [], result, undefined);
	return result;
}

function scan_statements(statements: any[], result: Set<string>, struct_name: string | undefined) {
	for (const stmt of statements) {
		if (stmt.node_type === "struct") {
			// Recurse into struct methods so e.g. Ansi.red / String.+ are detected.
			scan_statements((stmt as StructNode).functions ?? [], result, (stmt as StructNode).name);
			continue;
		}
		if (stmt.node_type === "func") {
			const func = stmt as FunctionNode;
			if (func.return_type?.name === "string" && func.has_body) {
				for (const s of func.statements) {
					if (
						s.node_type === "return" &&
						is_heap_string_expr((s as ReturnNode).value ?? undefined)
					) {
						// Match the label the build phase emits: `StructName_func_name`.
						const sanitized = func.name.replace(/#/g, "");
						const label = struct_name ? `${struct_name}_${sanitized}` : sanitized;
						result.add(label);
						break;
					}
				}
			}
			if (func.statements) {
				scan_statements(func.statements, result, struct_name);
			}
		}
	}
}

function is_heap_string_expr(node: BaseNode | undefined): boolean {
	if (!node) return false;

	if (node.node_type === "func_call") {
		const call = node as FunctionCallNode;
		if (call.name.startsWith("_string_interpolate_")) return true;
		if (call.name.endsWith("_to_string") && call.name !== "string_to_string") return true;
		return false;
	}

	if (node.node_type === "op") {
		const op = node as any;
		if (op.op === "*" && op.left_value?.type?.name === "string") return true;
		if (op.op === "+" && op.type?.name === "string") return true;
		return false;
	}

	return false;
}
