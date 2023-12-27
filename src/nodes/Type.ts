import BaseNode from "./BaseNode";
import DeclarationNode from "./DeclarationNode";
import FunctionNode from "./FunctionNode";

export default class Type {
  name: string;
  is_array: boolean;
  length?: BaseNode;

  constructor(name: string, is_array?: boolean, length?: BaseNode) {
    this.name = name;
    this.is_array = is_array || false;
    this.length = length;
  }
}
