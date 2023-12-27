import AccessFieldNode from "./nodes/AccessFieldNode";
import AccessInvocationNode from "./nodes/AccessInvocationNode";
import AccessNode from "./nodes/AccessNode";
import ArrayValuesNode from "./nodes/ArrayValuesNode";
import AssignmentNode from "./nodes/AssignmentNode";
import BaseNode from "./nodes/BaseNode";
import DeclarationNode from "./nodes/DeclarationNode";
import ForLoopNode from "./nodes/ForLoopNode";
import FunctionNode from "./nodes/FunctionNode";
import IfElseNode from "./nodes/IfElseNode";
import InvocationNode from "./nodes/InvocationNode";
import OperationNode from "./nodes/OperationNode";
import ParameterNode from "./nodes/ParameterNode";
import RangeNode from "./nodes/RangeNode";
import ReturnNode from "./nodes/ReturnNode";
import RootNode from "./nodes/RootNode";
import StructNode from "./nodes/StructNode";
import TraitNode from "./nodes/TraitNode";
import Type from "./nodes/Type";
import ValueNode from "./nodes/ValueNode";
import WhileLoopNode from "./nodes/WhileLoopNode";
import type BuildResult from "./types/BuildResult";

interface BuildStatus {
  root: BaseNode;
  traits: TraitNode[];
  headers: string;
  code: string;
  return_assign?: string;
}

export default function build(root: BaseNode): BuildResult {
  let status: BuildStatus = {
    root,
    traits: [],
    headers: "",
    code: "",
  };

  // Collect the traits
  // TODO: Handle traits declared in functions??
  if (root.node_type === "root") {
    status.traits = (root as RootNode).statements.filter(
      (c) => c.node_type === "trait",
    ) as TraitNode[];
  }

  build_node(root, status);

  return {
    headers: status.headers,
    code: status.code,
  };
}

function build_node(node: BaseNode, status: BuildStatus) {
  switch (node.node_type) {
    case "root": {
      build_root_node(node as RootNode, status);
      break;
    }
    case "declare": {
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
    case "if": {
      build_if_else_node(node as IfElseNode, status);
      break;
    }
    case "for": {
      build_for_loop_node(node as ForLoopNode, status);
      break;
    }
    case "while": {
      build_while_loop_node(node as WhileLoopNode, status);
      break;
    }
    case "return": {
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

function build_root_node(node: RootNode, status: BuildStatus) {
  status.code += `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "main.h"

`;

  // Build the function to retrieve the correct trait function from the vtables
  status.headers += "void **_get_trait_func(void **obj, int trait_index, int func_index);\n\n";

  status.code += "void **_get_trait_func(void **obj, int trait_index, int func_index)\n{";

  // Get the array of the trait's functions, then the function itself
  // HACK: This is two array checks -- maybe better as one?
  // _vt is at the start of each object so we can just use it like it's located at the object's address
  status.code += `
void **trait = *(obj + trait_index);
return *(trait + func_index);
}\n\n`;

  // Build traits, then structs, then functions
  for (let child of node.statements) {
    if (child.node_type === "trait") {
      build_trait_node(child as TraitNode, status);
    }
  }

  for (let child of node.statements) {
    if (child.node_type === "struct") {
      build_struct_node(child as StructNode, status);
    }
  }

  for (let child of node.statements) {
    if (child.node_type === "func") {
      build_function_node(child as FunctionNode, status);
    }
  }
}

function build_declaration_node(node: DeclarationNode, status: BuildStatus) {
  // HACK: Move the array part of a declaration after the variable name if applicable

  // If it's an array of traits, make it contain pointers
  if (
    node.type.is_array &&
    !!status.traits.find((t) => t.name === node.type.name) &&
    node.value &&
    node.value.node_type === "array"
  ) {
    const array_values = node.value as ArrayValuesNode;
    // Support GCC by defining vars first
    const variables = [];
    let i = 1;
    for (let value of array_values.values) {
      // TODO: Better naming
      const var_name = "_x" + i;
      // HACK:
      status.code += `${c_type(type_from_value_node(value).name)} ${var_name} = `;
      build_node(value, status);
      status.code += ";\n";
      i += 1;
      variables.push(var_name);
    }

    // Then build the array
    status.code += `void *${node.name}[`;
    if (node.type.length) {
      build_node(node.type.length, status);
    }
    status.code += `] = {${variables.map((v) => `&${v}`).join(", ")}};\n`;
  } else {
    status.code += `${c_type(node.type.name)} ${node.name}`;
    if (node.type.is_array) {
      status.code += `[`;
      if (node.type.length) {
        build_node(node.type.length, status);
      }
      status.code += `]`;
    }
    if (node.value) {
      // TODO: This should be in more places?? Or apply to more nodes?? Probably in build_node -- if it's a returning node??
      if (node.value.node_type === "if") {
        status.code += ";\n";
        const old_return_assign = status.return_assign;
        status.return_assign = node.name;
        build_node(node.value, status);
        status.return_assign = old_return_assign;
        // HACK:
        status.code += "\n";
        return;
      } else {
        status.code += " = ";
        build_node(node.value, status);
      }
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
    status.headers += `${c_type(func.return_type.name || "void")} ${node.name}_${
      func.name
    }(struct ${node.name} this${func.params.length ? ", " : ""}${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")});\n`;

    // Declare the function
    // HACK: Need to map names to types
    status.code += `${c_type(func.return_type.name || "void")} ${node.name}_${func.name}(struct ${
      node.name
    } this${func.params.length ? ", " : ""}${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")})\n{\n`;
    for (let child of func.statements) {
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
    status.headers += `${c_type(func.return_type.name || "void")} ${node.name}_${
      func.name
    }(struct ${node.name} this${func.params.length ? ", " : ""}${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")});\n`;

    // Declare the function
    // HACK: Need to map names to types
    status.code += `${c_type(func.return_type.name || "void")} ${node.name}_${func.name}(struct ${
      node.name
    } this${func.params.length ? ", " : ""}${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")})\n{\n`;
    for (let child of func.statements) {
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
  for (let child of node.statements) {
    build_node(child, status);
  }
  status.code += `}\n`;
}

function build_parameter_node(node: ParameterNode, status: BuildStatus, with_name = true) {
  status.code += c_type(node.type.name);
  if (with_name) {
    status.code += " ";
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
    case "ac_field": {
      build_node(node.source, status);
      status.code += `.${node.access.name}`;
      break;
    }
    case "ac_invoke": {
      // Convert the access function into a C function that takes the struct as an argument
      const invoke = node.access as AccessInvocationNode;
      const type = type_from_value_node(node.source);

      // PERF
      const trait = status.traits.find((t) => t.name === type.name);
      if (trait) {
        const func = trait.functions.find((f) => f.name == invoke.name)!;
        // TODO: Cast to the correct function definition
        // TODO: Use the correct variable name
        // TODO: Pass parameters
        const cast = "(char *(*)())";
        status.code += `(${cast} * _get_trait_func(`;
        build_node(node.source, status);
        status.code += `, ${status.traits.indexOf(trait)}, ${trait.functions.indexOf(func)}))()`;
      } else {
        status.code += `${c_type(type.name)}_${invoke.name}(`;
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
  build_node(node.left_value, status);
  status.code += ` ${node.op} `;
  build_node(node.right_value, status);
}

function build_if_else_node(node: IfElseNode, status: BuildStatus) {
  status.code += `if (`;
  build_node(node.condition, status);
  status.code += `) {\n`;
  for (let child of node.if_branch.statements) {
    build_node(child, status);
  }
  if (node.else_branch) {
    status.code += `} else {\n`;
    for (let child of node.else_branch.statements) {
      build_node(child, status);
    }
  }
  status.code += `}\n`;
}

function build_for_loop_node(node: ForLoopNode, status: BuildStatus) {
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
    } else if (!!status.traits.find((t) => t.name === node.item.type.name)) {
      // TODO: Handle index iterator variable
      const length = type_from_value_node(node.list).length;
      status.code += `for (int i = 0; i < `;
      build_node(length!, status);
      status.code += `; i++)\n{\n`;
      status.code += `void **${node.item.value} = *(`;
      build_node(node.list!, status);
      status.code += " + i);\n";
    } else {
      // TODO: Handle index iterator variable
      // HACK: Only want to do this if the item hasn't been declared previously?
      status.code += `int `;
      build_node(node.item, status);
      status.code += ";\nfor (";
      build_node(node.item, status);
      status.code += " = 0; ";
      build_node(node.item, status);
      const length = type_from_value_node(node.list).length;
      status.code += ` < `;
      build_node(length!, status);
      status.code += `; `;
      build_node(node.item, status);
      status.code += "++)\n{\n";
    }
  }

  for (let child of node.statements) {
    build_node(child, status);
  }

  status.code += `}\n`;
}

function build_while_loop_node(node: WhileLoopNode, status: BuildStatus) {
  status.code += `while (`;
  build_node(node.condition, status);
  status.code += `) {\n`;
  for (let child of node.statements) {
    build_node(child, status);
  }
  status.code += `}\n`;
}

function build_return_node(node: ReturnNode, status: BuildStatus) {
  if (status.return_assign) {
    status.code += `${status.return_assign} = `;
  } else {
    status.code += `return `;
  }
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
  const end = parseInt((node.right_value as ValueNode).value) + (node.inclusive ? 1 : 0);
  status.code += `{${[...Array(end - start).keys()].map((value) => start + value).join(", ")}}`;
}

// UTILS

function c_type(type: string): string {
  return type.replace("string", "char*");
}

function type_from_value_node(node: BaseNode): Type {
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
    case "ac_field": {
      return (node as AccessFieldNode).type;
    }
    case "ac_invoke": {
      return (node as AccessInvocationNode).type;
    }
    case "op": {
      return (node as OperationNode).type;
    }
  }
  return new Type("");
}
