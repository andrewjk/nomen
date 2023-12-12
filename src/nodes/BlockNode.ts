import BaseNode from "./BaseNode";

// TODO: Rename to block node
export default class BlockNode extends BaseNode {
  statements: BaseNode[] = [];
}
