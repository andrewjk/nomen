import { expect, describe, test } from "vitest";
import build from "../src/build";
import parse from "../src/parse";
import trim_test_build from "./trim_test_build";
import test_error from "./test_error";

// BUILD
describe("custom operator build", () => {
  test("add operator on struct", () => {
    const input = `
struct Point {
  var int x
  var int y
  pub op + (self, Point other, out Point) -> {
    return Point(self.x + other.x, self.y + other.y)
  }
}
const p1 = Point(1, 2)
const p2 = Point(3, 4)
const p3 = p1 + p2
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
typedef struct Point
{
void *_vt;
long x;
long y;
} Point;
Point Point_init(long x, long y)
{
Point p;
p.x = x;
p.y = y;
return p;
}
struct Point Point_add(struct Point *self, struct Point *other)
{
struct Point _self = *self;
return long _param_0 = _self.x + other.x;
long _param_1 = _self.y + other.y;
Point_init(_param_0, _param_1);
}
Point p1 = Point_init(1, 2);
Point p2 = Point_init(3, 4);
Point p3 = Point_add(&p1, &p2);
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });

  test("multiply operator on struct", () => {
    const input = `
struct Point {
  var int x
  var int y
  pub op * (self, int scalar, out Point) -> {
    return Point(self.x * scalar, self.y * scalar)
  }
}
const p1 = Point(2, 3)
const p2 = p1 * 4
`;
    const parsed = parse(input);
    const result = build(parsed.root);
    const expected = `
typedef struct Point
{
void *_vt;
long x;
long y;
} Point;
Point Point_init(long x, long y)
{
Point p;
p.x = x;
p.y = y;
return p;
}
struct Point Point_mul(struct Point *self, long scalar)
{
struct Point _self = *self;
return long _param_0 = _self.x * scalar;
long _param_1 = _self.y * scalar;
Point_init(_param_0, _param_1);
}
Point p1 = Point_init(2, 3);
Point p2 = Point_mul(&p1, 4);
`;
    expect(parsed.errors).toEqual([]);
    expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
  });
});

// ERRORS
describe("custom operator errors", () => {
  test("operator function not found", () => {
    const input = `
struct Point {
  var int x
  var int y
}
const p1 = Point(1, 2)
const p2 = Point(3, 4)
const p3 = p1 + p2
`;
    const expected = [
      test_error(input, "No operator + defined for type Point", 8, 12),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });

  test("operator param type mismatch", () => {
    const input = `
struct Point {
  var int x
  var int y
  op + (self, Point other, out Point) -> {
    return Point(self.x + other.x, self.y + other.y)
  }
}
const p1 = Point(1, 2)
const p3 = p1 + 5
`;
    const expected = [
      test_error(input, "Type mismatch in param: int (expected Point)", 10, 17),
    ];
    const parsed = parse(input);
    expect(parsed.errors).toEqual(expected);
  });
});
