import TraitNode from "../nodes/TraitNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";
import build_parameter_node from "./build_parameter_node";
import c_type from "./utils/c_type";

export default function build_trait_node(node: TraitNode, status: BuildStatus) {
  // We only need to build a trait node if there are default functions
  //if (!node.functions.find((f) => f.has_body)) {
  //  return;
  //}

  // TODO: Only if top-level
  status.headers += `// trait ${node.name}\n`;
  status.code += `// trait ${node.name}\n`;

  // Declare the trait as a struct
  status.headers += `struct ${node.name};\n`;
  status.code += `typedef struct ${node.name}\n{\n`;

  // Build the trait's fields
  // Fields from the struct
  //for (let field of node.fields) {
  //  status.code += `${c_type(field.type.name)} ${field.name};\n`;
  //}

  status.code += `} ${node.name};\n`;

  // Build the trait's default functions
  for (let func of node.functions) {
    if (!func.has_body) {
      continue;
    }

    // Define the function
    // HACK: Need to map names to types
    const func_start = status.code.length;
    status.code += `${c_type(func.return_type.name || "void")} ${node.name}_${func.name}(`;
    for (let i = 0; i < func.params.length; i++) {
      if (i > 0) {
        status.code += ", ";
      }
      build_parameter_node(func.params[i], status);
    }
    status.code += `)`;

    // TODO: Only if top-level
    status.headers += `${status.code.substring(func_start)};\n`;

    status.code += `\n{\n`;

    // HACK: Dereference the `self` pointer arg to a local variable with a random name
    // (`_self` for now, but we could automate it)
    // TODO: Store whether the type of the parameter is a pointer, and use -> in build_node etc
    if (func.params[0]?.is_self_param) {
      status.code += `struct ${node.name} _self = *self;\n`;
    }
    for (let child of func.statements) {
      build_node(child, status, true);
    }
    status.code += `}\n`;
  }

  status.headers += "\n";
  status.code += "\n";
}
