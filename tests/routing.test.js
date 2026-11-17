const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseRoute } = require("../src/routing");

const rules = [
  { source: "*", location: "*", service_type: "*", account_id: "default", pipeline_id: "inbox" },
  { source: "google_ads", location: "*", service_type: "*", account_id: "ads", pipeline_id: "ads-inbox" },
  { source: "google_ads", location: "austin", service_type: "plumbing", account_id: "local", pipeline_id: "plumbing" }
];

test("routing picks the most specific matching rule without case sensitivity", () => {
  assert.equal(
    chooseRoute({ source: "Google_Ads", location: "Austin", service_type: "Plumbing" }, rules).account_id,
    "local"
  );
});

test("routing falls back to a general matching rule", () => {
  assert.equal(
    chooseRoute({ source: "google_ads", location: "Dallas", service_type: "roofing" }, rules).account_id,
    "ads"
  );
});

test("routing returns null when no rule matches", () => {
  assert.equal(chooseRoute({ source: "unknown" }, []), null);
});
