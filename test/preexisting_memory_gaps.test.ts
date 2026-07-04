import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

// Failing tests documenting pre-existing memory gaps (NOT nullable-specific).
// These all leak and should be fixed eventually. The root cause for most is
// that class temporaries (constructor results not bound to a variable) passed
// to non-mov parameters are never anchored, so nobody frees them.
describe("pre-existing memory gaps", () => {
	test("class temporary passed to non-mov param leaks", async () => {
		const input = `
class Box {
	var int v
}
func take = (Box x) {
	Console.write_line("\\{x.v}")
}
take(Box(5))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_temp_nonmov_param", result, "5\n");
	});

	test("class temporary passed to nullable non-mov param leaks", async () => {
		const input = `
class Box {
	var int v
}
func take = (Box? x) {
	if x != null {
		Console.write_line("\\{x.v}")
	}
}
take(Box(5))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_temp_nullable_param", result, "5\n");
	});

	test("forwarding a non-mov param to another non-mov param leaks the temporary", async () => {
		const input = `
class Box {
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_forwarded_param", result, "5\n");
	});

	test("class temporary in a loop compounds leak", async () => {
		const input = `
class Box {
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_temp_loop", result, "done");
	});

	test("?? eagerly evaluates fallback, leaking it when unused", async () => {
		const input = `
class Box {
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_coalesce_eager", result, "5\n");
	});

	test("class temporary field access leaks the instance", async () => {
		const input = `
class Box {
	var int v
}
func getV = (Box b, out int) {
	return b.v
}
Console.write_line("\\{getV(Box(5))}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_temp_field_access", result, "5\n");
	});

	test("multiple class temporaries in one call all leak", async () => {
		const input = `
class Box {
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_multi_temp", result, "3\ndone");
	});

	test("class temporary stored via field then owner leaks old", async () => {
		const input = `
class Box {
	var int v
	func #destroy = () {
		Console.write_line("d\\{self.v}")
	}
}
class Holder {
	mov Box c
}
func make = (int n, out Box) {
	return Box(n)
}
func test = () {
	var Holder h = Holder(mov Box(0))
	h.c = make(1)
	h.c = make(2)
}
test()
Console.write("done")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("gap_field_factory_reassign", result, "d0\nd1\nd2\ndone");
	});
});
