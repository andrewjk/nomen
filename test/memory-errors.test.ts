import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

function extract_main(asm: string): string {
	const start = asm.indexOf("_main:\n");
	const ret = asm.indexOf("\nret\n", start);
	return start >= 0 && ret >= 0 ? asm.substring(start, ret + 5) : "";
}

describe("memory errors", () => {
	describe("runtime bugs (codegen issues)", () => {
		test("reassigning struct variable frees old Buffer.data", async () => {
			const input = `
var List<int> a = List<int>()
a.push(1)
a.push(2)
a = List<int>()
a.push(3)
const int v = a.pop()
Console.write("\\{v}")
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch: "aarch64", audit: true });
			await check_output("leak_reassign", result, "3");
		});

		test("leak: early return skips Buffer.destroy and audit_check", async () => {
			const input = `
var List<int> a = List<int>()
a.push(1)
a.push(2)
if true {
	return
}
a.push(3)
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch: "aarch64", audit: true });
			const main_asm = extract_main(result.code);

			const jumpIdx = main_asm.indexOf("b .return_0");
			const destroyIdx = main_asm.indexOf("bl Buffer_int_destroy");
			const auditIdx = main_asm.indexOf("bl _echo_audit_check");
			expect(jumpIdx).toBeGreaterThan(0);
			expect(destroyIdx).toBeGreaterThan(jumpIdx);
			expect(auditIdx).toBeGreaterThan(jumpIdx);
		});

		test("assigning struct frees old Buffer.data", async () => {
			const input = `
var List<int> a = List<int>()
a.push(1)
var List<int> b = List<int>()
b.push(2)
b = mov a
const int v = b.pop()
Console.write("\\{v}")
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch: "aarch64", audit: true });
			await check_output("leak_field_assign", result, "1");
		});

		test("returning local struct with owned Buffer from function", async () => {
			const input = `
func make_list = (out List<int>) {
	var List<int> list = List<int>()
	list.push(42)
	return list
}
var List<int> a = make_list()
const int v = a.pop()
Console.write("\\{v}")
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch: "aarch64", audit: true });
			await check_output("uaf_return_local_struct", result, "42");
		});
	});

	describe("class field ownership (compile errors)", () => {
		test("class aliasing is allowed (reference type)", () => {
			const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(42))
var Holder h2 = h1
Console.write("\\{h1.content.value}")
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
		});

		test("cannot assign class field from another owner", () => {
			const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(1))
var Holder h2 = Holder(mov Box(2))
h1.content = h2.content
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(expect.stringContaining("cannot"));
		});

		test("cannot mov out of class field", () => {
			const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(42))
var Holder h2 = Holder(mov h1.content)
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(expect.stringContaining("cannot"));
		});

		test("reading class field from class is allowed", async () => {
			const input = `
class Box {
	var int value
}
class Holder {
	mov Box content
}
var Holder h = Holder(mov Box(42))
Console.write("\\{h.content.value}")
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch: "aarch64", audit: true });
			await check_output("ok_read_field", result, "42");
		});

		test("cannot copy a struct that owns a class field by value", () => {
			const input = `
class Box {
	var int value
}
struct Holder {
	mov Box content
}
var Holder h1 = Holder(mov Box(1))
var Holder h2 = h1
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(
				expect.stringContaining("cannot copy 'Holder'"),
			);
		});
	});
});

// Echo has two kinds of `#destroy`, and only one makes a struct uncopyable:
//
//   - Owning (resource-releasing): the #destroy calls into a raw asm/C block to
//     release a heap allocation or system handle (Buffer frees its `data`, File
//     calls fclose, ClassBuffer frees each element). A byte-copy would duplicate
//     that ownership, so both copies release the same resource on cleanup -- a
//     double-free. These structs may not be copied from a variable.
//
//   - Copyable (benign): the #destroy only resets Echo fields (e.g. Token sets
//     `self.id = 0`). The struct is a plain value type with a cleanup hook; each
//     independent copy runs the harmless hook at its own scope exit. These copy
//     freely.
//
// The detector (`is_owning_struct_type` in src/check/utils/ownership.ts) tells
// them apart by whether the #destroy contains a `raw` node: every real resource
// release in Echo is emitted through a raw block (free/fclose/release are C/asm
// primitives), whereas a benign hook is pure Echo field assignment. Ownership is
// also transitive -- a struct with an owning field (e.g. List owns a Buffer) is
// itself owning even without its own #destroy.
describe("owning vs copyable #destroy", () => {
	test("a struct whose #destroy frees via a raw block is owning (copy rejected)", () => {
		// Buffer.#destroy calls `free(self->data)` from a raw block.
		const input = `
var Buffer<int> a = Buffer<int>()
var Buffer<int> b = a
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("cannot copy 'Buffer'"),
		);
	});

	test("ownership is transitive through a struct field (List owns a Buffer)", () => {
		// List has no #destroy of its own, but its Buffer field is owning, so a
		// List is owning too -- copying would share the Buffer's backing data.
		const input = `
var List<int> a = List<int>()
var List<int> b = a
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("cannot copy 'List'"),
		);
	});

	test("a struct whose #destroy only resets fields is copyable", () => {
		// Token's #destroy just sets self.id = 0 -- no resource release, so the
		// struct is a copyable value type.
		const input = `
struct Token {
	var int id

	func #destroy = () {
		self.id = 0
	}
}
var Token a = Token(1)
var Token b = a
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("a copyable #destroy still runs on each independent copy", async () => {
		// b is an independent copy of a; both are destroyed at scope exit and
		// each resets its own id. No shared heap, so this is sound (audit clean).
		const input = `
struct Token {
	var int id

	func #destroy = () {
		self.id = 0
	}
}
var Token a = Token(7)
var Token b = a
Console.write("\\{b.id}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("copyable_destroy_runs", result, "7");
	});
});

// An owning struct may not be byte-copied from a variable (the source and the
// copy would both free the same backing data). The escape hatch is the `mov`
// keyword, which transfers ownership instead of copying: the bytes still move
// into the destination, but the source is marked moved and skipped at cleanup,
// so only one owner frees. `mov` works in both copy sites:
//
//   - declaration:   `var List<int> b = mov a`
//   - assignment:    `b = mov a`
//
// Requiring `mov` on both keeps the two sites consistent (previously an
// assignment silently moved while a declaration was rejected). A struct whose
// `#destroy` is benign (no raw block) is a value type and needs no `mov`.
describe("owning-struct moves (mov keyword)", () => {
	test("declaration `var X b = mov a` transfers ownership (no double-free)", async () => {
		// b takes the list; a is moved (not freed). Only b is destroyed, so the
		// backing Buffer is freed exactly once (audit clean).
		const input = `
var List<int> a = List<int>()
a.push(1)
a.push(2)
var List<int> b = mov a
const int v = b.pop()
Console.write("\\{v}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64", audit: true });
		await check_output("owning_decl_mov", result, "2");
	});

	test("assignment of an owning struct requires mov", () => {
		// Plain `b = a` is rejected for owning structs -- use `b = mov a` (or
		// `.copy()` for an independent copy). Mirrors the declaration-side rule.
		const input = `
var List<int> a = List<int>()
var List<int> b = List<int>()
b = a
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("cannot copy 'List'"),
		);
	});
});
