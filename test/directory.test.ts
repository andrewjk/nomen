import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const ARCHITECTURES = ["c", "aarch64"] as const;

describe("Directory helpers", () => {
	test("Directory.exists true for created, false for missing", async () => {
		const input = `
Directory.create("dir_exists_test")
if Directory.exists("dir_exists_test") {
	if Directory.exists("dir_no_such_xyz") {
		Console.write("both")
	} else {
		Console.write("one")
	}
} else {
	Console.write("none")
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: true };
			const result = build(parsed.root, options);
			await check_output(`directory_exists_${arch}`, result, "one", options);
		}
	});

	test("Directory.list on missing path yields empty string", async () => {
		const input = `
const string names = Directory.list("dir_no_such_xyz_123")
if names.length == 0 {
	Console.write("empty")
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: true };
			const result = build(parsed.root, options);
			await check_output(`directory_list_missing_${arch}`, result, "empty", options);
		}
	});

	test("Directory.list returns created entry", async () => {
		const input = `
Directory.create("dir_list_test")
File.write_all("dir_list_test/only.txt", "x")
const string names = Directory.list("dir_list_test")
Console.write(names)
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: true };
			const result = build(parsed.root, options);
			// Wipe any stale subdir from a previous run so the listing only
			// contains the single file this run creates (readdir order is
			// filesystem-dependent; a single entry makes the output deterministic).
			const folder = path.resolve(".", "test", "out", arch, `directory_list_entries_${arch}`);
			fs.rmSync(path.join(folder, "dir_list_test"), { recursive: true, force: true });
			await check_output(`directory_list_entries_${arch}`, result, "only.txt\n", options);
		}
	});

	test("Directory.create then Directory.remove", async () => {
		const input = `
Directory.create("dir_remove_test")
Directory.remove("dir_remove_test")
if Directory.exists("dir_remove_test") {
	Console.write("still here")
} else {
	Console.write("gone")
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: true };
			const result = build(parsed.root, options);
			await check_output(`directory_remove_${arch}`, result, "gone", options);
		}
	});
});
