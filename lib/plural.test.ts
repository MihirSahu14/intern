import assert from "node:assert/strict";
import { test } from "node:test";
import { plural } from "./plural.ts";

test("singular count uses the singular form", () => {
  assert.equal(plural(1, "person", "people"), "1 person");
});

test("zero uses the plural form", () => {
  assert.equal(plural(0, "person", "people"), "0 people");
});

test("plural count uses an explicit irregular plural", () => {
  assert.equal(plural(2, "person", "people"), "2 people");
});

test("plural defaults to singular + s when no plural form is given", () => {
  assert.equal(plural(2, "fact"), "2 facts");
  assert.equal(plural(1, "fact"), "1 fact");
});
