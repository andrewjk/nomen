import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// STRUCT_PLAN_3 Phase B — B6: nullable mv types, one mechanism, two
// lowerings. The checker's optional machinery (nil checks, unwrap, switch)
// is representation-agnostic; the backend picks the lowering by SHAPE:
//   - `Box<T>?` / trait-handle `?`  → the null pointer (natural null slot)
//   - inline struct `T?`            → the companion `<slot>_has` flag
// Both spellings are specified by the type; nothing boxes silently and no
// presence byte is wasted on types with a natural null slot.

describe("B6: nullable mv struct keeps the companion flag", () => {
	test("nullable mv-struct local: null, then a moved value", async () => {
		const input = `
mv struct Config {
	var string name
}
func probe = () {
	var Config? c = null
	Console.write_line("null ok")
	c = Config("x")
	Console.write_line(c.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b6_nullable_owning_local", "null ok\nx\ndone\n");
	});

	test("nullable mv-struct field: stored, read, replaced", async () => {
		const input = `
mv struct Config {
	var string name
}
mv struct Wrapper {
	var Config? c
}
func probe = () {
	var Wrapper w = Wrapper(Config("a"))
	Console.write_line(w.c.name)
	w.c = Config("b")
	Console.write_line(w.c.name)
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b6_nullable_owning_field", "a\nb\ndone\n");
	});

	test("function returning a nullable mv struct — both paths", async () => {
		const input = `
mv struct Config {
	var string name
}
func find = (int flag, out Config?) {
	if flag == 1 {
		return Config("hit")
	}
	return null
}
func probe = () {
	var Config? a = find(1)
	Console.write_line(a.name)
	var Config? b = find(0)
	if b == null {
		Console.write_line("miss")
	}
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b6_nullable_owning_return", "hit\nmiss\ndone\n");
	});
});

describe("B6: Box<T>? is the null pointer", () => {
	test("null box local round-trips and takes a value", async () => {
		const input = `
mv struct Item {
	var int value
}
func probe = () {
	var Box<Item>? b = null
	Console.write_line("null ok")
	var Item n = Item(7)
	b = Box<Item>(mv n)
	Console.write_line(b.value.to_string())
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b6_nullable_box_local", "null ok\n7\ndone\n");
	});

	test("Box<T>? field on a mv struct (the cycle shape)", async () => {
		const input = `
mv struct Item {
	var int value
	var Box<Item>? next
}
func probe = () {
	var Item tail = Item(2, null)
	var Box<Item> tail_box = Box<Item>(mv tail)
	var Item head = Item(1, mv tail_box)
	var Box<Item> head_box = Box<Item>(mv head)
	var Box<Item>? middle = head_box.next
	if middle != null {
		Console.write_line(middle.value.to_string())
	}
}
probe()
Console.write_line("done")
`;
		await build_and_check_output(input, "b6_nullable_box_field", "2\ndone\n");
	});
});
