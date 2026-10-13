import path from "node:path";

import { expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

const lib = get_library(path.resolve(import.meta.dirname, "../core"));

// A struct with a `view string` field is a scope-local bundle: it cannot be
// stored into a generic container (a push/set is a call boundary, and the
// container outlives the borrow source). These encode the rejection; the
// zero-copy record pattern over a long-lived buffer is expressed with
// (start, length) integers + re-slicing instead.

function errors(src: string) {
	return parse(src, lib).errors.map((e) => `${e.message}`);
}

test("pushing a view-carrying struct into a List is rejected", () => {
	const input = `
import System

pub struct VLine {
	var view string text
	var start = 0
}

pub mv struct Doc {
	var text = ""
	pub func lines = (ref self, out List<VLine>) {
		var List<VLine> result = List<VLine>()
		view txt = self.text.slice(0, self.text.length)
		if txt.length >= 2 {
			view first = txt.slice(0, 2)
			var l = VLine(first)
			l.start = 0
			result.push(mv l)
		}
		return result
	}
}

var d = Doc()
`;
	expect(errors(input).some((m) => m.includes("scope-local"))).toBe(true);
});

// The sanctioned zero-copy record pattern: store (start, length) integers
// over a long-lived buffer and re-slice on use. Under the boundary rules the
// records provably cannot outlive the source, so this needs no runtime
// identity check — the scope is the guarantee.
test("many records over one buffer via (start, length) pairs", async () => {
	const input = `
pub struct Span {
	var int start
	var int length
}

pub mv struct Doc {
	var text = ""
	pub func words = (ref self, out List<Span>) {
		var List<Span> result = List<Span>()
		var int i = 0
		var int start = -1
		while i < self.text.length; i += 1 {
			switch {
				case self.text.at(i) == ' ' {
					if start >= 0 {
						result.push(Span(start, i - start))
						start = -1
					}
				}
				case start < 0 {
					start = i
				}
			}
		}
		if start >= 0 {
			result.push(Span(start, self.text.length - start))
		}
		return result
	}
	pub func slice_of = (ref self, Span s, out view string) {
		var int start = s.start
		var int end = s.start + s.length
		if start >= 0 && start <= self.text.length && end >= start && end <= self.text.length {
			return self.text.slice(start, end)
		}
		panic("span out of range")
	}
}

var d = Doc()
d.text = "aa bb cc"
const spans = d.words()
Console.write("\\{spans.length} ")
var int i = 0
while i < spans.length {
	Console.write(d.slice_of(spans.at(i)).to_string())
	i += 1
}
`;
	await build_and_check_output(input, "view_span_records", "3 aabbcc");
});

// A guarded slice straight off a `self` field — no length local: bounds
// must propagate through the `self.` field path.
test("guarded slice of self field verifies", async () => {
	const input = `
pub mv struct Doc {
	var text = ""
	pub func first_two = (ref self, out string) {
		if self.text.length >= 2 {
			view first = self.text.slice(0, 2)
			return first.to_string()
		}
		return ""
	}
}

var d = Doc()
d.text = "hi\\n"
Console.write(d.first_two())
`;
	await build_and_check_output(input, "view_guarded_self_field_slice", "hi");
});
