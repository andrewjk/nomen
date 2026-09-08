import add_error from "../add_error.ts";
import { library_path_prefixes } from "../lib.ts";
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

	if (status.library) {
		validate_import_path(status, segments, start);
	}

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

/**
 * An import path must name something real: the library root (`System`) or a
 * path mirroring the library's file layout — a namespace directory
 * (`System::Controls`), a module file (`System::Controls::Geometry`), or a
 * top-level module (`import Map`, resolved from `Map.nm`). Anything else
 * (`import System::Contrls`) is a typo that would otherwise silently import
 * nothing, so it is a compile error.
 */
function validate_import_path(status: ParseStatus, segments: string[], start: number) {
	if (segments.some((s) => !s)) return;
	if (segments.length === 1 && segments[0] === "System") return;
	if (library_path_prefixes(status.library!).has(segments.join("/"))) return;
	add_error(status, `Unknown import path: ${segments.join("::")}`, start);
}
