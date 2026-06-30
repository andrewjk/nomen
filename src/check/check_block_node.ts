import add_error from "../add_error.ts";
import BitsetNode from "../nodes/BitsetNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import EnumNode from "../nodes/EnumNode.ts";
import FunctionNode from "../nodes/FunctionNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_block_node(node: BlockNode, status: CheckStatus) {
	gather_structs(node, status);

	status.scope_depth++;
	status.stack.push(node);
	for (let child of node.statements) {
		check_node(child, status);
	}
	status.stack.pop();
	status.scope_depth--;
}

function gather_structs(block: BlockNode, status: CheckStatus) {
	const names_in_block = {
		structs: new Set<string>(),
		traits: new Set<string>(),
		functions: new Set<string>(),
		enums: new Set<string>(),
		bitsets: new Set<string>(),
	};

	for (let node of block.statements) {
		switch (node.node_type) {
			case "struct": {
				const struct = node as StructNode;
				if (names_in_block.structs.has(struct.name)) {
					add_error(status, `Struct already declared: ${struct.name}`, struct.start);
				} else {
					names_in_block.structs.add(struct.name);
					struct.scope = status.stack.at(-1) || block;
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
					func.scope = status.stack.at(-1) || block;
					status.functions.push(func);
				}
				break;
			}
			case "enum": {
				const enum_node = node as EnumNode;
				if (names_in_block.enums.has(enum_node.name)) {
					add_error(status, `Enum already declared: ${enum_node.name}`, enum_node.start);
				} else {
					names_in_block.enums.add(enum_node.name);
					status.types.push(enum_node.name);
					status.enums.push(enum_node);
				}
				break;
			}
			case "bitset": {
				const bitset_node = node as BitsetNode;
				if (names_in_block.bitsets.has(bitset_node.name)) {
					add_error(status, `Bitset already declared: ${bitset_node.name}`, bitset_node.start);
				} else {
					names_in_block.bitsets.add(bitset_node.name);
					status.types.push(bitset_node.name);
					status.bitsets.push(bitset_node);
				}
				break;
			}
		}
	}
}
