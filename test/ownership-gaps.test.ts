import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Regression tests for the FOLLOWUP.md "Latent ownership-tracking holes":
// value-struct methods overwriting caller-tracked string fields, and mov
// sites only splicing the current scope frame.

async function build_and_run(input: string, name: string, expected: string, audit = false) {
	for (const arch of ["aarch64", "c"] as const) {
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch, audit });
		await check_output(name, result, expected, { arch, audit });
	}
}

// A value-struct method writing `self.name = <literal>` overwrites the
// caller's heap-tracked field value with a non-heap one. The caller's
// heap_string_fields record must be dropped at the call site — a surviving
// record freed the literal at scope exit (invalid free / abort). The
// displaced heap value conservatively leaks, so this runs without the leak
// audit.
test("value-struct method overwriting tracked string field", async () => {
	const input = `
struct Person {
  var string name

  func rename = (ref self, string new_name) {
    self.name = new_name
  }
}

var Person p = Person("Alice")
p.name = 42.to_string()
p.rename("Zed")
Console.write("\\{p.name}")
`;
	await build_and_run(input, "self_write_drops_field_record", "Zed");
});

// Same shape, plus the caller reassigning the field afterwards: the stale
// record would eagerly free the method's literal at that assignment.
test("caller reassignment after self-write uses fresh ownership state", async () => {
	const input = `
struct Person {
  var string name

  func rename = (ref self, string new_name) {
    self.name = new_name
  }
}

var Person p = Person("Alice")
p.name = 42.to_string()
p.rename("Zed")
p.name = "Cat"
Console.write("\\{p.name}")
`;
	await build_and_run(input, "self_write_then_reassign", "Cat");
});

// The write happens in a method the called method invokes on `self` — the
// scanner must follow same-struct self-calls.
test("self-write through a delegated self-call", async () => {
	const input = `
struct Person {
  var string name

  func rename = (ref self, string new_name) {
    self.name = new_name
  }

  func reset = (ref self) {
    self.rename("Reset")
  }
}

var Person p = Person("Alice")
p.name = 42.to_string()
p.reset()
p.name = "Cat"
Console.write("\\{p.name}")
`;
	await build_and_run(input, "self_write_delegated", "Cat");
});

// A `mov` call inside an if branch with the variable declared in the outer
// scope: the C backend's mov-site splice only searched the current frame, so
// the outer scope-exit cleanup freed the instance the callee already owned
// (double-free).
test("mov of outer-scope variable inside if branch", async () => {
	const input = `
class Box {
  var int v = 0
}

func consume = (mov Box b, out int) {
  return b.v
}

var Box b = Box()
b.v = 7
if b.v > 0 {
  var int got = consume(mov b)
  Console.write("\\{got}")
}
Console.write("done")
`;
	await build_and_run(input, "mov_outer_scope_if_branch", "7done", true);
});

// Same hole on the method-call mov path (build_access_node).
test("method-call mov of outer-scope variable inside if branch", async () => {
	const input = `
class Box {
  var int v = 0
}

struct Collector {
  var int total = 0

  func take = (ref self, mov Box b) {
    self.total = self.total + b.v
  }
}

var Box b = Box()
b.v = 7
var Collector c = Collector()
if b.v > 0 {
  c.take(mov b)
}
Console.write("\\{c.total}")
`;
	await build_and_run(input, "method_mov_outer_scope_if_branch", "7", true);
});
