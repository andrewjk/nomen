import type BuildStatus from "./build/BuildStatus";
import build_node from "./build/build_node";
import BaseNode from "./nodes/BaseNode";
import { is_root_node, is_struct_node, is_trait_node } from "./nodes/check_node_type";
import type BuildResult from "./types/BuildResult";

export default function build(root: BaseNode): BuildResult {
  let status: BuildStatus = {
    root,
    structs: [],
    traits: [],
    headers: "",
    code: "",
    scoped_declarations: [],
  };

  // Collect the traits
  // TODO: Handle traits declared in child scopes??
  if (is_root_node(root)) {
    status.structs = root.statements.filter((c) => is_struct_node(c));
    status.traits = root.statements.filter((c) => is_trait_node(c));
  }

  build_node(root, status);

  return {
    headers: status.headers,
    code: status.code,
  };
}
