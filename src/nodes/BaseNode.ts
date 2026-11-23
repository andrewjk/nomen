import type { NodeType } from "./NodeType.ts";

/**
 * The base node type which all nodes extend
 */
export default class BaseNode {
	node_type: NodeType;
	start: number;

	/** Documentation block comment preceding this declaration, if any.
	 *  Attached after parsing by attach_doc_comments. */
	doc?: string;

	// HACK: We attach declarations for e.g. function call params here on check
	// We don't want to add them into the statements at check time, because that affects the check loop
	// We don't want to add them to the statements afterwards, because that would be slower
	allocations?: BaseNode[];

	/** Set when this expression was written with a leading `mv` (e.g. `b = mv a`,
	 *  `var X b = mv a`). Marks an ownership transfer rather than a copy. */
	is_moved?: boolean;

	/**
	 * The `start` offset of the compile-time `#for` that generated this
	 * node (R7, docs/COMPTIME.md). Stamped on clones spliced out of
	 * a `#for` arm so an error inside unrolled code can report both the
	 * generated site and the loop that spawned it. Undefined on
	 * hand-written nodes.
	 */
	spawn_of?: number;

	/**
	 * Attributes attached to this declaration — `@Name("user_name")` lines
	 * directly above it (stage 3, docs/COMPTIME.md D1). Present on
	 * struct, field and function declarations; pure metadata surfaced
	 * through META.
	 */
	attrs?: import("../types/AttributeMeta.ts").default[];

	/**
	 * The namespace this declaration belongs to (docs/SCOPING.md):
	 * `"System"` / `"System::Controls"` for library files, the
	 * entry-relative directory path (`"Blah"`, `"Blah::Sub"`, `".."` for a
	 * file gathered from the parent directory, `""` for the entry folder)
	 * for program files. Stamped by parse from the `// file://` markers.
	 * Visibility is checked against this — `pub` needs the namespace
	 * imported (or an ancestor), `internal` needs it to be an ancestor-or-
	 * self, an unmarked declaration is visible only within its own
	 * namespace.
	 */
	namespace?: string;

	/**
	 * Index into RootNode.file_paths / file_namespaces for the file this
	 * declaration came from. Stamped by parse alongside `namespace`.
	 */
	file_id?: number;

	constructor(node_type: NodeType, start: number) {
		this.node_type = node_type;
		this.start = start;
	}
}
