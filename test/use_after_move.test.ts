import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("use-after-move", () => {
	test("passing class to two move functions", () => {
		const input = `
class Box {
	var int value
}
func take = (move Box b) {
}
var Box a = Box(42)
take(move a)
take(move a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("class field mutation after move", () => {
		const input = `
class Box {
	var int value
}
func take = (move Box b) {
}
var Box a = Box(42)
take(move a)
a.value = 10
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("class used as struct init after move", () => {
		const input = `
class Box {
	var int value
}
class Holder {
	move Box content
}
func take = (move Box b) {
}
var Box a = Box(42)
take(move a)
var Holder h = Holder(move a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("reading class after move into struct", () => {
		const input = `
class Box {
	var int value
}
class Holder {
	move Box content
}
var Box a = Box(42)
var Holder h = Holder(move a)
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("reading class field after move to function", () => {
		const input = `
class Box {
	var int value
}
func take = (move Box b) {
}
var Box a = Box(42)
take(move a)
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after move"),
		);
	});

	test("move then use different variable still works", async () => {
		const input = `
class Box {
	var int value
}
var Box a = Box(1)
var Box b = Box(2)
func take = (move Box x) {
}
take(move a)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "mov_use_other", "2");
	});

	test("move into struct then use other fields still works", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	var int id
	move Box content
}
var Box b = Box(99)
var Holder h = Holder(1, move b)
Console.write("\\{h.id}")
`;
		await build_and_check_output(input, "mov_struct_other_field", "1");
	});

	test("unused move class param with owned field is reclaimed", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	move Box c
}
var Box a = Box(1)
var Holder h = Holder(move Box(2))
func take = (move Holder x) {
	var int z = 1
}
take(move h)
Console.write("\\{a.value}")
`;
		await build_and_check_output(input, "mov_param_owned_field", "1");
	});

	test("unused move class param with empty body is reclaimed", async () => {
		const input = `
class Box {
	var int value
}
var Box a = Box(1)
var Box b = Box(2)
func take = (move Box x) {
}
take(move a)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "mov_param_empty_body", "2");
	});
});
