import type ParseStatus from "../ParseStatus.ts";

export default function default_visibility(status: ParseStatus) {
	const parent_type = status.stack.at(-1)?.node_type;
	return parent_type === "class" || parent_type === "struct" || parent_type === "enum"
		? "pub"
		: "private";
}
