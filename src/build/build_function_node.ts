import FunctionNode from "../nodes/FunctionNode.ts";
import build_auto_free from "./build_auto_free.ts";
import build_block_node from "./build_block_node.ts";
import build_node from "./build_node.ts";
import build_parameter_node from "./build_parameter_node.ts";
import type BuildStatus from "./BuildStatus.ts";
import c_type from "./utils/c_type.ts";

export default function build_function_node(node: FunctionNode, status: BuildStatus) {
  const old_scoped_declarations = status.scoped_declarations;
  status.scoped_declarations = [];

  // TODO: Only if top-level
  status.headers += `// Func ${node.name}\n`;
  status.code += `// Func ${node.name}\n`;

  const func_start = status.code.length;
  if (node.name.toLocaleLowerCase() === "main") {
    status.code += `int main(`;
  } else {
    if (node.return_type.name) {
      // TODO: Set is_struct / is_trait on type when checking
      if (
        status.structs.find((s) => s.name === node.return_type.name) ||
        status.traits.find((t) => t.name === node.return_type.name)
      ) {
        status.code += `struct `;
      }
      status.code += `${c_type(node.return_type.name)} `;
      if (status.traits.find((t) => t.name === node.return_type.name)) {
        status.code += `*`;
      }
      if (node.return_type.is_array) {
        status.code += `[`;
        if (node.return_type.length) {
          build_node(node.return_type.length, status);
        }
        status.code += `] `;
      }
    } else {
      status.code += `void `;
    }
    status.code += `${node.name}(`;
  }
  for (let i = 0; i < node.params.length; i++) {
    if (i > 0) {
      status.code += ", ";
    }
    build_parameter_node(node.params[i], status);
  }
  status.code += `)`;

  // TODO: Only if top-level
  status.headers += `${status.code.substring(func_start)};\n\n`;

  status.code += `\n{\n`;

  build_block_node(node, status);

  if (!node.has_return) {
    build_auto_free(status);
  }

  // Print out the number of mallocs less the number of frees, which should be 0!
  if (node.name.toLocaleLowerCase() === "main") {
    status.code += `\nprintf("\\n\\nMalloc balance: %d\\n", malloc_count);\n`;
  }

  status.code += `}\n\n`;

  status.scoped_declarations = old_scoped_declarations;
}
