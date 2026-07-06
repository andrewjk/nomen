import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("nullable parse errors", () => {
	test("null assigned to non-nullable type", () => {
		const input = `
struct Foo {
    var int x
}

const f = Foo(null)
Console.write("ok")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("null"))).toBe(true);
	});

	test("null assigned to non-nullable int", () => {
		const input = `
const int x = null
Console.write("ok")
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors[0].message).toContain("null");
	});
});

describe("nullable usage errors", () => {
	test("using null variable errors", () => {
		const input = `
struct Foo {
    var int x
}

var int? a = null
const b = a + 1
Console.write("\\{b}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("may be null"))).toBe(true);
	});

	test("using null variable in function call errors", () => {
		const input = `
var int? x = null
Console.write("\\{x}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("may be null"))).toBe(true);
	});
});

describe("nullable valid usage", () => {
	test("nullable variable with non-null value works", async () => {
		const input = `
var int? x = 5
Console.write("\\{x}")
`;
		await build_and_check_output(input, "nullable_non_null", "5");
	});

	test("nullable variable declared without value", () => {
		const input = `
var int? x = null
Console.write("ok")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("nullable == null comparison", async () => {
		const input = `
var int? x = null
if x == null {
    Console.write("is null")
}
`;
		await build_and_check_output(input, "nullable_eq_null", "is null");
	});

	test("nullable != null comparison", async () => {
		const input = `
var int? x = 5
if x != null {
    Console.write("\\{x}")
}
`;
		await build_and_check_output(input, "nullable_neq_null", "5");
	});

	test("null == nullable comparison", async () => {
		const input = `
var int? x = null
if null == x {
    Console.write("is null")
}
`;
		await build_and_check_output(input, "null_eq_nullable", "is null");
	});

	test("null != nullable comparison", async () => {
		const input = `
var int? x = 5
if null != x {
    Console.write("\\{x}")
}
`;
		await build_and_check_output(input, "null_neq_nullable", "5");
	});

	test("nullable variable usable after != null check", async () => {
		const input = `
var int? x = 5
if x != null {
    Console.write("\\{x}")
}
`;
		await build_and_check_output(input, "nullable_narrowed_neq", "5");
	});

	test("nullable variable usable in else after == null check", async () => {
		const input = `
var int? x = 5
if x == null {
    Console.write("null")
} else {
    Console.write("\\{x}")
}
`;
		await build_and_check_output(input, "nullable_narrowed_eq_else", "5");
	});

	test("null-valued variable usable after != null check", async () => {
		const input = `
func getVal = (out int?) {
    return 10
}
var int? x = getVal()
if x != null {
    Console.write("\\{x}")
}
`;
		await build_and_check_output(input, "nullable_narrowed_func", "10");
	});
});

describe("null coalescing ??", () => {
	test("?? with null value returns default", async () => {
		const input = `
var int? x = null
var int y = x ?? 42
Console.write("\\{y}")
`;
		await build_and_check_output(input, "coalesce_null", "42");
	});

	test("?? with non-null value returns value", async () => {
		const input = `
var int? x = 5
var int y = x ?? 42
Console.write("\\{y}")
`;
		await build_and_check_output(input, "coalesce_non_null", "5");
	});

	test("?? with function returning null", async () => {
		const input = `
func deepThought = (out int?) {
    return null
}
var int answer = deepThought() ?? 42
Console.write("\\{answer}")
`;
		await build_and_check_output(input, "coalesce_func_null", "42");
	});

	test("?? with function returning value", async () => {
		const input = `
func deepThought = (out int?) {
    return 7
}
var int answer = deepThought() ?? 42
Console.write("\\{answer}")
`;
		await build_and_check_output(input, "coalesce_func_val", "7");
	});

	test("?? result is non-nullable", async () => {
		const input = `
var int? x = null
var int y = x ?? 10
Console.write("\\{y + 1}")
`;
		await build_and_check_output(input, "coalesce_non_nullable", "11");
	});
});

describe("nullable function parameters", () => {
	test("field access on nullable param errors", () => {
		const input = `
class Thing {
    var int value
}
func null_check = (Thing? thing) {
    const x = thing.value
    Console.write("\\{x}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("null"))).toBe(true);
	});

	test("nullable param with null check is fine", () => {
		const input = `
class Thing {
    var int value
}
func null_check = (Thing? thing) {
    if thing != null {
        const x = thing.value
        Console.write("\\{x}")
    }
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("nullable param with guard clause return is fine", () => {
		const input = `
class Thing {
    var int value
}
func null_check = (Thing? thing) {
    if thing == null {
        return
    }
    const x = thing.value
    Console.write("\\{x}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("non-nullable param field access is fine", () => {
		const input = `
class Thing {
    var int value
}
func use_thing = (Thing thing) {
    const x = thing.value
    Console.write("\\{x}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});

describe("flow analysis improvements", () => {
	test("assignment to nullable var clears is_null", () => {
		const input = `
class Thing {
    var int value
}
func test = (Thing? thing) {
    var Thing? t = null
    t = Thing(5)
    const x = t.value
    Console.write("\\{x}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("assignment of null re-sets is_null", () => {
		const input = `
class Thing {
    var int value
}
func test = () {
    var Thing? t = Thing(5)
    t = null
    const x = t.value
    Console.write("\\{x}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("may be null"))).toBe(true);
	});

	test("break as guard clause in while loop", () => {
		const input = `
class Thing {
    var int value
}
func test = (Thing? thing) {
    while true {
        if thing == null {
            break
        }
        const x = thing.value
        Console.write("\\{x}")
    }
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("&& short-circuit null narrowing in if condition", () => {
		const input = `
class Thing {
    var int value
}
func test = (Thing? thing) {
    if thing != null && thing.value > 0 {
        Console.write("\\{thing.value}")
    }
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("&& short-circuit null narrowing in if body", () => {
		const input = `
class Thing {
    var int value
}
func test = (Thing? thing) {
    if thing != null && thing.value > 0 {
        const x = thing.value
        Console.write("\\{x}")
    }
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("while loop condition narrows null in body", () => {
		const input = `
class Thing {
    var int value
}
func test = (Thing? thing) {
    while thing != null {
        const x = thing.value
        Console.write("\\{x}")
    }
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});

describe("nullable classes — declaration and codegen", () => {
	test("var Box? a = null does not emit adr x0, null", () => {
		const input = `
class Box {
    var int v
}
var Box? a = null
Console.write("ok")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		expect(result.code).not.toContain("adr x0, null");
	});

	test("var Box? a = null then if a != null / else branch", async () => {
		const input = `
class Box {
    var int v
}
var Box? a = null
if a != null {
    Console.write("non")
} else {
    Console.write("null")
}
`;
		await build_and_check_output(input, "nullable_class_branch_null", "null");
	});

	test("var Box? a = Box(5) then if a != null branch", async () => {
		const input = `
class Box {
    var int v
}
var Box? a = Box(5)
if a != null {
    Console.write("non")
} else {
    Console.write("null")
}
`;
		await build_and_check_output(input, "nullable_class_branch_non", "non");
	});

	test("nullable class with destroy reading self, freed when null", async () => {
		const input = `
class Box {
    var int v
    func #destroy = () {
        Console.write_line("\\{self.v}")
    }
}
func test = () {
    var Box? a = null
}
test()
Console.write("done")
`;
		// Destroy must be skipped on null — no crash, no "destroyed" output.
		await build_and_check_output(input, "nullable_class_destroy_null", "done");
	});

	test("nullable class with destroy reading self, freed when non-null", async () => {
		const input = `
class Box {
    var int v
    func #destroy = () {
        Console.write_line("\\{self.v}")
    }
}
func test = () {
    var Box? a = Box(5)
}
test()
Console.write("done")
`;
		// Destroy must run exactly once when non-null.
		await build_and_check_output(input, "nullable_class_destroy_non", "5\ndone");
	});

	test("nullable class owning a class field, reclaimed at scope exit", async () => {
		const input = `
class Box {
    var int v
}
class Holder {
    mov Box c
}
func test = () {
    var Holder? h = Holder(Box(7))
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_class_owning_field", "done");
	});

	test("reassign nullable var: h = Box(...) then h = null", async () => {
		const input = `
class Box {
    var int v
}
func test = () {
    var Box? h = Box(1)
    h = null
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_class_reassign_null", "done");
	});
});

describe("nullable classes — function parameters", () => {
	test("pass nullable var to nullable non-mov param", () => {
		const input = `
class Box {
    var int v
}
func take = (Box? x) {
    if x != null {
        Console.write("non")
    } else {
        Console.write("null")
    }
}
var Box? a = null
take(a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("pass nullable var to nullable mov param", () => {
		const input = `
class Box {
    var int v
}
func take = (mov Box? x) {
    if x != null {
        Console.write("non")
    } else {
        Console.write("null")
    }
}
var Box? a = null
take(mov a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("pass null literal to nullable non-mov param", () => {
		const input = `
class Box {
    var int v
}
func take = (Box? x) {
    if x == null {
        Console.write("null")
    }
}
	take(null)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});

describe("nullable classes — memory reclamation", () => {
	test("reassign nullable var with non-null value frees old instance", async () => {
		const input = `
class Box {
    var int v
}
func test = () {
    var Box? a = Box(1)
    a = Box(2)
    a = Box(3)
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_reassign_chain", "done");
	});

	test("nullable var: null then assign then null then assign", async () => {
		const input = `
class Box {
    var int v
}
func test = () {
    var Box? a = null
    a = Box(1)
    a = null
    a = Box(2)
    if a != null {
        Console.write("\\{a.v}")
    }
}
test()
`;
		await build_and_check_output(input, "nullable_null_assign_cycle", "2");
	});

	test("return nullable class from function — caller frees", async () => {
		const input = `
class Box {
    var int v
}
func make = (out Box?) {
    return Box(5)
}
func test = () {
    var Box? a = make()
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_return_from_func", "done");
	});

	test("nullable class in a loop — each iteration frees", async () => {
		const input = `
class Box {
    var int v
}
func test = () {
    var Box? a = null
    var int i = 0
    while i < 5 {
        a = Box(i)
        i = i + 1
    }
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_loop_reclaim", "done");
	});

	test("nullable class owning class field, reassigned to null frees field", async () => {
		const input = `
class Box {
    var int v
}
class Holder {
    mov Box c
}
func test = () {
    var Holder? h = Holder(mov Box(7))
    h = null
    h = Holder(mov Box(8))
    h = null
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_field_owner_reassign", "done");
	});

	test("pass non-null nullable var to mov param — freed exactly once", async () => {
		const input = `
class Box {
    var int v
}
func take = (mov Box? x) {
    if x != null {
        Console.write_line("\\{x.v}")
    }
}
func test = () {
    var Box? a = Box(5)
    take(mov a)
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_mov_nonnull", "5\ndone");
	});

	test("pass null nullable var to mov param — no free, no crash", async () => {
		const input = `
class Box {
    var int v
}
func take = (mov Box? x) {
    if x == null {
        Console.write_line("null")
    }
}
func test = () {
    var Box? a = null
    take(mov a)
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_mov_null", "null\ndone");
	});

	test("nullable class with destroy owning class field, freed when non-null", async () => {
		const input = `
class Box {
    var int v
    func #destroy = () {
        Console.write_line("box \\{self.v}")
    }
}
class Holder {
    mov Box c
}
func test = () {
    var Holder? h = Holder(mov Box(7))
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_owner_destroy_non", "box 7\ndone");
	});

	test("nullable class returned from function and reassigned", async () => {
		const input = `
class Box {
    var int v
}
func make = (int n, out Box?) {
    return Box(n)
}
func test = () {
    var Box? a = make(1)
    a = make(2)
    a = null
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_returned_reassigned", "done");
	});
});

describe("nullable classes — move semantics and fields", () => {
	test("move nullable var then reassign null — no double free", async () => {
		const input = `
class Box {
    var int v
}
func take = (mov Box? x) {
}
func test = () {
    var Box? a = Box(1)
    take(mov a)
    a = null
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_mov_then_null", "done");
	});

	test("move nullable var then reassign new value — no double free", async () => {
		const input = `
class Box {
    var int v
}
func take = (mov Box? x) {
}
func test = () {
    var Box? a = Box(1)
    take(mov a)
    a = Box(2)
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_mov_then_new", "done");
	});

	test("nullable class field (mov) freed at scope exit when null", async () => {
		const input = `
class Box {
    var int v
    func #destroy = () {
        Console.write_line("box \\{self.v}")
    }
}
class Holder {
    mov Box? maybe
}
func test = () {
    var Holder h = Holder(mov null)
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_field_null", "done");
	});

	test("nullable class field (mov) freed at scope exit when non-null", async () => {
		const input = `
class Box {
    var int v
    func #destroy = () {
        Console.write_line("box \\{self.v}")
    }
}
class Holder {
    mov Box? maybe
}
func test = () {
    var Holder h = Holder(mov Box(7))
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_field_val", "box 7\ndone");
	});

	test("nullable class with destroy in a loop — destroy runs each iteration", async () => {
		const input = `
class Box {
    var int v
    func #destroy = () {
        Console.write_line("d\\{self.v}")
    }
}
func test = () {
    var Box? a = null
    var int i = 0
    while i < 3 {
        a = Box(i)
        i = i + 1
    }
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_destroy_loop", "d0\nd1\nd2\ndone");
	});

	test("?? coalescing on nullable class returns fallback when null", async () => {
		const input = `
class Box {
    var int v
}
func make = (Box? x, out Box) {
    return x ?? Box(99)
}
func test = () {
    var Box a = make(null)
    Console.write_line("\\{a.v}")
}
test()
`;
		await build_and_check_output(input, "nullable_coalesce_class", "99\n");
	});
});

describe("nullable class field assignment", () => {
	test("nullable field assigned null→value — destroy runs at scope exit", async () => {
		const input = `
class Box {
    var int v
    func #destroy = () {
        Console.write_line("\\{self.v}")
    }
}
class Holder {
    mov Box? maybe
}
func test = () {
    var Holder h = Holder(mov null)
    h.maybe = Box(5)
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_field_null_to_val", "5\ndone");
	});

	test("nullable field assigned value→null — old instance destroyed", async () => {
		const input = `
class Box {
    var int v
    func #destroy = () {
        Console.write_line("\\{self.v}")
    }
}
class Holder {
    mov Box? maybe
}
func test = () {
    var Holder h = Holder(mov Box(5))
    h.maybe = null
}
test()
Console.write("done")
`;
		await build_and_check_output(input, "nullable_field_val_to_null", "5\ndone");
	});
});
