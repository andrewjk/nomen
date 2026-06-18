import fs from "node:fs";
import path from "node:path";

import * as vscode from "vscode";

import { get_library } from "../../src/lib.ts";
import type { Library } from "../../src/lib.ts";
import parse from "../../src/parse.ts";
import type CompileError from "../../src/types/CompileError.ts";

const ECHO_LANGUAGE = "echo";
const TERMINAL_NAME = "Echo";
const DEBOUNCE_MS = 350;

// Matches `func main` at the start of a line, optionally preceded by `pub`.
const MAIN_FUNC = /^\s*(?:pub\s+)?func\s+main\b/;

let terminal: vscode.Terminal | undefined;
let diagnostics: vscode.DiagnosticCollection;

const library_cache = new Map<string, Library>();
const debounce_timers = new Map<string, ReturnType<typeof setTimeout>>();

export function activate(context: vscode.ExtensionContext): void {
	terminal = undefined;
	diagnostics = vscode.languages.createDiagnosticCollection("echo");

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			{ language: ECHO_LANGUAGE },
			new EchoCodeLensProvider(),
		),
		vscode.commands.registerCommand("echo.run", (uri?: vscode.Uri) => runEcho(uri, false)),
		vscode.commands.registerCommand("echo.audit", (uri?: vscode.Uri) => runEcho(uri, true)),
		vscode.window.onDidCloseTerminal((t) => {
			if (t === terminal) terminal = undefined;
		}),
		diagnostics,
		vscode.workspace.onDidOpenTextDocument(maybe_update_diagnostics),
		vscode.workspace.onDidSaveTextDocument(maybe_update_diagnostics),
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor) maybe_update_diagnostics(editor.document);
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (diagnostics_mode() !== "onType") return;
			schedule_diagnostics(event.document, DEBOUNCE_MS);
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			diagnostics.delete(document.uri);
			clear_timer(document.uri);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("echo.diagnostics")) {
				for (const doc of vscode.workspace.textDocuments) maybe_update_diagnostics(doc);
			}
		}),
	);

	for (const doc of vscode.workspace.textDocuments) maybe_update_diagnostics(doc);
}

export function deactivate(): void {
	terminal = undefined;
}

class EchoCodeLensProvider implements vscode.CodeLensProvider {
	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const lenses: vscode.CodeLens[] = [];
		for (let i = 0; i < document.lineCount; i++) {
			const line = document.lineAt(i);
			if (MAIN_FUNC.test(line.text)) {
				const range = new vscode.Range(i, 0, i, line.text.length);
				lenses.push(
					new vscode.CodeLens(range, {
						title: "Run",
						command: "echo.run",
						arguments: [document.uri],
					}),
					new vscode.CodeLens(range, {
						title: "Audit",
						command: "echo.audit",
						arguments: [document.uri],
					}),
				);
			}
		}
		return lenses;
	}
}

async function runEcho(uri: vscode.Uri | undefined, audit: boolean): Promise<void> {
	const document = resolveDocument(uri);
	if (!document) {
		vscode.window.showErrorMessage("Echo: No active Echo file to run.");
		return;
	}

	if (get_config("saveBeforeRun", true)) {
		await document.save();
	}

	const executable = resolve_executable(document.uri);
	const arch = get_config<"aarch64" | "c">("arch", "aarch64");
	const file_arg = shell_quote(document.uri.fsPath);
	const flags = ["--in", file_arg, "--arch", arch];
	if (audit) {
		flags.push("--audit");
		const runtime = resolve_audit_runtime(document.uri);
		if (runtime) flags.push("--audit-runtime", shell_quote(runtime));
	}

	const command = `${executable} ${flags.join(" ")}`;

	const term = get_terminal();
	term.show(true);
	term.sendText(command);
}

function resolveDocument(uri: vscode.Uri | undefined): vscode.TextDocument | undefined {
	if (uri) {
		const found = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		if (found) return found;
	}
	return vscode.window.activeTextEditor?.document;
}

function resolve_executable(uri: vscode.Uri): string {
	const workspace_folder = workspace_folder_of(uri);

	const setting = get_config<string>("executable", "lang").trim();
	if (setting && setting !== "lang") {
		return substitute_workspace(setting, workspace_folder);
	}

	if (workspace_folder) {
		const candidate = path.join(workspace_folder, "bin", "dist", "index.mjs");
		if (fs.existsSync(candidate)) {
			return `node ${shell_quote(candidate)}`;
		}
	}

	return "lang";
}

function resolve_audit_runtime(uri: vscode.Uri): string | undefined {
	const workspace_folder = workspace_folder_of(uri);

	const setting = get_config<string>("auditRuntime", "").trim();
	if (setting) {
		const resolved = substitute_workspace(setting, workspace_folder);
		return fs.existsSync(resolved) ? resolved : undefined;
	}

	if (workspace_folder) {
		const candidate = path.join(workspace_folder, "src", "audit_runtime.c");
		if (fs.existsSync(candidate)) return candidate;
	}

	return undefined;
}

function workspace_folder_of(uri: vscode.Uri): string {
	return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? "";
}

function substitute_workspace(value: string, workspace_folder: string): string {
	return value
		.split("${workspaceFolder}")
		.join(workspace_folder)
		.split("$workspaceFolder")
		.join(workspace_folder);
}

function get_terminal(): vscode.Terminal {
	const mode = get_config<"dedicated" | "new">("terminal", "dedicated");
	if (mode === "dedicated" && terminal) {
		return terminal;
	}
	const term = vscode.window.createTerminal(TERMINAL_NAME);
	if (mode === "dedicated") {
		terminal = term;
	}
	return term;
}

function get_config<T>(key: string, fallback: T): T {
	const value = vscode.workspace.getConfiguration("echo").get<T>(key);
	return value === undefined ? fallback : value;
}

function shell_quote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// --- Diagnostics -------------------------------------------------------------

function diagnostics_mode(): "onType" | "onSave" | "off" {
	return get_config<"onType" | "onSave" | "off">("diagnostics", "onType");
}

function is_echo(document: vscode.TextDocument): boolean {
	return document.languageId === ECHO_LANGUAGE;
}

function maybe_update_diagnostics(document: vscode.TextDocument): void {
	if (diagnostics_mode() === "off") {
		diagnostics.delete(document.uri);
		return;
	}
	if (is_echo(document)) update_diagnostics(document);
}

function schedule_diagnostics(document: vscode.TextDocument, delay: number): void {
	if (!is_echo(document)) return;
	const key = document.uri.toString();
	const existing = debounce_timers.get(key);
	if (existing) clearTimeout(existing);
	debounce_timers.set(
		key,
		setTimeout(() => {
			debounce_timers.delete(key);
			update_diagnostics(document);
		}, delay),
	);
}

function clear_timer(uri: vscode.Uri): void {
	const timer = debounce_timers.get(uri.toString());
	if (timer) {
		clearTimeout(timer);
		debounce_timers.delete(uri.toString());
	}
}

function update_diagnostics(document: vscode.TextDocument): void {
	if (!is_echo(document)) return;

	const text = document.getText();
	const library = load_library(document.uri);

	let errors: CompileError[];
	try {
		errors = parse(text, library).errors;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		diagnostics.set(document.uri, [
			new vscode.Diagnostic(zero_range(), `Echo: ${message}`, vscode.DiagnosticSeverity.Error),
		]);
		return;
	}

	const in_file = errors.filter((e) => e.start >= 0 && e.start < text.length);
	const diags = in_file.map(
		(e) =>
			new vscode.Diagnostic(
				error_range(document, text, e.start),
				e.message,
				vscode.DiagnosticSeverity.Error,
			),
	);
	diagnostics.set(document.uri, diags);
}

function load_library(uri: vscode.Uri): Library | undefined {
	const lib_dir = resolve_lib_dir(uri);
	if (!lib_dir) return undefined;
	const cached = library_cache.get(lib_dir);
	if (cached) return cached;
	try {
		const library = get_library(lib_dir);
		library_cache.set(lib_dir, library);
		return library;
	} catch {
		return undefined;
	}
}

function resolve_lib_dir(uri: vscode.Uri): string | undefined {
	let dir = path.dirname(uri.fsPath);
	for (let i = 0; i < 20; i++) {
		const config_path = path.join(dir, "package.jsonc");
		if (fs.existsSync(config_path)) {
			try {
				const raw = fs
					.readFileSync(config_path, "utf8")
					.replace(/\/\/.*$/gm, "")
					.replace(/\/\*[\s\S]*?\*\//g, "");
				const parsed = JSON.parse(raw);
				if (parsed.imports?.System) return path.resolve(dir, parsed.imports.System);
			} catch {
				// ignore malformed package.jsonc and keep searching
			}
		}
		// Also check for a `core/` directory at this level (the standard library itself).
		const lib_config = path.join(dir, "core", "package.jsonc");
		if (fs.existsSync(lib_config)) return path.join(dir, "core");
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	const workspace_folder = workspace_folder_of(uri);
	if (workspace_folder) {
		const fallback = path.join(workspace_folder, "core");
		if (fs.existsSync(path.join(fallback, "package.jsonc"))) return fallback;
	}
	return undefined;
}

function error_range(document: vscode.TextDocument, text: string, start: number): vscode.Range {
	let end = start;
	while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++;
	if (end === start && start < text.length) end = start + 1;
	return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function zero_range(): vscode.Range {
	const position = new vscode.Position(0, 0);
	return new vscode.Range(position, position);
}
