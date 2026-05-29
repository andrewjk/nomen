const std = @import("std");
const Io = std.Io;
const pidigits_mod = @import("pidigits.zig");

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    const arena: std.mem.Allocator = init.arena.allocator();

    const args = try init.minimal.args.toSlice(arena);
    const n = if (args.len > 1) try std.fmt.parseInt(usize, args[1], 10) else 1;

    const result = try pidigits_mod.pidigits_to_string(n, arena);
    defer arena.free(result);

    var stdout_buffer: [1024]u8 = undefined;
    var stdout_file_writer: Io.File.Writer = .init(.stdout(), io, &stdout_buffer);
    const stdout_writer = &stdout_file_writer.interface;

    for (result, 0..) |digit, i| {
        try stdout_writer.writeByte(digit);
        if (@rem(i + 1, 10) == 0) {
            try stdout_writer.print("\t:{d}\n", .{i + 1});
        }
    }

    if (@rem(result.len, 10) != 0) {
        const padding = 10 - @rem(result.len, 10);
        for (0..padding) |_| {
            try stdout_writer.writeByte(' ');
        }
        try stdout_writer.print("\t:{d}\n", .{result.len});
    }

    try stdout_writer.flush();
}

test "simple test" {
    const gpa = std.testing.allocator;
    var list: std.ArrayList(i32) = .empty;
    defer list.deinit(gpa);
    try list.append(gpa, 42);
    try std.testing.expectEqual(@as(i32, 42), list.pop());
}