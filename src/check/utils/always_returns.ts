import type BaseNode from "../../nodes/BaseNode.ts";

/** Check if a block always exits (e.g. contains a top-level return/break/continue) */
export default function block_always_returns(node: { statements: BaseNode[] }): boolean {
	return node.statements.some(
		(s) =>
			s.node_type === "return" ||
			s.node_type === "break" ||
			s.node_type === "continue" ||
			// A bare nested block is sequential: a return at its (top) level
			// always executes.
			(s.node_type === "block" && block_always_returns(s as never)),
	);
}
