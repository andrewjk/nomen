export default function c_type(type: string): string {
  return type.replace("string", "char*");
}
