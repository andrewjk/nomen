import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { compile_module } from "./spec/_helpers.ts";

// Stage-6 iterable: attribute-collected type sets — `META.types_with("x")`
// iterates every non-generic struct carrying the attribute, in
// registration order. The binding is a TYPE: `.name` folds to the type
// name, `META.info(#t)` reflects over it, and `#{t.name}` splices names.

test("attribute type sets generate per-type members, composed with field reflection", async () => {
	await build_and_check_output(
		`
import System

@entity
pub mv struct User {
	pub var name = ""
	pub var age = 0
}

@entity
pub mv struct Order {
	pub var id = 0
}

pub struct Plain {
	pub var x = 0
}

#for t of META.types_with("entity") {
	pub func keys_#{t.name} = (out string) {
		var s = ""
		#for f of META.info(#t).fields {
			s = s + f.name + ","
		}
		return s
	}
	pub func kind_#{t.name} = (out string) {
		return t.name
	}
}

pub func main = () {
	Console.write_line(keys_User())
	Console.write_line(keys_Order())
	Console.write_line(kind_Order())
}
`,
		"comptime_types_with",
		"name,age,\nid,\nOrder\n",
		true,
		{ js: true },
	);
});

test("types_with takes an attribute name string", () => {
	const errors = compile_module(`
		#for t of META.types_with(42) {
			pub func f_#{t.name} = (out int) { return 0 }
		}
	`);
	expect(
		errors.some((e) => e.message.includes("META.types_with takes an attribute name string")),
	).toBe(true);
});

test("type bindings expose .name — reflection goes through META.info(#t)", () => {
	const errors = compile_module(`
		@entity
		pub struct User {
			pub var x = 0
		}
		#for t of META.types_with("entity") {
			pub func f = (out string) { return t.fields }
		}
	`);
	expect(errors.some((e) => e.message.includes("type bindings expose .name"))).toBe(true);
});

test("an empty attribute set generates nothing", () => {
	const body = `
		pub struct Plain {
			pub var x = 0
		}
		#for t of META.types_with("nothing_has_this") {
			pub func f_#{t.name} = (out int) { return 0 }
		}
		func probe = (out int) {
			return 1
		}
	`;
	expect(compile_module(body)).toEqual([]);
});
