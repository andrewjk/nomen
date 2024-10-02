import type BuildStatus from "./build/BuildStatus";
import build_node from "./build/build_node";
import BaseNode from "./nodes/BaseNode";
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

  build_node(root, status);

  return {
    headers: status.headers,
    code: status.code,
  };
}
