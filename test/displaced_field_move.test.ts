import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `box.items = mv list` on aarch64 used to orphan the displaced field
// value (a List's Buffer slab + the slot strings — 2 leaked allocations per
// store; the C backend reclaimed). The field mv-assign now destroys the
// displaced value before the struct copy, mirroring build_c's field
// mv-assign reclaim.
//
// The sibling string-field fixes (same session, same corpus): a `string`
// declaration/assignment whose RHS is a FIELD read is a BORROW — the stale
// `last_result_is_heap` flag (whatever the previous statement built) must
// never mark the binding heap-owned, or its scope-exit free races the
// field's owner (the displaced destroy, `replace_T`, arena teardown).

describe("container-field mv-assign displaced reclaim", () => {
	test("two displaced stores: the first list is reclaimed (audit clean)", async () => {
		const input = `
mv struct Item {
	var string name
}

mv struct Box {
	mv List<Item> items
}

var box = Box(List<Item>())
var l1 = List<Item>()
var i1 = Item("a")
l1.push(mv i1)
box.items = mv l1
var l2 = List<Item>()
var i2 = Item("b")
l2.push(mv i2)
box.items = mv l2
Console.write("len=\\{box.items.length} name=\\{box.items.at_or_panic(0).name}\\n")
`;
		await build_and_check_output(input, "displaced_field_move", "len=1 name=b\n");
	});

	test("a plain List<Item> scope exit stays balanced", async () => {
		const input = `
mv struct Item {
	var string name
}

var l = List<Item>()
var i1 = Item("a")
l.push(mv i1)
var i2 = Item("b")
l.push(mv i2)
Console.write("len=\\{l.length} a=\\{l.at_or_panic(0).name} b=\\{l.at_or_panic(1).name}\\n")
`;
		await build_and_check_output(input, "displaced_field_move_plain", "len=2 a=a b=b\n");
	});
});

describe("field-read string bindings are borrows", () => {
	test("the binding aliases the field, and the field stays valid", async () => {
		const input = `
mv struct Attr {
	var string value = ""
}

mv struct Box {
	mv List<Attr> items
}

var box = Box(List<Attr>())
var a = Attr()
a.value = "hello"
box.items.push(mv a)
var attr = box.items.at_or_panic(0)
var copy = attr.value.copy()
Console.write("copy=\\{copy}\\n")
Console.write("field=\\{box.items.at_or_panic(0).value}\\n")
var box2 = box.items.at_or_panic(0)
Console.write("still=\\{box2.value}\\n")
`;
		await build_and_check_output(
			input,
			"field_read_borrow_binding",
			"copy=hello\nfield=hello\nstill=hello\n",
		);
	});
});
