import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_program } from "./parse_with_imports";

// The front-page tour (site/src/samples/tour.nm) is highlighted on the home
// page and compiled on demand in the playground — it must stay a working
// program on both native backends, mv struct and all. Read from disk so the
// test can never drift from the sample the site actually shows.

const TOUR = fs.readFileSync(
	path.resolve(import.meta.dirname, "../site/src/samples/tour.nm"),
	"utf8",
);

test("the front-page tour compiles and runs on both backends", async () => {
	// rename to "painted door", then the `mv`-transfer demo renames again via
	// an existing binding; rect(2,3)*4 = 24, circle(1)*6 = 18 → total 42.
	const expected = "The good door: 24\nTotal area: 42\nPer worker: 14\nWith no workers: 0\n";
	for (const arch of ["aarch64", "c"] as const) {
		const parsed = parse_program(TOUR, { arch });
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch, audit: true });
		expect(result.errors ?? []).toEqual([]);
		await check_output(`tour_sample_${arch}`, result, expected, { arch, audit: true });
	}
});

test("the tour also builds for the js backend (playground target)", () => {
	const parsed = parse_program(TOUR, { arch: "js" });
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "js" });
	expect(result.errors ?? []).toEqual([]);
});
