import AccessIndexNode from "../nodes/AccessIndexNode";
import AccessNode from "../nodes/AccessNode";
import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "../build/BuildStatus";
import build_node from "./build_node";

export default function build_access_node(node: AccessNode, status: BuildStatus) {
  switch (node.access.node_type) {
    case "access_index": {
      const access_index = node.access as AccessIndexNode;

      // Get base address
      if (node.target.node_type === "value") {
        const name = (node.target as ValueNode).value;
        status.code += `adr x0, ${name}\n`;
      } else {
        build_node(node.target, status);
        if (!status.code.endsWith("\n")) {
          status.code += "\n";
        }
      }
      status.code += `mov x3, x0\n`;

      // Evaluate index
      if (access_index.index.node_type === "value") {
        const index_val = (access_index.index as ValueNode).value;
        if (/^(\+|-)*\d+$/.test(index_val)) {
          const offset = parseInt(index_val) * 8;
          status.code += `ldr x0, [x3, #${offset}]\n`;
          return;
        }
      }

      build_node(access_index.index, status);
      if (!status.code.endsWith("\n")) {
        status.code += "\n";
      }
      status.code += `mov x1, x0\n`;
      status.code += `mov x2, #8\n`;
      status.code += `mul x1, x1, x2\n`;
      status.code += `add x0, x3, x1\n`;
      status.code += `ldr x0, [x0]\n`;
      break;
    }
    default: {
      build_node(node.target, status);
      status.code += `/* unsupported access */\n`;
    }
  }
}
