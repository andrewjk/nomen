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
struct Slot<T> {
    var T value
}

const b = Slot<int>(42)
Console.write("\\{b.value}")
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
struct Slot<T> {
    var T value
}

func unwrap<T> = (Slot<T> slot, out T) {
    return slot.value
}

const b = Slot<int>(42)
const v = unwrap(b)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("type parameter: the argument is a bare type name, reflection composes", () => {
		const input = `
struct Point {
    var x = 0
    var y = 0
}

func field_names = (type T, out string) {
    var s = META.info(T).name + ": "
    #for field of META.info(T).fields {
        s = s + field.name + " "
    }
    return s
}

Console.write_line(field_names(Point))
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

	test("in-bounds reads discharge: guarded read and range-for", () => {
		const input = `
func sum = (...int nums, out int) {
    // ok, because we make sure we are in bounds:
    const second = if nums.length > 2 -> nums.at(1)
                   else -> -1

    // ok, because we know we are in bounds in each iteration:
    var result = 0
    for i of 0..nums.length {
        result += nums.at(i)
    }
    return result + second
}

sum(1, 2, 3)
`;
		expect(compile_main(input)).toEqual([]);
	});

	test("an unproven bounds read is an error", () => {
		const input = `
func first = (...int nums, out int) {
    // not ok, because we don't know how many items are in nums:
    return nums.at(0)
}

first(1)
`;
		const errors = compile_main(input);
		expect(errors.some((e) => e.message.includes("cannot be verified"))).toBe(true);
	});
});
