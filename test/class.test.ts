import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("class build", () => {
	test("class basic construction and field access", async () => {
		const input = `
class Point {
    var int x
    var int y
}

var p = Point(1, 2)
Console.write("\\{p.x},\\{p.y}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("class_basic", result, "1,2");
	});

	test("class method call", async () => {
		const input = `
class Counter {
    var int count

    func increment = (var self) {
        self.count = self.count + 1
    }
}

var c = Counter(0)
c.increment()
c.increment()
c.increment()
Console.write("\\{c.count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("class_method", result, "3");
	});

	test("class assignment shares reference", async () => {
		const input = `
class Point {
    var int x
    var int y
}

var p = Point(10, 20)
var q = p
q.x = 99
Console.write("\\{p.x}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("class_shared", result, "99");
	});

	test("class as function parameter", async () => {
		const input = `
class Point {
    var int x
    var int y
}

func getX = (Point p) {
    return p.x
}

var p = Point(42, 7)
var result = getX(p)
Console.write("\\{result}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("class_param", result, "42");
	});

	test("class with destroy", async () => {
		const input = `
class Resource {
    var int value

    func #destroy = () {
        self.value = 999
    }
}

func getValue = (Resource r) {
    return r.value
}

var r = Resource(42)
var v = getValue(r)
Console.write("\\{v}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("class_destroy", result, "42");
	});

	test("class field assignment", async () => {
		const input = `
class Point {
    var int x
    var int y
}

var p = Point(1, 2)
p.x = 10
p.y = 20
Console.write("\\{p.x},\\{p.y}\\n")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(parsed.errors).toEqual([]);
		await check_output("class_field_assign", result, "10,20");
	});
});
