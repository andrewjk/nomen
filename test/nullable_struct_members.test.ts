import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Value structs with nullable / heap-owning members:
//   - a nullable generic container field (`List<int>?`) was not
//     monomorphized at the C null-arg call site (`struct List` incomplete);
//   - a nullable struct field was destroyed unconditionally — a null field's
//     stale bytes were `free`d ("pointer being freed was not allocated");
//   - assigning a value struct into a nullable struct field on aarch64
//     copied the source's first word instead of its address (data loss).
// Covered here on both backends with the audit allocator on.

describe("nullable / owning struct members", () => {
	test("nullable container member round-trips null and non-null", async () => {
		const input = `
struct MaybeList {
	var List<int>? items = null
}

var e = MaybeList()
if e.items == null { Console.write("empty null\\n") } else { Console.write("EMPTY FULL\\n") }

var l = List<int>()
l.push(5)
l.push(6)
var m = MaybeList()
m.items = move l
if m.items == null { Console.write("M NULL\\n") } else { Console.write("direct=\\{m.items.length}\\n") }
`;
		await build_and_check_output(input, "nullable_container_member", "empty null\ndirect=2\n");
	});

	test("nullable container member through a List of structs", async () => {
		const input = `
struct Box {
	var List<int>? items = null
}

var l = List<int>()
l.push(7)
var b = Box()
b.items = move l

var boxes = List<Box>()
boxes.push(move b)
var back = boxes.pop()
if back.items == null { Console.write("BACK NULL\\n") } else { Console.write("back=\\{back.items.length}\\n") }

var empty_box = Box()
var boxes2 = List<Box>()
boxes2.push(move empty_box)
var back2 = boxes2.pop()
if back2.items == null { Console.write("back2 null\\n") } else { Console.write("BACK2 FULL\\n") }
`;
		await build_and_check_output(input, "nullable_container_member_list", "back=1\nback2 null\n");
	});
});
