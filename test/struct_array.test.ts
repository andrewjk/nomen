import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports, { parse_program } from "./parse_with_imports";

test("struct array -- build", async () => {
	const input = `
import System

struct Point {
  var int x
  var int y
}

pub func main = () {
    const points = Array(Point(1, 2), Point(3, 4), Point(5, 6))
    Console.write("\\{points.at(0).x} \\{points.at(0).y}\\n")
    Console.write("\\{points.at(1).x} \\{points.at(1).y}\\n")
    Console.write("\\{points.at(2).x} \\{points.at(2).y}")
}
`;
	const parsed = parse_program(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "ziglings_struct_array", "1 2\n3 4\n5 6", true);
});

test("owning struct array literal teardown -- audit clean", async () => {
	// Each literal element is constructed fresh (the mv ctor strdup's its
	// string field), so the array's scope-exit teardown must destroy every
	// element before freeing the buffer — previously the elements leaked.
	const input = `
mv struct Rec {
	var string name
}
var Array<Rec> rs = [Rec("a"), Rec("b"), Rec("c")]
Console.write("\\{rs.at_or_panic(1).name} \\{rs.length}")
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "struct_array_owned_elements", "b 3");
});

test("moved struct array element transfers ownership -- audit clean", async () => {
	// `mv r` hands r's bytes (and its strdup'd string) to the slot: r's own
	// cleanup is skipped, the element teardown frees exactly once.
	const input = `
mv struct Rec {
	var string name
}
var r = Rec("z")
var Array<Rec> rs = [mv r]
Console.write("\\{rs.at_or_panic(0).name}")
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "struct_array_moved_element", "z");
});

test("bare owning struct array element read again is rejected", () => {
	// A bare variable would alias the donor's string: the array teardown and
	// the donor's own cleanup would both free it.
	const parsed = parse_with_imports(`
mv struct Rec {
	var string name
}
var r = Rec("z")
var Array<Rec> rs = [r]
Console.write("\\{rs.at_or_panic(0).name} \\{r.name}")
`);
	expect(
		parsed.errors.some((e) => e.message.includes("cannot copy 'Rec' by value")),
		JSON.stringify(parsed.errors),
	).toBe(true);
});

test("bare string array element read again is rejected", () => {
	const parsed = parse_with_imports(`
var s = "hello".to_string()
var Array<string> xs = [s]
Console.write("\\{xs.at_or_panic(0)} \\{s}")
`);
	expect(
		parsed.errors.some((e) => e.message.includes("string local 's' is read again")),
		JSON.stringify(parsed.errors),
	).toBe(true);
});

test("moved string array element transfers ownership -- audit clean", async () => {
	const input = `
var s = "hello".to_string()
var string[] xs = [mv s]
Console.write("\\{xs.at(0)}")
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	await build_and_check_output(input, "struct_array_moved_string", "hello");
});
