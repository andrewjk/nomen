import type ParseStatus from "../ParseStatus.ts";

/**
 * The visibility an unmarked declaration takes. Struct, enum, extend and
 * trait members default `pub` — value-record fields are the language's
 * primary surface, and a trait member is exported with its contract (a
 * narrower contract member is meaningless). Everything else — root-level
 * structs, functions, enums, traits — defaults to the tightest scope: the
 * declaring namespace (docs/SCOPING.md); `pub` (everywhere) or `internal`
 * (the namespace and its descendants) is the explicit spell for anything
 * wider. (`private` does not exist as a keyword: an unmarked declaration
 * already IS the tight scope.)
 */
export default function default_visibility(status: ParseStatus) {
	const parent_type = status.stack.at(-1)?.node_type;
	return parent_type === "struct" ||
		parent_type === "extend" ||
		parent_type === "enum" ||
		parent_type === "trait"
		? "pub"
		: "private";
}
