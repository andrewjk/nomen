export default interface ParseNode {
  node_type: string;
  // TODO: Replace this with per-node appropriate data e.g. functions, structs, statements etc
  children: ParseNode[];
  i: number;
}
