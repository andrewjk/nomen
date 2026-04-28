import TraitNode from "../nodes/TraitNode.ts";
import check_declaration_node from "./check_declaration_node.ts";
import check_function_node from "./check_function_node.ts";
import type CheckStatus from "./CheckStatus.ts";

export default function check_trait_node(trait: TraitNode, status: CheckStatus) {
  for (let decl of trait.fields) {
    check_declaration_node(decl, status);
  }

  for (let func of trait.functions) {
    check_function_node(func, status);
  }

  status.types.push(trait.name);
  status.traits.push(trait);
}
