require("dotenv").config();

const { createServer } = require("node:http");
const { initializeDatabase, pool } = require("./db");
const { processWithRetries } = require("./processor");
const { verifyStripeSignature } = require("./integrations");

const maxBodyBytes = 1_000_000;
const validSources = new Set(["ghl", "form", "ads", "external", "stripe"]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new HttpError(413, "Request body exceeds 1 MB");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return { raw, body: JSON.parse(raw) };
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function validateEventBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
}

async function recordEvent(source, body, pool) {
  validateEventBody(body);
  const externalId = body.event_id || body.id;
  const eventType = body.event_type || body.type;
  if (typeof externalId !== "string" || !externalId.trim()) {
    throw new HttpError(400, "Request must include event_id (or id)");
  }
  if (typeof eventType !== "string" || !eventType.trim()) {
    throw new HttpError(400, "Request must include event_type (or type)");
  }

  const accountId =
    body.account_id ||
    body.data?.account_id ||
    body.data?.object?.metadata?.account_id ||
    null;
  const inserted = await pool.query(
    `INSERT INTO events
       (source, external_event_id, event_type, account_id, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source, external_event_id) DO NOTHING
     RETURNING *`,
    [source, externalId, eventType, accountId, body]
  );
  const event =
    inserted.rows[0] ||
    (await pool.query(
      "SELECT * FROM events WHERE source = $1 AND external_event_id = $2",
      [source, externalId]
    )).rows[0];
  return { event, isNew: inserted.rowCount === 1 };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function handleRequest(request, response) {
  try {
    const url = new URL(request.url, "http://localhost");
    const method = request.method;

    if (method === "GET" && url.pathname === "/health") {
      await pool.query("SELECT 1");
      send(response, 200, { status: "ok", database: "connected" });
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/webhooks/")) {
      const source = url.pathname.split("/")[2];
      if (!validSources.has(source)) throw new HttpError(404, "Unknown webhook source");
      const { raw, body } = await readBody(request);
      validateEventBody(body);

      if (source === "stripe" && process.env.STRIPE_WEBHOOK_SECRET) {
        const valid = verifyStripeSignature(
          raw,
          request.headers["stripe-signature"],
          process.env.STRIPE_WEBHOOK_SECRET
        );
        if (!valid) throw new HttpError(401, "Stripe signature is invalid");
      }

      const { event, isNew } = await recordEvent(source, body, pool);
      const result = isNew ? await processWithRetries(pool, event.id) : event;
      send(response, 202, {
        event_id: result.id,
        status: result.status,
        duplicate_delivery: !isNew,
        attempts: result.attempts,
        error: result.last_error
      });
      return;
    }

    const replayMatch = url.pathname.match(/^\/events\/([^/]+)\/replay$/);
    if (method === "POST" && replayMatch) {
      const eventId = replayMatch[1];
      if (!isUuid(eventId)) throw new HttpError(400, "Event ID must be a UUID");
      const reset = await pool.query(
        `UPDATE events SET status = 'received', last_error = NULL, updated_at = now()
         WHERE id = $1 AND status = 'failed' RETURNING id`,
        [eventId]
      );
      if (reset.rowCount === 0) {
        const existing = await pool.query("SELECT status FROM events WHERE id = $1", [eventId]);
        if (!existing.rowCount) throw new HttpError(404, "Event not found");
        throw new HttpError(409, `Only failed events can be replayed (current status: ${existing.rows[0].status})`);
      }
      const result = await processWithRetries(pool, eventId);
      send(response, 200, {
        event_id: result.id,
        status: result.status,
        attempts: result.attempts,
        error: result.last_error
      });
      return;
    }

    if (method === "GET" && url.pathname === "/events") {
      const status = url.searchParams.get("status");
      if (status && !["received", "processing", "processed", "failed"].includes(status)) {
        throw new HttpError(400, "Invalid event status filter");
      }
      const result = status
        ? await pool.query(
            `SELECT id, source, external_event_id, event_type, account_id, status,
                    attempts, last_error, created_at, updated_at
             FROM events WHERE status = $1 ORDER BY created_at DESC LIMIT 100`,
            [status]
          )
        : await pool.query(
            `SELECT id, source, external_event_id, event_type, account_id, status,
                    attempts, last_error, created_at, updated_at
             FROM events ORDER BY created_at DESC LIMIT 100`
          );
      send(response, 200, { events: result.rows });
      return;
    }

    if (method === "GET" && url.pathname === "/contacts") {
      const result = await pool.query(
        `SELECT c.id, c.email, c.phone, c.first_name, c.last_name, co.name AS company,
                c.created_at, c.updated_at
         FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
         ORDER BY c.created_at DESC LIMIT 100`
      );
      send(response, 200, { contacts: result.rows });
      return;
    }

    if (method === "GET" && url.pathname === "/leads") {
      const result = await pool.query(
        `SELECT id, contact_id, account_id, pipeline_id, source, location, service_type,
                status, external_id, created_at
         FROM leads ORDER BY created_at DESC LIMIT 100`
      );
      send(response, 200, { leads: result.rows });
      return;
    }

    if (method === "GET" && url.pathname === "/reports/summary") {
      const [leads, conversions, revenue] = await Promise.all([
        pool.query(
          `SELECT account_id, source, count(*)::int AS lead_count
           FROM leads GROUP BY account_id, source ORDER BY account_id, source`
        ),
        pool.query(
          `SELECT account_id, count(*)::int AS conversion_count
           FROM leads WHERE status = 'converted' GROUP BY account_id ORDER BY account_id`
        ),
        pool.query(
          `SELECT account_id, currency, sum(amount_cents)::bigint AS revenue_cents
           FROM payments WHERE status = 'succeeded'
           GROUP BY account_id, currency ORDER BY account_id, currency`
        )
      ]);
      send(response, 200, {
        leads_by_source_and_account: leads.rows,
        conversions_by_account: conversions.rows,
        revenue_by_account: revenue.rows
      });
      return;
    }

    if (method === "GET" && url.pathname === "/sync-logs") {
      const result = await pool.query(
        `SELECT account_id, contact_id, mode, outcome, message, created_at
         FROM ghl_sync_logs ORDER BY created_at DESC LIMIT 100`
      );
      send(response, 200, { sync_logs: result.rows });
      return;
    }

    throw new HttpError(404, "Route not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error(error);
    send(response, status, { error: error.message || "Internal server error" });
  }
}

async function start() {
  await initializeDatabase();
  const server = createServer(handleRequest);
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  server.listen(port, () => console.info(`GHL Hub POC listening on http://localhost:${port}`));

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
    });
  }
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Could not start GHL Hub POC:", error);
    process.exitCode = 1;
  });
}

module.exports = { handleRequest, recordEvent };
