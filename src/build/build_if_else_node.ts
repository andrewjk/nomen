import IfElseNode from "../nodes/IfElseNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_if_else_node(node: IfElseNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];

	const cond_start = status.code.length;
	build_node(node.condition, status);
	let cond_code = status.code.substring(cond_start);
	status.code = status.code.substring(0, cond_start);

	const decls: string[] = [];
	while (cond_code.includes(";")) {
		const semi = cond_code.indexOf(";");
		const stmt = cond_code.substring(0, semi + 1).trim();
		cond_code = cond_code.substring(semi + 1).trim();
		decls.push(stmt);
	}
	cond_code = cond_code.trim();

	while (cond_code.startsWith("(") && !cond_code.endsWith(")")) {
		cond_code = cond_code.substring(1).trim();
	}

	if (decls.length > 0) {
		status.code += decls.join("\n") + "\n";
	}
	status.code += `if (${cond_code}) {\n`;

	if (node.if_branch) {
		build_block_node(node.if_branch, status);
		build_auto_free(status);
	}
	if (node.else_branch) {
		status.code += `} else {\n`;
		build_block_node(node.else_branch, status);
		build_auto_free(status);
	}
	status.code += `}\n`;

	status.scoped_declarations = old_scoped_declarations;
}
