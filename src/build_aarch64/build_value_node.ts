import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "../build/BuildStatus";

let string_counter = 0;

export function reset_string_counter() {
  string_counter = 0;
}

function is_literal(value: string): boolean {
  return (
    /^(\+|-)*\d+$/.test(value) ||
    /^(\+|-)*\d+.\d+$/.test(value) ||
    value === "true" ||
    value === "false"
  );
}

export default function build_value_node(node: ValueNode, status: BuildStatus) {
  const original_value = node.value;
  let value = node.value.replace("self", "_self");

  if (value === "true") {
    value = "1";
  } else if (value === "false") {
    value = "0";
  }

  // Check param regs with both original and replaced name
  let paramReg = status.function_param_regs?.get(original_value);
  if (!paramReg) {
    paramReg = status.function_param_regs?.get(value);
  }

  if (paramReg) {
    if (original_value === "self" || value === "_self") {
      // self is always the struct address, don't dereference
      if (paramReg !== "x0") {
        status.code += `mov x0, ${paramReg}`;
      }
    } else if (status.function_param_vars?.has(original_value) || status.function_param_vars?.has(value)) {
      // var param - address in register, load value
      status.code += `ldr x0, [${paramReg}]`;
    } else {
      // const param - value in register
      if (paramReg !== "x0") {
        status.code += `mov x0, ${paramReg}`;
      }
      // if already x0, no-op
    }
    return;
  }

  if (is_literal(value)) {
    status.code += `ldr x0, =${value}`;
    return;
  }

  if (value.startsWith('"')) {
    const label = `_str_${string_counter++}`;
    status.strings!.set(label, value);
    status.code += `adr x0, ${label}`;
    return;
  }

  status.code += `adr x0, ${value}\nldr x0, [x0]`;
}
