import TraitNode from "../nodes/TraitNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";
import build_parameter_node from "./build_parameter_node";
import c_type from "./c_type";

export default function build_trait_node(node: TraitNode, status: BuildStatus) {
  // We only need to build a trait node if there are default functions
  if (!node.functions.find((f) => f.has_body)) {
    return;
  }

  status.headers += `// ${node.name}:\n`;
  status.code += `// ${node.name}:\n`;

  // Declare the trait as a struct
  status.headers += `struct ${node.name};\n`;
  status.code += `typedef struct ${node.name}\n{\n} ${node.name};\n`;

  // Build the trait's default functions
  for (let func of node.functions) {
    // Define the function
    // HACK: Need to map names to types
    status.headers += `${c_type(func.return_type.name || "void")} ${node.name}_${
      func.name
    }(struct ${node.name} *self${func.params.length ? ", " : ""}${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")});\n`;

    // Declare the function
    // HACK: Need to map names to types
    status.code += `${c_type(func.return_type.name || "void")} ${node.name}_${func.name}(struct ${
      node.name
    } *self${func.params.length ? ", " : ""}${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")})\n{\n`;
    // HACK: Dereference the `self` pointer arg to a local variable with a random name
    // (`zz` for now, but we could automate it)
    status.code += `struct ${node.name} zz = *self;\n`;
    for (let child of func.statements) {
      build_node(child, status);
    }
    status.code += `}\n`;
  }

  status.headers += "\n";
  status.code += "\n";
}
