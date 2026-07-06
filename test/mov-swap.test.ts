import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("mov-swap in function call args", () => {
	test("mov field with swap into struct constructor", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(42))
var Holder h2 = Holder(mov h1.content swap Box(0))
Console.write("\\{h1.content.value} \\{h2.content.value}")
`;
		await build_and_check_output(input, "mov_swap_constructor", "0 42");
	});

	test("mov field with swap into function call", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
func take = (mov Box b) {
	Console.write("\\{b.value}")
}
var Holder h = Holder(mov Box(99))
take(mov h.content swap Box(0))
Console.write("\\{h.content.value}")
`;
		await build_and_check_output(input, "mov_swap_funcall", "990");
	});

	test("swap without mov is an error", () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
func take = (mov Box b) {
}
var Holder h = Holder(mov Box(42))
take(h.content swap Box(0))
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("swap requires mov"),
		);
	});

	test("swap type mismatch is an error", () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
func take = (mov Box b) {
}
var Holder h = Holder(mov Box(42))
take(mov h.content swap 99)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("mov field with swap no leak", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(1))
var Holder h2 = Holder(mov Box(2))
h2 = Holder(mov h1.content swap Box(3))
Console.write("done")
`;
		await build_and_check_output(input, "mov_swap_no_leak", "done");
	});
});
