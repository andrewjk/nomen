import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

const ARCHS = ["aarch64", "c"] as const;

async function run(name: string, input: string, expected: string) {
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	for (const arch of ARCHS) {
		const result = build(parsed.root, { arch, platform: "macos" });
		await check_output(`${name}_${arch}`, result, expected, { arch, audit: false });
	}
}

describe("geometry types", () => {
	test("BoxConstraints clamp + bound checks", async () => {
		await run(
			"geometry_clamp",
			`

var BoxConstraints c = BoxConstraints()
c = c.tighten_width(100, 300)
c = c.tighten_height(50, 200)
var int w = c.clamp_width(250)
var int h = c.clamp_height(999)
var bool wb = c.is_width_bounded()
var bool hb = c.is_height_bounded()
var int lo = c.clamp_width(10)
var int hi = c.clamp_width(400)
Console.write("\\{w} \\{h} \\{wb} \\{hb} \\{lo} \\{hi}")
`,
			"250 200 true true 100 300",
		);
	});

	test("LayoutParams default literal resolves enum values", async () => {
		await run(
			"geometry_default_params",
			`

var LayoutParams p = DEFAULT_PARAMS
var int gw = p.grow
var int sh = p.shrink
Console.write("\\{gw} \\{sh}")
`,
			"0 1",
		);
	});

	test("named-field LayoutParams with enum shorthand values", async () => {
		await run(
			"geometry_layout_params_literal",
			`

var LayoutParams p = LayoutParams() + [ width = .fixed(120), height = .percent(50), align_self = .center, grow = 2 ]
match p.width {
	case .auto -> Console.write("auto ")
	case .fixed(n) -> Console.write("fixed \\{n} ")
	case .percent(n) -> Console.write("percent \\{n} ")
	case .fill -> Console.write("fill ")
}
match p.height {
	case .percent(n) -> Console.write("percent \\{n} ")
	case .fill -> Console.write("fill ")
	case .auto -> Console.write("auto ")
	case .fixed(n) -> Console.write("fixed \\{n} ")
}
var int a = 0
match p.align_self {
	case .start -> a = 1
	case .center -> a = 2
	case .end -> a = 3
	case .stretch -> a = 4
}
Console.write("\\{a} \\{p.grow}")
`,
			"fixed 120 percent 50 2 2",
		);
	});
});
