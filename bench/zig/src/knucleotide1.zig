const std = @import("std");

var gpa: std.mem.Allocator = undefined;

const Code = struct {
	data: u64,

	pub inline fn encodeByte(c: u8) u8 {
		return (c >> 1) & 0b11;
	}

	pub inline fn makeMask(frame: usize) u64 {
		return (@as(u64, 1) << @as(u6, @intCast(2 * frame))) - 1;
	}

	pub inline fn push(self: *Code, c: u8, mask: u64) void {
		self.data = ((self.data << 2) | c) & mask;
	}

	pub fn fromStr(s: []const u8) Code {
		const mask = Code.makeMask(s.len);
		var res = Code{ .data = 0 };
		for (s) |c| {
			res.push(Code.encodeByte(c), mask);
		}
		return res;
	}

	pub fn toString(self: Code, frame: usize) ![]const u8 {
		var result: std.ArrayList(u8) = .empty;
		errdefer result.deinit(gpa);
		var code = self.data;
		var i: usize = 0;
		while (i < frame) : (i += 1) {
			const c: u8 = switch (@as(u8, @truncate(code)) & 0b11) {
				Code.encodeByte('A') => 'A',
				Code.encodeByte('T') => 'T',
				Code.encodeByte('G') => 'G',
				Code.encodeByte('C') => 'C',
				else => unreachable,
			};
			try result.append(gpa, c);
			code >>= 2;
		}
		std.mem.reverse(u8, result.items);
		return result.toOwnedSlice(gpa);
	}
};

// Read the FASTA input, locate the ">THREE" sequence (skipping any preceding
// throwaway headers), and return it with newlines removed and each nucleotide
// encoded as its low 2 bits.
fn readInput(io: std.Io, file_name: []const u8) ![]u8 {
	const cwd = std.Io.Dir.cwd();
	const raw = try cwd.readFileAlloc(io, file_name, gpa, .unlimited);
	defer gpa.free(raw);

	// Find the ">THREE" header.
	var pos: usize = 0;
	if (std.mem.indexOf(u8, raw, ">THREE")) |p| {
		pos = p + ">THREE".len;
	}
	// Skip to the end of the header line.
	while (pos < raw.len and raw[pos] != '\n') pos += 1;
	if (pos < raw.len) pos += 1; // consume '\n'

	const seq = raw[pos..];
	const buf = try gpa.alloc(u8, seq.len);
	var w: usize = 0;
	for (seq) |c| {
		if (c != '\n' and c != '\r') {
			buf[w] = (c >> 1) & 0x03;
			w += 1;
		}
	}
	return buf[0..w];
}

const CodeContext = struct {
	pub fn eql(_: CodeContext, a: Code, b: Code) bool {
		return a.data == b.data;
	}
	pub fn hash(_: CodeContext, c: Code) u64 {
		return c.data ^ (c.data >> 7);
	}
};

const Map = std.HashMapUnmanaged(Code, u32, CodeContext, 45);

const Iter = struct {
	i: usize = 0,
	input: []const u8,
	code: Code,
	mask: u64,

	pub fn init(input: []const u8, frame: usize) Iter {
		const mask = Code.makeMask(frame);
		var code = Code{ .data = 0 };
		for (input[0 .. frame - 1]) |c| code.push(c, mask);
		return .{
			.input = input[frame - 1 ..],
			.code = code,
			.mask = mask,
		};
	}

	pub fn next(self: *Iter) ?Code {
		if (self.i >= self.input.len) return null;
		defer self.i += 1;
		const c = self.input[self.i];
		Code.push(&self.code, c, self.mask);
		return self.code;
	}
};

fn genMap(seq: []const u8, n: usize, map: *Map) !void {
	map.clearAndFree(gpa);
	var iter = Iter.init(seq, n);
	while (iter.next()) |code| {
		const gop = try map.getOrPut(gpa, code);
		if (!gop.found_existing) gop.value_ptr.* = 0;
		gop.value_ptr.* += 1;
	}
}

const CountCode = struct {
	count: u64,
	code: Code,
	pub fn asc(_: void, a: CountCode, b: CountCode) bool {
		const order = std.math.order(a.count, b.count);
		return order == .lt or (order == .eq and b.code.data < a.code.data);
	}
};

fn printMap(stdout: *std.Io.File.Writer, self: usize, map: Map) !void {
	var v: std.ArrayList(CountCode) = .empty;
	defer v.deinit(gpa);
	var iter = map.iterator();
	var total: u64 = 0;
	while (iter.next()) |it| {
		const count = it.value_ptr.*;
		total += count;
		try v.append(gpa, .{ .count = count, .code = it.key_ptr.* });
	}

	std.mem.sort(CountCode, v.items, {}, comptime CountCode.asc);
	if (v.items.len == 0) {
		try stdout.interface.writeAll("\n");
		return;
	}
	var i = v.items.len - 1;
	while (true) : (i -= 1) {
		const cc = v.items[i];
		const s = try cc.code.toString(self);
		defer gpa.free(s);
		try stdout.interface.print("{s} {d:.3}\n", .{
			s,
			@as(f32, @floatFromInt(cc.count)) / @as(f32, @floatFromInt(total)) * 100.0,
		});
		if (i == 0) break;
	}
	try stdout.interface.writeAll("\n");
}

fn printOcc(stdout: *std.Io.File.Writer, s: []const u8, map: *Map) !void {
	const count = if (map.get(Code.fromStr(s))) |x| x else 0;
	try stdout.interface.print("{d}\t{s}\n", .{ count, s });
}

pub fn main(init: std.process.Init) !void {
	gpa = init.gpa;

	var out_buffer: [8192]u8 = undefined;
	var stdout = std.Io.File.stdout().writer(init.io, &out_buffer);

	const arena = init.arena.allocator();
	const args = try std.process.Args.toSlice(init.minimal.args, arena);
	const file_name: []const u8 = if (args.len > 1) args[1] else "knucleotide_input.txt";

	const occs = [_][]const u8{
		"GGT",
		"GGTA",
		"GGTATT",
		"GGTATTTTAATT",
		"GGTATTTTAATTTATAGT",
	};
	const input = try readInput(init.io, file_name);
	defer gpa.free(input);
	var map: Map = .{};
	try genMap(input, 1, &map);
	try printMap(&stdout, 1, map);
	try genMap(input, 2, &map);
	try printMap(&stdout, 2, map);

	for (occs) |occ| {
		try genMap(input, occ.len, &map);
		try printOcc(&stdout, occ, &map);
	}
	try stdout.interface.flush();
}
