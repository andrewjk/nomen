import DeclarationNode from "./types/DeclarationNode";
import ParseNode from "./types/ParseNode";
import BuildResult from "./types/BuildResult";

interface BuildStatus {
  headers: string;
  code: string;
}

export default function build(root: ParseNode): BuildResult {
  let status: BuildStatus = {
    headers: "",
    code: "",
  };

  buildNode(root, status);

  return {
    ok: true,
    headers: status.headers,
    code: status.code,
  };
}

function buildNode(node: ParseNode, status: BuildStatus) {
  switch (node.nodetype) {
    case "root": {
      buildRootNode(node, status);
      break;
    }
    case "decl": {
      buildDeclarationNode(node as DeclarationNode, status);
      break;
    }
    default: {
      throw Error("Invalid node: " + node.nodetype);
    }
  }
}

function buildRootNode(node: ParseNode, status: BuildStatus) {
  status.code += `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "main.h"

int main() {
`;
  for (let child of node.children) {
    buildNode(child, status);
  }

  status.code += `
}
`;
}

function buildDeclarationNode(node: DeclarationNode, status: BuildStatus) {
  status.code += `  ${node.type} ${node.name}${node.value ? " = " : ""}${
    node.value
  };
`;
}
