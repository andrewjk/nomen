import SwitchNode from "../nodes/SwitchNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { strip_outer_parens } from "./utils/build_condition.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";

export default function build_switch_node(node: SwitchNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;

	for (const c of node.cases) {
		status.scoped_declarations = enter_c_scope(status);

		const cond_start = status.code.length;
		build_node(c.condition, status);
		let cond_code = status.code.substring(cond_start);
		status.code = status.code.substring(0, cond_start);

		// Pull any statements (e.g. param allocations) out of the condition
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
		// Drop redundant outer parens so `if ((a == b))` isn't emitted
		// (clang's -Wparentheses-equality).
		cond_code = strip_outer_parens(cond_code);

		if (decls.length > 0) {
			status.code += decls.join("\n") + "\n";
		}
		const prefix = status.code.endsWith("} else ") ? "" : "";
		status.code += `${prefix}if (${cond_code}) {\n`;
		build_block_node(c.branch, status);
		build_auto_free(status);
		status.code += `} else `;
		leave_c_scope(status);
	}

	if (node.else_branch) {
		status.scoped_declarations = enter_c_scope(status);
		status.code += `{\n`;
		build_block_node(node.else_branch, status);
		build_auto_free(status);
		status.code += `}\n`;
		leave_c_scope(status);
	} else {
		// Strip the trailing `} else ` since there's no default branch
		status.code = status.code.replace(/\} else $/, "}\n");
	}

	status.scoped_declarations = old_scoped_declarations;
}
