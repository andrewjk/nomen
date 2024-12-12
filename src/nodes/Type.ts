import BaseNode from "./BaseNode";

// TODO: Remove is_array and length, add generic arguments

export default class Type {
  name: string;
  is_static?: boolean;
  is_array?: boolean;
  length?: BaseNode;

  constructor(name: string, is_static?: boolean, is_array?: boolean, length?: BaseNode) {
    this.name = name;
    this.is_static = is_static;
    this.is_array = is_array;
    this.length = length;
  }
}
