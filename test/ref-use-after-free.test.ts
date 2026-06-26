import { expect, describe, test } from "vite-plus/test";

import parse_with_imports from "./parse_with_imports";

// `ref T?` is a non-owning borrow: it points at a value without owning it, and
// the language has no borrow checker to tie the borrow's lifetime to its
// target. So a borrow stored in an outer scope can outlive the inner-scope
// value it points at -- a use-after-free.
//
// This was originally a runtime UAF probe (it read destroyed memory through a
// dangling borrow). The `ref`-field ban now rejects it at compile time, so the
// test asserts the compiler emits the soundness error instead of building a
// program that would read freed memory.

describe("ref borrow use-after-free", () => {
	test("ref T? field is rejected at compile time", () => {
		const input = `
struct Inner {
  var int value

  func #destroy = () {
    self.value = -999
  }
}

struct Holder {
  var ref Inner? borrow = null
}

var Holder h = Holder()
if 1 == 1 {
  var Inner inner = Inner(42)
  h.borrow = inner
}
if h.borrow != null {
  Console.write("\\{h.borrow.value}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.some((e) => e.message.includes("fields cannot be 'ref'"))).toBe(true);
	});
});
