import type { NirStmt } from "../nir/nir.ts";
import SwitchNode from "../nodes/SwitchNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { build_block_with_cursor } from "./emit_nir.ts";
import { strip_outer_parens } from "./utils/build_condition.ts";
import { enter_c_scope, leave_c_scope } from "./utils/c_scope.ts";
import { begin_code_scratch, end_code_scratch } from "./utils/code_scratch.ts";

export default function build_switch_node(
	node: SwitchNode,
	status: BuildStatus,
	nir?: NirStmt & { kind: "switch_match" },
) {
	const old_scoped_declarations = status.scoped_declarations;

	for (let i = 0; i < node.cases.length; i++) {
		const c = node.cases[i];
		status.scoped_declarations = enter_c_scope(status);

		// The condition builds into a scratch buffer (code_scratch.ts) — the
		// historical substring-and-truncate capture flattened the accumulated
		// code rope per case (an O(code) copy, quadratic in memory).
		const saved_code = begin_code_scratch(status);
		build_node(c.condition, status);
		let cond_code = end_code_scratch(status, saved_code);

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
		// The `} else ` connector separating the previous case (or nothing for
		// the first) from this one — appended BEFORE the case's own decls/`if`
		// so the byte order matches the historical emit-then-strip form.
		if (i > 0) {
			status.code += "} else ";
		}
		status.code += `if (${cond_code}) {\n`;
		build_block_with_cursor(c.branch, nir?.arms[i]?.branch, status);
		build_auto_free(status);
		leave_c_scope(status);
	}

	if (node.else_branch) {
		status.code += "} else ";
		status.scoped_declarations = enter_c_scope(status);
		status.code += `{\n`;
		build_block_with_cursor(node.else_branch, nir?.otherwise ?? undefined, status);
		build_auto_free(status);
		status.code += `}\n`;
		leave_c_scope(status);
	} else if (node.cases.length > 0) {
		// Close the last case's `if` block (the connector that used to be
		// rewritten into this by the trailing replace below).
		status.code += "}\n";
	}

	status.scoped_declarations = old_scoped_declarations;
}
