import BitsetNode from "../nodes/BitsetNode.ts";
import type BlockNode from "../nodes/BlockNode.ts";
import { is_function_node, is_struct_node, is_trait_node } from "../nodes/check_node_type.ts";
import EnumNode from "../nodes/EnumNode.ts";
import StructNode from "../nodes/StructNode.ts";
import TraitNode from "../nodes/TraitNode.ts";
import build_bitset_node from "./build_bitset_node.ts";
import build_enum_node from "./build_enum_node.ts";
import build_function_node from "./build_function_node.ts";
import build_node from "./build_node.ts";
import build_struct_body from "./build_struct_body.ts";
import build_struct_node from "./build_struct_node.ts";
import build_trait_node from "./build_trait_node.ts";
import type BuildStatus from "./BuildStatus.ts";

export default function build_block_node(node: BlockNode, status: BuildStatus) {
	// Gather structs, traits and funcs that might be used before they are declared
	gather_structs(node, status);

	// PERF: Probably an opportunity to cut down on loops here by adding a prop in check?
	// Or storing these things in different lists?

	// Emit all struct forward declarations to headers before building anything,
	// so that function declarations can reference struct types not yet built.
	for (let child of node.statements) {
		if (is_struct_node(child)) {
			const struct = child as StructNode;
			if (!struct.is_simple_type && !struct.is_generic) {
				status.headers += `struct ${struct.name};\n`;
			}
		}
	}

	// Pass 1: Emit all struct bodies first so that all types are fully defined
	// before any struct functions are emitted (which may access fields of other structs).
	for (let child of node.statements) {
		if (is_struct_node(child)) {
			build_struct_body(child as StructNode, status);
		}
	}

	// Pass 2: Build traits, then enums/bitsets, then struct functions, then functions
	for (let child of node.statements) {
		if (is_trait_node(child)) {
			build_trait_node(child, status);
		}
	}

	for (let child of node.statements) {
		if (child.node_type === "enum") {
			build_enum_node(child as EnumNode, status);
		}
	}

	for (let child of node.statements) {
		if (child.node_type === "bitset") {
			build_bitset_node(child as BitsetNode, status);
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
		if (
			!is_trait_node(child) &&
			!is_struct_node(child) &&
			!is_function_node(child) &&
			child.node_type !== "enum" &&
			child.node_type !== "bitset"
		)
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
			case "enum": {
				status.enums.push(node as EnumNode);
				break;
			}
			case "bitset": {
				status.bitsets.push(node as BitsetNode);
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
