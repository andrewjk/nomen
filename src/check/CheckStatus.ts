import BaseNode from "../nodes/BaseNode";
import FunctionNode from "../nodes/FunctionNode";
import StructNode from "../nodes/StructNode";
import TraitNode from "../nodes/TraitNode";
import Type from "../nodes/Type";
import type CompileError from "../types/CompileError";
import type StackValue from "./StackValue";

export default interface CheckStatus {
  /**
   * The stack of nodes, with the current node being checked on top
   */
  stack: BaseNode[];
  /**
   * Types (values, structs and traits) in scope
   */
  types: string[];
  /**
   * For declarations and assignments, store the type if set, for use in
   * ambigous nodes such as arrays
   */
  expected_type?: Type;
  /**
   * Values (variables, params etc) in scope
   */
  values: StackValue[];
  /**
   * Structs in scope
   */
  structs: StructNode[];
  /**
   * Traits in scope
   */
  traits: TraitNode[];
  /**
   * Functions in scope
   */
  functions: FunctionNode[];
  /**
   * Errors that have been encountered
   */
  errors: CompileError[];
}
