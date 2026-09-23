import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

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
		await build_and_check_output(input, "time_now_ms", "ok");
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
		await build_and_check_output(input, "time_now_unix", "ok");
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
		await build_and_check_output(input, "time_sleep", "slept");
	});
});
