const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { verifyStripeSignature } = require("../src/integrations");

function sign(rawBody, secret, timestamp) {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

test("Stripe signature verification accepts a fresh valid signature", () => {
  const rawBody = '{"id":"evt_test"}';
  const timestamp = Math.floor(Date.now() / 1000);
  assert.equal(verifyStripeSignature(rawBody, sign(rawBody, "test-secret", timestamp), "test-secret"), true);
});

test("Stripe signature verification rejects invalid and stale signatures", () => {
  const rawBody = '{"id":"evt_test"}';
  const timestamp = Math.floor(Date.now() / 1000);
  assert.equal(verifyStripeSignature(rawBody, sign(rawBody, "other-secret", timestamp), "test-secret"), false);
  assert.equal(verifyStripeSignature(rawBody, sign(rawBody, "test-secret", timestamp - 600), "test-secret"), false);
});
