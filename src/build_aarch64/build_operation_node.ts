import BaseNode from "../nodes/BaseNode";
import OperationNode from "../nodes/OperationNode";
import ValueNode from "../nodes/ValueNode";
import type BuildStatus from "../build/BuildStatus";
import build_node from "./build_node";

let string_counter = 0;

export function reset_string_counter() {
  string_counter = 0;
}

function is_comparison(op: string): boolean {
  return [">", "<", "==", "!=", ">=", "<="].includes(op);
}

function map_cmp(op: string): string {
  switch (op) {
    case ">":
      return "gt";
    case "<":
      return "lt";
    case "==":
      return "eq";
    case "!=":
      return "ne";
    case ">=":
      return "ge";
    case "<=":
      return "le";
    default:
      return "eq";
  }
}

function map_op(op: string): string {
  switch (op) {
    case "+":
      return "add";
    case "-":
      return "sub";
    case "*":
      return "mul";
    case "/":
      return "sdiv";
    default:
      return "add";
  }
}

function build_operand(
  node: BaseNode,
  target_reg: string,
  status: BuildStatus,
) {
  if (node.node_type === "value") {
    const value = (node as ValueNode).value.replace("self", "_self");
    if (value === "true" || value === "false") {
      const num = value === "true" ? "1" : "0";
      status.code += `ldr ${target_reg}, =${num}`;
      return;
    }
    if (/^(\+|-)*\d+$/.test(value) || /^(\+|-)*\d+.\d+$/.test(value)) {
      status.code += `ldr ${target_reg}, =${value}`;
      return;
    }
    const paramReg = status.function_param_regs?.get(value);
    if (paramReg) {
      if (status.function_param_vars?.has(value)) {
        status.code += `ldr ${target_reg}, [${paramReg}]`;
      } else if (paramReg !== target_reg) {
        status.code += `mov ${target_reg}, ${paramReg}`;
      }
      return;
    }
    if (value.startsWith('"')) {
      const label = `_str_op_${string_counter++}`;
      status.strings!.set(label, value);
      status.code += `adr ${target_reg}, ${label}`;
      return;
    }
  }
  build_node(node, status);
  if (target_reg !== "x0") {
    if (!status.code.endsWith("\n")) {
      status.code += "\n";
    }
    status.code += `mov ${target_reg}, x0\n`;
  }
}

export default function build_operation_node(
  node: OperationNode,
  status: BuildStatus,
) {
  // Evaluate right first, then left, so that saving left doesn't clobber right's param reg
  build_operand(node.right_value, "x2", status);
  if (!status.code.endsWith("\n")) {
    status.code += "\n";
  }
  build_operand(node.left_value, "x1", status);
  if (!status.code.endsWith("\n")) {
    status.code += "\n";
  }

  if (is_comparison(node.op)) {
    status.code += `cmp x1, x2\n`;
    status.code += `cset x0, ${map_cmp(node.op)}\n`;
  } else {
    const op = map_op(node.op);
    status.code += `${op} x0, x1, x2\n`;
  }
}
