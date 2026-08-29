import { describe, expect, test } from "vite-plus/test";

import { parse_args } from "../cli/src/args.ts";

describe("parse_args program passthrough", () => {
	test("no `--` leaves program_args empty", () => {
		const a = parse_args(["run", "--in", "app/main.nm"]);
		expect(a.command).toBe("run");
		expect(a.in).toBe("app/main.nm");
		expect(a.program_args).toEqual([]);
	});

	test("`--` captures everything after it as program_args", () => {
		const a = parse_args(["run", "--in", "app/main.nm", "--", "file1", "file2"]);
		expect(a.command).toBe("run");
		expect(a.in).toBe("app/main.nm");
		expect(a.program_args).toEqual(["file1", "file2"]);
	});

	test("program_args capture option-like tokens verbatim (no further parsing)", () => {
		const a = parse_args(["run", "--", "--arch", "c", "-x", "--in", "other"]);
		expect(a.command).toBe("run");
		expect(a.arch).toBe("aarch64"); // untouched — the `--arch` after `--` is not consumed
		expect(a.in).toBeUndefined();
		expect(a.program_args).toEqual(["--arch", "c", "-x", "--in", "other"]);
	});

	test("trailing `--` with nothing after yields empty program_args", () => {
		const a = parse_args(["run", "--in", "app/main.nm", "--"]);
		expect(a.command).toBe("run");
		expect(a.program_args).toEqual([]);
	});

	test("`--` with empty argv either side is fine", () => {
		const a = parse_args(["--"]);
		expect(a.command).toBeUndefined();
		expect(a.program_args).toEqual([]);
	});

	test("init <name> positional still works without `--`", () => {
		const a = parse_args(["init", "myapp"]);
		expect(a.command).toBe("init");
		expect(a.name).toBe("myapp");
		expect(a.program_args).toEqual([]);
	});

	test("defaults preserved: arch aarch64, watch false", () => {
		const a = parse_args(["run", "--", "x"]);
		expect(a.arch).toBe("aarch64");
		expect(a.watch).toBe(false);
		expect(a.program_args).toEqual(["x"]);
	});
});

describe("parse_args release flag", () => {
	test("release defaults to false", () => {
		const a = parse_args(["run", "--in", "app/main.nm"]);
		expect(a.release).toBe(false);
	});

	test("--release sets it true", () => {
		const a = parse_args(["build", "--in", "app/main.nm", "--release"]);
		expect(a.release).toBe(true);
	});

	test("-r short form sets it true", () => {
		const a = parse_args(["build", "-r", "-i", "app/main.nm"]);
		expect(a.release).toBe(true);
	});

	test("--release=false sets it false explicitly", () => {
		const a = parse_args(["build", "--release=false", "-i", "app/main.nm"]);
		expect(a.release).toBe(false);
	});
});

describe("parse_args fast_math flag", () => {
	test("fast_math defaults to false", () => {
		const a = parse_args(["run", "--in", "app/main.nm"]);
		expect(a.fast_math).toBe(false);
	});

	test("--fast-math sets it true", () => {
		const a = parse_args(["build", "--in", "app/main.nm", "--fast-math"]);
		expect(a.fast_math).toBe(true);
	});

	test("--fast-math=false sets it false explicitly", () => {
		const a = parse_args(["build", "--fast-math=false", "-i", "app/main.nm"]);
		expect(a.fast_math).toBe(false);
	});
});
