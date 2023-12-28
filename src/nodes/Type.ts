import BaseNode from "./BaseNode";

export default class Type {
  name: string;
  is_array?: boolean;
  length?: BaseNode;

  constructor(name: string, is_array?: boolean, length?: BaseNode) {
    this.name = name;
    this.is_array = is_array;
    this.length = length;
  }
}
