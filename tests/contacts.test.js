const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeEmail, normalizePhone } = require("../src/contacts");

test("email normalization trims whitespace and ignores letter case", () => {
  assert.equal(normalizeEmail("  Jane.Doe@Example.com "), "jane.doe@example.com");
  assert.equal(normalizeEmail(""), null);
});

test("phone normalization retains digits with a leading plus sign", () => {
  assert.equal(normalizePhone("(415) 555-0100"), "+4155550100");
  assert.equal(normalizePhone("no phone"), null);
});
