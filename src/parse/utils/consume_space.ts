import type ParseStatus from "../ParseStatus";

export default function consume_space(status: ParseStatus): string {
  if (status.i < status.tokens.length) {
    if (!status.tokens[status.i].value.trim()) {
      const result = status.tokens[status.i].value;
      status.i += 1;
      return result;
    }
  }
  return "";
}
