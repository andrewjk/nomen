import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { parse_raw } from "./parse_with_imports";

// The demos must parse + check against the local compiler. (They are built
// by the released CLI in CI; this keeps them green against HEAD.)
describe("demos check", () => {
	const demos = ["button", "controls", "todo"];
	for (const demo of demos) {
		test(demo, () => {
			const source = fs.readFileSync(path.resolve("demos", demo, "src", "main.nm"), "utf8");
			const parsed = parse_raw(source);
			expect(parsed.errors).toEqual([]);
		});
	}
});
