import { expect } from "vitest";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports, { parse_raw } from "./parse_with_imports";

export default async function build_and_check_output(
	input: string,
	name: string,
	expected: string,
	raw = false,
) {
	let architectures = ["aarch64", "c"] as const;
	for (let arch of architectures) {
		const parsed = raw ? parse_raw(input) : parse_with_imports(input);
		expect(parsed.errors).toEqual([]);

		const options = { arch, audit: true };
		const result = build(parsed.root, options);
		await check_output(name, result, expected, options);
	}
}
