import { describe, expect, test } from "vite-plus/test";

import parse_with_imports, { parse_raw } from "./parse_with_imports";

// Checker name resolution must prefer the innermost (last-pushed) declaration:
// core library Nomen method bodies are checked through a clone of the ambient
// status, so their locals share the values array with the caller's values.
// First-match resolution let a user's top-level `const` shadow a core method's
// own local, producing "Assignment to const: <name>" for an assignment inside
// the core method's body — order-dependent, and invisible for raw `#arch`
// blocks (their identifiers never reached the checker).

describe("checker name resolution: core bodies vs user names", () => {
	// String.hash declares `var i = 0` and updates it (`i += 1`) in its own
	// body; a user top-level `const i` declared before the call must not turn
	// that update into "Assignment to const: i".
	test("user top-level const does not shadow String.hash's own loop local", () => {
		const source = `
import System

const i = 42

pub func main = () {
	Console.write_line("\\{"abc".hash()}")
}
`;
		const parsed = parse_raw(source);
		const errors = parsed.errors.map((e) => e.message);
		expect(errors).toEqual([]);
	});

	test("main-local const does not shadow core body locals of the same name", () => {
		const source = `
const i = 0
Console.write_line("\\{"abc".hash()} \\{i}")
`;
		const parsed = parse_with_imports(source);
		const errors = parsed.errors.map((e) => e.message);
		expect(errors).toEqual([]);
	});

	// The originally-reported shape: a user const named like String.hash's
	// own accumulator (h), with the hash reached through an interpolation on
	// a user struct value.
	test("user const h does not shadow String.hash's accumulator", () => {
		const source = `
import System

struct Point: Hashable {
	var int x
}

const h = Point(5)

pub func main = () {
	Console.write_line("\\{h.hash()} \\{"abc".hash()}")
}
`;
		const parsed = parse_raw(source);
		const errors = parsed.errors.map((e) => e.message);
		expect(errors).toEqual([]);
	});
});

// The Box transparent-access rewrite (`box.f` → `box.__value.f`) re-dispatches
// check_access_node, which re-walks the ALREADY-CHECKED target chain. When that
// chain contains a hoisted receiver temp (`l.at(0)` hoisted into `_recv_N`
// because its mv-struct result must reach a scope-exit destroy), the re-walk
// re-visits the temp's ValueNode — whose declaration is attached to the
// statement for the build pass and never enters status.values. The live lookup
// missed, surfacing as the internal-shaped "Unknown value: _recv_N". The
// checker now keeps the type it stamped on the node.
describe("checker name resolution: hoisted receiver temps under re-dispatch", () => {
	test("chained Box deref through an accessor result resolves", () => {
		const source = `
mv struct Payload {
	var int v
}
mv struct Cell {
	var Box<Payload> payload
}
var List<Cell> l = List<Cell>()
var int x = l.at_or_panic(0).payload.v
Console.write_line("\\{l.at_or_panic(0).payload.v} \\{x}")
`;
		const parsed = parse_with_imports(source);
		const errors = parsed.errors.map((e) => e.message);
		expect(errors).toEqual([]);
	});
});
