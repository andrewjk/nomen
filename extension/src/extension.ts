import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import * as vscode from "vscode";

import { forget_document, get_analysis, invalidate_all } from "./documents.ts";
import {
	bundled_lib_completed,
	resolve_lib_dir,
	set_bundled_lib_dir,
	workspace_folder_of,
} from "./library.ts";
import {
	NomenCompletionProvider,
	NomenDefinitionProvider,
	NomenDocumentFormattingProvider,
	NomenHoverProvider,
	NomenReferenceProvider,
	format_edits,
} from "./providers.ts";

const ECHO_LANGUAGE = "nomen";
const TERMINAL_NAME = "Nomen";
const DEBOUNCE_MS = 350;

// Matches `func main` at the start of a line, optionally preceded by `pub`.
const MAIN_FUNC = /^\s*(?:pub\s+)?func\s+main\b/;

let terminal: vscode.Terminal | undefined;
let diagnostics: vscode.DiagnosticCollection;

const debounce_timers = new Map<string, ReturnType<typeof setTimeout>>();

export function activate(context: vscode.ExtensionContext): void {
	terminal = undefined;
	diagnostics = vscode.languages.createDiagnosticCollection("nomen");

	const selector = { language: ECHO_LANGUAGE };

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(selector, new NomenCodeLensProvider()),
		vscode.languages.registerHoverProvider(selector, new NomenHoverProvider()),
		vscode.languages.registerDefinitionProvider(selector, new NomenDefinitionProvider()),
		vscode.languages.registerReferenceProvider(selector, new NomenReferenceProvider()),
		vscode.languages.registerDocumentFormattingEditProvider(
			selector,
			new NomenDocumentFormattingProvider(),
		),
		vscode.languages.registerCompletionItemProvider(selector, new NomenCompletionProvider(), "."),
		vscode.commands.registerCommand("nomen.run", (uri?: vscode.Uri) => runNomen(uri, false)),
		vscode.commands.registerCommand("nomen.audit", (uri?: vscode.Uri) => runNomen(uri, true)),
		vscode.commands.registerCommand("nomen.format.force", () => forceFormat()),
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
			forget_document(document.uri);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("nomen.diagnostics")) {
				for (const doc of vscode.workspace.textDocuments) maybe_update_diagnostics(doc);
			}
		}),
	);

	for (const doc of vscode.workspace.textDocuments) maybe_update_diagnostics(doc);

	// Locate the System library bundled with the CLI, so editor features
	// (completion, hover, diagnostics) work for projects without a local
	// `core/`. Deferred so we don't block activation; the error fires once.
	setTimeout(discover_bundled_lib, 0);
}

export function deactivate(): void {
	terminal = undefined;
}

// Run `nomen lib-path` to find the System library bundled with the CLI. If
// the CLI isn't installed (or the lookup fails), surface a one-time error so
// the user knows editor features will be limited.
function discover_bundled_lib(): void {
	resolve_shell_path();
	const dummy_uri = vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.file("/");
	const executable = resolve_executable(dummy_uri);
	let found = false;
	try {
		const result = execSync(`${executable} lib-path`, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
		// The path is the last non-empty line of output, so older CLIs that
		// print a banner to stdout still resolve correctly.
		const lines = result.split("\n").filter((line) => line.trim().length > 0);
		const lib_dir = lines.length > 0 ? lines[lines.length - 1].trim() : "";
		if (lib_dir && fs.existsSync(path.join(lib_dir, "package.jsonc"))) {
			set_bundled_lib_dir(lib_dir);
			found = true;
		}
	} catch {
		// CLI missing, on PATH under a different name, or errored.
	}
	if (!found) {
		set_bundled_lib_dir(undefined);
		vscode.window.showErrorMessage(
			"Nomen: CLI not found. Editor features (completion, hover, diagnostics) need the Nomen CLI — install it with `npm i -g nomen-lang`.",
		);
	}
	// `maybe_update_diagnostics` held off until the bundled lib lookup
	// finished; the lookup is now complete, so analyze every open document
	// (and drop any pre-lookup cached analyses).
	invalidate_all();
	for (const doc of vscode.workspace.textDocuments) maybe_update_diagnostics(doc);
}

// GUI-launched VS Code on macOS/Linux inherits a minimal PATH that excludes
// installer-specific global bin dirs (npm, pnpm, yarn, bun, volta, fnm, asdf,
// …). Spawn the user's login+interactive shell once and prepend its PATH so
// `nomen` is discoverable regardless of how it was installed.
let shell_path_resolved = false;
function resolve_shell_path(): void {
	if (shell_path_resolved) return;
	shell_path_resolved = true;
	// Windows GUI launches inherit the system PATH (npm's global bin is there
	// by default), so no shell trick is needed.
	if (process.platform === "win32") return;
	const shell = process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
	try {
		// `-i -l` sources both .zprofile/.bash_profile (login) AND .zshrc/.bashrc
		// (interactive) — the latter is where most users add their PATH entries.
		// stdin from /dev/null and stderr suppressed to avoid hangs/noise.
		const result = execSync(`${shell} -i -l -c "echo $PATH"`, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
			env: { ...process.env, TERM: "dumb" },
		}).trim();
		if (result && result !== process.env.PATH) {
			process.env.PATH = result + path.delimiter + (process.env.PATH ?? "");
		}
	} catch {
		// Shell failed or timed out — leave PATH untouched and let the caller
		// surface the "CLI not found" error if applicable.
	}
}

class NomenCodeLensProvider implements vscode.CodeLensProvider {
	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const lenses: vscode.CodeLens[] = [];
		for (let i = 0; i < document.lineCount; i++) {
			const line = document.lineAt(i);
			if (MAIN_FUNC.test(line.text)) {
				const range = new vscode.Range(i, 0, i, line.text.length);
				lenses.push(
					new vscode.CodeLens(range, {
						title: "Run",
						command: "nomen.run",
						arguments: [document.uri],
					}),
					new vscode.CodeLens(range, {
						title: "Audit",
						command: "nomen.audit",
						arguments: [document.uri],
					}),
				);
			}
		}
		return lenses;
	}
}

async function forceFormat(): Promise<void> {
	const document = vscode.window.activeTextEditor?.document;
	if (!document || document.languageId !== ECHO_LANGUAGE) {
		vscode.window.showErrorMessage("Nomen: No active Nomen file to format.");
		return;
	}
	const edits = format_edits(document, true);
	if (!edits.length) return;
	const edit = new vscode.WorkspaceEdit();
	edit.set(document.uri, edits);
	await vscode.workspace.applyEdit(edit);
}

async function runNomen(uri: vscode.Uri | undefined, audit: boolean): Promise<void> {
	const document = resolveDocument(uri);
	if (!document) {
		vscode.window.showErrorMessage("Nomen: No active Nomen file to run.");
		return;
	}

	if (get_config("saveBeforeRun", true)) {
		await document.save();
	}

	const executable = resolve_executable(document.uri);
	const arch = get_config<"aarch64" | "c">("arch", "aarch64");
	const file_arg = shell_quote(document.uri.fsPath);
	const flags = ["run", "--in", file_arg, "--arch", arch];
	const lib_dir = resolve_lib_dir(document.uri);
	if (lib_dir) flags.push("--lib", shell_quote(lib_dir));
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

	const setting = get_config<string>("executable", "nomen").trim();
	if (setting && setting !== "nomen") {
		return substitute_workspace(setting, workspace_folder);
	}

	if (workspace_folder) {
		const candidate = path.join(workspace_folder, "bin", "dist", "index.mjs");
		if (fs.existsSync(candidate)) {
			return `node ${shell_quote(candidate)}`;
		}
	}

	return "nomen";
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
	const value = vscode.workspace.getConfiguration("nomen").get<T>(key);
	return value === undefined ? fallback : value;
}

function shell_quote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// --- Diagnostics -------------------------------------------------------------

function diagnostics_mode(): "onType" | "onSave" | "off" {
	return get_config<"onType" | "onSave" | "off">("diagnostics", "onType");
}

function is_nomen(document: vscode.TextDocument): boolean {
	return document.languageId === ECHO_LANGUAGE;
}

function maybe_update_diagnostics(document: vscode.TextDocument): void {
	if (diagnostics_mode() === "off") {
		diagnostics.delete(document.uri);
		return;
	}
	if (!is_nomen(document)) return;
	// Until the bundled System library lookup completes, defer diagnosing
	// files that have no local library: analyzing them early flashes
	// "unknown type/value" errors that vanish once the library resolves.
	// Files with a local `core/` or `imports.System` can be diagnosed at once.
	if (!resolve_lib_dir(document.uri) && !bundled_lib_completed()) return;
	update_diagnostics(document);
}

function schedule_diagnostics(document: vscode.TextDocument, delay: number): void {
	if (!is_nomen(document)) return;
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
	if (!is_nomen(document)) return;

	const state = get_analysis(document);
	if (!state) return;

	if (state.fatal) {
		diagnostics.set(document.uri, [
			new vscode.Diagnostic(zero_range(), `Nomen: ${state.fatal}`, vscode.DiagnosticSeverity.Error),
		]);
		return;
	}

	const text = document.getText();
	const in_file = state.errors.filter((e) => e.start >= 0 && e.start < text.length);
	const diags = in_file.map(
		(e) =>
			new vscode.Diagnostic(
				error_range(document, text, e.start),
				e.message,
				vscode.DiagnosticSeverity.Error,
			),
	);
	// Surface lint warnings (unused declarations, var-never-changed) as hints so
	// they're visible without competing with real errors. Only those that fall
	// within the document itself (not the inlined library source).
	for (const w of state.warnings) {
		if (w.start < 0 || w.start >= text.length) continue;
		diags.push(
			new vscode.Diagnostic(
				error_range(document, text, w.start),
				w.message,
				vscode.DiagnosticSeverity.Warning,
			),
		);
	}
	diagnostics.set(document.uri, diags);
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
