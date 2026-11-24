import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

describe("readme: memory management", () => {
	test("struct with custom #init and #destroy", () => {
		const input = `
mv struct Transaction {
    var int handle

    func #init = (ref self, int handle) {
        self.handle = handle
    }

    func #destroy = (ref self) {
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("readme: ownership and borrows", () => {
	test("mv mv field and mv mv parameter", () => {
		const input = `
mv struct Crate {
    var int value
}

mv struct Holder {
    mv Crate content
}

func take = (mv Crate c) {
    Console.write("\\{c.value}")
}

pub func main = () {
    const h = Holder(mv Crate(7))
    var c = Crate(42)
    take(mv c)
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("view string slice borrows from source", () => {
		const input = `
pub func main = () {
    var s = "hello world"
    view v = s.slice(0, 5)
    Console.write(v.to_string())
}
`;
		expect(compile_module(input)).toEqual([]);
	});

	test("using a view after reassigning its source is rejected", () => {
		const input = `
pub func main = () {
    var s = "hello world"
    view v = s.slice(0, 5)
    s = "changed"
    Console.write("\\{v.length}")
}
`;
		expect(compile_module(input).some((e) => e.message.includes("invalidat"))).toBe(true);
	});
});
