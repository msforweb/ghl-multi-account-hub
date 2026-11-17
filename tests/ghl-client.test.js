const test = require("node:test");
const assert = require("node:assert/strict");
const { createGhlClient, GhlApiError } = require("../src/integrations");

const env = {
  GHL_API_BASE_URL: "https://ghl.example.test",
  GHL_API_VERSION: "2021-07-28",
  GHL_ACCOUNT_CONFIG_JSON: JSON.stringify({
    "brand-a": { locationId: "location-123", tokenEnv: "GHL_TOKEN_BRAND_A" }
  }),
  GHL_TOKEN_BRAND_A: "test-access-token"
};
const contact = {
  first_name: "Jane",
  last_name: "Doe",
  email: "jane@example.com",
  phone: "+15125550100",
  company_name: "Example Services"
};

test("GHL client upserts a contact by location when no remote ID is known", async () => {
  let request;
  const client = createGhlClient({
    env,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ contact: { id: "ghl-contact-1" }, new: true }),
        headers: new Headers()
      };
    }
  });

  const id = await client.syncContact("brand-a", contact);
  assert.equal(id, "ghl-contact-1");
  assert.equal(request.url, "https://ghl.example.test/contacts/upsert");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test-access-token");
  assert.equal(request.options.headers.Version, "2021-07-28");
  assert.deepEqual(JSON.parse(request.options.body), {
    locationId: "location-123",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: "+15125550100",
    companyName: "Example Services"
  });
});

test("GHL client updates a known account-specific contact ID", async () => {
  let request;
  const client = createGhlClient({
    env,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ succeeded: true }),
        headers: new Headers()
      };
    }
  });

  const id = await client.syncContact("brand-a", contact, "existing-contact");
  assert.equal(id, "existing-contact");
  assert.equal(request.url, "https://ghl.example.test/contacts/existing-contact");
  assert.equal(request.options.method, "PUT");
  assert.equal("locationId" in JSON.parse(request.options.body), false);
});

test("GHL client exposes rate-limit retry information", async () => {
  const client = createGhlClient({
    env,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ message: "Too many requests" }),
      headers: new Headers({ "retry-after": "2" })
    })
  });

  await assert.rejects(
    client.syncContact("brand-a", contact),
    (error) =>
      error instanceof GhlApiError &&
      error.statusCode === 429 &&
      error.retryable === true &&
      error.retryAfterMs === 2000
  );
});
