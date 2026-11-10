import { codeToTokens } from "nomen-shiki";

import { FIRST_CHAR, GLYPH_COUNT, GLYPH_HEIGHT, GLYPHS, GLYPH_WIDTH } from "./font8x8.ts";
import { encode_png } from "./png.ts";

/**
 * Renders the per-program social card for a share link: the syntax-highlighted
 * program, and — when the share link carries the author's run output — that
 * output underneath.
 *
 * Runs in the Worker with no image stack: Shiki supplies token colours, a
 * public-domain 8x8 bitmap font supplies the glyphs, and `encode_png` writes
 * the result as an indexed-colour PNG. Nothing here needs satori, resvg, a
 * headless browser, or a canvas API.
 */

const WIDTH = 1200;
const HEIGHT = 630;
const MARGIN = 40;
const SCALE = 2;
/** One glyph cell plus a scaled pixel of spacing. */
const ADVANCE = (GLYPH_WIDTH + 1) * SCALE;
const LINE = (GLYPH_HEIGHT + 2) * SCALE;
const MAX_COLS = Math.floor((WIDTH - MARGIN * 2) / ADVANCE);
const TITLE_Y = 30;
const CODE_TOP = 82;
const MAX_LINES = Math.floor((HEIGHT - MARGIN - CODE_TOP) / LINE);
const MAX_OUTPUT_LINES = 8;

const BACKGROUND = "#101214";
const TITLE_COLOR = "#e6e9ee";
const ACCENT = "#8ab4f8";
const MUTED = "#6f7885";
const OUTPUT_COLOR = "#9aa4b2";
const SEPARATOR = "#262d36";
const TOKEN_FALLBACK = "#d4d4d4";

interface Cell {
	ch: string;
	color: string;
}

interface Canvas {
	pixels: Uint8Array;
	palette: number[];
	index: Map<string, number>;
}

export async function render_code_card(
	source: string,
	output: string | undefined,
	host: string,
): Promise<ArrayBuffer> {
	const canvas: Canvas = {
		pixels: new Uint8Array(WIDTH * HEIGHT),
		palette: [0x10, 0x12, 0x14],
		index: new Map([[BACKGROUND, 0]]),
	};
	const rows = await highlighted_rows(source);
	const output_rows = (output ?? "").replace(/\r\n?/g, "\n").split("\n");
	while (output_rows.length > 0 && output_rows[output_rows.length - 1].trim() === "") {
		output_rows.pop();
	}

	// Header: the wordmark, and the host the card belongs to.
	draw_text(canvas, MARGIN, TITLE_Y, "Nomen", TITLE_COLOR);
	draw_text(canvas, MARGIN + 6 * ADVANCE, TITLE_Y, "REPL", ACCENT);
	const host_text = fit_text(host, Math.floor((WIDTH - MARGIN * 2) / (GLYPH_WIDTH + 1)));
	draw_text(
		canvas,
		WIDTH - MARGIN - host_text.length * (GLYPH_WIDTH + 1),
		TITLE_Y + 4,
		host_text,
		MUTED,
		1,
	);
	fill_rect(canvas, MARGIN, 64, WIDTH - MARGIN * 2, 2, SEPARATOR);

	// Split the space between the program and (optionally) its output.
	const has_output = output_rows.some((line) => line.trim().length > 0);
	const shown_output = has_output ? Math.min(output_rows.length, MAX_OUTPUT_LINES) : 0;
	const reserved = has_output ? shown_output + 1 : 0;
	const code_limit = Math.max(1, MAX_LINES - reserved);

	let y = CODE_TOP;
	let drawn = 0;
	for (const row of rows) {
		if (drawn >= code_limit) break;
		draw_row(canvas, y, row);
		if (drawn === code_limit - 1 && rows.length > code_limit) {
			// The program continues past the card: mark the right edge of the
			// last shown line.
			draw_text(canvas, MARGIN + (MAX_COLS - 3) * ADVANCE, y, "...", MUTED);
		}
		y += LINE;
		drawn += 1;
	}
	if (has_output) {
		fill_rect(canvas, MARGIN, y + 4, WIDTH - MARGIN * 2, 2, SEPARATOR);
		let output_y = y + LINE;
		for (let i = 0; i < shown_output; i++) {
			const line =
				i === shown_output - 1 && output_rows.length > shown_output ? "..." : output_rows[i];
			draw_output_line(canvas, output_y, line);
			output_y += LINE;
		}
	}

	return encode_png(WIDTH, HEIGHT, canvas.pixels, Uint8Array.from(canvas.palette)).then(
		(bytes) => bytes.buffer as ArrayBuffer,
	);
}

/** Shiki token rows, with tabs expanded so the fixed-width grid lines up. */
async function highlighted_rows(source: string): Promise<Cell[][]> {
	const code = source.replace(/\t/g, "    ");
	try {
		const { tokens } = await codeToTokens(code, { lang: "nomen", theme: "dark-plus" });
		return tokens.map((line) =>
			line.flatMap((token) =>
				Array.from(token.content, (ch) => ({ ch, color: token.color ?? TOKEN_FALLBACK })),
			),
		);
	} catch {
		return code
			.split("\n")
			.map((line) => Array.from(line, (ch) => ({ ch, color: TOKEN_FALLBACK })));
	}
}

function draw_row(canvas: Canvas, y: number, cells: Cell[]): void {
	const clipped = cells.length > MAX_COLS;
	const shown = clipped ? cells.slice(0, MAX_COLS) : cells;
	if (clipped) {
		for (let i = Math.max(0, shown.length - 3); i < shown.length; i++) {
			shown[i] = { ch: ".", color: MUTED };
		}
	}
	let x = MARGIN;
	for (const cell of shown) {
		draw_char(canvas, x, y, cell.ch, cell.color);
		x += ADVANCE;
	}
}

function draw_output_line(canvas: Canvas, y: number, line: string): void {
	draw_row(
		canvas,
		y,
		Array.from(line, (ch) => ({ ch, color: OUTPUT_COLOR })),
	);
}

function fit_text(text: string, columns: number): string {
	return text.length > columns ? `${text.slice(0, Math.max(0, columns - 3))}...` : text;
}

function draw_text(
	canvas: Canvas,
	x: number,
	y: number,
	text: string,
	color: string,
	scale = SCALE,
): void {
	let cursor = x;
	for (const ch of text) {
		draw_char(canvas, cursor, y, ch, color, scale);
		cursor += (GLYPH_WIDTH + 1) * scale;
	}
}

function draw_char(
	canvas: Canvas,
	x: number,
	y: number,
	ch: string,
	color: string,
	scale = SCALE,
): void {
	const code = ch.charCodeAt(0);
	// Non-ASCII (and control characters) degrade to `?` rather than a blank.
	const glyph =
		code >= FIRST_CHAR && code < FIRST_CHAR + GLYPH_COUNT ? code - FIRST_CHAR : 63 - FIRST_CHAR;
	const index = color_index(canvas, color);
	const base = glyph * GLYPH_HEIGHT;
	for (let row = 0; row < GLYPH_HEIGHT; row++) {
		const bits = GLYPHS[base + row];
		if (!bits) continue;
		for (let col = 0; col < GLYPH_WIDTH; col++) {
			if (bits & (1 << col)) {
				fill_rect(canvas, x + col * scale, y + row * scale, scale, scale, index);
			}
		}
	}
}

function fill_rect(
	canvas: Canvas,
	x: number,
	y: number,
	width: number,
	height: number,
	color: string | number,
): void {
	const index = typeof color === "number" ? color : color_index(canvas, color);
	const left = Math.max(0, x);
	const top = Math.max(0, y);
	const right = Math.min(WIDTH, x + width);
	const bottom = Math.min(HEIGHT, y + height);
	for (let row = top; row < bottom; row++) {
		canvas.pixels.fill(index, row * WIDTH + left, row * WIDTH + right);
	}
}

function color_index(canvas: Canvas, hex: string): number {
	const existing = canvas.index.get(hex);
	if (existing !== undefined) return existing;
	const value = hex.replace("#", "");
	const index = canvas.palette.length / 3;
	canvas.palette.push(
		Number.parseInt(value.slice(0, 2), 16),
		Number.parseInt(value.slice(2, 4), 16),
		Number.parseInt(value.slice(4, 6), 16),
	);
	canvas.index.set(hex, index);
	return index;
}
