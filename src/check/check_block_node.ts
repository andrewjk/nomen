import add_error from "../add_error.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_block_node(node: BlockNode, status: CheckStatus) {
	gather_structs(node, status);

	status.stack.push(node);
	for (let child of node.statements) {
		check_node(child, status);
	}
	status.stack.pop();
}

function gather_structs(block: BlockNode, status: CheckStatus) {
	const names_in_block = {
		structs: new Set<string>(),
		traits: new Set<string>(),
		functions: new Set<string>(),
	};

	for (let node of block.statements) {
		switch (node.node_type) {
			case "struct": {
				const struct = node as StructNode;
				if (names_in_block.structs.has(struct.name)) {
					add_error(status, `Struct already declared: ${struct.name}`, struct.start);
				} else {
					names_in_block.structs.add(struct.name);
					status.types.push(struct.name);
					status.structs.push(struct);
				}
				break;
			}
			case "trait": {
				const trait = node as TraitNode;
				if (names_in_block.traits.has(trait.name)) {
					add_error(status, `Trait already declared: ${trait.name}`, trait.start);
				} else {
					names_in_block.traits.add(trait.name);
					status.types.push(trait.name);
					status.traits.push(trait);
				}
				break;
			}
			case "func": {
				const func = node as FunctionNode;
				if (names_in_block.functions.has(func.name)) {
					add_error(status, `Function already declared: ${func.name}`, func.start);
				} else {
					names_in_block.functions.add(func.name);
					status.functions.push(func);
				}
				break;
			}
		}
	}
}
