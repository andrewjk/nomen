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
  scoped_declarations: DeclarationNode[];
  return_assign?: string;
}
