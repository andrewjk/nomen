import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import type BuildResult from "../src/types/BuildResult";
import parse_with_imports from "./parse_with_imports";

function postprocess_macos(code: string): string {
	code = code.replace(/\bbl printf\b/g, "bl _printf");
	code = code.replace(/\bbl snprintf\b/g, "bl _snprintf");
	code = code.replace(/\bbl malloc\b/g, "bl _malloc");
	code = code.replace(/\bbl exit\b/g, "bl _exit");
	code = code.replace(/\bbl realloc\b/g, "bl _realloc");
	code = code.replace(/\bbl free\b/g, "bl _free");
	code = code.replace(/\bbl strdup\b/g, "bl _strdup");
	code = code.replace(/\bbl _malloc\b/g, "bl _echo_malloc_wrap");
	code = code.replace(/\bbl _calloc\b/g, "bl _echo_calloc_wrap");
	code = code.replace(/\bbl _realloc\b/g, "bl _echo_realloc_wrap");
	code = code.replace(/\bbl _free\b/g, "bl _echo_free_wrap");
	code = code.replace(/\bbl _strdup\b/g, "bl _echo_strdup_wrap");
	code = code.replace(/\bmain:\n/g, ".globl _main\n_main:\n");
	return code;
}

interface RunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exit_code: number | null;
}

async function compile_and_run(name: string, built: BuildResult): Promise<RunResult> {
	const folder = path.join(".", "test", "out", name);
	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder, { recursive: true });
	}

	const code = postprocess_macos(built.code);
	const codefile = path.join(folder, "main.s");
	const outfile = path.join(folder, "main.out");

	fs.writeFileSync(codefile, code);

	const execPromise = util.promisify(exec);
	const audit_runtime = path.join(".", "test", "audit_runtime.c");
	const audit_obj = path.join(folder, "audit_runtime.o");

	try {
		await execPromise(`clang -c ${audit_runtime} -o ${audit_obj}`);
		await execPromise(`clang ${codefile} ${audit_obj} -o ${outfile}`);
		const result = await execPromise(outfile);
		return { ok: true, stdout: result.stdout, stderr: result.stderr, exit_code: 0 };
	} catch (err: any) {
		return {
			ok: false,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			exit_code: err.code ?? null,
		};
	}
}

function extract_main(asm: string): string {
	const start = asm.indexOf("_main:\n");
	const ret = asm.indexOf("\nret\n", start);
	return start >= 0 && ret >= 0 ? asm.substring(start, ret + 5) : "";
}

describe("memory errors", () => {
	describe("runtime bugs (codegen issues)", () => {
		test("leak: reassigning struct variable overwrites Buffer.data without freeing old", async () => {
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
			const run = await compile_and_run("leak_reassign", result);
			expect(run.stdout).toContain("LEAK:");
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

		test("leak: assigning struct overwrites old Buffer.data", async () => {
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
			const run = await compile_and_run("leak_field_assign", result);
			expect(run.stdout).toContain("LEAK:");
		});

		test("uaf: returning local struct with owned Buffer from function", async () => {
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
			const run = await compile_and_run("uaf_return_local_struct", result);
			expect(run.ok).toBe(false);
		});
	});

	describe("use-after-move (compile errors)", () => {
		test("passing class to two mov functions", () => {
			const input = `
class Box {
	var int value
}
func take = (mov Box b) {
}
var Box a = Box(42)
take(mov a)
take(mov a)
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(
				expect.stringContaining("used after move"),
			);
		});

		test("class field mutation after mov", () => {
			const input = `
class Box {
	var int value
}
func take = (mov Box b) {
}
var Box a = Box(42)
take(mov a)
a.value = 10
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(
				expect.stringContaining("used after move"),
			);
		});

		test("class used as struct init after mov", () => {
			const input = `
class Box {
	var int value
}
struct Holder {
	var Box content
}
func take = (mov Box b) {
}
var Box a = Box(42)
take(mov a)
var Holder h = Holder(mov a)
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(
				expect.stringContaining("used after move"),
			);
		});

		test("reading class after mov into struct", () => {
			const input = `
class Box {
	var int value
}
struct Holder {
	var Box content
}
var Box a = Box(42)
var Holder h = Holder(mov a)
Console.write("\\{a.value}")
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(
				expect.stringContaining("used after move"),
			);
		});

		test("reading class field after mov to function", () => {
			const input = `
class Box {
	var int value
}
func take = (mov Box b) {
}
var Box a = Box(42)
take(mov a)
Console.write("\\{a.value}")
`;
			const parsed = parse_with_imports(input);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors.map((e) => e.message)).toContainEqual(
				expect.stringContaining("used after move"),
			);
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
			const run = await compile_and_run("ok_read_field", result);
			expect(run.ok).toBe(true);
			expect(run.stdout).toContain("42");
		});
	});
});
