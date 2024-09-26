import type BuildStatus from "./build/BuildStatus";
import build_node from "./build/build_node";
import BaseNode from "./nodes/BaseNode";
import RootNode from "./nodes/RootNode";
import StructNode from "./nodes/StructNode";
import TraitNode from "./nodes/TraitNode";
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
  if (root.node_type === "root") {
    status.structs = (root as RootNode).statements.filter(
      (c) => c.node_type === "struct",
    ) as StructNode[];

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
