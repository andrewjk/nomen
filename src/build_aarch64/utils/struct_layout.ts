import DeclarationNode from "../nodes/DeclarationNode";
import StructNode from "../nodes/StructNode";
import type BuildStatus from "../build/BuildStatus";
import aarch64_size from "./aarch64_size";

const VT_SIZE = 8;

export function get_struct_size(name: string, status: BuildStatus): number {
  const struct = status.structs.find((s) => s.name === name);
  if (!struct) return VT_SIZE;
  if (struct.is_simple_type) return VT_SIZE;
  let size = VT_SIZE;
  for (const field of struct.fields) {
    size += aarch64_size(field.type.name);
  }
  return size;
}

export function get_field_offset(
  struct_name: string,
  field_name: string,
  status: BuildStatus,
): number {
  const struct = status.structs.find((s) => s.name === struct_name);
  if (!struct) return VT_SIZE;
  let offset = VT_SIZE;
  for (const field of struct.fields) {
    if (field.name === field_name) return offset;
    offset += aarch64_size(field.type.name);
  }
  return offset;
}

export function get_field(
  struct_name: string,
  field_name: string,
  status: BuildStatus,
): DeclarationNode | undefined {
  const struct = status.structs.find((s) => s.name === struct_name);
  if (!struct) return undefined;
  return struct.fields.find((f) => f.name === field_name);
}
