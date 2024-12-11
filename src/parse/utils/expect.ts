import add_error from "../../add_error";
import type ParseStatus from "../ParseStatus";
import get_index from "./get_index";

export default function expect(value: string, status: ParseStatus, advance = true): boolean {
  if (status.i < status.tokens.length) {
    let token = status.tokens[status.i].value;
    if (token === value) {
      status.i += advance ? 1 : 0;
      return true;
    } else {
      add_error(status, `Expected ${value}`, get_index(status));
    }
  } else {
    const last = status.tokens.at(-1);
    add_error(status, "Expected token", last ? last.i + last.value.length : 0);
  }
  return false;
}
