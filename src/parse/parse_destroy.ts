import parse_function from "./parse_function.ts";
import type ParseStatus from "./ParseStatus.ts";

export default function parse_destroy(
	visibility: "pub" | "private" | "internal",
	status: ParseStatus,
	name = "#destroy",
) {
	parse_function(visibility, status, name);
}
