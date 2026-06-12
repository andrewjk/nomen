const std = @import("std");

pub fn main(init: std.process.Init) !void {
    var arg_iter = try std.process.Args.iterateAllocator(init.minimal.args, init.gpa);
    defer arg_iter.deinit();
    _ = arg_iter.skip();
    const arg = arg_iter.next();
    var buf: [256]u8 = undefined;
    if (arg) |a| {
        const msg = std.fmt.bufPrint(&buf, "Hello world {s}!\n", .{a}) catch unreachable;
        _ = std.c.write(1, msg.ptr, msg.len);
    } else {
        const msg = "Hello world!\n";
        _ = std.c.write(1, msg.ptr, msg.len);
    }
}
