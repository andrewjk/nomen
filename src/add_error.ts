import type CheckStatus from "./check/CheckStatus.ts";
import type QuickFix from "./check/utils/QuickFix.ts";
import type ParseStatus from "./parse/ParseStatus.ts";

export default function add_error(
	status: ParseStatus | CheckStatus,
	message: string,
	start: number,
	quick_fix?: QuickFix,
) {
	status.errors.push({
		message,
		start,
		line: 0,
		column: 0,
		...(quick_fix ? { quick_fix } : {}),
	});
}
