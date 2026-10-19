import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib.ts";
import { parse_raw } from "./parse_with_imports";

const system = get_library(path.resolve("core"));

// The demos must parse + check against the local compiler. (They are built
// by the released CLI in CI; this keeps them green against HEAD.)
describe("demos check", () => {
	const demos = ["controls", "todo"];
	for (const demo of demos) {
		test(demo, () => {
			const source = fs.readFileSync(path.resolve("demos", demo, "src", "main.nm"), "utf8");
			const parsed = parse_raw(source);
			expect(parsed.errors).toEqual([]);
		});
	}
});
