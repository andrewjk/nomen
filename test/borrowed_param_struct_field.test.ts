import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A borrowed string parameter stored directly into a struct/class field used
// to trip a codegen bug (freeing a non-heap pointer). The assignment now
// takes the ownership it needs: a CLASS string field is always heap (strdup'd
// on store), and a value-struct field stays a borrow that destroy does not
// free. Covered with the audit allocator on so an invalid free/leak fails.

describe("borrowed string param stored into a field", () => {
	test("value struct and class fields from borrowed params", async () => {
		const input = `
struct Attr {
	var string name = ""
	var string value = ""
}

class CAttr {
	pub var string name = ""
	pub var string value = ""
}

func make_attr = (string name, string value, out Attr) {
	var a = Attr()
	a.name = name
	a.value = value
	return a
}

func make_cattr = (string name, string value, out CAttr) {
	var a = CAttr()
	a.name = name
	a.value = value
	return a
}

var a = make_attr("n", "borrowed")
Console.write("s=\\{a.name}:\\{a.value}\\n")
var c = make_cattr("cn", "cborrowed")
Console.write("c=\\{c.name}:\\{c.value}\\n")
`;
		await build_and_check_output(input, "borrowed_param_fields", "s=n:borrowed\nc=cn:cborrowed\n");
	});

	test("ref class and ref value struct fields from borrowed params", async () => {
		const input = `
class C {
	pub var string v = ""
}

struct S {
	var string v = ""
}

func set_c = (ref C c, string v) {
	c.v = v
}

func set_s = (ref S s, string v) {
	s.v = v
}

var c = C()
set_c(ref c, "literal-c")
Console.write("c=\\{c.v}\\n")

var s = S()
set_s(ref s, "literal-s")
Console.write("s=\\{s.v}\\n")
`;
		await build_and_check_output(input, "borrowed_param_ref_fields", "c=literal-c\ns=literal-s\n");
	});
});
