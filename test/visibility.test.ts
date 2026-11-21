import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import test_error from "./test_error";

// Visibility is two-valued: `pub` (everywhere) and `internal` (this
// library). An unmarked declaration is already the tightest scope (the
// declaring file at the top level), so `private` retired — using it is a
// dedicated error, and the declaration continues as the unmarked form (one
// error, no cascade).
const RETIRED =
	"'private' has retired — an unmarked declaration is already the tightest scope: drop the keyword, or spell `internal` (this library) or `pub` (everywhere)";

describe("visibility errors", () => {
	test("invalid target", () => {
		const input = `
pub if true {
  // ...
}
`;
		const expected = [
			test_error(
				input,
				"Visibility can only be set for const, var, mv, readonly, struct, trait or func",
				2,
				1,
			),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("`private` has retired on a struct field", () => {
		const input = `
struct Counter {
  private var int count = 0
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([test_error(input, RETIRED, 3, 3)]);
	});

	test("`private` has retired on a struct method", () => {
		const input = `
struct Foo {
  private func secret = (out int) {
    return 42
  }
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([test_error(input, RETIRED, 3, 3)]);
	});

	test("`private` has retired on root declarations", () => {
		const input = `
private func helper = (out int) {
  return 42
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([test_error(input, RETIRED, 2, 1)]);
	});

	test("`private` has retired on every type declaration form", () => {
		const input = `
private struct Point {
  var int x = 0
}
private enum Color {
  case Red
}
private bitset Flags {
  case Read
}
private trait Named {
  func name = (self, out string)
}
`;
		const parsed = parse(input);
		const messages = parsed.errors.map((e) => e.message);
		expect(messages.filter((m) => m === RETIRED).length).toBe(4);
	});

	test("`mv private struct` reports the retired keyword once, no cascade", () => {
		const input = `
mv private struct Point {
  var int x = 0
}
var Point p = Point()
`;
		const parsed = parse(input);
		// One error, at the keyword token (one past `mv`), and the
		// declaration still parses — no follow-on diagnostics.
		expect(parsed.errors).toEqual([test_error(input, RETIRED, 2, 4)]);
	});

	test("retirement does not cascade: the declaration still checks", () => {
		const input = `
private struct Point {
  var int x = 0
  var int y = 0
}
var Point p = Point()
p.x = 10
p.y = 20
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([test_error(input, RETIRED, 2, 1)]);
	});

	test("`internal` in a trait is still rejected (a contract member is exported)", () => {
		const input = `
trait Person {
  internal var string name
  internal func greet = () {}
}
`;
		const expected = [
			test_error(input, "Trait fields cannot be internal", 3, 3),
			test_error(input, "Trait functions cannot be internal", 4, 3),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("trait members are exported with their contract", () => {
		const input = `
trait Person {
  mv string name = "anon"
  func greet = (self, out string) {
    return self.name
  }
}
mv struct Alice: Person {
}
var a = Alice()
a.name = mv "alice"
`;
		// Bare trait members default `pub` (no private-default leniency);
		// the conformer's inherited field is reassignable from outside.
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("bare struct members are pub by default", () => {
		const input = `
struct Point {
  var int x = 0
  var int y = 0
}
var Point p = Point()
p.x = 10
p.y = 20
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("bare root declarations are file-scoped by default", () => {
		const input = `
struct Helper {
  var int value = 0
}
func useHelper = () {
  var Helper h = Helper()
}
`;
		const parsed = parse(input);
		// An unmarked root declaration is accessible from its own file.
		expect(parsed.errors).toEqual([]);
	});

	test("`internal` items are visible within the program", () => {
		const input = `
internal struct Cache {
  var int slots = 0
}
var Cache c = Cache()
c.slots = 4
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("pub and internal mix with bare members", () => {
		const input = `
mv struct User {
  pub mv string name
  var int age = 0
  pub func getName = (self, out string) {
    return self.name
  }
}
var User u = User("Alice")
u.getName()
u.age
`;
		const parsed = parse(input);
		// Every member is exported: `pub` is the implicit member default, so
		// the mix parses and the access installs.
		expect(parsed.errors).toEqual([]);
	});
});
