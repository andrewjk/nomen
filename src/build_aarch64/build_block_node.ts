import type BuildStatus from "../build/BuildStatus.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_function_node, is_struct_node, is_trait_node } from "../nodes/check_node_type.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import build_function_node from "./build_function_node.ts";
import build_node from "./build_node.ts";
import build_struct_node from "./build_struct_node.ts";
import { emit_destroy_for_scope } from "./utils/auto_destroy.ts";

export default function build_block_node(node: BlockNode, status: BuildStatus) {
	gather_structs(node, status);

	const declarations_before = status.scoped_declarations.length;

	for (let child of node.statements) {
		if (is_struct_node(child)) {
			build_struct_node(child as StructNode, status);
		}
	}

	for (let child of node.statements) {
		if (is_function_node(child)) {
			build_function_node(child as FunctionNode, status);
		}
	}

	for (let child of node.statements) {
		if (!is_trait_node(child) && !is_struct_node(child) && !is_function_node(child))
			build_node(child, status, true);
	}

	emit_destroy_for_scope(status, declarations_before);
}

function gather_structs(block: BlockNode, status: BuildStatus) {
	for (let node of block.statements) {
		switch (node.node_type) {
			case "struct": {
				const struct = node as StructNode;
				status.structs.push(struct);
				break;
			}
			case "trait": {
				const trait = node as TraitNode;
				status.traits.push(trait);
				break;
			}
		}
	}
}
