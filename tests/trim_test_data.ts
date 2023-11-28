import type ParseNode from "../src/types/ParseNode";

export default function trim_test_data(node: ParseNode): ParseNode {
  trim_any(node);
  return node;
}

function trim_any(node: any) {
  if (node.children && !node.children.length) {
    delete node.children;
  }
  for (let [key, value] of Object.entries(node)) {
    if (key === "children") {
      for (let child of node.children) {
        trim_any(child);
      }
      if (!node.children.length) {
        delete node.children;
      }
    } else if (key === "i") {
      delete node.i;
    } else if (typeof value === "object") {
      trim_any(value);
    }
  }
}
