import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, expect, test } from "vite-plus/test";

import LspClient from "../../lsp/test/lsp_client.ts";

// `nomen lsp` wires the language server (lsp/) to stdio. Drive it as a
// separate process, exactly as an editor would, to check the command: the
// banner stays off stdout, the bundled System library resolves, and `exit`
// ends the process cleanly.

const SOURCE = `import System

pub func main = (Init init) {
	Console.write("hi\\n")
}
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-lsp-cmd-"));
const uri = pathToFileURL(path.join(dir, "main.nm")).href;

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test("`nomen lsp` speaks LSP over stdio", async () => {
	const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const tsx = path.join(cli, "node_modules", ".bin", "tsx");
	const child = spawn(tsx, [path.join(cli, "src", "index.ts"), "lsp", "--stdio"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	try {
		const stdio = new LspClient(child.stdout!, child.stdin!);
		const init = await stdio.request("initialize", { processId: null, capabilities: {} });
		expect(init.serverInfo.name).toBe("nomen");
		stdio.notify("initialized", {});
		stdio.notify("textDocument/didOpen", {
			textDocument: { uri, languageId: "nomen", version: 1, text: SOURCE },
		});
		const diags = await stdio.wait_for("textDocument/publishDiagnostics");
		expect(diags.uri).toBe(uri);
		const hover = await stdio.request("textDocument/hover", {
			textDocument: { uri },
			position: { line: 3, character: 3 },
		});
		expect(hover.contents.value).toContain("Console");
		await stdio.request("shutdown", null);
		const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
		stdio.notify("exit", null);
		expect(await exited).toBe(0);
	} finally {
		child.kill();
	}
});
