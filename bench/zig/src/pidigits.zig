// From https://github.com/hanabi1224/Programming-Language-Benchmarks/blob/main/bench/algorithm/pidigits/1.zig

const std = @import("std");
const bigint = std.math.big.int;

pub fn pidigits(n: usize, allocator: std.mem.Allocator) !void {
    var one = try bigint.Managed.initSet(allocator, 1);
    defer one.deinit();
    var two = try bigint.Managed.initSet(allocator, 2);
    defer two.deinit();
    var ten = try bigint.Managed.initSet(allocator, 10);
    defer ten.deinit();

    var k = try bigint.Managed.initSet(allocator, 1);
    defer k.deinit();
    var n1 = try bigint.Managed.initSet(allocator, 4);
    defer n1.deinit();
    var n2 = try bigint.Managed.initSet(allocator, 3);
    defer n2.deinit();
    var d = try bigint.Managed.initSet(allocator, 1);
    defer d.deinit();
    var tmp = try bigint.Managed.init(allocator);
    defer tmp.deinit();
    var tmp2 = try bigint.Managed.init(allocator);
    defer tmp2.deinit();
    var v = try bigint.Managed.init(allocator);
    defer v.deinit();
    var u = try bigint.Managed.init(allocator);
    defer u.deinit();
    var w = try bigint.Managed.init(allocator);
    defer w.deinit();

    var digits_printed: usize = 0;
    var lbuf: [10]std.math.big.Limb = undefined;
    var sb: [10]u8 = undefined;
    while (true) {
        try bigint.Managed.divFloor(&u, &tmp, &n1, &d);
        try bigint.Managed.divFloor(&v, &tmp, &n2, &d);
        if (bigint.Managed.eql(u, v)) {
            const rem = @rem(digits_printed, 10);
            _ = u.toConst().toString(sb[rem..], 10, .lower, &lbuf);
            digits_printed += 1;
            if (rem == 9) {}

            if (digits_printed >= n) {
                break;
            }
            try bigint.Managed.mul(&tmp, &u, &d);
            try bigint.Managed.mul(&tmp2, &tmp, &ten);
            try bigint.Managed.mul(&tmp, &n1, &ten);
            try bigint.Managed.sub(&n1, &tmp, &tmp2);
            try bigint.Managed.mul(&tmp, &n2, &ten);
            try bigint.Managed.sub(&n2, &tmp, &tmp2);
        } else {
            try bigint.Managed.mul(&tmp2, &k, &two);
            try bigint.Managed.sub(&tmp, &tmp2, &one);
            try bigint.Managed.mul(&u, &tmp, &n1);
            try bigint.Managed.mul(&v, &n2, &two);
            try bigint.Managed.sub(&tmp, &k, &one);
            try bigint.Managed.mul(&w, &tmp, &n1);
            try bigint.Managed.add(&n1, &u, &v);
            try bigint.Managed.add(&tmp, &k, &two);
            try bigint.Managed.mul(&u, &tmp, &n2);
            try bigint.Managed.add(&n2, &w, &u);
            try bigint.Managed.add(&tmp, &tmp2, &one);
            try bigint.Managed.mul(&d, &tmp, &d);
            try bigint.Managed.add(&k, &k, &one);
        }
    }
}

pub fn pidigits_to_string(n: usize, allocator: std.mem.Allocator) ![]const u8 {
    var one = try bigint.Managed.initSet(allocator, 1);
    defer one.deinit();
    var two = try bigint.Managed.initSet(allocator, 2);
    defer two.deinit();
    var ten = try bigint.Managed.initSet(allocator, 10);
    defer ten.deinit();

    var k = try bigint.Managed.initSet(allocator, 1);
    defer k.deinit();
    var n1 = try bigint.Managed.initSet(allocator, 4);
    defer n1.deinit();
    var n2 = try bigint.Managed.initSet(allocator, 3);
    defer n2.deinit();
    var d = try bigint.Managed.initSet(allocator, 1);
    defer d.deinit();
    var tmp = try bigint.Managed.init(allocator);
    defer tmp.deinit();
    var tmp2 = try bigint.Managed.init(allocator);
    defer tmp2.deinit();
    var v = try bigint.Managed.init(allocator);
    defer v.deinit();
    var u = try bigint.Managed.init(allocator);
    defer u.deinit();
    var w = try bigint.Managed.init(allocator);
    defer w.deinit();

    var result = std.ArrayList(u8).empty;
    defer result.deinit(allocator);

    var digits_printed: usize = 0;
    while (true) {
        try bigint.Managed.divFloor(&u, &tmp, &n1, &d);
        try bigint.Managed.divFloor(&v, &tmp, &n2, &d);
        if (bigint.Managed.eql(u, v)) {
            const digit_str = try u.toConst().toStringAlloc(allocator, 10, .lower);
            defer allocator.free(digit_str);
            try result.appendSlice(allocator, digit_str);
            digits_printed += 1;

            if (digits_printed >= n) {
                break;
            }
            try bigint.Managed.mul(&tmp, &u, &d);
            try bigint.Managed.mul(&tmp2, &tmp, &ten);
            try bigint.Managed.mul(&tmp, &n1, &ten);
            try bigint.Managed.sub(&n1, &tmp, &tmp2);
            try bigint.Managed.mul(&tmp, &n2, &ten);
            try bigint.Managed.sub(&n2, &tmp, &tmp2);
        } else {
            try bigint.Managed.mul(&tmp2, &k, &two);
            try bigint.Managed.sub(&tmp, &tmp2, &one);
            try bigint.Managed.mul(&u, &tmp, &n1);
            try bigint.Managed.mul(&v, &n2, &two);
            try bigint.Managed.sub(&tmp, &k, &one);
            try bigint.Managed.mul(&w, &tmp, &n1);
            try bigint.Managed.add(&n1, &u, &v);
            try bigint.Managed.add(&tmp, &k, &two);
            try bigint.Managed.mul(&u, &tmp, &n2);
            try bigint.Managed.add(&n2, &w, &u);
            try bigint.Managed.add(&tmp, &tmp2, &one);
            try bigint.Managed.mul(&d, &tmp, &d);
            try bigint.Managed.add(&k, &k, &one);
        }
    }

    return result.toOwnedSlice(allocator);
}

test "pidigits first 10 digits" {
    const gpa = std.testing.allocator;
    const result = try pidigits_to_string(10, gpa);
    defer gpa.free(result);
    try std.testing.expectEqualStrings("3141592653", result);
}

test "pidigits first 100 digits" {
    const gpa = std.testing.allocator;
    const result = try pidigits_to_string(100, gpa);
    defer gpa.free(result);
    try std.testing.expectEqualStrings("3141592653589793238462643383279502884197169399375105820974944592307816406286208998628034825342117067", result);
}

//test "pidigits first 8000 digits" {
//    const gpa = std.testing.allocator;
//    const result = try pidigits_to_string(8000, gpa);
//    defer gpa.free(result);
//    //try std.testing.expectEqualStrings("3141592653589793238462643383279502884197169399375105820974944592307816406286208998628034825342117067", result);
//}

test "pidigits just runs" {
    const gpa = std.testing.allocator;
    try pidigits(100, gpa);
}
