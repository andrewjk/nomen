import type BuildStatus from "../build/BuildStatus.ts";
import type_from_value_node from "../build/utils/type_from_value_node.ts";
import CastNode from "../nodes/CastNode.ts";
import build_node from "./build_node.ts";
import aarch64_size from "./utils/aarch64_size.ts";

function ensure_newline(status: BuildStatus) {
	if (!status.code.endsWith("\n")) {
		status.code += "\n";
	}
}

export default function build_cast_node(node: CastNode, status: BuildStatus) {
	build_node(node.value, status);
	ensure_newline(status);

	const from_type = type_from_value_node(node.value);
	const from = from_type.name;
	const to = node.target_type.name;
	const fs = aarch64_size(from);
	const ts = aarch64_size(to);

	if (from === to || (fs === ts && from !== "float" && from !== "float32" && from !== "float64")) {
		return;
	}

	if (ts > fs) {
		if (from === "bool" || from === "int8" || from === "uint8" || from === "char") {
			if (from === "int8" || from === "char") {
				status.code += `sxtb x0, x0\n`;
			} else {
				status.code += `and x0, x0, #0xFF\n`;
			}
		} else if (from === "int16") {
			status.code += `sxth x0, x0\n`;
		} else if (from === "uint16") {
			status.code += `and x0, x0, #0xFFFF\n`;
		} else if (from === "int32" || from === "int") {
			status.code += `sxtw x0, x0\n`;
		} else if (from === "uint32" || from === "uint") {
			status.code += `and x0, x0, #0xFFFFFFFF\n`;
		}
	} else if (ts < fs) {
		if (to === "bool" || to === "int8" || to === "uint8" || to === "char") {
			status.code += `and x0, x0, #0xFF\n`;
		} else if (to === "int16" || to === "uint16") {
			status.code += `and x0, x0, #0xFFFF\n`;
		} else if (to === "int32" || to === "uint32") {
			status.code += `and x0, x0, #0xFFFFFFFF\n`;
		}
	}
}
