import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import * as vscode from "vscode";
import { LanguageClient, State } from "vscode-languageclient/node";
import type { LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";

// Every language feature (diagnostics, hover, definition, references,
// completion, formatting, quick fixes, Run/Audit code lenses) comes from the
// Nomen language server, `nomen lsp`, shipped with the CLI. This extension
// launches it and adds the VS Code-only pieces: the Run/Audit terminal
// commands and the force-format command.

const LANGUAGE_ID = "nomen";
const TERMINAL_NAME = "Nomen";
/** The server's executeCommand behind "Nomen: Force Format File". */
const SERVER_FORCE_FORMAT = "nomen.server.forceFormat";

let terminal: vscode.Terminal | undefined;
let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	terminal = undefined;

	context.subscriptions.push(
		vscode.commands.registerCommand("nomen.run", (uri?: vscode.Uri | string) =>
			runNomen(uri, false),
		),
		vscode.commands.registerCommand("nomen.audit", (uri?: vscode.Uri | string) =>
			runNomen(uri, true),
		),
		vscode.commands.registerCommand("nomen.format.force", () => forceFormat()),
		vscode.window.onDidCloseTerminal((t) => {
			if (t === terminal) terminal = undefined;
		}),
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			// The executable is baked into the server launch; restart to pick
			// up a new one. Other settings reach the running server through
			// `workspace/didChangeConfiguration`.
			if (event.affectsConfiguration("nomen.executable")) await restart_client();
		}),
		{ dispose: () => void client?.stop() },
	);

	// GUI-launched VS Code may not see the PATH entry the CLI was installed
	// to; resolve it before launching the server.
	resolve_shell_path();
	await start_client();
}

export async function deactivate(): Promise<void> {
	terminal = undefined;
	await client?.stop();
	client = undefined;
}

async function start_client(): Promise<void> {
	const dummy_uri = vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.file("/");
	const executable = resolve_executable(dummy_uri);

	// `executable` may itself carry arguments (`node '/path/index.mjs'`), so
	// launch through the shell.
	const server: ServerOptions = {
		command: `${executable} lsp`,
		options: { shell: true },
	};
	const options: LanguageClientOptions = {
		documentSelector: [{ language: LANGUAGE_ID }],
		synchronize: {
			configurationSection: "nomen",
			fileEvents: vscode.workspace.createFileSystemWatcher("**/{*.nm,package.jsonc}"),
		},
		// The server only sends Run/Audit code lenses to clients that
		// implement those commands.
		initializationOptions: { runCommands: true },
	};

	client = new LanguageClient("nomen", "Nomen Language Server", server, options);
	try {
		await client.start();
	} catch {
		void vscode.window.showErrorMessage(
			`Nomen: could not start the language server (\`${executable} lsp\`). Editor features (completion, hover, diagnostics) need the Nomen CLI 0.17 or newer — install it with \`npm i -g nomen-lang\`.`,
		);
	}
}

async function restart_client(): Promise<void> {
	const previous = client;
	client = undefined;
	if (previous && previous.state !== State.Stopped) await previous.stop();
	await start_client();
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
		// Shell failed or timed out — leave PATH untouched and let the
		// client surface the "could not start" error if applicable.
	}
}

async function forceFormat(): Promise<void> {
	const document = vscode.window.activeTextEditor?.document;
	if (!document || document.languageId !== LANGUAGE_ID) {
		void vscode.window.showErrorMessage("Nomen: No active Nomen file to format.");
		return;
	}
	if (!client?.isRunning()) {
		void vscode.window.showErrorMessage("Nomen: the language server is not running.");
		return;
	}
	// The server answers with a `workspace/applyEdit`, which the client applies.
	await client.sendRequest("workspace/executeCommand", {
		command: SERVER_FORCE_FORMAT,
		arguments: [document.uri.toString()],
	});
}

async function runNomen(target: vscode.Uri | string | undefined, audit: boolean): Promise<void> {
	// Code lenses from the server pass the document URI as a string.
	const uri = typeof target === "string" ? vscode.Uri.parse(target) : target;
	const document = resolveDocument(uri);
	if (!document) {
		void vscode.window.showErrorMessage("Nomen: No active Nomen file to run.");
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

function workspace_folder_of(uri: vscode.Uri): string {
	return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? "";
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

/** The System library to pass to `nomen run --lib`: a local
 *  `imports.System` or `core/` at or above the file, else the workspace's
 *  `core/`. Without one, the CLI falls back to its bundled library itself. */
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
