import type ArrayValuesNode from "../nodes/ArrayValuesNode.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** Emit a JS array literal (`[a, b, c]`). */
export default function build_array_values_node(
	node: ArrayValuesNode,
	status: BuildStatus,
): string {
	return `[${node.values.map((v) => expr(v, status)).join(", ")}]`;
}
