import type { NodeType } from "./NodeType.ts";

/**
 * The base node type which all nodes extend
 */
export default class BaseNode {
	node_type: NodeType;
	start: number;

	// HACK: We attach declarations for e.g. function call params here on check
	// We don't want to add them into the statements at check time, because that affects the check loop
	// We don't want to add them into the statements afterwards, because that would be slower
	allocations?: BaseNode[];

	constructor(node_type: NodeType, start: number) {
		this.node_type = node_type;
		this.start = start;
	}
}
