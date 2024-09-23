import type ParseStatus from "../ParseStatus";

export default function peek_next(status: ParseStatus): string | undefined {
  return status.tokens[status.i + 1]?.value;
}
