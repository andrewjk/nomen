import StructNode from "../nodes/StructNode";
import TraitNode from "../nodes/TraitNode";
import type BuildStatus from "./BuildStatus";
import build_node from "./build_node";
import build_parameter_node from "./build_parameter_node";
import c_type from "./c_type";

export default function build_struct_node(node: StructNode, status: BuildStatus) {
  status.headers += `// ${node.name}:\n`;
  status.code += `// ${node.name}:\n`;

  if (node.traits.length) {
    build_struct_traits(node, status);
  }

  // Declare the struct
  status.headers += `struct ${node.name};\n`;

  // Define the struct
  status.code += `typedef struct ${node.name}\n{\n`;
  status.code += `void *_vt;\n`;
  // Fields from the struct
  for (let field of node.fields) {
    status.code += `${c_type(field.type.name)} ${field.name};\n`;
  }
  // Default fields from traits
  for (let traitName of node.traits) {
    const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
    if (trait) {
      for (let field of trait.fields.filter((f) => !node.fields.find((nf) => nf.name === f.name))) {
        status.code += `${c_type(field.type.name)} ${field.name};\n`;
      }
    }
  }
  status.code += `} ${node.name};\n`;

  // Declare the constructor
  const ctor = `${node.name} ${node.name}_init(${node.fields
    .filter((f) => f.value == null)
    .map((f) => `${c_type(f.type.name)} ${f.name}`)
    .join(", ")})`;
  status.headers += `struct ${ctor};\n`;

  // Define the constructor
  const object_name = node.name.substring(0, 1).toLocaleLowerCase();
  status.code += `${ctor}\n{`;
  status.code += `
${node.name} ${object_name};
${object_name}._vt = &_${node.name}_traits;
`;
  //status.code += ` *${object_name} = malloc(sizeof(${node.name}));`
  // Fields from the struct
  for (let field of node.fields) {
    status.code += `${object_name}.${field.name} = `;
    if (field.value) {
      build_node(field.value, status);
    } else {
      status.code += field.name;
    }
    status.code += ";\n";
  }
  // Default fields from traits
  for (let traitName of node.traits) {
    const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
    if (trait) {
      for (let field of trait.fields.filter((f) => !node.fields.find((nf) => nf.name === f.name))) {
        // TODO: Set the value properly
        status.code += `${object_name}.${field.name}`;
        if (field.value) {
          status.code += " = ";
          build_node(field.value, status);
        }
        status.code += ";\n";
      }
    }
  }
  status.code += `return ${object_name};\n`;
  status.code += `}\n`;

  build_struct_functions(node, status);

  status.headers += "\n";
  status.code += "\n";
}

export function build_struct_traits(node: StructNode, status: BuildStatus) {
  // Build the vtable that points to the struct's traits' methods by index
  for (let trait of node.traits) {
    // E.g. int* _Dog_Animal_vtable_[4];
    status.code += `void *_${node.name}_${trait}_funcs[] = {`;
    status.code += node.traits
      .map((t) => {
        const trait = status.traits.find((n) => n.name === t) as TraitNode;
        return trait.functions
          .map(
            (f) =>
              `${!!node.functions.find((tf) => tf.name === f.name) ? node.name : trait.name}_${
                f.name
              }`,
          )
          .join(", ");
      })
      .join(",");
    status.code += `};\n`;

    // Build the vtable that points to the above table by index
    // E.g. int* _Dog_vtable_[];
    status.code += `void *_${node.name}_traits[] = {`;
    status.code += node.traits
      .map((t) => {
        return `_${node.name}_${t}_funcs`;
      })
      .join(", ");
    status.code += `};\n`;
  }
}

export function build_struct_functions(node: StructNode, status: BuildStatus) {
  // Build the struct's functions
  // TODO: Default functions from traits
  for (let func of node.functions) {
    if (func.name === "init") {
      // We create the constructor elsewhere
      // We may need to do this here later on, if we allow custom init methods
      continue;
    }

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
}
