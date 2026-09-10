import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

describe("readme: memory management", () => {
	test("struct with custom #init and #destroy", () => {
		const input = `
struct Transaction {
    var int handle

    func #init = (self, int handle) {
        self.handle = handle
    }

    func #destroy = () {
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("readme: ownership and borrows", () => {
	test("move owning field and move owning parameter", () => {
		const input = `
class Box {
    var int value
}

class Holder {
    move Box content
}

func take = (move Box b) {
    Console.write("\\{b.value}")
}

pub func main = () {
    var h = Holder(move Box(7))
    var b = Box(42)
    take(move b)
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("view string slice borrows from source", () => {
		const input = `
pub func main = () {
    var string s = "hello world"
    view v = s.slice(0, 5)
    Console.write(v.to_string())
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("using a view after reassigning its source is rejected", () => {
		const input = `
pub func main = () {
    var string s = "hello world"
    view v = s.slice(0, 5)
    s = "changed"
    Console.write("\\{v.length}")
}
`;
		expect(compile_module(input).some((e) => e.message.includes("invalidat"))).toBe(true);
	});
});
