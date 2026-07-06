import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

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
		await build_and_check_output(input, "class_basic", "1,2");
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
		await build_and_check_output(input, "class_method", "3");
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
		await build_and_check_output(input, "class_shared", "99");
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
		await build_and_check_output(input, "class_param", "42");
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
		await build_and_check_output(input, "class_destroy", "42");
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
		await build_and_check_output(input, "class_field_assign", "10,20");
	});
});
