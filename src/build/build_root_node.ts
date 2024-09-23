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
