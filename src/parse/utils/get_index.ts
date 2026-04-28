import type ParseStatus from "../ParseStatus.ts";

export default function get_index(status: ParseStatus): number {
  return status.tokens[status.i].i;
}
