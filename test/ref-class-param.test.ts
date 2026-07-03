import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ref_class_field_read", result, "5");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ref_class_field_write", result, "9");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ref_class_reassign_read", result, "8\n");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("ref_class_field_loop", result, "4\n");
	});
});
