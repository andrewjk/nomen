import type CheckStatus from "./check/CheckStatus";
import check_node from "./check/check_node";
import BaseNode from "./nodes/BaseNode";
import FunctionNode from "./nodes/FunctionNode";
import RootNode from "./nodes/RootNode";
import StructNode from "./nodes/StructNode";
import TraitNode from "./nodes/TraitNode";
import Type from "./nodes/Type";
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

  if (root.node_type === "root") {
    gather_globals(root as RootNode, status);
  }

  check_node(root, status);

  return {
    ok: !status.errors.length,
    errors: status.errors,
  };
}

function gather_globals(root: RootNode, status: CheckStatus) {
  for (let node of root.statements) {
    switch (node.node_type) {
      case "struct": {
        const struct = node as StructNode;
        status.types.push(struct.name);
        status.values.push({
          declaration: "struct",
          name: struct.name,
          type: new Type(struct.name),
        });
        status.structs.push(struct);
        break;
      }
      case "trait": {
        const trait = node as TraitNode;
        status.types.push(trait.name);
        status.traits.push(trait);
        break;
      }
      case "func": {
        const func = node as FunctionNode;
        status.functions.push(func);
        break;
      }
    }
  }
}
