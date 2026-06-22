import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("struct array -- build", async () => {
	const input = `
import System

struct Point {
  var int x
  var int y
}

pub func main = () {
    const points = Array(Point(1, 2), Point(3, 4), Point(5, 6))
    Console.write("\\{points.at(0).x} \\{points.at(0).y}\\n")
    Console.write("\\{points.at(1).x} \\{points.at(1).y}\\n")
    Console.write("\\{points.at(2).x} \\{points.at(2).y}")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("struct_array", built, "1 2\n3 4\n5 6");
});
