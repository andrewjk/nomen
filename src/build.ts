import type AssignmentNode from "./types/AssignmentNode";
import type BuildResult from "./types/BuildResult";
import type DeclarationNode from "./types/DeclarationNode";
import type FunctionNode from "./types/FunctionNode";
import type ParameterNode from "./types/ParameterNode";
import type ParseNode from "./types/ParseNode";
import type ReturnNode from "./types/ReturnNode";
import type StructNode from "./types/StructNode";
import type TraitNode from "./types/TraitNode";

interface BuildStatus {
  root: ParseNode;
  headers: string;
  code: string;
  indent: number;
}

export default function build(root: ParseNode): BuildResult {
  let status: BuildStatus = {
    root,
    headers: "",
    code: "",
    indent: 0,
  };

  build_node(root, status);

  return {
    ok: true,
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
    case "ret": {
      build_return_node(node as ReturnNode, status);
      break;
    }
    default: {
      throw Error("Invalid node: " + node.node_type);
    }
  }
}

function build_root_node(node: ParseNode, status: BuildStatus) {
  status.code += `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "main.h"

int main() {
`;
  status.indent += 1;
  for (let child of node.children) {
    build_node(child, status);
  }
  status.indent -= 1;
  status.code += `}
`;
}

function build_declaration_node(node: DeclarationNode, status: BuildStatus) {
  status.code += `${indent(status)}${node.type} ${node.name}${
    node.value ? " = " : ""
  }${node.value};
`;
}

function build_assignment_node(node: AssignmentNode, status: BuildStatus) {
  status.code += `${indent(status)}${node.left_value} = ${node.right_value};
`;
}

function build_struct_node(node: StructNode, status: BuildStatus) {
  if (node.traits.length) {
    build_struct_traits(node, status);
  }

  // Declare the struct
  status.headers += `struct ${node.name};`;

  // Define the struct
  status.code += `${indent(status)}typedef struct ${node.name} {\n`;
  status.indent += 1;
  status.code += `${indent(status)}void *_vt;\n`;
  // TODO: Default fields from traits
  for (var field of node.fields) {
    // HACK: Generalise this
    status.code += `${indent(status)}${field.type.replace("string", "char*")} ${
      field.name
    };\n`;
  }
  status.indent -= 1;
  status.code += `${indent(status)}} ${node.name};\n`;

  // Declare the constructor
  status.headers += `struct ${node.name} ${node.name}__init();\n`;

  // Define the constructor
  // TODO: Parameters
  const objectName = node.name.substring(0, 1).toLocaleLowerCase();
  status.code += `${indent(status)}${node.name} ${node.name}__init() {`;
  status.indent += 1;
  status.code += `
${indent(status)}${node.name} ${objectName};
${indent(status)}${objectName}._vt = &_${node.name}_traits;
`;
  //status.code += ` *${objectName} = malloc(sizeof(${node.name}));`
  // TODO: Set fields
  for (var field of node.fields.filter((f) => f.value != null)) {
    // TODO: Set the value properly
    status.code += `${indent(status)}${objectName}.${field.name} = ${
      field.type === "string" ? `"${field.value}"` : field.value
    };\n`;
  }
  status.code += `${indent(status)}return ${objectName};\n`;
  status.indent -= 1;
  status.code += `${indent(status)}}\n`;

  // Build the struct's functions
  // TODO: Default functions from traits
  for (var func of node.functions) {
    // Define the function
    // HACK: Generalise this
    // HACK: Need to map names to types
    // TODO: Make Access and Invocation nodes a Target/Function thing rather than being in a series
    status.headers += `${func.return_type.replace(
      "string",
      "char*",
    )} ${node.name.toLocaleLowerCase()}_${func.name}(${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")});\n`;

    // Declare the function
    // HACK: Generalise this
    // HACK: Need to map names to types
    status.code += `${indent(status)}${(func.return_type || "void").replace(
      "string",
      "char*",
    )} ${node.name}_${func.name}(${func.params
      .map((p) => build_parameter_node(p, status))
      .join(", ")}) {\n`;
    status.indent += 1;
    for (let child of func.children) {
      build_node(child, status);
    }
    status.indent -= 1;
    status.code += `${indent(status)}}\n`;
  }
}

function build_struct_traits(node: StructNode, status: BuildStatus) {
  const traits = status.root.children.filter(
    (n) => n.node_type === "trait",
  ) as TraitNode[];

  // Build the vtable that points to the struct's traits' methods by index
  // TODO: Support default trait methods
  for (var trait of node.traits) {
    // E.g. int* _Dog_Animal_vtable_[4];
    status.code += `${indent(status)}void *_${node.name}_${trait}_funcs[${
      node.traits.length
    }] = {\n`;
    status.indent += 1;
    status.code += node.traits
      .map((t) => {
        const trait = status.root.children.find(
          (n) => n.node_type === "trait" && (n as TraitNode).name === t,
        ) as TraitNode;
        return trait.functions
          .map((f, fi) => `${indent(status)}[${fi}] = ${node.name}_${f.name}`)
          .join(",\n");
      })
      .join(",\n");
    status.indent -= 1;
    status.code += `\n${indent(status)}}\n`;

    // Build the vtable that points to the above table by index
    // E.g. int* _Dog_vtable_[40];
    status.code += `${indent(status)}void *_${node.name}_traits[${
      traits.length
    }] = {\n`;
    status.indent += 1;
    status.code += node.traits
      .map((t) => {
        return `${indent(status)}[0] = _${node.name}_${t}_funcs`;
      })
      .join(",\n");
    status.indent -= 1;
    status.code += `\n${indent(status)}}\n\n`;
  }
}

function build_trait_node(node: TraitNode, status: BuildStatus) {
  // Hmm
}

function build_function_node(node: FunctionNode, status: BuildStatus) {
  status.code += `${indent(status)}void ${node.name}(`;
  for (let i = 0; i < node.params.length; i++) {
    if (i > 0) {
      status.code += ", ";
    }
    build_parameter_node(node.params[i], status);
  }
  status.code += `) {
`;
  status.indent += 1;
  for (let child of node.children) {
    build_node(child, status);
  }
  status.indent -= 1;
  status.code += `${indent(status)}}
`;
}

function build_parameter_node(node: ParameterNode, status: BuildStatus) {
  if (node.type == "string") {
    // HACK: Need a string library
    status.code += "const char *";
  } else {
    status.code += node.type;
    status.code += " ";
  }
  status.code += node.name;
}

function build_return_node(node: ReturnNode, status: BuildStatus) {
  status.code += `${indent(status)}return ${node.value};
`;
}

function indent(status: BuildStatus) {
  // HACK: Why doesn't this work
  //return new Array(status.indent).join("  ");
  let result = "";
  for (let i = 0; i < status.indent; i++) {
    result += "  ";
  }
  return result;
}
