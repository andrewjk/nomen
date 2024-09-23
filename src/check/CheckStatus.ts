import BaseNode from "../nodes/BaseNode";
import FunctionNode from "../nodes/FunctionNode";
import StructNode from "../nodes/StructNode";
import TraitNode from "../nodes/TraitNode";
import Type from "../nodes/Type";
import type CompileError from "../types/CompileError";
import type StackValue from "../types/StackValue";

export default interface CheckStatus {
  // The current node
  stack: BaseNode[];
  // TODO: Scope these properly
  // Types (values, structs and traits) in scope
  types: string[];
  // For declarations and assignments, store the type if set, for use in ambigous nodes such as arrays
  expected_type?: Type;
  // Values (vars, params etc), structs, traits and functions in scope
  values: StackValue[];
  structs: StructNode[];
  traits: TraitNode[];
  functions: FunctionNode[];
  // Errors that have been encountered
  errors: CompileError[];
}
