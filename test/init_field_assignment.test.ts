import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import { parse_raw } from "./parse_with_imports";
import test_error from "./test_error";

describe("#init field completeness", () => {
	test("class field with no default and no assignment errors", () => {
		const input = `
class Person {
  var string name
  var int age
  pub func #init = (ref self) {
    self.age = 42
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(input, "Field 'name' is not assigned by '#init' and has no default", 3, 3),
		]);
	});

	test("all fields assigned is fine", () => {
		const input = `
class Person {
  var string name
  var int age
  pub func #init = (ref self, string n, int a) {
    self.name = n
    self.age = a
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("defaulted field need not be assigned", () => {
		const input = `
class Counter {
  var int count = 0
  var string label
  pub func #init = (ref self, string l) {
    self.label = l
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("struct field with no default and no assignment errors", () => {
		const input = `
struct Pair {
  var int x
  var int y
  func #init = (ref self, int a) {
    self.x = a
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(input, "Field 'y' is not assigned by '#init' and has no default", 4, 3),
		]);
	});

	test("assignment inside a conditional branch counts", () => {
		const input = `
class Person {
  var string name
  pub func #init = (ref self, int v) {
    if v > 0 {
      self.name = "pos"
    } else {
      self.name = "neg"
    }
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("every overload must assign the field", () => {
		const input = `
class Person {
  var string name
  pub func #init = (ref self) {
    self.name = "anon"
  }
  pub func #init = (ref self, int v) {
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(input, "Field 'name' is not assigned by '#init' and has no default", 3, 3),
		]);
	});

	test("an overload with a raw #arch block is opaque (no diagnostic)", () => {
		const input = `
class Handle {
  var uint64 id
  pub func #init = (self) {
  \`\`\`
  #arch: c
  self->id = 7;
  \`\`\`
  }
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
	});

	test("a method dispatched on self is opaque (no diagnostic)", () => {
		const input = `
class Person {
  var string name
  pub func #init = (ref self) {
    self.setup()
  }
  func setup = (ref self) {
    self.name = "x"
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("passing self to a call is opaque (no diagnostic)", () => {
		const input = `
struct Pair {
  var int x
  func #init = (ref self) {
    fill(ref self)
  }
}
func fill = (ref Pair p) {
  p.x = 1
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("compound assignment does not count as initialization", () => {
		const input = `
class Counter {
  var int count
  pub func #init = (ref self) {
    self.count += 1
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(input, "Field 'count' is not assigned by '#init' and has no default", 3, 3),
		]);
	});

	test("generic struct custom init is checked at monomorphization", () => {
		const input = `
struct Box<T> {
  var T item
  var int stamp
  pub func #init = (ref self, T item) {
    self.item = item
  }
}
func main = () {
  var Box<int> b = Box(1)
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(input, "Field 'stamp' is not assigned by '#init' and has no default", 4, 3),
		]);
	});
});
