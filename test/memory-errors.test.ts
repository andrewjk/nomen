import { exec } from "node:child_process";
import path from "node:path";
import util from "node:util";

import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import type BuildResult from "../src/types/BuildResult";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

async function compile_and_run(
	name: string,
	built: BuildResult,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const execPromise = util.promisify(exec);
	try {
		const result = await execPromise(path.join(".", "test", "out", name, "main.out"));
		return { ok: true, stdout: result.stdout, stderr: result.stderr };
	} catch (err: any) {
		return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
	}
}

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
			const destroyIdx = main_asm.indexOf("bl Buffer_destroy");
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
b = a
const int v = a.pop()
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
		test("cannot copy struct that owns a class field", () => {
			const input = `
class Box {
	var int value
}
struct Holder {
	var Box content
}
var Holder h1 = Holder(mov Box(42))
var Holder h2 = h1
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(expect.stringContaining("copy"));
		});

		test("cannot assign class field from another owner", () => {
			const input = `
class Box {
	var int value
}
struct Holder {
	var Box content
}
var Holder h1 = Holder(mov Box(1))
var Holder h2 = Holder(mov Box(2))
h1.content = h2.content
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(expect.stringContaining("cannot"));
		});

		test("cannot mov out of struct field", () => {
			const input = `
class Box {
	var int value
}
struct Holder {
	var Box content
}
var Holder h1 = Holder(mov Box(42))
var Holder h2 = Holder(mov h1.content)
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(expect.stringContaining("cannot"));
		});

		test("reading class field from struct is allowed", async () => {
			const input = `
class Box {
	var int value
}
struct Holder {
	var Box content
}
var Holder h = Holder(mov Box(42))
Console.write("\\{h.content.value}")
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const result = build(parsed.root, { arch: "aarch64", audit: true });
			await check_output("ok_read_field", result, "42");
		});
	});
});
