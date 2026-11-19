import { expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { compile_module } from "./spec/_helpers.ts";

// Stage-6 iterable: enum cases. Two halves — `META.info(E).cases` as a
// `#for` iterable (generate per-case members anywhere), and `#for` inside
// an enum body generating the enum's own cases (`case #{c.name}`).

test("enum cases iterate at file scope — one generated function per case", async () => {
	await build_and_check_output(
		`
import System

pub enum Shape {
	case circle
	case square
}

#for c of META.info(Shape).cases {
	pub func describe_#{c.name} = (out string) {
		return "shape: " + c.name
	}
}

pub func main = () {
	Console.write_line(describe_circle())
	Console.write_line(describe_square())
}
`,
		"comptime_enum_cases",
		"shape: circle\nshape: square\n",
		true,
		{ js: true },
	);
});

test("an enum body generates cases from another enum plus an #if-selected case", async () => {
	await build_and_check_output(
		`
import System

pub enum Shape {
	case circle
	case square
}

pub enum Mirrored {
	#for c of META.info(Shape).cases {
		case #{c.name}
	}
	#if META.arch == "js" || META.arch == "c" || META.arch == "aarch64" {
		case extra
	}
}

pub func main = () {
	var a = Mirrored.circle
	var b = Mirrored.square
	var c = Mirrored.extra
	match a {
		case .circle -> Console.write_line("circle")
		case .square -> Console.write_line("square")
		case .extra -> Console.write_line("extra")
	}
	Console.write_line("\\{a == b}")
}
`,
		"comptime_enum_generate",
		"circle\nfalse\n",
		true,
		{ js: true },
	);
});

test("cases iterate over another enum's cases inside an enum body", async () => {
	await build_and_check_output(
		`
import System

pub enum Source {
	case alpha
	case beta
}

pub enum Copy {
	#for c of META.info(Source).cases {
		case #{c.name}
	}
}

pub func main = () {
	var v = Copy.beta
	match v {
		case .alpha -> Console.write_line("a")
		case .beta -> Console.write_line("b")
	}
}
`,
		"comptime_enum_copy",
		"b\n",
		true,
		{ js: true },
	);
});

test(".cases over a non-enum errors", () => {
	const errors = compile_module(`
		pub struct NotAnEnum {
			pub var x = 0
		}
		#for c of META.info(NotAnEnum).cases {
			pub func f_#{c.name} = (out int) { return 0 }
		}
	`);
	expect(errors.some((e) => e.message.includes("unknown enum 'NotAnEnum'"))).toBe(true);
});

test("case bindings expose .name only", () => {
	const errors = compile_module(`
		pub enum Shape {
			case circle
		}
		#for c of META.info(Shape).cases {
			pub func f = (out string) { return c.type.name }
		}
	`);
	expect(errors.some((e) => e.message.includes("case bindings expose .name"))).toBe(true);
});

test("a #if-selected case needs a literal name", () => {
	const errors = compile_module(`
		pub enum Shape {
			case circle
		}
		pub enum Bad {
			#if 1 == 1 {
				case #{shape_name}
			}
		}
	`);
	expect(errors.some((e) => e.message.includes("a #if-selected case needs a literal name"))).toBe(
		true,
	);
});

test("a case outside an enum body is a loud error", () => {
	const errors = compile_module(`
		func f = () {
			case stray
		}
	`);
	expect(
		errors.some((e) => e.message.includes("case declarations belong inside enum bodies")),
	).toBe(true);
});
