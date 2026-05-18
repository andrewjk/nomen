import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function build_for_loop_node(node: ForLoopNode, status: BuildStatus) {
	const old_scoped_declarations = status.scoped_declarations;
	status.scoped_declarations = [];

	if (node.item && node.list) {
		if (node.list.node_type == "range") {
			// HACK: Only want to do this if the item hasn't been declared previously?
			status.code += `${c_type("int")} `;
			build_node(node.item, status);
			status.code += ";\nfor (";
			build_node(node.item, status);
			status.code += " = ";
			const range = node.list as RangeNode;
			if (range.left_value) {
				build_node(range.left_value, status);
			}
			status.code += "; ";
			build_node(node.item, status);
			status.code += " < ";
			if (range.right_value) {
				build_node(range.right_value, status);
			}
			status.code += "; ";
			build_node(node.item, status);
			status.code += "++)\n{\n";
		} else if (status.traits.find((t) => t.name === node.item.type.name) !== undefined) {
			// TODO: Handle index iterator variable
			const length = type_from_value_node(node.list).length;
			status.code += `for (int i = 0; i < `;
			build_node(length!, status);
			status.code += `; i++)\n{\n`;
			status.code += `void *${node.item.value} = *(`;
			build_node(node.list!, status);
			status.code += " + i);\n";
		} else {
			const list_type = type_from_value_node(node.list);
			const length = list_type.length;
			const element_type = list_type.name || "int";
			const idx_var = `_idx_${node.item.value}`;
			status.code += `for (int ${idx_var} = 0; ${idx_var} < `;
			build_node(length!, status);
			status.code += `; ${idx_var}++)\n{\n`;
			status.code += `${c_type(element_type)} ${node.item.value} = `;
			build_node(node.list!, status);
			status.code += `[${idx_var}];\n`;
		}
	}

	build_block_node(node, status);

	build_auto_free(status);

	status.code += `}\n`;

	status.scoped_declarations = old_scoped_declarations;
}
