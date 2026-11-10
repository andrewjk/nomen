import type OperationNode from "../nodes/OperationNode.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import { kind_of } from "./types.ts";

/** Emit a JS expression for a Nomen operator node. Ints are bigints and
 *  floats are numbers, so the same JS operator serves both; the one special
 *  case is string repetition (`"x" * n` → `.repeat(n)`). */
export default function build_operation_node(node: OperationNode, status: BuildStatus): string {
	const op = node.op;
	if (op === "u-") return `(-${expr(node.left_value, status)})`;
	if (op === "!") return `(!${expr(node.left_value, status)})`;

	const left = expr(node.left_value, status);
	const right = expr(node.right_value, status);

	if (op === "*" && kind_of(node.left_value) === "string") {
		return `(${left}.repeat(Number(${right})))`;
	}

	// Value equality on the JS representations is exact (bigint vs bigint,
	// string vs string); use the strict forms so a null check can't be
	// satisfied by undefined.
	if (op === "==") return `(${left} === ${right})`;
	if (op === "!=") return `(${left} !== ${right})`;

	return `(${left} ${op} ${right})`;
}
