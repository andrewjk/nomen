import type { Readable, Writable } from "node:stream";

/**
 * A minimal JSON-RPC client that speaks LSP's wire format (Content-Length
 * framed JSON) to a Nomen language server over a pair of byte streams — the
 * same bytes an editor would exchange with `nomen lsp`. No LSP library is
 * involved on this side, so the tests exercise the real protocol framing.
 */
export default class LspClient {
	private next_id = 1;
	private buffer = Buffer.alloc(0);
	private pending = new Map<number, (message: any) => void>();
	private waiters: { method: string; match: (params: any) => boolean; done: (p: any) => void }[] =
		[];
	/** Every notification received, in order. */
	notifications: { method: string; params: any }[] = [];
	/** Answers for server → client requests, by method. */
	handlers: Record<string, (params: any) => unknown> = {
		"workspace/configuration": (params) => params.items.map(() => this.settings),
		"client/registerCapability": () => null,
		"workspace/applyEdit": (params) => {
			this.applied_edits.push(params.edit);
			return { applied: true };
		},
	};
	settings: Record<string, unknown> = {};
	applied_edits: any[] = [];

	constructor(
		input: Readable,
		private output: Writable,
	) {
		input.on("data", (chunk: Buffer) => this.receive(chunk));
	}

	request(method: string, params: unknown): Promise<any> {
		const id = this.next_id++;
		this.send({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => {
			this.pending.set(id, (message) => {
				if (message.error) reject(new Error(message.error.message));
				else resolve(message.result);
			});
		});
	}

	notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	/** Resolve with the first notification of `method` (already received or
	 *  still to come) whose params satisfy `match`. */
	wait_for(method: string, match: (params: any) => boolean = () => true): Promise<any> {
		const seen = this.notifications.find((n) => n.method === method && match(n.params));
		if (seen) return Promise.resolve(seen.params);
		return new Promise((done) => this.waiters.push({ method, match, done }));
	}

	private send(message: unknown): void {
		const body = Buffer.from(JSON.stringify(message), "utf8");
		this.output.write(`Content-Length: ${body.length}\r\n\r\n`);
		this.output.write(body);
	}

	private receive(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const header_end = this.buffer.indexOf("\r\n\r\n");
			if (header_end === -1) return;
			const header = this.buffer.subarray(0, header_end).toString("ascii");
			const match = header.match(/Content-Length: (\d+)/i);
			if (!match) throw new Error(`Bad LSP header: ${header}`);
			const length = Number(match[1]);
			const start = header_end + 4;
			if (this.buffer.length < start + length) return;
			const body = this.buffer.subarray(start, start + length).toString("utf8");
			this.buffer = this.buffer.subarray(start + length);
			this.dispatch(JSON.parse(body));
		}
	}

	private dispatch(message: any): void {
		// A response to one of our requests.
		if (message.id !== undefined && message.method === undefined) {
			const resolve = this.pending.get(message.id);
			this.pending.delete(message.id);
			resolve?.(message);
			return;
		}
		// A request from the server.
		if (message.id !== undefined) {
			const handler = this.handlers[message.method];
			const result = handler ? handler(message.params) : null;
			this.send({ jsonrpc: "2.0", id: message.id, result });
			return;
		}
		this.notifications.push({ method: message.method, params: message.params });
		const ready = this.waiters.filter(
			(w) => w.method === message.method && w.match(message.params),
		);
		this.waiters = this.waiters.filter((w) => !ready.includes(w));
		for (const waiter of ready) waiter.done(message.params);
	}
}
