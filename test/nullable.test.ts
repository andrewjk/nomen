import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("nullable_non_null", result, "5");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("nullable_eq_null", result, "is null");
	});

	test("nullable != null comparison", async () => {
		const input = `
var int? x = 5
if x != null {
    Console.write("\\{x}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("nullable_neq_null", result, "5");
	});

	test("null == nullable comparison", async () => {
		const input = `
var int? x = null
if null == x {
    Console.write("is null")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("null_eq_nullable", result, "is null");
	});

	test("null != nullable comparison", async () => {
		const input = `
var int? x = 5
if null != x {
    Console.write("\\{x}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("null_neq_nullable", result, "5");
	});

	test("nullable variable usable after != null check", async () => {
		const input = `
var int? x = 5
if x != null {
    Console.write("\\{x}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("nullable_narrowed_neq", result, "5");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("nullable_narrowed_eq_else", result, "5");
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
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("nullable_narrowed_func", result, "10");
	});
});

describe("null coalescing ??", () => {
	test("?? with null value returns default", async () => {
		const input = `
var int? x = null
var int y = x ?? 42
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("coalesce_null", result, "42");
	});

	test("?? with non-null value returns value", async () => {
		const input = `
var int? x = 5
var int y = x ?? 42
Console.write("\\{y}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("coalesce_non_null", result, "5");
	});

	test("?? with function returning null", async () => {
		const input = `
func deepThought = (out int?) {
    return null
}
var int answer = deepThought() ?? 42
Console.write("\\{answer}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("coalesce_func_null", result, "42");
	});

	test("?? with function returning value", async () => {
		const input = `
func deepThought = (out int?) {
    return 7
}
var int answer = deepThought() ?? 42
Console.write("\\{answer}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("coalesce_func_val", result, "7");
	});

	test("?? result is non-nullable", async () => {
		const input = `
var int? x = null
var int y = x ?? 10
Console.write("\\{y + 1}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("coalesce_non_nullable", result, "11");
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
