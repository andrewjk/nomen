import type AssignmentNode from "./types/AssignmentNode";
import type BuildResult from "./types/BuildResult";
import type DeclarationNode from "./types/DeclarationNode";
import type FunctionNode from "./types/FunctionNode";
import type ParameterNode from "./types/ParameterNode";
import type ParseNode from "./types/ParseNode";
import ReturnNode from "./types/ReturnNode";

interface BuildStatus {
  headers: string;
  code: string;
  indent: number;
}

export default function build(root: ParseNode): BuildResult {
  let status: BuildStatus = {
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
  console.log("INDENTING ROOT");
  status.indent += 1;
  for (let child of node.children) {
    build_node(child, status);
  }
  console.log("DE-INDENTING ROOT");
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
