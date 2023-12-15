import type ReturningNode from "./ReturningNode";

export default function isReturningNode(object: any): object is ReturningNode {
  return "return_type" in object;
}
