import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `x.field = <borrowed param>` inside an if/else (or switch) whose OTHER
// branch makes a call used to SIGABRT (both backends): heap_string_fields
// records are per-path facts, but the else branch inherited the then
// branch's records (linear build order), so its store freed the displaced
// value as heap while it was still the freshly constructed literal —
// "pointer being freed was not allocated". Exclusive branches now start
// from the pre-branch records; the join keeps the union.

describe("exclusive-branch string field stores", () => {
	test("class field store in else, call in if", async () => {
		const input = `
import System

class Pair {
	var a = ""
}

func decorated = (string v, move out string) {
	return "[" + v + "]"
}

func commit = (ref Pair pair, string raw) {
	if raw.length > 2 {
		pair.a = decorated(raw)
	} else {
		pair.a = raw
	}
}

pub func main = (Init init) {
	var short = Pair()
	commit(ref short, "x")
	Console.write("short a=\\{short.a}\\n")
	var long = Pair()
	commit(ref long, "hello")
	Console.write("long a=\\{long.a}\\n")
}
`;
		await build_and_check_output(
			input,
			"branch_field_store_else",
			"short a=x\nlong a=[hello]\n",
			true,
		);
	});

	test("class field store across switch cases", async () => {
		const input = `
import System

class Pair {
	var a = ""
}

func decorated = (string v, move out string) {
	return "[" + v + "]"
}

func pick = (ref Pair pair, int which, string raw) {
	switch {
		case which == 1 {
			pair.a = raw
		}
		case which == 2 {
			pair.a = decorated(raw)
		}
		else {
			pair.a = "default"
		}
	}
}

pub func main = (Init init) {
	var one = Pair()
	pick(ref one, 1, "ab")
	Console.write("one a=\\{one.a}\\n")
	var two = Pair()
	pick(ref two, 2, "ab")
	Console.write("two a=\\{two.a}\\n")
	var three = Pair()
	pick(ref three, 3, "ab")
	Console.write("three a=\\{three.a}\\n")
}
`;
		await build_and_check_output(
			input,
			"switch_field_store",
			"one a=ab\ntwo a=[ab]\nthree a=default\n",
			true,
		);
	});
});
