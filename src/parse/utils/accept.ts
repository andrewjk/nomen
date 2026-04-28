import type ParseStatus from "../ParseStatus.ts";

export default function accept(value: string, status: ParseStatus, advance = true): boolean {
  if (status.i < status.tokens.length) {
    if (status.tokens[status.i].value == value) {
      status.i += advance ? 1 : 0;
      return true;
    }
  }
  return false;
}
