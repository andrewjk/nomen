import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A trait-typed `mv` parameter boxes the conformer at the call site. The C
// backend's box emission used to hardcode `nomen_malloc_wrap(` — the audit
// runtime's wrapper — which is never declared or linked in non-audit builds,
// so ANY mv-trait parameter failed to compile there (undeclared function).
// The emission is plain `malloc(` now (wrap_c_allocators rewrites it under
// audit); this test pins the non-audit shape on the C backend.
describe("trait-typed mv parameter (C backend, no audit)", () => {
	test("boxes the conformer without the audit runtime", { timeout: 120000 }, async () => {
		const input = `
import System

pub trait Shape {
	func area = (self, out float)
}

mv struct Square : Shape {
	var float side = 0

	pub func area = (self, out float) {
		return self.side * self.side
	}
}

func report = (mv Shape s, out string) {
	var float a = s.area()
	return "area \\{a}"
}

pub func main = (Init init) {
	var Square sq = Square()
	sq.side = 3.0
	Console.write_line(report(mv sq))
}
`;
		// build_and_check_output builds both architectures; the audit flag
		// off is the regression's target (the C box previously referenced
		// the audit wrapper with no declaration).
		await build_and_check_output(input, "trait_box_no_audit", "area 9", true, {
			audit: false,
		});
		expect(true).toBe(true);
	});
});
