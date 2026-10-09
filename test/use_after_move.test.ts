import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("use-after-mv", () => {
	test("passing class to two mv functions", () => {
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
take(mv a)
take(mv a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("class field mutation after mv", () => {
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
take(mv a)
a.value = 10
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("class used as struct init after mv", () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box content
}
func take = (mv Box b) {
}
var Box a = Box(42)
take(mv a)
var Holder h = Holder(mv a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("reading class after mv into struct", () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box content
}
var Box a = Box(42)
var Holder h = Holder(mv a)
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("reading class field after mv to function", () => {
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
take(mv a)
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("mv then use different variable still works", async () => {
		const input = `
mv struct Box {
	var int value
}
var Box a = Box(1)
var Box b = Box(2)
func take = (mv Box x) {
}
take(mv a)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "mov_use_other", "2");
	});

	test("mv into struct then use other fields still works", async () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var int id
	var Box content
}
var Box b = Box(99)
var Holder h = Holder(1, mv b)
Console.write("\\{h.id}")
`;
		await build_and_check_output(input, "mov_struct_other_field", "1");
	});

	test("unused mv class param with owned field is reclaimed", async () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box c
}
var Box a = Box(1)
var Holder h = Holder(mv Box(2))
func take = (mv Holder x) {
	var int z = 1
}
take(mv h)
Console.write("\\{a.value}")
`;
		await build_and_check_output(input, "mov_param_owned_field", "1");
	});

	test("unused mv class param with empty body is reclaimed", async () => {
		const input = `
mv struct Box {
	var int value
}
var Box a = Box(1)
var Box b = Box(2)
func take = (mv Box x) {
}
take(mv a)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "mov_param_empty_body", "2");
	});
});
