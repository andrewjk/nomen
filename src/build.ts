import type BuildStatus from "./build/BuildStatus";
import build_c_node from "./build/build_node";
import build_aarch64_node from "./build_aarch64/build_node";
import BaseNode from "./nodes/BaseNode";
import type BuildResult from "./types/BuildResult";

export default function build(
  root: BaseNode,
  options: { arch?: "c" | "aarch64" } = {},
): BuildResult {
  let status: BuildStatus = {
    root,
    structs: [],
    traits: [],
    headers: "",
    code: "",
    scoped_declarations: [],
    interpolate_string_counts: new Set(),
  };

  if (options.arch === "aarch64") {
    build_aarch64_node(root, status);
  } else {
    build_c_node(root, status);
  }

  return {
    headers: status.headers,
    code: status.code,
  };
}
