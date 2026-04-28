import type BlockNode from "../nodes/BlockNode.ts";
import { is_function_node, is_struct_node, is_trait_node } from "../nodes/check_node_type.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import build_function_node from "./build_function_node.ts";
import build_node from "./build_node.ts";
import build_struct_node from "./build_struct_node.ts";
import build_trait_node from "./build_trait_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_block_node(node: BlockNode, status: BuildStatus) {
	// Gather structs, traits and funcs that might be used before they are declared
	gather_structs(node, status);

	// PERF: Probably an opportunity to cut down on loops here by adding a prop in check?
	// Or storing these things in different lists?

	// Build traits, then structs, then functions
	for (let child of node.statements) {
		if (is_trait_node(child)) {
			build_trait_node(child, status);
		}
	}

	for (let child of node.statements) {
		if (is_struct_node(child)) {
			build_struct_node(child, status);
		}
	}

	for (let child of node.statements) {
		if (is_function_node(child)) {
			build_function_node(child, status);
		}
	}

	// Build the block's statements
	for (let child of node.statements) {
		if (!is_trait_node(child) && !is_struct_node(child) && !is_function_node(child))
			build_node(child, status, true);
	}
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
			//case "func": {
			//  const func = node as FunctionNode;
			//  status.functions.push(func);
			//  break;
			//}
		}
	}
}
