import RootNode from "../nodes/RootNode";
import type BuildStatus from "./BuildStatus";
import build_block_node from "./build_block_node";

export default function build_root_node(node: RootNode, status: BuildStatus) {
  status.code += `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "standard.h"
#include "main.h"

int malloc_count;

`;

  build_block_node(node, status);
}
