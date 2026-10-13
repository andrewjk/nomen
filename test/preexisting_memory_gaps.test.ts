import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Regression tests for the old pre-existing memory gaps (NOT nullable-specific).
// These used to leak and were documented as known gaps: class temporaries
// (constructor results not bound to a variable) passed to non-mv parameters
// were never anchored, so nobody freed them. The struct/move refactor closed
// the family (mv temporaries are transferred/reclaimed); these tests pin the
// fixes — any regression here fails with `LEAK:` from the audit runtime.
describe("pre-existing memory gaps", () => {
	test("class temporary passed to non-mv param leaks", async () => {
		const input = `
mv struct Box {
	var int v
}
func take = (Box x) {
	Console.write_line("\\{x.v}")
}
take(Box(5))
`;
		await build_and_check_output(input, "gap_temp_nonmov_param", "5\n");
	});

	test("class temporary passed to nullable non-mv param leaks", async () => {
		const input = `
mv struct Box {
	var int v
}
func take = (Box? x) {
	if x != null {
		Console.write_line("\\{x.v}")
	}
}
take(Box(5))
`;
		await build_and_check_output(input, "gap_temp_nullable_param", "5\n");
	});

	test("forwarding a non-mv param to another non-mv param leaks the temporary", async () => {
		const input = `
mv struct Box {
	var int v
}
func inner = (Box x) {
	Console.write_line("\\{x.v}")
}
func outer = (Box y) {
	inner(y)
}
outer(Box(5))
`;
		await build_and_check_output(input, "gap_forwarded_param", "5\n");
	});

	test("class temporary in a loop compounds leak", async () => {
		const input = `
mv struct Box {
	var int v
}
func take = (Box x) {
}
func test = () {
	var int i = 0
	while i < 5 {
		take(Box(i))
		i = i + 1
	}
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "gap_temp_loop", "done");
	});

	test("?? eagerly evaluates fallback, leaking it when unused", async () => {
		const input = `
mv struct Box {
	var int v
}
func make = (Box? x, out Box) {
	return x ?? Box(99)
}
func test = () {
	var Box a = make(Box(5))
	Console.write_line("\\{a.v}")
}
test()
`;
		await build_and_check_output(input, "gap_coalesce_eager", "5\n");
	});

	test("class temporary field access leaks the instance", async () => {
		const input = `
mv struct Box {
	var int v
}
func getV = (Box b, out int) {
	return b.v
}
Console.write_line("\\{getV(Box(5))}")
`;
		await build_and_check_output(input, "gap_temp_field_access", "5\n");
	});

	test("multiple class temporaries in one call all leak", async () => {
		const input = `
mv struct Box {
	var int v
}
func take2 = (Box a, Box b) {
	Console.write_line("\\{a.v + b.v}")
}
func test = () {
	take2(Box(1), Box(2))
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "gap_multi_temp", "3\ndone");
	});

	test("class temporary stored via field then owner leaks old", async () => {
		const input = `
mv struct Box {
	var int v
	func #destroy = () {
		Console.write_line("d\\{self.v}")
	}
}
mv struct Holder {
	var Box c
}
func make = (int n, out Box) {
	return Box(n)
}
func test = () {
	var Holder h = Holder(mv Box(0))
	h.c = make(1)
	h.c = make(2)
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "gap_field_factory_reassign", "d0\nd1\nd2\ndone");
	});
});
