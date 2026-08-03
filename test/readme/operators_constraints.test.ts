import { describe, expect, test } from "vite-plus/test";

import { compile_main } from "./_helpers.ts";

describe("readme: operator overloading", () => {
	test("struct #op_add used with +", () => {
		const input = `
struct Vec2 {
    var int x
    var int y

    func #op_add = (self, Vec2 other, out Vec2) {
        return Vec2(self.x + other.x, self.y + other.y)
    }
}

const sum = Vec2(1, 2) + Vec2(3, 4)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: generics", () => {
	test("generic struct instantiated with concrete type args", () => {
		const input = `
struct Box<T> {
    var T value
}

var Box<int> b = Box<int>(42)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("type param with trait bound (declaration only)", () => {
		const input = `
trait Named {
    func id = (self, out int)
}

struct Holder<T: Named> {
    var T item
}
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("generic free function infers T from the call site", () => {
		const input = `
struct Box<T> {
    var T value
}

func unwrap<T> = (Box<T> box, out T) {
    return box.value
}

var Box<int> b = Box<int>(42)
var int v = unwrap(b)
`;
		expect(compile_main(input)).toEqual([]);
	});
});

describe("readme: constraints", () => {
	test("parameter constraint — ok call compiles", () => {
		const input = `
func restricted = (int x: x > 5) {
    Console.write("\\{x}")
}

restricted(10)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("parameter constraint — violating call is an error", () => {
		const input = `
func restricted = (int x: x > 5) {
    Console.write("\\{x}")
}

restricted(2)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("constraint"))).toBe(true);
	});
});
