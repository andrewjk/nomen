import type CheckStatus from "./check/CheckStatus";
import check_node from "./check/check_node";
import BaseNode from "./nodes/BaseNode";
import FunctionNode from "./nodes/FunctionNode";
import ParameterNode from "./nodes/ParameterNode";
import RootNode from "./nodes/RootNode";
import StructNode from "./nodes/StructNode";
import TraitNode from "./nodes/TraitNode";
import Type from "./nodes/Type";
import { is_root_node } from "./nodes/check_node_type";
import type CheckResult from "./types/CheckResult";

export default function check(root: BaseNode): CheckResult {
  const status: CheckStatus = {
    stack: [root],
    values: [],
    types: ["bool", "int", "string"],
    structs: [],
    traits: [],
    functions: [],
    errors: [],
  };

  // HACK: Add printf as a global function
  //status.functions.push(
  //  new FunctionNode(0, "pub", "printf", new Type(""), [
  //    new ParameterNode(0, "value", new Type("string")),
  //    new ParameterNode(0, "value", new Type("string")),
  //  ]),
  //);

  check_node(root, status);

  return {
    ok: !status.errors.length,
    errors: status.errors,
  };
}
