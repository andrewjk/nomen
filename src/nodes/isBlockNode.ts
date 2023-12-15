import type BlockNode from "./BlockNode";

export default function isBlockNode(object: any): object is BlockNode {
  return "statements" in object;
}
