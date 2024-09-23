import TraitNode from "../nodes/TraitNode";
import type CheckStatus from "./CheckStatus";
import check_declaration_node from "./check_declaration_node";
import check_function_node from "./check_function_node";

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
