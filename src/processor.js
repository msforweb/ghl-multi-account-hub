const { upsertContact } = require("./contacts");
const { sendSlackAlert, syncContact } = require("./integrations");
const { chooseRoute } = require("./routing");

const retryCount = Number.parseInt(process.env.MAX_RETRIES || "3", 10);
const maxRetries = Number.isInteger(retryCount) && retryCount > 0 ? retryCount : 3;

async function saveAccountContact(client, accountId, contactId, ghlContactId) {
  if (!accountId) return;
  await client.query(
    `INSERT INTO account_contacts (account_id, contact_id, ghl_contact_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id, contact_id)
     DO UPDATE SET ghl_contact_id = COALESCE(EXCLUDED.ghl_contact_id, account_contacts.ghl_contact_id)`,
    [accountId, contactId, ghlContactId || null]
  );
}

async function processLead(client, event) {
  const data = event.payload.data;
  if (!data || !data.contact) throw new Error("Lead event is missing data.contact");
  const contact = await upsertContact(client, data.contact);
  const source = data.lead_source || data.source || event.source;
  const route = chooseRoute({
    source,
    location: data.location,
    service_type: data.service_type
  });
  if (!route) throw new Error("No routing rule matched the lead");

  await client.query(
    `INSERT INTO leads
       (contact_id, account_id, pipeline_id, source, location, service_type, status, external_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id, external_id) DO NOTHING`,
    [
      contact.id,
      route.account_id,
      route.pipeline_id,
      source,
      data.location || null,
      data.service_type || null,
      data.status || "new",
      data.external_id || event.external_event_id
    ]
  );
  const existing = await client.query(
    `SELECT ghl_contact_id FROM account_contacts
     WHERE account_id = $1 AND contact_id = $2`,
    [route.account_id, contact.id]
  );
  const ghlContactId = await syncContact(
    client,
    route.account_id,
    contact,
    existing.rows[0]?.ghl_contact_id
  );
  await saveAccountContact(client, route.account_id, contact.id, ghlContactId);
}

async function processGhlEvent(client, event) {
  const data = event.payload.data;
  if (!data || !data.contact) throw new Error("GHL event is missing data.contact");
  const contact = await upsertContact(client, data.contact);
  const accountId = event.account_id || data.account_id;
  if (!accountId) throw new Error("GHL event is missing account_id");
  await saveAccountContact(client, accountId, contact.id, data.ghl_contact_id || data.contact.id);

  if (event.event_type.startsWith("lead.")) {
    const route = chooseRoute({
      source: data.lead_source || "ghl",
      location: data.location,
      service_type: data.service_type
    });
    if (!route) throw new Error("No routing rule matched the GHL lead");
    await client.query(
      `INSERT INTO leads
         (contact_id, account_id, pipeline_id, source, location, service_type, status, external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (account_id, external_id) DO NOTHING`,
      [
        contact.id,
        accountId,
        data.pipeline_id || route.pipeline_id,
        data.lead_source || "ghl",
        data.location || null,
        data.service_type || null,
        data.status || "new",
        data.external_id || event.external_event_id
      ]
    );
  }
}

function stripeContactDetails(object) {
  const metadata = object.metadata || {};
  const customerDetails = object.customer_details || {};
  return {
    email: metadata.email || metadata.contact_email || object.receipt_email || object.customer_email || customerDetails.email,
    phone: metadata.phone || metadata.contact_phone || customerDetails.phone,
    first_name: metadata.first_name || customerDetails.name?.split(/\s+/, 2)[0],
    last_name: metadata.last_name || customerDetails.name?.split(/\s+/, 2)[1],
    company_name: metadata.company_name
  };
}

async function processStripeEvent(client, event) {
  const object = event.payload.data?.object;
  if (!object) throw new Error("Stripe event is missing data.object");
  const metadata = object.metadata || {};
  const accountId = metadata.account_id || event.account_id;
  if (!accountId) throw new Error("Stripe event is missing metadata.account_id");
  const contact = await upsertContact(client, stripeContactDetails(object));
  await saveAccountContact(client, accountId, contact.id);

  if (event.event_type === "payment_intent.succeeded" || event.event_type === "invoice.payment_succeeded") {
    if (typeof object.id !== "string" || !object.id) {
      throw new Error("Stripe payment is missing its object ID");
    }
    const amount = object.amount_received ?? object.amount_paid ?? object.amount;
    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error("Stripe payment is missing a valid amount in cents");
    }
    await client.query(
      `INSERT INTO payments
         (stripe_payment_id, contact_id, account_id, amount_cents, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'succeeded')
       ON CONFLICT (stripe_payment_id) DO UPDATE SET status = 'succeeded'`,
      [object.id, contact.id, accountId, amount, object.currency || "usd"]
    );
    return;
  }

  if (event.event_type.startsWith("customer.subscription.")) {
    if (typeof object.id !== "string" || !object.id) {
      throw new Error("Stripe subscription is missing its object ID");
    }
    const periodEnd = object.current_period_end
      ? new Date(object.current_period_end * 1000)
      : null;
    await client.query(
      `INSERT INTO subscriptions
         (stripe_subscription_id, contact_id, account_id, status, current_period_end)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stripe_subscription_id)
       DO UPDATE SET status = EXCLUDED.status,
                     current_period_end = EXCLUDED.current_period_end,
                     updated_at = now()`,
      [object.id, contact.id, accountId, object.status || event.event_type, periodEnd]
    );
    return;
  }

  throw new Error(`Unsupported Stripe event type: ${event.event_type}`);
}

async function processOnce(pool, eventId) {
  const client = await pool.connect();
  let event;
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    event = result.rows[0];
    if (!event) throw new Error("Event not found");
    if (event.status === "processed") {
      await client.query("COMMIT");
      return event;
    }
    if (event.status === "processing") {
      await client.query("COMMIT");
      return event;
    }
    await client.query(
      `UPDATE events SET status = 'processing', attempts = attempts + 1,
       last_error = NULL, updated_at = now() WHERE id = $1`,
      [eventId]
    );
    await client.query("COMMIT");

    await client.query("BEGIN");
    if (event.source === "stripe") {
      await processStripeEvent(client, event);
    } else if (event.source === "ghl") {
      await processGhlEvent(client, event);
    } else if (event.event_type.startsWith("lead.")) {
      await processLead(client, event);
    } else {
      throw new Error(`Unsupported event type: ${event.event_type}`);
    }
    await client.query(
      `UPDATE events SET status = 'processed', last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [eventId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (event) {
      await client.query(
        `UPDATE events SET status = 'failed', last_error = $2, updated_at = now()
         WHERE id = $1 AND status != 'processed'`,
        [eventId, error.message]
      );
    }
    throw error;
  } finally {
    client.release();
  }

  const refreshed = await pool.query("SELECT * FROM events WHERE id = $1", [eventId]);
  return refreshed.rows[0];
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function processWithRetries(pool, eventId) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await processOnce(pool, eventId);
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt + 1 >= maxRetries) break;
      const delay = error.retryAfterMs || 100 * 2 ** attempt;
      await wait(Math.min(delay, 60_000));
    }
  }

  const result = await pool.query("SELECT * FROM events WHERE id = $1", [eventId]);
  const event = result.rows[0];
  if (event) {
    try {
      await sendSlackAlert(event, lastError);
    } catch (error) {
      console.error(`Slack alert failed for event ${event.external_event_id}: ${error.message}`);
    }
  }
  return event;
}

module.exports = { processWithRetries };
