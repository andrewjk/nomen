import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import check_output from "./check_output";

const system = get_library(path.resolve(import.meta.dirname, "../core"));
const opts = { arch: "aarch64", audit: false } as const;

function run(source: string, name: string, expected: string) {
	return async () => {
		const parsed = parse(source, system, undefined, { allow_internal: true });
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, { arch: "aarch64" });
		await check_output(name, result, expected, opts);
	};
}

describe("ref args survive sibling argument evaluation", () => {
	test(
		"Regex.find with a composed-const pattern and a ref struct arg",
		run(
			`
import System

pub const PART_A = "^("
pub const PART_B = "[a-z]+"
pub const COMPOSED = PART_A + PART_B + ")$"

pub func main = () {
	var RegexMatch m = RegexMatch()
	Regex.find(COMPOSED, "hello", ref m)
	Console.write("\\{m.found} [\\{m.text}]\\n")
}
`,
			"ref_arg_composed_const",
			"true [hello]\n",
		),
	);

	test(
		"ref arg address survives a calling scalar sibling",
		run(
			`
import System

struct Box {
	var value = 0
}

func fill = (ref Box b, int v) {
	b.value = v
}

func next = (int base, out int) {
	return base + 1
}

pub func main = () {
	var Box box = Box()
	fill(ref box, next(41))
	Console.write("\\{box.value}\\n")
}
`,
			"ref_arg_calling_sibling",
			"42\n",
		),
	);
});
