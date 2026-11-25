import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { start_server } from "../src/server.ts";
import LspClient from "./lsp_client.ts";

// Drives the Nomen language server over JSON-RPC exactly as an editor would:
// Content-Length framed messages on a pair of byte streams. The server runs
// in-process for speed; cli/test/lsp_command.test.ts spawns the real
// `nomen lsp` command.

const SOURCE = `import System

struct Point {
	var int x
	var int y

	/** The sum of both coordinates. */
	pub func total = (ref self, out int) {
		return self.x + self.y
	}
}

pub func main = (Init init) {
	var p = Point(2, 3)
	Console.write("\\{p.total()}\\n")
}
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-lsp-"));
const file = path.join(dir, "main.nm");
const uri = pathToFileURL(file).href;
fs.writeFileSync(file, SOURCE);

let client: LspClient;
let dispose: () => void;
let first_diagnostics: any;
let init_result: any;

const at = (line: number, character: number) => ({
	textDocument: { uri },
	position: { line, character },
});

beforeAll(async () => {
	const to_server = new PassThrough();
	const from_server = new PassThrough();
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const connection = start_server(to_server, from_server, {
		bundled_lib_dir: path.join(repo, "core"),
	});
	dispose = () => connection.dispose();
	client = new LspClient(from_server, to_server);
	client.settings = { diagnostics: "onType", format: { force: false } };

	init_result = await client.request("initialize", {
		processId: null,
		rootUri: pathToFileURL(dir).href,
		capabilities: {
			workspace: { configuration: true },
			textDocument: { completion: { completionItem: { snippetSupport: true } } },
		},
		initializationOptions: { runCommands: true },
	});
	client.notify("initialized", {});
	client.notify("textDocument/didOpen", {
		textDocument: { uri, languageId: "nomen", version: 1, text: SOURCE },
	});
	first_diagnostics = await client.wait_for(
		"textDocument/publishDiagnostics",
		(p) => p.uri === uri && p.version === 1,
	);
});

afterAll(() => {
	dispose();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("initialize advertises every feature", async () => {
	expect(init_result.serverInfo.name).toBe("nomen");
	const caps = init_result.capabilities;
	expect(caps.hoverProvider).toBe(true);
	expect(caps.definitionProvider).toBe(true);
	expect(caps.referencesProvider).toBe(true);
	expect(caps.documentFormattingProvider).toBe(true);
	expect(caps.completionProvider.triggerCharacters).toEqual(["."]);
	expect(caps.codeActionProvider.codeActionKinds).toEqual(["quickfix"]);
	expect(caps.codeLensProvider).toBeDefined();
	expect(caps.executeCommandProvider.commands).toEqual(["nomen.server.forceFormat"]);
});

test("open publishes lint warnings", () => {
	// `ref self` on a method that never mutates is a warning with a quick fix.
	const messages = first_diagnostics.diagnostics.map((d: any) => d.message);
	expect(messages).toContain(
		"Method receiver 'self' is never mutated — use bare 'self' instead of 'ref self'",
	);
	for (const d of first_diagnostics.diagnostics) expect(d.severity).toBe(2);
});

test("hover shows the signature and doc comment", async () => {
	const hover = await client.request("textDocument/hover", at(14, 22));
	expect(hover.contents.kind).toBe("markdown");
	expect(hover.contents.value).toContain("pub func total = (ref self, out int)");
	expect(hover.contents.value).toContain("_method of `Point`_");
	expect(hover.contents.value).toContain("The sum of both coordinates.");
	expect(hover.range).toEqual({
		start: { line: 14, character: 20 },
		end: { line: 14, character: 25 },
	});
});

test("hover on whitespace is null", async () => {
	expect(await client.request("textDocument/hover", at(1, 0))).toBeNull();
});

test("definition jumps to the declaration", async () => {
	const location = await client.request("textDocument/definition", at(14, 22));
	expect(location).toEqual({
		uri,
		range: { start: { line: 7, character: 10 }, end: { line: 7, character: 15 } },
	});
});

test("definition into the System library maps back to its file", async () => {
	// `Point` → this file; `Console` lives in core/.
	const location = await client.request("textDocument/definition", at(14, 3));
	expect(location).not.toBeNull();
	const target = fileURLToPath(location.uri);
	expect(target).not.toBe(file);
	expect(fs.existsSync(target)).toBe(true);
	const lines = fs.readFileSync(target, "utf8").split("\n");
	expect(lines[location.range.start.line].slice(location.range.start.character)).toMatch(
		/^Console\b/,
	);
});

test("references include the declaration on request", async () => {
	const with_decl = await client.request("textDocument/references", {
		...at(7, 11),
		context: { includeDeclaration: true },
	});
	expect(with_decl.map((l: any) => l.range.start)).toEqual([
		{ line: 7, character: 10 },
		{ line: 14, character: 20 },
	]);
	const without = await client.request("textDocument/references", {
		...at(7, 11),
		context: { includeDeclaration: false },
	});
	expect(without).toHaveLength(1);
});

test("code action applies the quick fix", async () => {
	const diagnostic = first_diagnostics.diagnostics.find((d: any) =>
		d.message.startsWith("Method receiver 'self' is never mutated"),
	);
	const actions = await client.request("textDocument/codeAction", {
		textDocument: { uri },
		range: diagnostic.range,
		context: { diagnostics: [diagnostic] },
	});
	expect(actions).toHaveLength(1);
	expect(actions[0].kind).toBe("quickfix");
	expect(actions[0].isPreferred).toBe(true);
	const edits = actions[0].edit.changes[uri];
	expect(edits).toHaveLength(1);
});

test("code lenses offer Run and Audit above main", async () => {
	const lenses = await client.request("textDocument/codeLens", { textDocument: { uri } });
	expect(lenses.map((l: any) => l.command.title)).toEqual(["Run", "Audit"]);
	expect(lenses[0].range.start.line).toBe(12);
	expect(lenses[0].command).toEqual({ title: "Run", command: "nomen.run", arguments: [uri] });
});

test("formatting a tidy file is a no-op", async () => {
	const edits = await client.request("textDocument/formatting", {
		textDocument: { uri },
		options: { tabSize: 4, insertSpaces: false },
	});
	expect(edits).toEqual([]);
});

test("completion lists members after a dot (and diagnostics follow edits)", async () => {
	// Insert `p.` on a new line inside main (after `var p = …`): the parse
	// breaks, so completion falls back to the last clean analysis.
	client.notify("textDocument/didChange", {
		textDocument: { uri, version: 2 },
		contentChanges: [
			{
				range: { start: { line: 13, character: 20 }, end: { line: 13, character: 20 } },
				text: "\n\tp.",
			},
		],
	});
	const items = await client.request("textDocument/completion", at(14, 3));
	const labels = items.map((i: any) => i.label);
	expect(labels).toContain("x");
	expect(labels).toContain("y");
	expect(labels).toContain("total");
	const total = items.find((i: any) => i.label === "total");
	expect(total.kind).toBe(2); // Method
	expect(total.insertText).toBe("total($0)");
	expect(total.insertTextFormat).toBe(2); // Snippet
	expect(total.documentation.value).toContain("The sum of both coordinates.");

	// The debounced onType diagnostics arrive for the edited version.
	const diags = await client.wait_for(
		"textDocument/publishDiagnostics",
		(p) => p.uri === uri && p.version === 2,
	);
	expect(diags.uri).toBe(uri);
});

test("formatting re-indents, and force-format applies via executeCommand", async () => {
	const messy = 'pub func main = (Init init) {\nconst x = 1\n  Console.write("\\{x}")\n}\n';
	const messy_uri = pathToFileURL(path.join(dir, "messy.nm")).href;
	client.notify("textDocument/didOpen", {
		textDocument: { uri: messy_uri, languageId: "nomen", version: 1, text: messy },
	});
	const edits = await client.request("textDocument/formatting", {
		textDocument: { uri: messy_uri },
		options: { tabSize: 4, insertSpaces: false },
	});
	expect(edits).toHaveLength(1);
	expect(edits[0].newText).toContain("\n\tconst x = 1\n\tConsole.write");

	await client.request("workspace/executeCommand", {
		command: "nomen.server.forceFormat",
		arguments: [messy_uri],
	});
	expect(client.applied_edits).toHaveLength(1);
	expect(client.applied_edits[0].changes[messy_uri][0].newText).toBe(edits[0].newText);
	client.notify("textDocument/didClose", { textDocument: { uri: messy_uri } });
	const cleared = await client.wait_for(
		"textDocument/publishDiagnostics",
		(p) => p.uri === messy_uri && p.diagnostics.length === 0 && p.version === undefined,
	);
	expect(cleared.diagnostics).toEqual([]);
});

test("diagnostics can be switched off via configuration", async () => {
	client.settings = { diagnostics: "off" };
	const before = client.notifications.length;
	client.notify("workspace/didChangeConfiguration", { settings: {} });
	const p = await client.wait_for(
		"textDocument/publishDiagnostics",
		(n) => n.uri === uri && client.notifications.length > before && n.diagnostics.length === 0,
	);
	expect(p.diagnostics).toEqual([]);
	client.settings = { diagnostics: "onType" };
});
