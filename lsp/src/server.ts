import type { Readable, Writable } from "node:stream";

import { TextDocuments, TextDocumentSyncKind } from "vscode-languageserver";
import type { Connection, InitializeResult } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
	ProposedFeatures,
	StreamMessageReader,
	StreamMessageWriter,
	createConnection,
} from "vscode-languageserver/node.js";

import { forget_document, invalidate_all, uri_to_path } from "./documents.ts";
import {
	code_actions,
	code_lenses,
	completions,
	definition,
	diagnostics_for,
	format_edits,
	hover,
	references,
} from "./features.ts";
import { forget_libraries_for, set_bundled_lib_dir, set_workspace_folders } from "./library.ts";

/** The server-side command behind VS Code's "Nomen: Force Format File" (and
 *  usable from any client via `workspace/executeCommand`, argument: the
 *  document URI). Named apart from the extension's own `nomen.format.force`
 *  so the two command registrations don't collide. */
export const FORCE_FORMAT_COMMAND = "nomen.server.forceFormat";

const DEBOUNCE_MS = 350;

type DiagnosticsMode = "onType" | "onSave" | "off";

/** The `nomen` settings section, as a client sends it (`workspace/configuration`,
 *  `didChangeConfiguration`, or `initializationOptions.settings`). */
interface Settings {
	diagnostics: DiagnosticsMode;
	format_force: boolean;
}

const DEFAULT_SETTINGS: Settings = { diagnostics: "onType", format_force: false };

function read_settings(raw: unknown): Settings {
	const value = (raw ?? {}) as Record<string, any>;
	const mode = value.diagnostics;
	const force = value["format.force"] ?? value.format?.force;
	return {
		diagnostics: mode === "onSave" || mode === "off" ? mode : "onType",
		format_force: force === true,
	};
}

export interface ServerOptions {
	/** Where the System library lives for files with no local one — the
	 *  copy bundled with the CLI, which passes it in. */
	bundled_lib_dir?: string;
}

/**
 * Start the Nomen language server on the given streams (stdin/stdout by
 * default). Returns the connection so tests can dispose of it.
 */
export function start_server(
	input: Readable = process.stdin,
	output: Writable = process.stdout,
	options: ServerOptions = {},
): Connection {
	const connection = createConnection(
		ProposedFeatures.all,
		new StreamMessageReader(input),
		new StreamMessageWriter(output),
	);
	const documents = new TextDocuments(TextDocument);

	set_bundled_lib_dir(options.bundled_lib_dir);

	let settings: Settings = DEFAULT_SETTINGS;
	let pull_configuration = false;
	let run_commands = false;
	let snippets = false;
	let folder_events = false;
	let folders: string[] = [];
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	const clear_timer = (uri: string): void => {
		const timer = timers.get(uri);
		if (timer) clearTimeout(timer);
		timers.delete(uri);
	};

	const publish = (document: TextDocument): void => {
		clear_timer(document.uri);
		const diagnostics = settings.diagnostics === "off" ? [] : diagnostics_for(document);
		void connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics });
	};

	const schedule = (document: TextDocument): void => {
		clear_timer(document.uri);
		timers.set(
			document.uri,
			setTimeout(() => {
				timers.delete(document.uri);
				// The document may have closed while the timer was pending.
				const live = documents.get(document.uri);
				if (live) publish(live);
			}, DEBOUNCE_MS),
		);
	};

	const refresh_settings = async (pushed?: unknown): Promise<void> => {
		if (pull_configuration) {
			try {
				// A client with nothing configured answers `null`: keep the
				// settings from `initializationOptions` (or the defaults).
				const pulled: unknown = await connection.workspace.getConfiguration("nomen");
				if (pulled) settings = read_settings(pulled);
			} catch {
				// The client advertised configuration but failed the request;
				// keep what we had.
			}
		} else if (pushed !== undefined) {
			settings = read_settings(pushed);
		}
	};

	connection.onInitialize((params): InitializeResult => {
		const capabilities = params.capabilities;
		pull_configuration = !!capabilities.workspace?.configuration;
		snippets = !!capabilities.textDocument?.completion?.completionItem?.snippetSupport;

		const init = (params.initializationOptions ?? {}) as Record<string, any>;
		run_commands = init.runCommands === true;
		// Settings may arrive as `{ settings: { … } }`, `{ nomen: { … } }`
		// (Helix passes its `config` table this way) or flat.
		const initial = init.settings ?? init.nomen ?? init;
		settings = read_settings(initial);

		folder_events = !!capabilities.workspace?.workspaceFolders;
		folders = (params.workspaceFolders ?? []).map((f) => uri_to_path(f.uri));
		if (!folders.length && params.rootUri) folders.push(uri_to_path(params.rootUri));
		set_workspace_folders(folders);

		return {
			capabilities: {
				textDocumentSync: {
					openClose: true,
					change: TextDocumentSyncKind.Incremental,
					save: { includeText: false },
				},
				hoverProvider: true,
				definitionProvider: true,
				referencesProvider: true,
				completionProvider: { triggerCharacters: ["."] },
				documentFormattingProvider: true,
				codeActionProvider: { codeActionKinds: ["quickfix"] },
				codeLensProvider: { resolveProvider: false },
				executeCommandProvider: { commands: [FORCE_FORMAT_COMMAND] },
				workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
			},
			serverInfo: { name: "nomen" },
		};
	});

	connection.onInitialized(async () => {
		if (folder_events) {
			connection.workspace.onDidChangeWorkspaceFolders((event) => {
				const removed = new Set(event.removed.map((f) => uri_to_path(f.uri)));
				folders = folders.filter((f) => !removed.has(f));
				folders.push(...event.added.map((f) => uri_to_path(f.uri)));
				set_workspace_folders(folders);
				invalidate_all();
				for (const document of documents.all()) publish(document);
			});
		}
		await refresh_settings();
		for (const document of documents.all()) publish(document);
	});

	connection.onDidChangeConfiguration(async (change) => {
		const pushed = (change.settings as Record<string, unknown> | undefined)?.nomen;
		await refresh_settings(pushed);
		for (const document of documents.all()) publish(document);
	});

	connection.onDidChangeWatchedFiles((params) => {
		// A sibling module, library file or package.jsonc changed on disk:
		// re-analyze every open document (re-reading any affected library).
		forget_libraries_for(params.changes.map((c) => uri_to_path(c.uri)));
		invalidate_all();
		for (const document of documents.all()) publish(document);
	});

	documents.onDidOpen((event) => publish(event.document));
	documents.onDidSave((event) => publish(event.document));
	documents.onDidChangeContent((event) => {
		// `onDidOpen` already published the opening version.
		if (event.document.version === 0) return;
		if (settings.diagnostics === "onType") schedule(event.document);
	});
	documents.onDidClose((event) => {
		clear_timer(event.document.uri);
		forget_document(event.document.uri);
		void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
	});

	const with_document = <T>(uri: string, fallback: T, fn: (document: TextDocument) => T): T => {
		const document = documents.get(uri);
		if (!document) return fallback;
		try {
			return fn(document);
		} catch (err) {
			connection.console.error(`nomen: ${err instanceof Error ? err.stack : String(err)}`);
			return fallback;
		}
	};

	connection.onHover((p) =>
		with_document(p.textDocument.uri, null, (d) => hover(d, p.position) ?? null),
	);
	connection.onDefinition((p) =>
		with_document(p.textDocument.uri, null, (d) => definition(d, p.position) ?? null),
	);
	connection.onReferences((p) =>
		with_document(p.textDocument.uri, [], (d) =>
			references(d, p.position, p.context.includeDeclaration),
		),
	);
	connection.onCompletion((p) =>
		with_document(p.textDocument.uri, [], (d) => completions(d, p.position, snippets)),
	);
	connection.onDocumentFormatting((p) =>
		with_document(p.textDocument.uri, [], (d) => format_edits(d, settings.format_force)),
	);
	connection.onCodeAction((p) =>
		with_document(p.textDocument.uri, [], (d) => code_actions(d, p.context.diagnostics)),
	);
	connection.onCodeLens((p) =>
		with_document(p.textDocument.uri, [], (d) => (run_commands ? code_lenses(d) : [])),
	);

	connection.onExecuteCommand(async (p) => {
		if (p.command !== FORCE_FORMAT_COMMAND) return null;
		const uri = p.arguments?.[0];
		if (typeof uri !== "string") return null;
		const edits = with_document(uri, [], (d) => format_edits(d, true));
		if (!edits.length) return null;
		await connection.workspace.applyEdit({
			label: "Force format",
			edit: { changes: { [uri]: edits } },
		});
		return null;
	});

	connection.onShutdown(() => {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
	});

	documents.listen(connection);
	connection.listen();
	return connection;
}
