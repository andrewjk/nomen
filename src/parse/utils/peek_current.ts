import type ParseStatus from "../ParseStatus.ts";

export default function peek_current(status: ParseStatus): string | undefined {
	return status.tokens[status.i]?.value;
}
