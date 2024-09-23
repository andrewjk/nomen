import type BuildStatus from "./build/BuildStatus";
import build_node from "./build/build_node";
import BaseNode from "./nodes/BaseNode";
import RootNode from "./nodes/RootNode";
import TraitNode from "./nodes/TraitNode";
import type BuildResult from "./types/BuildResult";

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
