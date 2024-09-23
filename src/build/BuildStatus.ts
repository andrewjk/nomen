import BaseNode from "../nodes/BaseNode";
import TraitNode from "../nodes/TraitNode";

export default interface BuildStatus {
  root: BaseNode;
  traits: TraitNode[];
  headers: string;
  code: string;
  return_assign?: string;
}
