import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("string replace_first and replace_all", () => {
	test("replace_all is non-overlapping left to right", async () => {
		const input = `
Console.write("aaaa".replace_all("aa", "b") + "\\n")
Console.write("hello".replace_all("l", "L") + "\\n")
Console.write("abc".replace_all("z", "q") + "\\n")
`;
		await build_and_check_output(input, "replace_all_basic", "bb\nheLLo\nabc\n");
	});

	test("replace_first stops after one", async () => {
		const input = `
Console.write("aaaa".replace_first("aa", "b") + "\\n")
Console.write("abc".replace_first("z", "q") + "\\n")
`;
		await build_and_check_output(input, "replace_first_basic", "baa\nabc\n");
	});

	test("edge cases: empty needle, empty replacement, empty text", async () => {
		const input = `
Console.write("aaa".replace_all("", "b") + "\\n")
Console.write("aaa".replace_first("", "b") + "\\n")
Console.write("hello".replace_all("l", "") + "\\n")
Console.write("hello".replace_first("l", "") + "\\n")
Console.write("hi".replace_all("i", "iii") + "\\n")
Console.write("".replace_all("a", "b") + "E\\n")
Console.write("hi".replace_all("hello", "b") + "\\n")
Console.write("end".replace_all("nd", "ND") + "\\n")
`;
		await build_and_check_output(input, "replace_edges", "aaa\naaa\nheo\nhelo\nhiii\nE\nhi\neND\n");
	});

	test("view needle and replacement pass straight in", async () => {
		const input = `
var string csv = "a,b,c"
if csv.length == 5 {
	Console.write(csv.replace_all(csv.slice(1, 2), ";") + "\\n")
	Console.write(csv.replace_all(",", csv.slice(2, 3)) + "\\n")
	Console.write(csv.replace_first(csv.slice(1, 2), csv.slice(2, 3)) + "\\n")
}
`;
		await build_and_check_output(input, "replace_views", "a;b;c\nabbbc\nabb,c\n");
	});
});
