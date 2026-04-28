import type BaseNode from "../src/nodes/BaseNode.ts";

export default function trim_test_parse(node: BaseNode): string {
  trim_node(node);
  return JSON.parse(JSON.stringify(node));
}

function trim_node(node: any) {
  if (node.children && !node.children.length) {
    delete node.children;
  }
  for (let [key, value] of Object.entries(node)) {
    if (key === "children") {
      for (let child of node.children) {
        trim_node(child);
      }
      if (!node.children.length) {
        delete node.children;
      }
    } else if (key === "start" || key.endsWith("_start")) {
      delete node[key];
    } else if (typeof value === "object") {
      trim_node(value);
    }
  }
}
