import add_error from "../add_error.ts";
import ImportNode from "../nodes/ImportNode.ts";
import RootNode from "../nodes/RootNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";
import parse_qualified_name from "./utils/parse_qualified_name.ts";

export default function parse_import(status: ParseStatus) {
	const start = get_index(status);
	accept("import", status);
	// Handle `import System::Controls` (tokens: System, ::, Controls)
	const { segments } = parse_qualified_name(status, consume(status), start, false);
	const imp = new ImportNode(start, segments.join("::"));

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
