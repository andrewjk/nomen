import fs from "node:fs";
import path from "node:path";

import * as vscode from "vscode";

const ECHO_LANGUAGE = "echo";
const TERMINAL_NAME = "Echo";

// Matches `func main` at the start of a line, optionally preceded by `pub`.
const MAIN_FUNC = /^\s*(?:pub\s+)?func\s+main\b/;

let terminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext): void {
	terminal = undefined;

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ language: ECHO_LANGUAGE }, new EchoCodeLensProvider()),
		vscode.commands.registerCommand("echo.run", (uri?: vscode.Uri) => runEcho(uri, false)),
		vscode.commands.registerCommand("echo.audit", (uri?: vscode.Uri) => runEcho(uri, true)),
		vscode.window.onDidCloseTerminal((t) => {
			if (t === terminal) terminal = undefined;
		}),
	);
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
	if (audit) flags.push("--audit");

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
	const ws = vscode.workspace.getWorkspaceFolder(uri);
	const workspace_folder = ws?.uri.fsPath ?? "";
	const substitute = (value: string): string =>
		value
			.split("${workspaceFolder}")
			.join(workspace_folder)
			.split("$workspaceFolder")
			.join(workspace_folder);

	const setting = get_config<string>("executable", "lang").trim();
	if (setting && setting !== "lang") {
		return substitute(setting);
	}

	if (workspace_folder) {
		const candidate = path.join(workspace_folder, "bin", "dist", "index.mjs");
		if (fs.existsSync(candidate)) {
			return `node ${shell_quote(candidate)}`;
		}
	}

	return "lang";
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
