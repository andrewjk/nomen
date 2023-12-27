import Type from "../nodes/Type";

export default interface StackValue {
  declaration: "struct" | "const" | "var";
  name: string;
  type: Type;
}
