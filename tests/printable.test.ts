import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, printable, printableDeep, printableLine } from "../src/printable.ts";

await test("escape sequences and control characters go; tabs, newlines and every printable character stay", () => {
  assert.equal(printable("\x1b[31mred\x1b[0m \x1b]52;c;aGk=\x07\x1b]8;;http://e\x1b\\link\x1b]8;;\x1b\\"), "red link");
  assert.equal(printable("a\u009b2Jb\x7fc\x00d\x07e"), "a2Jbcde");
  assert.equal(printable("one\r\ntwo\rthree\tfour"), "one\ntwo\nthree\tfour");
  assert.equal(printable("é 👩‍💻 ｗｉｄｅ"), "é 👩‍💻 ｗｉｄｅ");
});

await test("a line has no newlines, and its runs of whitespace are single spaces", () => {
  assert.equal(printableLine("  ali\n\tce \x1b[2J "), "ali ce");
});

await test("every string of an object is made printable, and nothing else changes", () => {
  assert.deepEqual(printableDeep({ a: ["x\x1b[2J", { b: "\u009bq" }], n: 1, z: null }), { a: ["x", { b: "q" }], n: 1, z: null });
});

await test("clip never splits a surrogate pair", () => {
  assert.equal(clip("ab😀", 3), "ab");
  assert.equal(clip("ab😀", 4), "ab😀");
  assert.equal(clip("abc", 5), "abc");
});
