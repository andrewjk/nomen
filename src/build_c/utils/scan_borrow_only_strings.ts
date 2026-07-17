import AssignmentNode from "../../nodes/AssignmentNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import is_string_borrow from "./is_string_borrow.ts";

const CHILD_KEYS = [
	"value",
	"left",
	"right",
	"condition",
	"body",
	"true_statements",
	"false_statements",
	"else_statements",
	"statements",
	"update",
	"list",
	"item",
	"args",
	"left_value",
	"right_value",
	"target",
	"index",
	"if_branch",
	"else_branch",
	"branch",
];

/**
 * Find variable names that are reassigned ONLY to borrowed values (e.g.
 * `filename = init.args.at(1)`) within a function body — never to a freshly
 * allocated (heap) value. For such a variable, a `var string x = "literal"`
 * declaration must NOT strdup the literal into a heap copy: the variable gives
 * up ownership on the (possibly untaken) borrow branch, and auto_free can't
 * tell at scope exit whether the borrow happened. A pre-emptive strdup leaks
 * whenever the borrow branch isn't taken. Mirrors aarch64, which never
 * strdup's literals and tracks ownership per-assignment instead.
 *
 * Conservative under shadowing: if ANY assignment to the name — even a
 * different shadowed instance — is a non-borrow (heap/value) reassignment, the
 * name is excluded. So a shadowed heap reassignment disables the skip for all
 * same-named declarations, never omitting a strdup where one is needed.
 */
export default function scan_borrow_only_strings(body: BaseNode): Set<string> {
	const borrow = new Set<string>();
	const other = new Set<string>();
	walk(body);
	const result = new Set<string>();
	for (const name of borrow) {
		if (!other.has(name)) result.add(name);
	}
	return result;

	function walk(n: BaseNode | null | undefined) {
		if (!n) return;
		const any_n = n as unknown as { node_type?: string; [k: string]: any };
		if (n.node_type === "assign") {
			const a = n as AssignmentNode;
			if (a.left_value.node_type === "value" && !a.operator) {
				const name = (a.left_value as ValueNode).value;
				if (is_string_borrow(a.right_value)) borrow.add(name);
				else other.add(name);
			}
		}
		for (const key of CHILD_KEYS) {
			recurse(any_n[key]);
		}
		// Switch `cases` is an array of { condition, branch } records rather
		// than BaseNodes, so recurse into its BaseNode children explicitly.
		if (Array.isArray(any_n.cases)) {
			for (const c of any_n.cases) {
				if (c && typeof c === "object") {
					recurse(c.condition);
					recurse(c.branch);
				}
			}
		}
	}

	function recurse(child: any) {
		if (Array.isArray(child)) {
			for (const c of child) {
				if (c && typeof c === "object" && typeof c.node_type === "string") walk(c);
			}
		} else if (child && typeof child === "object" && typeof child.node_type === "string") {
			walk(child);
		}
	}
}
