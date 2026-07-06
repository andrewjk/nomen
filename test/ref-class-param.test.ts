import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A `ref` CLASS param is passed the ADDRESS of the caller's pointer slot (so the
// callee can reassign it — see reassignment-loop.test.ts). The callee loads the
// instance into its register, so ordinary field reads/writes through the param
// must still target the instance, not the slot. These guard against an OOB
// read/write regression where field access treated the &slot address as the
// instance pointer.
describe("ref class param field access", () => {
	test("read a field through a ref class param", async () => {
		const input = `
class Box { var int v }
func readv = (ref Box b, out int) {
    return b.v
}
var Box a = Box(5)
var int r = readv(ref a)
Console.write("\\{r}")
`;
		await build_and_check_output(input, "ref_class_field_read", "5");
	});

	test("write a field through a ref class param", async () => {
		const input = `
class Box { var int v }
func setv = (ref Box b, int n) {
    b.v = n
}
var Box a = Box(5)
setv(ref a, 9)
Console.write("\\{a.v}")
`;
		await build_and_check_output(input, "ref_class_field_write", "9");
	});

	test("reassign a ref class param then read a field of the new instance", async () => {
		const input = `
class Box { var int v }
class Holder { mov Box c }
func replace = (ref Holder h, int n) {
    h = Holder(mov Box(n))
}
var Holder h = Holder(mov Box(0))
replace(ref h, 7)
replace(ref h, 8)
Console.write("\\{h.c.v}\\n")
`;
		await build_and_check_output(input, "ref_class_reassign_read", "8\n");
	});

	test("ref class param with owned field reassigned in a loop", async () => {
		const input = `
class Box { var int v }
class Holder { mov Box c }
func replace = (ref Holder h, int n) {
    h = Holder(mov Box(n))
}
var Holder h = Holder(mov Box(0))
var int i = 1
while i <= 4 {
    replace(ref h, i)
    i = i + 1
}
Console.write("\\{h.c.v}\\n")
`;
		await build_and_check_output(input, "ref_class_field_loop", "4\n");
	});
});
