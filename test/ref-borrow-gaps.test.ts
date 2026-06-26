import { expect, describe, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// Originally runtime UAF probes for the patterns a lexical-scope rule would
// miss (borrow returned from a function; borrow of a field whose owner is
// freed). The `ref`-field ban now rejects all `ref` fields at compile time, so
// both are caught before any code runs -- these tests assert that.

describe("ref borrow soundness gaps", () => {
	test("ref field in a returned struct is rejected (escape via return)", () => {
		const input = `
struct Inner {
  var int value
  func #destroy = () { self.value = -777 }
}
struct Holder { var ref Inner? borrow = null }

func make_holder = (out Holder) {
  var Inner inner = Inner(42)
  var Holder h = Holder()
  h.borrow = inner
  return h
}

var Holder h = make_holder()
if h.borrow != null {
  Console.write("\\{h.borrow.value}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("fields cannot be 'ref'"))).toBe(true);
	});

	test("ref field borrowing a deeper-scope value is rejected (owner freed)", () => {
		const input = `
struct Inner {
  var int value
  func #destroy = () { self.value = -555 }
}
struct Outer { var Inner inner }
struct Handle { var ref Inner? target = null }

var Handle hd = Handle()
if 1 == 1 {
  var Outer o = Outer(Inner(42))
  hd.target = o.inner
}
if hd.target != null {
  Console.write("\\{hd.target.value}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("fields cannot be 'ref'"))).toBe(true);
	});
});
