import BaseNode from "./BaseNode";

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
