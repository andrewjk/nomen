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
	test("mov owning field and mov owning parameter", () => {
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

pub func main = () {
    var h = Holder(mov Box(7))
    var b = Box(42)
    take(mov b)
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
