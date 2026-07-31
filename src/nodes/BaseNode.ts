import type { NodeType } from "./NodeType.ts";

/**
 * The base node type which all nodes extend
 */
export default class BaseNode {
	node_type: NodeType;
	start: number;

	/** Documentation block comment preceding this declaration, if any.
	 *  Attached after parsing by attach_doc_comments. */
	doc?: string;

	// HACK: We attach declarations for e.g. function call params here on check
	// We don't want to add them into the statements at check time, because that affects the check loop
	// We don't want to add them to the statements afterwards, because that would be slower
	allocations?: BaseNode[];

	/** Set when this expression was written with a leading `mov` (e.g. `b = mov a`,
	 *  `var X b = mov a`). Marks an ownership transfer rather than a copy. */
	is_moved?: boolean;

	constructor(node_type: NodeType, start: number) {
		this.node_type = node_type;
		this.start = start;
	}
}
