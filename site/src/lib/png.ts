/**
 * A minimal indexed-colour PNG encoder.
 *
 * The social card only needs flat pixels, so this writes an 8-bit palette PNG
 * (colour type 3) and compresses the scanlines with the platform's
 * `CompressionStream` — no image library, no WASM, no canvas.
 */

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let value = n;
		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[n] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function be32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	out.set(be32(data.length), 0);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	const crc = crc32(out.subarray(4, 8 + data.length));
	out.set(be32(crc), 8 + data.length);
	return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	const body = new Response(bytes as unknown as BodyInit).body;
	if (!body) throw new Error("png: no response body stream");
	const stream = body.pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encode_png(
	width: number,
	height: number,
	/** One palette index per pixel, row-major. */
	pixels: Uint8Array,
	/** Packed palette: three bytes (R, G, B) per entry. */
	palette: Uint8Array,
): Promise<Uint8Array> {
	const ihdr = new Uint8Array([
		...be32(width),
		...be32(height),
		8, // bit depth
		3, // colour type: indexed
		0, // compression
		0, // filter
		0, // interlace
	]);

	// Each scanline is a filter byte (0 = none) followed by the row's indices.
	const raw = new Uint8Array(height * (width + 1));
	for (let y = 0; y < height; y++) {
		const from = y * width;
		raw.set(pixels.subarray(from, from + width), y * (width + 1) + 1);
	}

	const parts = [
		SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("PLTE", palette),
		chunk("IDAT", await deflate(raw)),
		chunk("IEND", new Uint8Array(0)),
	];
	const length = parts.reduce((total, part) => total + part.length, 0);
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
