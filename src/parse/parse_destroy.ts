import parse_function from "./parse_function.ts";
import type ParseStatus from "./ParseStatus.ts";

export default function parse_destroy(visibility: "pub" | "private", status: ParseStatus) {
	parse_function(visibility, status, "destroy");
}
