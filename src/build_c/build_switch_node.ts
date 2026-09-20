import type { NirStmt } from "../nir/nir.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { strip_outer_parens } from "./utils/build_condition.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";

export default function build_switch_node(
	node: SwitchNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "switch_match" },
) {
	const old_scoped_declarations = status.scoped_declarations;

	for (let i = 0; i < node.cases.length; i++) {
		const c = node.cases[i];
		status.scoped_declarations = enter_c_scope(status);

		const cond_start = status.code.length;
		build_node(c.condition, status);
		let cond_code = status.code.substring(cond_start);
		status.code = status.code.substring(0, cond_start);

		// Pull any statements (e.g. param allocations) out of the condition.
		// Split only at TOP-LEVEL semicolons: paren/brace depth tracking keeps
		// statement expressions intact (the string→view adapter is
		// `({ ... ; ...; })` — its inner semicolons must NOT split), and
		// string-literal skipping keeps `"a;b"` intact.
		const decls: string[] = [];
		{
			let depth = 0;
			let stmt_start = 0;
			let in_string = false;
			let in_char = false;
			let i = 0;
			while (i < cond_code.length) {
				const ch = cond_code[i];
				if (in_string) {
					if (ch === "\\") i += 1;
					else if (ch === '"') in_string = false;
				} else if (in_char) {
					if (ch === "\\") i += 1;
					else if (ch === "'") in_char = false;
				} else if (ch === '"') {
					in_string = true;
				} else if (ch === "'") {
					in_char = true;
				} else if (ch === "(" || ch === "{") {
					depth += 1;
				} else if (ch === ")" || ch === "}") {
					depth = Math.max(0, depth - 1);
				} else if (ch === ";" && depth === 0) {
					const stmt = cond_code.substring(stmt_start, i + 1).trim();
					if (stmt) decls.push(stmt);
					stmt_start = i + 1;
				}
				i += 1;
			}
			cond_code = cond_code.substring(stmt_start).trim();
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
		build_block_with_cursor(c.branch, nir?.arms[i]?.branch, status);
		build_auto_free(status);
		status.code += `} else `;
		leave_c_scope(status);
	}

	if (node.else_branch) {
		status.scoped_declarations = enter_c_scope(status);
		status.code += `{\n`;
		build_block_with_cursor(node.else_branch, nir?.otherwise ?? undefined, status);
		build_auto_free(status);
		status.code += `}\n`;
		leave_c_scope(status);
	} else {
		// Strip the trailing `} else ` since there's no default branch
		status.code = status.code.replace(/\} else $/, "}\n");
	}

	status.scoped_declarations = old_scoped_declarations;
}
