import FunctionNode from "../nodes/FunctionNode";
import RootNode from "../nodes/RootNode";
import StructNode from "../nodes/StructNode";
import TraitNode from "../nodes/TraitNode";
import type BuildStatus from "./BuildStatus";
import build_function_node from "./build_function_node";
import build_struct_node from "./build_struct_node";
import build_trait_node from "./build_trait_node";

export default function build_root_node(node: RootNode, status: BuildStatus) {
  status.code += `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "standard.h"
#include "main.h"

`;

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
