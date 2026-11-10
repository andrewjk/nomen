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
		if (is_library(statement)) continue;
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
