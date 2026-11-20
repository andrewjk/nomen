import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build.ts";
import build_js from "../src/build_js/build_js.ts";
import { get_library } from "../src/lib.ts";
import parse from "../src/parse.ts";

const system = get_library(path.resolve(import.meta.dirname, "../core"));

function parse_src(source: string, options?: { arch?: string; platform?: string }) {
	return parse(`import System\n${source}`, system, undefined, {
		allow_internal: true,
		...options,
	});
}

test("attributes attach to structs and fields and parse all shapes", () => {
	const parsed = parse_src(`
		@sql_table("users")
		mv pub struct User {
			@rename("user_name"), @sql_type("VARCHAR")
			mv string user_name
			var int age
			@deprecated
			mv string old_field
		}
	`);
	expect(parsed.errors).toEqual([]);
	const struct = parsed.root.statements.find(
		(s) => s.node_type === "struct" && (s as any).name === "User",
	) as any;
	expect(struct.attrs.map((a: any) => a.name)).toEqual(["sql_table"]);
	expect(struct.attrs[0].values[0]).toMatchObject({ kind: "string", text: "users" });
	const fields = struct.fields;
	expect(fields[0].attrs.map((a: any) => a.name)).toEqual(["rename", "sql_type"]);
	expect(fields[0].attrs[1].values[0]).toMatchObject({ kind: "string", text: "VARCHAR" });
	expect(fields[1].attrs).toBeUndefined();
	// A flag attribute has no values.
	expect(fields[2].attrs[0]).toMatchObject({ name: "deprecated", values: [] });
});

test("int, float and bool attribute arguments parse", () => {
	const parsed = parse_src(`
		struct Config {
			@level(3)
			var int tier
			@weight(1.5)
			var float weight
		}
	`);
	expect(parsed.errors).toEqual([]);
	const struct = parsed.root.statements.find((s) => s.node_type === "struct") as any;
	expect(struct.fields[0].attrs[0].values[0]).toEqual({
		kind: "int",
		text: "3",
		start: expect.any(Number),
	});
	expect(struct.fields[1].attrs[0].values[0]).toEqual({
		kind: "float",
		text: "1.5",
		start: expect.any(Number),
	});
});

test("one value per attribute — packed arguments are rejected", () => {
	const parsed = parse_src(`
		struct Config {
			@level(3, true, "prod")
			var int tier
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("One value per attribute"))).toBe(true);
});

test("repeated attribute names are rejected", () => {
	const parsed = parse_src(`
		struct Config {
			@column("a"), @column("b")
			var int tier
		}
	`);
	expect(parsed.errors.some((e) => e.message.includes("Attribute '@column' repeated"))).toBe(true);
});

test("negative int attribute arguments parse", () => {
	const parsed = parse_src(`
		struct Config {
			@offset(-1)
			var int tier
		}
	`);
	expect(parsed.errors).toEqual([]);
	const field = (parsed.root.statements.find((s) => s.node_type === "struct") as any).fields[0];
	expect(field.attrs[0].values[0]).toMatchObject({ kind: "int", text: "-1" });
});

test("attributes before a non-declaration are rejected", () => {
	const parsed = parse_src(`
		@rename("x")
		Console.write_line("hi")
	`);
	expect(
		parsed.errors.some((e) =>
			e.message.includes("Expected a struct, field or function declaration after attributes"),
		),
	).toBe(true);
});

test("attributes on local declarations are rejected", () => {
	const parsed = parse_src(`
		func f = () {
			@rename("x")
			var y = 1
		}
	`);
	expect(
		parsed.errors.some((e) => e.message.includes("Attributes are not supported on local")),
	).toBe(true);
});

test("non-literal attribute arguments are rejected", () => {
	const parsed = parse_src(`
		struct P {
			@rename(whatever)
			var int x
		}
	`);
	expect(
		parsed.errors.some((e) => e.message.includes("Attribute arguments must be comptime literals")),
	).toBe(true);
});

test("field.attr without the attribute errors and points at has_attr", () => {
	const parsed = parse_src(`
		struct Point {
			var int x
		}
		func f = () {
			#for field of META.info(Point).fields {
				Console.write_line(field.attr("rename"))
			}
		}
	`);
	expect(
		parsed.errors.some((e) =>
			e.message.includes(`no '@rename' attribute — guard with field.has_attr("rename")`),
		),
	).toBe(true);
});

test("struct.attr without the attribute errors and points at has_attr", () => {
	const parsed = parse_src(`
		struct Point {
			var int x
		}
		func f = () {
			Console.write_line(META.info(Point).attr("sql_table"))
		}
	`);
	expect(
		parsed.errors.some((e) =>
			e.message.includes(`no '@sql_table' attribute — guard with META.info(Point).has_attr`),
		),
	).toBe(true);
});

// End-to-end: reflection-driven metadata consumption — the JSON/SQL story.
// The generic `keys` reads the struct's table attribute, uses per-field
// renames when present, and falls back to field names otherwise.

const META_SOURCE = `
import System

@sql_table("users")
mv pub struct User {
	@rename("user_name"), @sql_type("VARCHAR")
	mv string user_name
	var int age
	@deprecated
	mv string old_field
}

func keys<T> = (T value, out string) {
	var s = META.info(T).attr("sql_table") + ": "
	#for field of META.info(T).fields {
		if field.has_attr("rename") {
			s = s + field.attr("rename")
		} else {
			s = s + field.name
		}
		s = s + ","
	}
	return s
}

pub func main = () {
	Console.write_line(keys(User("jane", 31, "x")))
}
`;

test("META.attr / has_attr drive a generic metadata consumer at runtime", () => {
	const parsed = parse_src(META_SOURCE);
	expect(parsed.errors).toEqual([]);

	const js = build_js(parsed.root, { target: "node" });
	expect(js.errors ?? []).toEqual([]);

	const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "attrs-")), "attrs.mjs");
	fs.writeFileSync(outfile, js.code);
	const stdout = execFileSync(process.execPath, [outfile], { encoding: "utf8" }).trim();
	// The table attribute, the @rename rename, and the plain-name fallbacks —
	// all resolved at compile time, executed at runtime.
	expect(stdout).toBe("users: user_name,age,old_field,");
});

test("the C backend builds the attribute-consuming program clean", () => {
	const parsed = parse_src(META_SOURCE, { arch: "c", platform: "linux" });
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "c", platform: "linux" });
	expect(built.errors ?? []).toEqual([]);
});
