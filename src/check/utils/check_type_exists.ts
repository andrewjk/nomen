import add_error from "../../add_error";
import Type from "../../nodes/Type";
import type CheckStatus from "../CheckStatus";
import type_name from "./type_name";

export default function check_type_exists(type: Type, status: CheckStatus, start: number): boolean {
  if (!status.types.includes(type.name)) {
    add_error(status, `Unknown type: ${type_name(type)}`, start);
    return false;
  }
  return true;
}
