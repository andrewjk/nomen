import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("use-after-move", () => {
	test("passing class to two mov functions", () => {
		const input = `
class Box {
	var int value
}
func take = (mov Box b) {
}
var Box a = Box(42)
take(mov a)
take(mov a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("class field mutation after mov", () => {
		const input = `
class Box {
	var int value
}
func take = (mov Box b) {
}
var Box a = Box(42)
take(mov a)
a.value = 10
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("class used as struct init after mov", () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
func take = (mov Box b) {
}
var Box a = Box(42)
take(mov a)
var Holder h = Holder(mov a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("reading class after mov into struct", () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Box a = Box(42)
var Holder h = Holder(mov a)
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("reading class field after mov to function", () => {
		const input = `
class Box {
	var int value
}
func take = (mov Box b) {
}
var Box a = Box(42)
take(mov a)
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("mov then use different variable still works", async () => {
		const input = `
class Box {
	var int value
}
var Box a = Box(1)
var Box b = Box(2)
func take = (mov Box x) {
}
take(mov a)
Console.write("\\{b.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output("mov_use_other", result, "2", { audit: false });
	});

	test("mov into struct then use other fields still works", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	var int id
	mov Box content
}
var Box b = Box(99)
var Holder h = Holder(1, mov b)
Console.write("\\{h.id}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("mov_struct_other_field", result, "1");
	});
});
