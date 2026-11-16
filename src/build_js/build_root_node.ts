import type BaseNode from "../nodes/BaseNode.ts";
import type FunctionNode from "../nodes/FunctionNode.ts";
import type RootNode from "../nodes/RootNode.ts";
import { emit, stmt } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/**
 * Emit the program: every non-library root statement in order, then the
 * entry-point call. The System library's own declarations are skipped — the
 * JS runtime provides the supported slice of its surface (Console, Format,
 * the string/array builtins), and anything else fails loudly at the call
 * site.
 */
export default function build_root_node(root: RootNode, status: BuildStatus): void {
	let main: FunctionNode | undefined;
	for (const statement of root.statements) {
		if (is_library(statement)) {
			// Library file-scope constants (e.g. the regex engine's opcode
			// numbers) are plain values any lowered body may reference —
			// emit them into the library section (top-level `const` is
			// initialized before `main()` runs).
			if (
				statement.node_type === "declare" &&
				(statement as unknown as { declaration?: string }).declaration === "const"
			) {
				console.error(
					"DEBUG lib const:",
					(statement as any).name,
					"value type:",
					(statement as any).value?.node_type,
					"vtype:",
					(statement as any).value?.type?.name,
				);
				const outer_code = status.code;
				const outer_indent = status.indent;
				status.code = "";
				status.indent = 0;
				stmt(statement, status);
				status.library_code += status.code;
				status.code = outer_code;
				status.indent = outer_indent;
			}
			continue;
		}
		if (statement.node_type === "import") continue;
		if (statement.node_type === "func" && (statement as FunctionNode).name === "main") {
			main = statement as FunctionNode;
		}
		stmt(statement, status);
	}

	const args = main && main.params.length > 0 ? "({})" : "()";
	emit(status, `main${args};`);
}

function is_library(node: BaseNode): boolean {
	return (node as unknown as { is_library?: boolean }).is_library === true;
}
