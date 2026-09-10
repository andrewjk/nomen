import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { parse_args } from "../cli/src/args.ts";
import { outfile_for, project_root_for } from "../cli/src/paths.ts";

function make_project(): { dir: string; input: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-out-"));
	fs.writeFileSync(path.join(dir, "package.jsonc"), "{}");
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	const input = path.join(dir, "src", "bench_one.nm");
	fs.writeFileSync(input, "");
	return { dir, input };
}

describe("build --out", () => {
	test("explicit --out wins, resolved against cwd", () => {
		const { dir, input } = make_project();
		try {
			expect(outfile_for(input, false, "custom/bin")).toBe(path.resolve("custom/bin"));
			expect(outfile_for(input, false, "/abs/out")).toBe("/abs/out");
			expect(outfile_for(input, true, "custom/test_bin")).toBe(path.resolve("custom/test_bin"));
		} finally {
			fs.rmSync(dir, { recursive: true });
		}
	});

	test("default is build dir + entry basename", () => {
		const { dir, input } = make_project();
		try {
			expect(project_root_for(input)).toBe(dir);
			expect(outfile_for(input, false, undefined)).toBe(path.join(dir, "build", "bench_one"));
			expect(outfile_for(input, true, undefined)).toBe(
				path.join(dir, "build", "test", "bench_one"),
			);
		} finally {
			fs.rmSync(dir, { recursive: true });
		}
	});

	test("parse_args captures --out and -o", () => {
		expect(parse_args(["build", "--in", "a.nm", "--out", "b"]).out).toBe("b");
		expect(parse_args(["build", "-i", "a.nm", "-o", "b"]).out).toBe("b");
		expect(parse_args(["build", "--in", "a.nm"]).out).toBeUndefined();
	});
});
