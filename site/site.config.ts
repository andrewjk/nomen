import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflare } from "@torpor/adapter-cloudflare";
import { Site } from "@torpor/build";

const here = path.dirname(fileURLToPath(import.meta.url));

const site: Site = new Site();
site.adapter = cloudflare;

// The REPL compiles on the server, and the compiler imports `node:fs` and
// `node:path` at module scope (for Node-only library loading and `#embed_file`).
// The Worker has no filesystem and we want no Node built-ins in the bundle, so
// point those modules at the site's stubs. The System library is embedded by
// `scripts/bundle-core.ts` — nothing reads a file at runtime.
site.viteConfig = {
	resolve: {
		alias: [
			{ find: /^node:fs$/, replacement: path.join(here, "src/lib/fs-stub.ts") },
			{ find: /^node:path$/, replacement: path.join(here, "src/lib/path-shim.ts") },
		],
	},
	// The compiler's backends read debug switches from `process.env` (and one
	// reads it at module scope). The Worker has no `process`; all of these are
	// simply "off".
	define: {
		"process.env": "({})",
	},
};

await site.addRouteFolder("./src/routes");

export default site;
