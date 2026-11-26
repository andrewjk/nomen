import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { parse_args } from "../cli/src/args.ts";
import { collect_docs, run_docs } from "../cli/src/docs.ts";
import parse from "../src/parse.ts";

// A tiny library: package.jsonc with `exports`, one root file and one nested
// namespace, so namespaces and the library-mode file walk are exercised.
function make_library(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-docs-"));
	fs.writeFileSync(
		path.join(dir, "package.jsonc"),
		'{ "name": "Lib", "exports": ["./Lib/*", "./Lib/Text/*"] }',
	);
	fs.mkdirSync(path.join(dir, "Lib", "Text"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "Lib", "Stack.nm"),
		`/**
 * A last-in, first-out stack
 **/
pub mv struct Stack<T>: Countable {
	var length = 0
	internal var secret = 0

	/** Push a value on top */
	pub func push = (
		ref self,
		mv T value,
	) {
		self.length += 1
	}

	/**
	 * How many values the stack
	 * holds.
	 *
	 * Constant time.
	 **/
	pub inline func count = (self, out int) {
		return self.length
	}

	pub func empty = (out Stack<T>) {
		return Stack<T>()
	}

	func #destroy = (self) { }
}

/** Something countable */
pub trait Countable {
	func count = (self, out int)
}

/** A choice */
pub enum Pick<T> {
	/** Exactly one value **/
	case one(T value)
	case none
}

pub func helper = (int a, out int) {
	return a // the result
}

/** The answer */
pub const ANSWER = 42 // not part of the signature

func private_helper = () { }

/** File permissions */
pub bitset Perm {
	/** May read **/
	case read
	case write
}
`,
	);
	fs.writeFileSync(
		path.join(dir, "Lib", "Text", "Words.nm"),
		`/** Word utilities **/
pub struct Words {
	pub func count = (string s, out int) {
		return 0
	}
}
`,
	);
	return dir;
}

describe("nomen docs", () => {
	test("collects a structured model of pub declarations", () => {
		const dir = make_library();
		try {
			const model = collect_docs(dir);
			const names = model.entries.map((e) => `${e.namespace}::${e.name}`);
			expect(names).toEqual([
				"Lib::Stack",
				"Lib::Countable",
				"Lib::Pick",
				"Lib::helper",
				"Lib::ANSWER",
				"Lib::Perm",
				"Lib::Text::Words",
			]);

			const stack = model.entries[0];
			expect(stack).toMatchObject({
				kind: "struct",
				file: "Lib/Stack.nm",
				line: 4,
				signature: "mv struct Stack<T>: Countable",
				doc: "A last-in, first-out stack",
				type_params: ["T"],
				traits: ["Countable"],
			});
			// Multi-line parameter lists fold onto one line; `pub`/`inline`
			// drop; internal members and `#destroy` are left out.
			expect(stack.members.map((m) => [m.kind, m.signature, m.doc])).toEqual([
				["field", "var length = 0", undefined],
				["method", "func push = (ref self, mv T value)", "Push a value on top"],
				[
					"method",
					"func count = (self, out int)",
					"How many values the stack\nholds.\n\nConstant time.",
				],
				["static", "func empty = (out Stack<T>)", undefined],
			]);

			const pick = model.entries[2];
			// A case takes its own doc comment; an undocumented case after it
			// doesn't inherit it (nor the enum's).
			expect(pick.members.map((m) => [m.signature, m.doc, m.line])).toEqual([
				["case one(T value)", "Exactly one value", 41],
				["case none", undefined, 42],
			]);
			expect(model.entries[3].signature).toBe("func helper = (int a, out int)");
			expect(model.entries[4].signature).toBe("const ANSWER = 42");
			// Bitset flags take docs the same way.
			expect(model.entries[5].members.map((m) => [m.signature, m.doc, m.line])).toEqual([
				["case read", "May read", 57],
				["case write", undefined, 58],
			]);
			expect(model.entries[6].members[0]).toMatchObject({
				kind: "static",
				signature: "func count = (string s, out int)",
			});
			expect(model.warnings).toEqual(["func `helper` has no doc comment (Stack.nm:45)"]);
		} finally {
			fs.rmSync(dir, { recursive: true });
		}
	});

	test("writes markdown, and api.json with --json", () => {
		const dir = make_library();
		const log = console.log;
		console.log = () => {};
		try {
			run_docs(dir, { json: true });
			const md = fs.readFileSync(path.join(dir, "docs", "Lib", "Stack.md"), "utf8");
			expect(md).toContain("## `mv struct Stack<T>: Countable`");
			expect(md).toContain("- `func push = (ref self, mv T value)` — Push a value on top");
			// A wrapped doc's first paragraph, joined onto one line.
			expect(md).toContain("- `func count = (self, out int)` — How many values the stack holds.\n");
			expect(md).toContain("- `case one(T value)` — Exactly one value");
			expect(fs.existsSync(path.join(dir, "docs", "Lib", "Text", "Words.md"))).toBe(true);
			const json = JSON.parse(fs.readFileSync(path.join(dir, "docs", "api.json"), "utf8"));
			expect(json.entries).toHaveLength(7);
		} finally {
			console.log = log;
			fs.rmSync(dir, { recursive: true });
		}
	});

	test("--json is a boolean option", () => {
		expect(parse_args(["docs", "--json"]).json).toBe(true);
		expect(parse_args(["docs"]).json).toBe(false);
	});

	test("doc comments attach across modifiers and attributes", () => {
		const source = `/** A list **/
pub mv struct List<T> {
	var length = 0
}

/** Tagged **/
@table("t")
pub struct Row {
	/** The id **/
	pub var id = 0
}

/** Stray **/
const X = 1
pub struct NoDoc { }
`;
		const statements = parse(source).root.statements as unknown as { doc?: string }[];
		expect(statements.map((s) => s.doc)).toEqual(["A list", "Tagged", "Stray", undefined]);
	});
});
