import add_error from "../add_error.ts";
import AccessFieldNode from "../nodes/AccessFieldNode.ts";
import AccessNode from "../nodes/AccessNode.ts";
import ForLoopNode from "../nodes/ForLoopNode.ts";
import RangeNode from "../nodes/RangeNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import check_block_node from "./check_block_node.ts";
import check_node from "./check_node.ts";
import type CheckStatus from "./CheckStatus.ts";
import clone_status from "./utils/clone_status.ts";
import type_from_value_node from "./utils/type_from_value_node.ts";

export default function check_for_loop_node(for_loop: ForLoopNode, status: CheckStatus) {
	let for_status = clone_status(status);

	if (for_loop.list) {
		check_node(for_loop.list, for_status);

		const list_type = type_from_value_node(for_loop.list, for_status);
		if (!list_type.is_array && list_type.name) {
			add_error(
				for_status,
				`For loop list must be an array, not ${list_type.name}`,
				for_loop.list.start,
			);
		}

		if (for_loop.item) {
			for_loop.item.type = new Type(list_type.name);

			let range_lower: number | undefined;
			let range_upper: number | undefined;

			if (for_loop.list instanceof RangeNode) {
				const range = for_loop.list;
				if (range.left_value.node_type === "value") {
					range_lower = parseInt((range.left_value as ValueNode).value, 10);
					if (isNaN(range_lower)) range_lower = undefined;
				}
				if (range.right_value.node_type === "access") {
					const access = range.right_value as AccessNode;
					if (access.access.node_type === "access_field") {
						const field = access.access as AccessFieldNode;
						if (field.name === "length" && access.target.node_type === "value") {
							const decl = for_status.values.findLast(
								(v) => v.name === (access.target as ValueNode).value,
							);
							if (decl?.type?.length) {
								range_upper = parseInt((decl.type.length as ValueNode).value, 10);
								if (isNaN(range_upper)) range_upper = undefined;
							}
						}
					}
				}
			}

			for_status.values.push({
				declaration: "var",
				name: for_loop.item.value,
				type: for_loop.item.type,
				is_set: true,
				range_lower,
				range_upper,
			});
		}
	}

	check_block_node(for_loop, for_status);

	if (for_loop.update) {
		check_node(for_loop.update, for_status);
	}
}
