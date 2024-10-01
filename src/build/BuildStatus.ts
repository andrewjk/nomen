import BaseNode from "../nodes/BaseNode";
import DeclarationNode from "../nodes/DeclarationNode";
import StructNode from "../nodes/StructNode";
import TraitNode from "../nodes/TraitNode";

export default interface BuildStatus {
  root: BaseNode;
  structs: StructNode[];
  traits: TraitNode[];
  headers: string;
  code: string;
  /**
   * Declarations that were made in the current scope and will need to be freed
   */
  scoped_declarations: DeclarationNode[];
  return_assign?: string;
}
