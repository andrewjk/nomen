import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check from "../src/check";
import parse from "../src/parse";

test("generics -- parse generic struct", () => {
	const input = `
struct Circle<T> {
    var T center_x
    var T center_y
    var T radius
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
});

test("generics -- check resolves type params on instantiation", () => {
	const input = `
struct Circle<T> {
    var T center_x
    var T center_y
    var T radius
}

pub func main = () {
    var Circle<int> c = Circle<int>(25, 70, 15)
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const checked = check(parsed.root);
	const errors = checked.errors.filter((e) => !e.message.includes("void"));
	expect(errors).toEqual([]);
});

test("generics -- field access on generic instance", () => {
	const input = `
struct Circle<T> {
    var T center_x
    var T center_y
    var T radius
}

pub func main = () {
    var Circle<int> c = Circle<int>(25, 70, 15)
    var int x = c.center_x
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const checked = check(parsed.root);
	const errors = checked.errors.filter((e) => !e.message.includes("void"));
	expect(errors).toEqual([]);
});

test("generics -- build C with monomorphized struct", () => {
	const input = `
struct Circle<T> {
    var T center_x
    var T center_y
    var T radius
}

pub func main = () {
    var Circle<int> c = Circle<int>(25, 70, 15)
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root);
	expect(built.code).toContain("Circle_int_init");
});

test("generics -- two instantiations of same generic", () => {
	const input = `
struct Pair<T, U> {
    var T first
    var U second
}

pub func main = () {
    var Pair<int, int> a = Pair<int, int>(1, 2)
    var Pair<int, string> b = Pair<int, string>(3, "hello")
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root);
	expect(built.code).toContain("Pair_int_int_init");
	expect(built.code).toContain("Pair_int_string_init");
});

test("generics -- wrong number of type args", () => {
	const input = `
struct Circle<T> {
    var T center_x
    var T center_y
    var T radius
}

pub func main = () {
    var Circle<int, string> c = Circle<int, string>(25, 70, 15)
    return
}
`;
	const parsed = parse(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});
