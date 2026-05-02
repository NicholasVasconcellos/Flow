import test from "node:test";
import assert from "node:assert/strict";

import { slugifyTitle } from "../src/ids.js";

test("slugifyTitle: lowercases and collapses whitespace runs", () => {
  assert.equal(slugifyTitle("Hello World"), "hello-world");
  assert.equal(slugifyTitle("Hello   World"), "hello-world");
});

test("slugifyTitle: collapses any non-alphanumeric run", () => {
  assert.equal(slugifyTitle("Foo / Bar — Baz!"), "foo-bar-baz");
  assert.equal(slugifyTitle("a___b...c"), "a-b-c");
});

test("slugifyTitle: trims leading and trailing separators", () => {
  assert.equal(slugifyTitle("  hello  "), "hello");
  assert.equal(slugifyTitle("--hello--"), "hello");
});

test("slugifyTitle: returns empty string when input has no alphanumerics", () => {
  assert.equal(slugifyTitle("!!!"), "");
  assert.equal(slugifyTitle("   "), "");
  assert.equal(slugifyTitle(""), "");
});

test("slugifyTitle: truncates at 64 chars without leaving a trailing dash", () => {
  // 65-char title: "a" * 32 + " " + "b" * 32 → slug "aaaa…-bbbb…" of length 65.
  // Truncation lands inside the second run; trailing-dash strip not triggered.
  const long = "a".repeat(32) + " " + "b".repeat(32);
  const slug = slugifyTitle(long);
  assert.equal(slug.length, 64);
  assert.ok(!slug.endsWith("-"), "trailing dash should be stripped");

  // Boundary case: separator falls exactly at position 64. Truncation cuts
  // immediately before, then the trailing-dash strip removes nothing because
  // the separator was already cut. Confirm no dash leaks through.
  const exact = "a".repeat(64) + " tail";
  const slugExact = slugifyTitle(exact);
  assert.equal(slugExact, "a".repeat(64));

  // Truncation that *would* leave a trailing dash is cleaned up.
  const dashy = "a".repeat(63) + " b"; // "aaa…a-b" → slice(0,64) = "aaa…a-"
  const slugDashy = slugifyTitle(dashy);
  assert.ok(!slugDashy.endsWith("-"));
  assert.equal(slugDashy, "a".repeat(63));
});
