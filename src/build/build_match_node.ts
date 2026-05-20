import MatchNode from "../nodes/MatchNode.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_match_node(node: MatchNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;

	status.scoped_declarations = [];

	status.code += "switch (";
	build_node(node.value, status);
	status.code += ") {\n";

	for (const match_case of node.cases) {
		status.scoped_declarations = [];
		status.code += "case ";
		build_node(match_case.match_value, status);
		status.code += ":\n";
		build_block_node(match_case.branch, status);
		status.code += "break;\n";
	}

	if (node.else_branch) {
		status.scoped_declarations = [];
		status.code += "default:\n";
		build_block_node(node.else_branch, status);
		status.code += "break;\n";
	}

	status.code += "}\n";

	status.scoped_declarations = old_scoped_declarations;
}
