import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// The C backend's if/else and switch builders saved the pre-branch
// `heap_string_fields` set BY REFERENCE, but value-struct field stores
// record via in-place `.add()` — so the then branch's record bled into the
// "pre" set, and the else branch's store emitted `free(field.ptr)` on the
// struct's still-unassigned zero-initialized `""` default (free of a
// non-heap pointer → SIGABRT, exit 134, no output). Both builders now hand
// each branch a copy (mirroring the aarch64 backend), and the join keeps
// the union. The class form was already covered (branch_string_field_store)
// — class targets never record, so only this value-struct shape regressed.
// This is also the allmark port's `sanitize_commit_attribute` shape: a
// local struct field stored in both arms (one a call result, one a borrowed
// param) and the struct then pushed into a List.

const Defs = `
struct Attr {
	var name = ""
	var value = ""
}

class Node {
	var attributes = List<Attr>()
}

func owned_of = (string text, move out string) {
	return text.to_string()
}

func has_attribute = (Node node, string name, out bool) {
	var i = 0
	while i < node.attributes.length; i += 1 {
		var a = node.attributes.at_or_panic(i)
		if a.name == name {
			return true
		}
	}
	return false
}

func commit = (ref Node holder, string attr_name, string raw_value, bool needs_decode) {
	if !has_attribute(holder, attr_name) {
		var attr = Attr()
		attr.name = attr_name
		if needs_decode {
			attr.value = owned_of(raw_value)
		} else {
			attr.value = raw_value
		}
		holder.attributes.push(move attr)
	}
}
`;

test("if/else: direct store into a local value-struct field in both arms", async () => {
	const input = `
import System

${Defs}

pub func main = (Init init) {
	var n = Node()
	commit(ref n, "href", "https://x", false)
	Console.write("[0]\\{n.attributes.at_or_panic(0).value}\\n")
	commit(ref n, "alt", "a&b", true)
	Console.write("[1]\\{n.attributes.at_or_panic(1).value}\\n")
}
`;
	await build_and_check_output(
		input,
		"branch_value_struct_field_store",
		"[0]https://x\n[1]a&b\n",
		true,
	);
});

test("switch: direct store into a local value-struct field across cases", async () => {
	const input = `
import System

struct Pair {
	var a = ""
}

func owned_of = (string text, move out string) {
	return text.to_string()
}

func commit = (ref List<Pair> sink, string raw, int mode) {
	var p = Pair()
	switch {
		case mode == 0 {
			p.a = owned_of(raw)
		}
		case mode == 1 {
			p.a = raw
		}
		else {
			p.a = "other"
		}
	}
	sink.push(move p)
}

pub func main = (Init init) {
	var pairs = List<Pair>()
	commit(ref pairs, "zero", 0)
	Console.write("[0]\\{pairs.at_or_panic(0).a}\\n")
	commit(ref pairs, "one", 1)
	Console.write("[1]\\{pairs.at_or_panic(1).a}\\n")
	commit(ref pairs, "x", 2)
	Console.write("[2]\\{pairs.at_or_panic(2).a}\\n")
}
`;
	await build_and_check_output(
		input,
		"branch_value_struct_field_store_switch",
		"[0]zero\n[1]one\n[2]other\n",
		true,
	);
});
