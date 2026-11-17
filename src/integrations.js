const https = require("node:https");
const http = require("node:http");

class GhlApiError extends Error {
  constructor(message, statusCode, retryAfterMs = 0) {
    super(message);
    this.name = "GhlApiError";
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
    this.retryable =
      statusCode === undefined || statusCode === 408 || statusCode === 429 || statusCode >= 500;
  }
}

function getGhlAccountConfig(accountId, env = process.env) {
  let accounts;
  try {
    accounts = JSON.parse(env.GHL_ACCOUNT_CONFIG_JSON || "{}");
  } catch {
    throw new Error("GHL_ACCOUNT_CONFIG_JSON must contain valid JSON");
  }

  const config = accounts[accountId];
  if (!config || typeof config !== "object") {
    throw new Error(`No GHL configuration found for account "${accountId}"`);
  }
  if (!config.locationId || !config.tokenEnv) {
    throw new Error(`GHL configuration for "${accountId}" requires locationId and tokenEnv`);
  }
  const accessToken = env[config.tokenEnv];
  if (!accessToken) {
    throw new Error(`GHL token environment variable "${config.tokenEnv}" is not set`);
  }

  return { locationId: config.locationId, accessToken };
}

function contactPayload(contact, locationId) {
  const payload = {
    ...(locationId ? { locationId } : {}),
    ...(contact.first_name ? { firstName: contact.first_name } : {}),
    ...(contact.last_name ? { lastName: contact.last_name } : {}),
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
    ...(contact.company_name ? { companyName: contact.company_name } : {})
  };
  if (Object.keys(payload).length === (locationId ? 1 : 0)) {
    throw new Error("Contact has no fields to sync to GoHighLevel");
  }
  return payload;
}

function retryAfterMilliseconds(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

function responseMessage(body, statusCode) {
  const apiMessage = body && typeof body.message === "string" ? body.message.slice(0, 300) : "";
  return `GoHighLevel API returned HTTP ${statusCode}${apiMessage ? `: ${apiMessage}` : ""}`;
}

function createGhlClient({ env = process.env, fetchImpl = fetch } = {}) {
  const baseUrl = (env.GHL_API_BASE_URL || "https://services.leadconnectorhq.com").replace(/\/+$/, "");
  const version = env.GHL_API_VERSION || "2021-07-28";
  const timeoutMs = Number.parseInt(env.GHL_REQUEST_TIMEOUT_MS || "10000", 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("GHL_REQUEST_TIMEOUT_MS must be a positive integer");
  }

  return {
    async syncContact(accountId, contact, ghlContactId) {
      const { locationId, accessToken } = getGhlAccountConfig(accountId, env);
      const isUpdate = Boolean(ghlContactId);
      const endpoint = isUpdate
        ? `/contacts/${encodeURIComponent(ghlContactId)}`
        : "/contacts/upsert";
      const payload = contactPayload(contact, isUpdate ? null : locationId);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetchImpl(`${baseUrl}${endpoint}`, {
          method: isUpdate ? "PUT" : "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Version: version
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } catch (error) {
        if (error.name === "AbortError") {
          throw new GhlApiError(`GoHighLevel request timed out after ${timeoutMs} ms`);
        }
        throw new GhlApiError(`GoHighLevel request failed: ${error.message}`);
      } finally {
        clearTimeout(timeout);
      }

      const responseText = await response.text();
      let body = {};
      if (responseText) {
        try {
          body = JSON.parse(responseText);
        } catch {
          if (response.ok) throw new Error("GoHighLevel returned a non-JSON success response");
        }
      }
      if (!response.ok) {
        throw new GhlApiError(
          responseMessage(body, response.status),
          response.status,
          retryAfterMilliseconds(response.headers.get("retry-after"))
        );
      }
      if (body.succeeded === false) {
        throw new Error("GoHighLevel returned HTTP success but marked the contact update as unsuccessful");
      }

      const returnedId =
        body.contact?.id ||
        body.contactId ||
        body.id ||
        (isUpdate ? ghlContactId : null);
      if (!returnedId) {
        throw new Error("GoHighLevel succeeded but did not return a contact ID");
      }
      return returnedId;
    }
  };
}

async function syncContact(client, accountId, contact, ghlContactId = null) {
  const mode = process.env.GHL_MODE || "mock";
  if (mode === "mock") {
    const message = "Mock only: contact sync was recorded, not sent to GoHighLevel";
    await client.query(
      `INSERT INTO ghl_sync_logs (contact_id, account_id, mode, outcome, message)
       VALUES ($1, $2, $3, 'simulated', $4)`,
      [contact.id, accountId, mode, message]
    );
    console.info(`[GHL mock] Account ${accountId}: ${message}`);
    return ghlContactId;
  }
  if (mode !== "real") {
    throw new Error(`Unsupported GHL_MODE "${mode}". Set it to "mock" or "real".`);
  }

  const syncedContactId = await createGhlClient().syncContact(
    accountId,
    contact,
    ghlContactId
  );
  await client.query(
    `INSERT INTO ghl_sync_logs (contact_id, account_id, mode, outcome, message)
     VALUES ($1, $2, $3, 'synced', $4)`,
    [contact.id, accountId, mode, "Contact synced to GoHighLevel"]
  );
  return syncedContactId;
}

function sendSlackAlert(event, error) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return Promise.resolve();

  const target = new URL(webhookUrl);
  const transport = target.protocol === "https:" ? https : http;
  const body = JSON.stringify({
    text: `GHL Hub event failed. Account: ${event.account_id || "unknown"}; source: ${event.source}; event: ${event.external_event_id}; reason: ${error.message}`
  });

  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      { method: "POST", headers: { "content-type": "application/json" } },
      (response) => {
        response.resume();
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Slack webhook returned HTTP ${response.statusCode}`));
          return;
        }
        resolve();
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  const crypto = require("node:crypto");
  const parts = String(signatureHeader || "").split(",");
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return signatures.some((signature) => {
    if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature, "hex");
    return crypto.timingSafeEqual(actual, expectedBuffer);
  });
}

module.exports = {
  createGhlClient,
  getGhlAccountConfig,
  GhlApiError,
  sendSlackAlert,
  syncContact,
  verifyStripeSignature
};
