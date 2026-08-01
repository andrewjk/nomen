import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const ARCHITECTURES = ["c", "aarch64"] as const;

describe("Time", () => {
	test("Time.now_ms returns a positive value", async () => {
		const input = `
const uint64 t = Time.now_ms()
if t > 0 {
	Console.write("ok")
} else {
	Console.write("bad")
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: true };
			const result = build(parsed.root, options);
			await check_output(`time_now_ms_${arch}`, result, "ok", options);
		}
	});

	test("Time.now_unix returns a positive value", async () => {
		const input = `
const uint64 t = Time.now_unix()
if t > 0 {
	Console.write("ok")
} else {
	Console.write("bad")
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: true };
			const result = build(parsed.root, options);
			await check_output(`time_now_unix_${arch}`, result, "ok", options);
		}
	});

	test("Time.sleep_ms advances the clock", async () => {
		const input = `
const uint64 before = Time.now_ms()
Time.sleep_ms(60)
const uint64 after = Time.now_ms()
if after > before {
	Console.write("slept")
} else {
	Console.write("nosleep")
}
`;
		for (const arch of ARCHITECTURES) {
			const parsed = parse_with_imports(input);
			expect(parsed.errors).toEqual([]);
			const options = { arch, audit: true };
			const result = build(parsed.root, options);
			await check_output(`time_sleep_${arch}`, result, "slept", options);
		}
	});
});
