import { expect, test } from "vite-plus/test";

import build from "../../src/build";
//import test_error from "../test_error";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// TODO: convert zig code to nomen
const zig_source = `// This is the end for now!
// More exercises will follow...

const print = @import("std").debug.print;

pub fn main() void {
    print("\\nThis is the end for now!\\nWe hope you had fun and were able to learn a lot, so visit us again when the next exercises are available.\\n", .{});
}
`;

test.skip("ziglings 999 the end -- errors", () => {
	const input = zig_source;
	const expected: any[] = [];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test.skip("ziglings 999 the end -- fixed", () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test.skip("ziglings 999 the end -- build", async () => {
	const input = zig_source;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("999", built, "");
});
