import type ParseStatus from "../ParseStatus";

export default function consume(status: ParseStatus, advance = true): string {
  if (status.i < status.tokens.length) {
    const result = status.tokens[status.i].value;
    status.i += advance ? 1 : 0;
    return result;
  } else {
    const last = status.tokens.at(-1);
    status.errors.push({
      message: "Expected token",
      start: last ? last.i + last.value.length : 0,
    });
    return "";
  }
}
