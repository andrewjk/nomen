import type AccessFieldNode from "./types/AccessFieldNode";
import type AccessInvocationNode from "./types/AccessInvocationNode";
import type AccessNode from "./types/AccessNode";
import type ArrayValuesNode from "./types/ArrayValuesNode";
import type AssignmentNode from "./types/AssignmentNode";
import type BuildResult from "./types/BuildResult";
import type DeclarationNode from "./types/DeclarationNode";
import type ForNode from "./types/ForNode";
import type FunctionNode from "./types/FunctionNode";
import type InvocationNode from "./types/InvocationNode";
import type OperationNode from "./types/OperationNode";
import type ParameterNode from "./types/ParameterNode";
import type ParseNode from "./types/ParseNode";
import type RangeNode from "./types/RangeNode";
import type ReturnNode from "./types/ReturnNode";
import type StructNode from "./types/StructNode";
import type TraitNode from "./types/TraitNode";
import type ValueNode from "./types/ValueNode";

interface BuildStatus {
  root: ParseNode;
  traits: TraitNode[];
  headers: string;
  code: string;
}

export default function build(root: ParseNode): BuildResult {
  let status: BuildStatus = {
    root,
    traits: [],
    headers: "",
    code: "",
  };

  // Collect the traits
  // TODO: Handle traits declared in functions??
  status.traits = root.children.filter(
    (c) => c.node_type === "trait",
  ) as TraitNode[];

  build_node(root, status);

  return {
    headers: status.headers,
    code: status.code,
  };
}

function build_node(node: ParseNode, status: BuildStatus) {
  switch (node.node_type) {
    case "root": {
      build_root_node(node, status);
      break;
    }
    case "decl": {
      build_declaration_node(node as DeclarationNode, status);
      break;
    }
    case "assign": {
      build_assignment_node(node as AssignmentNode, status);
      break;
    }
    case "struct": {
      build_struct_node(node as StructNode, status);
      break;
    }
    case "trait": {
      build_trait_node(node as TraitNode, status);
      break;
    }
    case "func": {
      build_function_node(node as FunctionNode, status);
      break;
    }
    case "invoke": {
      build_invocation_node(node as InvocationNode, status);
      break;
    }
    case "access": {
      build_access_node(node as AccessNode, status);
      break;
    }
    case "op": {
      build_operation_node(node as OperationNode, status);
      break;
    }
    case "for": {
      build_for_node(node as ForNode, status);
      break;
    }
    case "ret": {
      build_return_node(node as ReturnNode, status);
      break;
    }
    case "value": {
      build_value_node(node as ValueNode, status);
      break;
    }
    case "array": {
      build_array_values_node(node as ArrayValuesNode, status);
      break;
    }
    case "range": {
      build_range_node(node as RangeNode, status);
      break;
    }
    default: {
      throw Error("Invalid node: " + node.node_type);
    }
  }
}

function build_root_node(node: ParseNode, status: BuildStatus) {
  status.code += `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "main.h"

`;

  // Build the function to retrieve the correct trait function from the vtables
  status.headers +=
    "void **_get_trait_func(void **obj, int trait_index, int func_index);\n\n";

  status.code +=
    "void **_get_trait_func(void **obj, int trait_index, int func_index)\n{";

  // Get the array of the trait's functions, then the function itself
  // HACK: This is two array checks -- maybe better as one?
  // _vt is at the start of each object so we can just use it like it's located at the object's address
  status.code += `
void **trait = *(obj + trait_index);
return *(trait + func_index);
}\n\n`;

  // Build traits, then structs, then functions
  for (let child of node.children) {
    if (child.node_type === "trait") {
      build_trait_node(child as TraitNode, status);
    }
  }

  for (let child of node.children) {
    if (child.node_type === "struct") {
      build_struct_node(child as StructNode, status);
    }
  }

  for (let child of node.children) {
    if (child.node_type === "func") {
      build_function_node(child as FunctionNode, status);
    }
  }
}

function build_declaration_node(node: DeclarationNode, status: BuildStatus) {
  // HACK: Move the array part of a declaration after the variable name if applicable
  const parts = node.type.match(/([^\[\]]+)(\[.*\])*/);
  const type = (parts && parts[1]) || node.type;

  // HACK: Do array types properly
  const is_array = parts && !!parts[2];
  // If it's an array of traits, make it contain pointers
  if (
    is_array &&
    !!status.traits.find((t) => t.name === type) &&
    node.value &&
    node.value.node_type === "array"
  ) {
    const arrayValues = node.value as ArrayValuesNode;
    // Support GCC by defining vars first
    const variables = [];
    let i = 1;
    for (let value of arrayValues.values) {
      // TODO: Better naming
      const var_name = "_x" + i;
      // HACK:
      status.code += `${type_from_value_node(value)} ${var_name} = `;
      build_node(value, status);
      status.code += ";\n";
      i += 1;
      variables.push(var_name);
    }

    // Then build the array
    status.code += `void *${node.name}${parts[2]} = {${variables
      .map((v) => `&${v}`)
      .join(", ")}};\n`;
  } else {
    status.code += `${c_type(type)} ${node.name}`;
    if (parts && parts[2]) {
      status.code += parts[2];
    }
    if (node.value) {
      status.code += " = ";
      build_node(node.value, status);
    }
    status.code += ";\n";
  }
}

function build_assignment_node(node: AssignmentNode, status: BuildStatus) {
  status.code += ``;
  build_node(node.left_value!, status);
  status.code += " = ";
  build_node(node.right_value!, status);
  status.code += ";\n";
}

function build_struct_node(node: StructNode, status: BuildStatus) {
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
    status.code += `${c_type(field.type)} ${field.name};\n`;
  }
  // Default fields from traits
  for (let traitName of node.traits) {
    const trait = status.traits.find((n) => n.name === traitName) as TraitNode;
    if (trait) {
      for (let field of trait.fields.filter(
        (f) => !node.fields.find((nf) => nf.name === f.name),
      )) {
        status.code += `${c_type(field.type)} ${field.name};\n`;
      }
    }
  }
  status.code += `} ${node.name};\n`;

  // Declare the constructor
  const ctor = `${node.name} ${node.name}_init(${node.fields
    .filter((f) => f.value == null)
    .map((f) => `${c_type(f.type)} ${f.name}`)
    .join(", ")})`;
  status.headers += `struct ${ctor};\n`;

  // Define the constructor
  const objectName = node.name.substring(0, 1).toLocaleLowerCase();
  status.code += `${ctor}\n{`;
  status.code += `
${node.name} ${objectName};
${objectName}._vt = &_${node.name}_traits;
`;
  //status.code += ` *${objectName} = malloc(sizeof(${node.name}));`
  // Fields from the struct
  for (let field of node.fields) {
    status.code += `${objectName}.${field.name} = `;
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
      for (let field of trait.fields.filter(
        (f) => !node.fields.find((nf) => nf.name === f.name),
      )) {
        // TODO: Set the value properly
        status.code += `${objectName}.${field.name}`;
        if (field.value) {
          status.code += " = ";
          build_node(field.value, status);
        }
        status.code += ";\n";
      }
    }
  }
  status.code += `return ${objectName};\n`;
  status.code += `}\n`;

  build_struct_functions(node, status);

  status.headers += "\n";
  status.code += "\n";
}

function build_struct_traits(node: StructNode, status: BuildStatus) {
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
              `${
                !!node.functions.find((tf) => tf.name === f.name)
                  ? node.name
                  : trait.name
              }_${f.name}`,
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

function build_struct_functions(node: StructNode, status: BuildStatus) {
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
    status.headers += `${c_type(func.return_type || "void")} ${node.name}_${
      func.name
    }(struct ${node.name} this${func.params.length ? ", " : ""}${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")});\n`;

    // Declare the function
    // HACK: Need to map names to types
    status.code += `${c_type(func.return_type || "void")} ${node.name}_${
      func.name
    }(struct ${node.name} this${func.params.length ? ", " : ""}${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")})\n{\n`;
    for (let child of func.children) {
      build_node(child, status);
    }
    status.code += `}\n`;
  }
}

function build_trait_node(node: TraitNode, status: BuildStatus) {
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
    status.headers += `${c_type(func.return_type || "void")} ${node.name}_${
      func.name
    }(struct ${node.name} this${func.params.length ? ", " : ""}${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")});\n`;

    // Declare the function
    // HACK: Need to map names to types
    status.code += `${c_type(func.return_type || "void")} ${node.name}_${
      func.name
    }(struct ${node.name} this${func.params.length ? ", " : ""}${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")})\n{\n`;
    for (let child of func.children) {
      build_node(child, status);
    }
    status.code += `}\n`;
  }

  status.headers += "\n";
  status.code += "\n";
}

function build_function_node(node: FunctionNode, status: BuildStatus) {
  if (node.name.toLocaleLowerCase() === "main") {
    status.code += `int main(`;
  } else {
    status.code += `void ${node.name}(`;
  }
  for (let i = 0; i < node.params.length; i++) {
    if (i > 0) {
      status.code += ", ";
    }
    build_parameter_node(node.params[i], status);
  }
  status.code += `)\n{\n`;
  for (let child of node.children) {
    build_node(child, status);
  }
  status.code += `}\n`;
}

function build_parameter_node(
  node: ParameterNode,
  status: BuildStatus,
  with_name = true,
) {
  if (node.type == "string") {
    // HACK: Need a string library
    status.code += "const char *";
  } else {
    status.code += node.type;
    if (with_name) {
      status.code += " ";
    }
  }
  if (with_name) {
    status.code += node.name;
  }
}

function build_invocation_node(node: InvocationNode, status: BuildStatus) {
  status.code += `${node.name}(`;
  for (let i = 0; i < node.params.length; i++) {
    if (i > 0) {
      status.code += ", ";
    }
    build_node(node.params[i], status);
  }
  status.code += ");\n";
}

function build_access_node(node: AccessNode, status: BuildStatus) {
  switch (node.access.node_type) {
    case "accfld": {
      build_node(node.source, status);
      status.code += `.${node.access.name}`;
      break;
    }
    case "accinv": {
      // Convert the access function into a C function that takes the struct as an argument
      const invoke = node.access as AccessInvocationNode;
      const type = type_from_value_node(node.source);

      // PERF
      const trait = status.traits.find((t) => t.name === type);
      if (trait) {
        const func = trait.functions.find((f) => f.name == invoke.name)!;
        // TODO: Cast to the correct function definition
        // TODO: Use the correct variable name
        // TODO: Pass parameters
        const cast = "(char *(*)())";
        status.code += `(${cast} * _get_trait_func(`;
        build_node(node.source, status);
        status.code += `, ${status.traits.indexOf(
          trait,
        )}, ${trait.functions.indexOf(func)}))()`;
      } else {
        status.code += `${type}_${invoke.name}(`;
        if (!invoke.static) {
          build_node(node.source, status);
        }
        for (let i = 0; i < invoke.params.length; i++) {
          if (!invoke.static || i > 0) {
            status.code += ", ";
          }
          build_node(invoke.params[i], status);
        }
        status.code += ")";
      }
      break;
    }
  }
}

function build_operation_node(node: OperationNode, status: BuildStatus) {
  if (node.left_value) {
    build_node(node.left_value, status);
  }
  status.code += ` ${node.op} `;
  if (node.right_value) {
    build_node(node.right_value, status);
  }
}

function build_for_node(node: ForNode, status: BuildStatus) {
  if (node.item && node.list) {
    if (node.list.node_type == "range") {
      // HACK: Only want to do this if the item hasn't been declared previously?
      status.code += `int `;
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
      status.code += range.inclusive ? " <= " : " < ";
      if (range.right_value) {
        build_node(range.right_value, status);
      }
      status.code += "; ";
      build_node(node.item, status);
      status.code += "++)\n{\n";
    } else if (!!status.traits.find((t) => t.name === node.item!.type)) {
      // TODO: Handle this.Index
      // TODO: Array length
      status.code += `for (int i = 0; i < 3; i++)\n{\n`;
      status.code += `void **${node.item!.value} = *(`;
      build_node(node.list!, status);
      status.code += " + i);\n";
    } else {
      // TODO: Handle this.Index
      // TODO: Array length
      // HACK: Only want to do this if the item hasn't been declared previously?
      status.code += `int `;
      build_node(node.item, status);
      status.code += ";\nfor (";
      build_node(node.item, status);
      status.code += " = 0; ";
      build_node(node.item, status);
      status.code += " < ?; ";
      build_node(node.item, status);
      status.code += "++)\n{\n";
    }
  }

  for (let child of node.children) {
    build_node(child, status);
  }

  status.code += `}\n`;
}

function build_return_node(node: ReturnNode, status: BuildStatus) {
  status.code += `return `;
  build_node(node.value, status);
  status.code += `;\n`;
}

function build_value_node(node: ValueNode, status: BuildStatus) {
  // TODO:
  //const value = node.type === "string" ? `"${node.value}"` : node.value;
  status.code += node.value;
}

function build_array_values_node(node: ArrayValuesNode, status: BuildStatus) {
  status.code += `{`;
  node.values.forEach((value, i) => {
    if (i > 0) status.code += ", ";
    build_node(value, status);
  });
  status.code += `}`;
}

function build_range_node(node: RangeNode, status: BuildStatus) {
  // HACK:
  const start = parseInt((node.left_value as ValueNode).value);
  const end =
    parseInt((node.right_value as ValueNode).value) + (node.inclusive ? 1 : 0);
  status.code += `{${[...Array(end - start).keys()]
    .map((value) => start + value)
    .join(", ")}}`;
}

// UTILS

function c_type(type: string): string {
  return type.replace("string", "char*");
}

function type_from_value_node(node: ParseNode): string {
  switch (node.node_type) {
    case "access": {
      return type_from_value_node((node as AccessNode).access);
    }
    case "value": {
      return (node as ValueNode).type;
    }
    case "array": {
      return (node as ArrayValuesNode).type;
    }
    case "invoke": {
      return (node as InvocationNode).type;
    }
    case "accfld": {
      return (node as AccessFieldNode).type;
    }
    case "accinv": {
      return (node as AccessInvocationNode).type;
    }
    case "op": {
      return (node as OperationNode).type;
    }
  }
  return "?";
}
