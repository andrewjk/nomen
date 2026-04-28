import type CheckStatus from "./check/CheckStatus.ts";
import type ParseStatus from "./parse/ParseStatus.ts";

export default function add_error(
  status: ParseStatus | CheckStatus,
  message: string,
  start: number,
) {
  status.errors.push({
    message,
    start,
    line: 0,
    column: 0,
  });
}
