const std = @import("std");
const math = std.math;
const Allocator = std.mem.Allocator;
const MIN_DEPTH = 4;

const global_allocator = std.heap.c_allocator;

pub fn main(init: std.process.Init) !void {
    const n = try getN(init);
    const max_depth = @max(MIN_DEPTH + 2, n);
    var buf: [256]u8 = undefined;
    {
        const stretch_depth = max_depth + 1;
        const stretch_tree = Node.make(stretch_depth, global_allocator).?;
        defer stretch_tree.deinit();
        const msg = std.fmt.bufPrint(&buf, "stretch tree of depth {d}\t check: {d}\n", .{ stretch_depth, stretch_tree.check() }) catch unreachable;
        _ = std.c.write(1, msg.ptr, msg.len);
    }
    const long_lived_tree = Node.make(max_depth, global_allocator).?;
    defer long_lived_tree.deinit();

    var depth: usize = MIN_DEPTH;
    while (depth <= max_depth) : (depth += 2) {
        const iterations = @as(usize, 1) << @as(u6, @intCast(max_depth - depth + MIN_DEPTH));
        var sum: usize = 0;
        var i: usize = 0;
        while (i < iterations) : (i += 1) {
            const tree = Node.make(depth, global_allocator).?;
            defer tree.deinit();
            sum += tree.check();
        }
        const msg = std.fmt.bufPrint(&buf, "{d}\t trees of depth {d}\t check: {d}\n", .{ iterations, depth, sum }) catch unreachable;
        _ = std.c.write(1, msg.ptr, msg.len);
    }

    const msg = std.fmt.bufPrint(&buf, "long lived tree of depth {d}\t check: {d}\n", .{ max_depth, long_lived_tree.check() }) catch unreachable;
    _ = std.c.write(1, msg.ptr, msg.len);
}

fn getN(init: std.process.Init) !usize {
    var arg_iter = try std.process.Args.iterateAllocator(init.minimal.args, init.gpa);
    defer arg_iter.deinit();
    _ = arg_iter.skip();
    const arg = arg_iter.next() orelse return 10;
    return try std.fmt.parseInt(usize, arg, 10);
}

const Node = struct {
    const Self = @This();

    allocator: Allocator,

    left: ?*Self = null,
    right: ?*Self = null,

    pub fn init(allocator: Allocator) !*Self {
        const node = try allocator.create(Self);
        node.* = .{ .allocator = allocator };
        return node;
    }

    pub fn deinit(self: *Self) void {
        if (self.left != null) {
            self.left.?.deinit();
        }
        if (self.right != null) {
            self.right.?.deinit();
        }
        self.allocator.destroy(self);
    }

    pub fn make(depth: usize, allocator: Allocator) ?*Self {
        var node = Self.init(allocator) catch return null;
        if (depth > 0) {
            const d = depth - 1;
            node.left = Self.make(d, allocator);
            node.right = Self.make(d, allocator);
        }
        return node;
    }

    pub fn check(self: *Self) usize {
        var sum: usize = 1;
        if (self.left != null) {
            sum += self.left.?.check();
        }
        if (self.right != null) {
            sum += self.right.?.check();
        }
        return sum;
    }
};
