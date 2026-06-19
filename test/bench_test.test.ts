import fs from "node:fs";
import path from "node:path";

import { describe, test, expect } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

describe("bench/test.echo", () => {
	test("catches param constraint violation", () => {
		const lib = get_library(path.resolve(import.meta.dirname, "../core"));
		const src = fs.readFileSync(path.resolve(import.meta.dirname, "../bench/test.echo"), "utf-8");
		const parsed = parse(src, lib);
		expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
		expect(parsed.errors.some((e) => e.message.includes("not satisfied"))).toBe(true);
	});
});
