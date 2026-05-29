import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import check_output from "./check_output";
import fs from "node:fs";

const system = get_library(path.resolve(import.meta.dirname, "../lib"));

test("BigInt new and get aarch64", async () => {
	const input = `
pub func main = () {
    var BigInt a = BigInt()
    a = a.new(42)
    Console.write(a.get(0).to_string())
}
`;
	const source = input + "\n" + system.source;
	const parsed = parse(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	await check_output("bigint_basic_aarch64", result, "42", { audit: false });
});

test("BigInt cmp aarch64", async () => {
	const input = `
pub func main = () {
    var BigInt a = BigInt()
    var BigInt b = BigInt()
    a = a.new(42)
    b = b.new(42)
    Console.write(a.cmp(b).to_string())
}
`;
	const source = input + "\n" + system.source;
	const parsed = parse(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	await check_output("bigint_cmp_aarch64", result, "0", { audit: false });
});

test("BigInt div aarch64", async () => {
	const input = `
pub func main = () {
    var BigInt a = BigInt()
    var BigInt b = BigInt()
    var BigInt rem = BigInt()
    var BigInt q = BigInt()
    a = a.new(20)
    b = b.new(4)
    q = q.div(a, b, rem)
    Console.write(q.get(0).to_string())
}
`;
	const source = input + "\n" + system.source;
	const parsed = parse(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	await check_output("bigint_div_aarch64", result, "5", { audit: false });
});

test("pidigits aarch64 n=3", async () => {
	const pidigits_source = fs.readFileSync(
		path.resolve(import.meta.dirname, "../bench/echo/pidigits.echo"),
		"utf-8",
	);
	const source = pidigits_source + "\n" + system.source;
	const parsed = parse(source);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch: "aarch64" });
	await check_output("pidigits_aarch64", result, "314\t:3", { audit: false });
});
