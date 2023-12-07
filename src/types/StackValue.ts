export default interface StackValue {
  declaration: "struct" | "const" | "var";
  name: string;
  type: string;
}
