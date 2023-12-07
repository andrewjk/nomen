import { suite } from "uvu";
import assert from "uvu/assert";
import check from "../../src/check";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import type AccessFieldNode from "../../src/types/AccessFieldNode";
import type AccessInvocationNode from "../../src/types/AccessInvocationNode";
import type AccessNode from "../../src/types/AccessNode";
import type AssignmentNode from "../../src/types/AssignmentNode";
import type DeclarationNode from "../../src/types/DeclarationNode";
import type ValueNode from "../../src/types/ValueNode";
import trim_test_data from "../trim_test_data";

const test = suite("Access parse");

test("getting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
var x = p.age
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "access",
      source: {
        node_type: "value",
        value: "p",
        type: "Person",
        children: [],
        i: 0,
      } as ValueNode,
      access: {
        node_type: "accfld",
        name: "age",
        type: "int",
        children: [],
        i: 0,
      } as AccessFieldNode,
      children: [],
      i: 0,
    } as AccessNode,
    type: "int",
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[2]),
    trim_test_data(expected),
  );
});

test("getting nested field", () => {
  const input = `
struct Address {
  var line: string
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
var x = p.address.line
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "access",
      source: {
        node_type: "access",
        source: {
          node_type: "value",
          value: "p",
          type: "Person",
          children: [],
          i: 0,
        } as ValueNode,
        access: {
          node_type: "accfld",
          name: "address",
          type: "Address",
          children: [],
          i: 0,
        } as AccessFieldNode,
        children: [],
        i: 0,
      } as AccessNode,
      access: {
        node_type: "accfld",
        name: "line",
        type: "string",
        children: [],
        i: 0,
      } as AccessFieldNode,
      children: [],
      i: 0,
    } as AccessNode,
    type: "string",
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[3]),
    trim_test_data(expected),
  );
});

test("setting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
p.age = 20
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: AssignmentNode = {
    node_type: "assign",
    left_value: {
      node_type: "access",
      source: {
        node_type: "value",
        value: "p",
        type: "Person",
        children: [],
        i: 0,
      } as ValueNode,
      access: {
        node_type: "accfld",
        name: "age",
        type: "int",
        children: [],
        i: 0,
      } as AccessFieldNode,
      children: [],
      i: 0,
    } as AccessNode,
    right_value: {
      node_type: "value",
      value: "20",
      type: "int",
      children: [],
      i: 0,
    } as ValueNode,
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[2]),
    trim_test_data(expected),
  );
});

test("setting nested field", () => {
  const input = `
struct Address {
  var line: string
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
p.address.line = "1 main st"
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: AssignmentNode = {
    node_type: "assign",
    left_value: {
      node_type: "access",
      source: {
        node_type: "access",
        source: {
          node_type: "value",
          value: "p",
          type: "Person",
          children: [],
          i: 0,
        } as ValueNode,
        access: {
          node_type: "accfld",
          name: "address",
          type: "Address",
          children: [],
          i: 0,
        } as AccessFieldNode,
        children: [],
        i: 0,
      } as AccessNode,
      access: {
        node_type: "accfld",
        name: "line",
        type: "string",
        children: [],
        i: 0,
      } as AccessFieldNode,
      children: [],
      i: 0,
    } as AccessNode,
    right_value: {
      node_type: "value",
      value: '"1 main st"',
      type: "string",
      children: [],
      i: 0,
    } as ValueNode,
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[3]),
    trim_test_data(expected),
  );
});

test("getting function", () => {
  const input = `
struct Person {
  func age() -> int {
    return 20
  }
}
var p: Person
var x = p.age()
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "access",
      source: {
        node_type: "value",
        value: "p",
        type: "Person",
        children: [],
        i: 0,
      } as ValueNode,
      access: {
        node_type: "accinv",
        name: "age",
        params: [],
        type: "int",
        children: [],
        i: 0,
      } as AccessInvocationNode,
      children: [],
      i: 0,
    } as AccessNode,
    type: "int",
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[2]),
    trim_test_data(expected),
  );
});

test("getting function after field", () => {
  const input = `
struct Address {
  func line() -> string {
    return "123 main st"
  }
}
struct Person {
  var age: int
  var address: Address
}
var p: Person
var x = p.address.line()
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "access",
      source: {
        node_type: "access",
        source: {
          node_type: "value",
          value: "p",
          type: "Person",
          children: [],
          i: 0,
        } as ValueNode,
        access: {
          node_type: "accfld",
          name: "address",
          type: "Address",
          children: [],
          i: 0,
        } as AccessFieldNode,
        children: [],
        i: 0,
      } as AccessNode,
      access: {
        node_type: "accinv",
        name: "line",
        params: [],
        type: "string",
        children: [],
        i: 0,
      } as AccessInvocationNode,
      children: [],
      i: 0,
    } as AccessNode,
    type: "string",
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[3]),
    trim_test_data(expected),
  );
});

test("getting field after function", () => {
  const input = `
struct Address {
  var line: string
}
struct Person {
  var age: int
  func address() -> Address {
    return Address.init("123 main st")
  }
}
var p: Person
var x = p.address().line
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  const expected: DeclarationNode = {
    node_type: "decl",
    declaration: "var",
    name: "x",
    value: {
      node_type: "access",
      source: {
        node_type: "access",
        source: {
          node_type: "value",
          value: "p",
          type: "Person",
          children: [],
          i: 0,
        } as ValueNode,
        access: {
          node_type: "accinv",
          name: "address",
          params: [],
          type: "Address",
          children: [],
          i: 0,
        } as AccessInvocationNode,
        children: [],
        i: 0,
      } as AccessNode,
      access: {
        node_type: "accfld",
        name: "line",
        type: "string",
        children: [],
        i: 0,
      } as AccessFieldNode,
      children: [],
      i: 0,
    } as AccessNode,
    type: "string",
    children: [],
    i: 0,
  };
  assert.equal(parsed.errors.concat(checked.errors), []);
  assert.equal(
    trim_test_data(parsed.root.children[3]),
    trim_test_data(expected),
  );
});

test.run();
