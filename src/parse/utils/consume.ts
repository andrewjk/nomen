import add_error from "../../add_error";
import type ParseStatus from "../ParseStatus";

export default function consume(status: ParseStatus, advance = true): string {
  if (status.i < status.tokens.length) {
    const result = status.tokens[status.i].value;
    status.i += advance ? 1 : 0;
    return result;
  } else {
    const last = status.tokens.at(-1);
    add_error(status, "Expected token", last ? last.i + last.value.length : 0);
    return "";
  }
}
