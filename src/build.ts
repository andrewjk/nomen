import type DeclarationNode from "./types/DeclarationNode";
import type ParseNode from "./types/ParseNode";
import type BuildResult from "./types/BuildResult";
import type AssignmentNode from "./types/AssignmentNode";

interface BuildStatus {
  headers: string;
  code: string;
}

export default function build(root: ParseNode): BuildResult {
  let status: BuildStatus = {
    headers: "",
    code: "",
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
    case "dec": {
      build_declaration_node(node as DeclarationNode, status);
      break;
    }
    case "ass": {
      build_assignment_node(node as AssignmentNode, status);
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
  for (let child of node.children) {
    build_node(child, status);
  }

  status.code += `
}
`;
}

function build_declaration_node(node: DeclarationNode, status: BuildStatus) {
  status.code += `  ${node.type} ${node.name}${node.value ? " = " : ""}${
    node.value
  };
`;
}

function build_assignment_node(node: AssignmentNode, status: BuildStatus) {
  status.code += `  ${node.left_value} = ${node.right_value};
`;
}
