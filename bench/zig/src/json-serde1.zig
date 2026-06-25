const std = @import("std");
const json = std.json;

pub fn main(init: std.process.Init) !void {
	const io = init.io;
	const gpa = init.gpa;
	const arena = init.arena.allocator();

	var out_buffer: [4096]u8 = undefined;
	var stdout = std.Io.File.stdout().writer(io, &out_buffer);

	const args = try std.process.Args.toSlice(init.minimal.args, arena);
	const path: []const u8 = if (args.len > 1) args[1] else "sample.json";
	var n: usize = 3;
	if (args.len > 2) {
		n = std.fmt.parseInt(usize, args[2], 10) catch 3;
	}

	const cwd = std.Io.Dir.cwd();
	const json_str = try cwd.readFileAlloc(io, path, gpa, .unlimited);
	defer gpa.free(json_str);

	// Parse once and serialize.
	{
		const parsed = try json.parseFromSlice(GeoData, gpa, json_str, .{});
		defer parsed.deinit();
		const serialized = try std.json.Stringify.valueAlloc(gpa, parsed.value, .{});
		defer gpa.free(serialized);
		try printHash(serialized, &stdout);
	}

	// Re-parse n times into an array and serialize.
	{
		var array: std.ArrayList(GeoData) = .empty;
		defer array.deinit(gpa);
		var i: usize = 0;
		while (i < n) : (i += 1) {
			// Intentionally leak each parse: the array borrows slice pointers
			// owned by `parsed`, so it must stay alive until after serialization.
			const parsed = try json.parseFromSlice(GeoData, gpa, json_str, .{});
			try array.append(gpa, parsed.value);
		}
		const serialized = try std.json.Stringify.valueAlloc(gpa, array.items, .{});
		defer gpa.free(serialized);
		try printHash(serialized, &stdout);
	}

	try stdout.interface.flush();
}

fn printHash(bytes: []const u8, stdout: *std.Io.File.Writer) !void {
	const Md5 = std.crypto.hash.Md5;
	var hash: [Md5.digest_length]u8 = undefined;
	Md5.hash(bytes, &hash, .{});
	const hex = std.fmt.bytesToHex(&hash, .lower);
	try stdout.interface.print("{s}\n", .{&hex});
}

const GeoData = struct {
	type: []const u8,
	features: []const Feature,
};
const Feature = struct {
	type: []const u8,
	properties: Properties,
	geometry: Geometry,
};
const Properties = struct { name: []const u8 };
const Geometry = struct {
	type: []const u8,
	coordinates: []const []const [2]f64,

	// Custom serialization to emit coordinates compactly (no inner spaces),
	// matching the reference checksum.
	pub fn jsonStringify(self: Geometry, jw: anytype) !void {
		try jw.beginWriteRaw();
		const w = jw.writer;
		try w.print("{{\"type\":\"{s}\",\"coordinates\":[", .{self.type});
		for (self.coordinates, 0..) |row, rowi| {
			if (rowi != 0) try w.writeAll(",");
			try w.writeAll("[");
			for (row, 0..) |col, coli| {
				if (coli != 0) try w.writeAll(",");
				try w.print("[{d},{d}]", .{ col[0], col[1] });
			}
			try w.writeAll("]");
		}
		try w.writeAll("]}");
		jw.endWriteRaw();
	}
};
