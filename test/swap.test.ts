import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("swap", () => {
	test("swap class field between two structs", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(1))
var Holder h2 = Holder(mov Box(2))
h1.content = h2.content swap Box(0)
Console.write("\\{h1.content.value} \\{h2.content.value}")
`;
		await build_and_check_output(input, "swap_fields", "2 0");
	});

	test("swap with no leak in audit mode", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(1))
var Holder h2 = Holder(mov Box(2))
h1.content = h2.content swap Box(0)
Console.write("done")
`;
		await build_and_check_output(input, "swap_no_leak", "done");
	});

	test("swap with fresh replacement value", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(10))
var Holder h2 = Holder(mov Box(20))
h1.content = h2.content swap Box(99)
Console.write("\\{h1.content.value} \\{h2.content.value}")
`;
		await build_and_check_output(input, "swap_fresh", "20 99");
	});

	test("swap frees old h1.content", async () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(1))
var Holder h2 = Holder(mov Box(2))
h1.content = h2.content swap Box(3)
Console.write("done")
`;
		await build_and_check_output(input, "swap_frees_old", "done");
	});

	test("swap on non-matching type errors", () => {
		const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(1))
var Holder h2 = Holder(mov Box(2))
h1.content = h2.content swap 42
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});

	test("swap on top-level variable", async () => {
		const input = `
class Box {
	var int value
}
var Box a = Box(1)
var Box b = Box(2)
a = b swap Box(0)
Console.write("\\{a.value} \\{b.value}")
`;
		await build_and_check_output(input, "swap_top_level", "2 0");
	});
});
