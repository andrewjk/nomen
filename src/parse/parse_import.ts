import add_error from "../add_error.ts";
import ImportNode from "../nodes/ImportNode.ts";
import RootNode from "../nodes/RootNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import get_index from "./utils/get_index.ts";

export default function parse_import(status: ParseStatus) {
	const start = get_index(status);
	accept("import", status);
	let name = consume(status);
	// Handle `import System/Controls` (tokens: System, /, Controls)
	while (accept("/", status)) {
		name += "/" + consume(status);
	}
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
