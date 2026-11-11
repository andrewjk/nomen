import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg, initWasm } from "@resvg/resvg-wasm";

/**
 * Generates the raster favicon set from `src/assets/nomen.svg`.
 *
 * The SVG is the source of truth (like Torpor's site icon): edit it, then run
 * `pnpm icons` (also part of `predev`/`prebuild`). `favicon.ico` packs the
 * 16/32/48 PNGs; `apple-touch-icon.png` gets an opaque background because iOS
 * applies its own rounded mask.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = path.join(root, "src/assets/nomen.svg");
const publicDir = path.join(root, "src/public");
const require = createRequire(import.meta.url);
const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");

const svg = await fs.readFile(source, "utf8");
await initWasm(await fs.readFile(wasmPath));

function png(size: number, background?: string): Uint8Array {
	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: size },
		...(background ? { background } : {}),
	});
	return resvg.render().asPng();
}

/** The GUI library's default app-icon source: the mark on a full-bleed
 *  square (no corners, no margin). `Window.set_icon` lays any source image
 *  out on Apple's 824/1024 squircle grid at runtime, so the asset stays
 *  raw art rather than a pre-masked icon. */
function app_icon_png(size: number): Uint8Array {
	const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
	const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
	<rect width="200" height="200" fill="#ffffff" />
	${body}
</svg>`;
	const resvg = new Resvg(square, { fitTo: { mode: "width", value: size } });
	return resvg.render().asPng();
}

/** Pack PNG frames into an ICO (PNG payloads are supported by all browsers
 *  that matter now; no BMP conversion needed). */
function ico(frames: { size: number; png: Uint8Array }[]): Uint8Array {
	const header = 6 + frames.length * 16;
	const total = header + frames.reduce((sum, frame) => sum + frame.png.length, 0);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint16(0, 0, true); // reserved
	view.setUint16(2, 1, true); // type: icon
	view.setUint16(4, frames.length, true);
	let offset = header;
	frames.forEach((frame, index) => {
		const at = 6 + index * 16;
		const dimension = frame.size >= 256 ? 0 : frame.size;
		out[at] = dimension;
		out[at + 1] = dimension;
		view.setUint16(at + 4, 1, true); // colour planes
		view.setUint16(at + 6, 32, true); // bits per pixel
		view.setUint32(at + 8, frame.png.length, true);
		view.setUint32(at + 12, offset, true);
		out.set(frame.png, offset);
		offset += frame.png.length;
	});
	return out;
}

const small = [16, 32, 48].map((size) => ({ size, png: png(size) }));
for (const frame of small.slice(0, 2)) {
	await fs.writeFile(path.join(publicDir, `favicon-${frame.size}x${frame.size}.png`), frame.png);
}
await fs.writeFile(path.join(publicDir, "favicon.ico"), ico(small));
await fs.writeFile(path.join(publicDir, "apple-touch-icon.png"), png(180, "#111122"));

// The 512 logo rasterizes for the VS Code extension's marketplace icon; the
// GUI framework's default app icon is the same art full-bleed at 1024 so its
// runtime grid layout (Window.set_icon) has resolution to spare. Both track
// the SVG.
const logo_512 = png(512);
await fs.writeFile(path.resolve(root, "../extension/logo.png"), logo_512);
const core_icon = path.resolve(root, "../core/assets/nomen.png");
await fs.mkdir(path.dirname(core_icon), { recursive: true });
await fs.writeFile(core_icon, app_icon_png(1024));

console.log(
	`icons: wrote favicon.ico (${small.map((frame) => frame.size).join("/")}) and PNGs, extension/logo.png @ 512, core/assets/nomen.png @ 1024`,
);
