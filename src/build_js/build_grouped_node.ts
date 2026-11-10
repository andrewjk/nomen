import type GroupedNode from "../nodes/GroupedNode.ts";
import { expr } from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";

/** A parenthesized expression: keep the grouping in the emitted JS. */
export default function build_grouped_node(node: GroupedNode, status: BuildStatus): string {
	return `(${expr(node.value, status)})`;
}
