import Type from "../../nodes/Type";
import type CheckStatus from "../CheckStatus";
import type_name from "./type_name";

export default function check_type_and_value_match(
  target_type: Type,
  expression_type: Type,
  // TODO: Do we need the value?? It's type should haev been retrieved??
  value: string,
  status: CheckStatus,
  i: number,
  node_type: string,
) {
  // TODO: Should i just be cehcking that types exist for target_type and expression_type???
  if (target_type.name) {
    // TODO: thorough checking
    if (target_type.is_array !== expression_type.is_array) {
      status.errors.push({
        message: `Type mismatch in ${node_type}: ${type_name(
          expression_type,
        )} (expected ${type_name(target_type)})`,
        start: i,
      });
    } else if (target_type.name !== expression_type.name) {
      // It might be a struct with a matching trait
      // TOOD: Check this in more places
      const struct = status.structs.find((f) => f.name === expression_type.name);
      if (struct?.traits.includes(target_type.name)) {
        return;
      }

      status.errors.push({
        message: !expression_type.name
          ? `Type mismatch in ${node_type}: unknown value ${value} (expected ${type_name(
              target_type,
            )})`
          : `Type mismatch in ${node_type}: ${type_name(expression_type)} (expected ${type_name(
              target_type,
            )})`,
        start: i,
      });
    }
  } else {
    if (!expression_type.name) {
      status.errors.push({
        message: `Unknown value: ${value}`,
        start: i,
      });
    }
  }
}
