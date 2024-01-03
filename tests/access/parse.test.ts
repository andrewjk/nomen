import { suite } from "uvu";
import assert from "uvu/assert";
import AccessFieldNode from "../../src/nodes/AccessFieldNode";
import AccessInvocationNode from "../../src/nodes/AccessInvocationNode";
import AccessNode from "../../src/nodes/AccessNode";
import AssignmentNode from "../../src/nodes/AssignmentNode";
import DeclarationNode from "../../src/nodes/DeclarationNode";
import ValueNode from "../../src/nodes/ValueNode";
import parse from "../../src/parse";
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
  const parsed = parse(input);
  const expected = new DeclarationNode(
    48,
    "def",
    "var",
    "x",
    "int",
    new AccessNode(56, new ValueNode(56, "p", "Person"), new AccessFieldNode(58, "age", "int")),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[2]), trim_test_data(expected));
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
  const parsed = parse(input);
  const expected = new DeclarationNode(
    109,
    "def",
    "var",
    "x",
    "string",
    new AccessNode(
      117,
      new AccessNode(
        117,
        new ValueNode(117, "p", "Person"),
        new AccessFieldNode(119, "address", "Address"),
      ),
      new AccessFieldNode(127, "line", "string"),
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[3]), trim_test_data(expected));
});

test("setting field", () => {
  const input = `
struct Person {
  var age: int
}
var p: Person
p.age = 20
`;
  const parsed = parse(input);
  const expected = new AssignmentNode(
    48,
    new AccessNode(48, new ValueNode(48, "p", "Person"), new AccessFieldNode(50, "age", "int")),
    new ValueNode(56, "20", "int"),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[2]), trim_test_data(expected));
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
  const parsed = parse(input);
  const expected = new AssignmentNode(
    109,
    new AccessNode(
      109,
      new AccessNode(
        109,
        new ValueNode(109, "p", "Person"),
        new AccessFieldNode(111, "address", "Address"),
      ),
      new AccessFieldNode(119, "line", "string"),
    ),
    new ValueNode(126, '"1 main st"', "string"),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[3]), trim_test_data(expected));
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
  const parsed = parse(input);
  const expected = new DeclarationNode(
    73,
    "def",
    "var",
    "x",
    "int",
    new AccessNode(
      81,
      new ValueNode(81, "p", "Person"),
      new AccessInvocationNode(83, "age", [], "int"),
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[2]), trim_test_data(expected));
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
  const parsed = parse(input);
  const expected = new DeclarationNode(
    145,
    "def",
    "var",
    "x",
    "string",
    new AccessNode(
      153,
      new AccessNode(
        153,
        new ValueNode(153, "p", "Person"),
        new AccessFieldNode(155, "address", "Address"),
      ),
      new AccessInvocationNode(163, "line", [], "string"),
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[3]), trim_test_data(expected));
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
  const parsed = parse(input);
  const expected = new DeclarationNode(
    159,
    "def",
    "var",
    "x",
    "string",
    new AccessNode(
      167,
      new AccessNode(
        167,
        new ValueNode(167, "p", "Person"),
        new AccessInvocationNode(169, "address", [], "Address"),
      ),
      new AccessFieldNode(179, "line", "string"),
    ),
  );
  assert.equal(parsed.errors, []);
  assert.equal(trim_test_data(parsed.root.statements[3]), trim_test_data(expected));
});

test.run();
