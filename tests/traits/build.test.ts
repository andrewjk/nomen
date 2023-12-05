import { suite } from "uvu";
import assert from "uvu/assert";
import build from "../../src/build";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";

const test = suite("Trait build");

function trimCode(code: string) {
  return code
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();
}

test("trait", () => {
  const input = `
trait Person {}

struct Frank: Person {}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root);
  const expected = `
void **_get_trait_func(void **obj, int trait_index, int func_index) {
  void **trait = *(obj + trait_index);
  return *(trait + func_index);
}

// Frank:
void *_Frank_Person_funcs[1] = {

};
void *_Frank_traits[1] = {
  [0] = _Frank_Person_funcs
};
typedef struct Frank {
  void *_vt;
} Frank;
Frank Frank_init() {
  Frank f;
  f._vt = &_Frank_traits;
  return f;
}
`;
  assert.equal(trimCode(result.code), expected.trim());
});

test("trait with fields", () => {
  const input = `
trait Person {
  var name: string
  var age = 0
}

struct Frank: Person {
  var name = "Frank"
}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root);
  const expected = `
void **_get_trait_func(void **obj, int trait_index, int func_index) {
  void **trait = *(obj + trait_index);
  return *(trait + func_index);
}

// Frank:
void *_Frank_Person_funcs[1] = {

};
void *_Frank_traits[1] = {
  [0] = _Frank_Person_funcs
};
typedef struct Frank {
  void *_vt;
  char* name;
  int age;
} Frank;
Frank Frank_init() {
  Frank f;
  f._vt = &_Frank_traits;
  f.name = "Frank";
  f.age = 0;
  return f;
}
`;
  assert.equal(trimCode(result.code), expected.trim());
});

test("trait with functions", () => {
  const input = `
trait Person {
  func greet() {}
}

struct Frank: Person {
  func greet() -> string {
    return "hi"
  }
}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root);
  const expected = `
void **_get_trait_func(void **obj, int trait_index, int func_index) {
  void **trait = *(obj + trait_index);
  return *(trait + func_index);
}

// Person:
typedef struct Person {} Person;
void Person_greet(struct Person this) {
}

// Frank:
void *_Frank_Person_funcs[1] = {
  [0] = Frank_greet
};
void *_Frank_traits[1] = {
  [0] = _Frank_Person_funcs
};
typedef struct Frank {
  void *_vt;
} Frank;
Frank Frank_init() {
  Frank f;
  f._vt = &_Frank_traits;
  return f;
}
char* Frank_greet(struct Frank this) {
  return "hi";
}
`;
  assert.equal(trimCode(result.code), expected.trim());
});

test("trait with implemented functions", () => {
  const input = `
trait Person {
  func greet() {
    return "hi"
  }
}

struct Frank: Person {
  func greet() -> string {
    return "hi"
  }
}
`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const result = build(parsed.root);
  const expected = `
void **_get_trait_func(void **obj, int trait_index, int func_index) {
  void **trait = *(obj + trait_index);
  return *(trait + func_index);
}

// Person:
typedef struct Person {} Person;
void Person_greet(struct Person this) {
  return "hi";
}

// Frank:
void *_Frank_Person_funcs[1] = {
  [0] = Frank_greet
};
void *_Frank_traits[1] = {
  [0] = _Frank_Person_funcs
};
typedef struct Frank {
  void *_vt;
} Frank;
Frank Frank_init() {
  Frank f;
  f._vt = &_Frank_traits;
  return f;
}
char* Frank_greet(struct Frank this) {
  return "hi";
}
`;
  assert.equal(trimCode(result.code), expected.trim());
});

test.run();
