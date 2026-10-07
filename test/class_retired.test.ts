import { describe, expect, test } from "vite-plus/test";

import parse from "../src/parse";
import test_error from "./test_error";

// STRUCT_PLAN_3 Phase R — the flip: `class` has retired. Each declaration
// site (bare, visibility-prefixed, `extend class`) emits the one retirement
// error and continues parsing as an `owning struct` — one clear error per
// declaration, no cascade.

const RETIRED =
	"'class' has retired — declare `owning struct` (single-owner, move-only) and spell sharing where it happens (`ref`, `Box<T>`, `Mutex<T>`, `WeakHandle<T>`)";

describe("class retirement", () => {
	test("bare class declaration: one retirement error, no cascade", () => {
		const input = `
class Point {
	var int x
	var int y
}
var Point p = Point(1, 2)
Console.write_line(p.x)
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([test_error(input, RETIRED, 2, 1)]);
	});

	test("the declaration continues as an owning struct (owning fields accepted)", () => {
		const input = `
class Holder {
	var List<int> items
}
var Holder h = Holder()
`;
		const parsed = parse(input);
		// A bare-struct continuation would cascade with the Copyable
		// verifier ("'Holder' cannot be Copyable — field 'items' owns heap
		// memory"); the owning continuation yields only the retirement
		// error.
		expect(parsed.errors).toEqual([test_error(input, RETIRED, 2, 1)]);
	});

	test("visibility-prefixed class declaration", () => {
		const input = `
pub class Widget {
	var int id
}
var Widget w = Widget()
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([test_error(input, RETIRED, 2, 5)]);
	});

	test("extend class: one retirement error, no 'Expected struct' cascade", () => {
		const input = `
struct Counter {
	var int count
	func get = (self, out int) {
		return self.count
	}
}
extend class Counter {
	func bump = (ref self) {
		self.count = self.count + 1
	}
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([test_error(input, RETIRED, 8, 8)]);
	});
});
