import add_error from "../add_error";
import ImportNode from "../nodes/ImportNode";
import RootNode from "../nodes/RootNode";
import type ParseStatus from "./ParseStatus";
import accept from "./utils/accept";
import consume from "./utils/consume";
import get_index from "./utils/get_index";

export default function parse_import(status: ParseStatus) {
  const start = get_index(status);
  accept("import", status);
  const name = consume(status);
  const imp = new ImportNode(start, name);

  // TODO: Move this into add_to_parent somehow
  const parent = status.stack.at(-1)!;
  switch (parent.node_type) {
    case "root": {
      (parent as RootNode).imports.push(imp);
      break;
    }
    default: {
      add_error(status, "Import cannot appear here", imp.start);
    }
  }
}
