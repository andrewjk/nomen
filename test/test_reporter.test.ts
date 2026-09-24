import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { report_file, type TestFileResult } from "../cli/src/test.ts";

// `nomen test` used to label EVERY record-less failure "(failed to build)" —
// including a binary that linked fine and then segfaulted before emitting
// its first record, which sent debugging to the wrong layer (PORT.md). The
// report now names the stage that actually failed.

function base(overrides: Partial<TestFileResult>): TestFileResult {
	return {
		file: "x.test.nm",
		ok: false,
		tests: [],
		fails: [],
		benches: [],
		other: [],
		ms: 1,
		...overrides,
	};
}

let lines: string[] = [];
let original_log: typeof console.log;

beforeEach(() => {
	lines = [];
	original_log = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.join(" "));
	};
});

afterEach(() => {
	console.log = original_log;
});

describe("nomen test failure report labels", () => {
	test("a run-phase crash is not called a build failure", () => {
		report_file(base({ crashed: "test binary exited abnormally (signal SIGSEGV)", phase: "run" }));
		expect(lines[0]).toContain("(crashed before records)");
		expect(lines[0]).not.toContain("(failed to build)");
		// The real reason is on the following line.
		expect(lines[1]).toContain("SIGSEGV");
	});

	test("parse and build errors keep the build-failure label", () => {
		report_file(base({ crashed: "Unknown value: X (3:4)", phase: "parse" }));
		expect(lines[0]).toContain("(failed to build)");
		report_file(base({ crashed: "some build error", phase: "build" }));
		expect(lines[0]).toContain("(failed to build)");
	});

	test("link and setup failures get their own labels", () => {
		report_file(base({ crashed: "link failed: undefined symbol", phase: "link" }));
		expect(lines[0]).toContain("(link failed)");
		lines = [];
		report_file(base({ crashed: "audit_runtime.c was not found", phase: "setup" }));
		expect(lines[0]).toContain("(setup failed)");
	});

	test("a crash with records still lists them under the normal report", () => {
		report_file(
			base({
				crashed: "test binary exited abnormally (signal SIGSEGV)",
				phase: "run",
				tests: [{ name: "a", passed: 1, failed: 0, ns: 100 }],
			}),
		);
		expect(lines[0]).toContain("(1 tests)");
		expect(lines.join("\n")).not.toContain("(crashed before records)");
	});
});
