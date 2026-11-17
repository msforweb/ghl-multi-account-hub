function normalizeEmail(email) {
  if (typeof email !== "string" || !email.trim()) return null;
  return email.trim().toLowerCase();
}

function normalizePhone(phone) {
  if (typeof phone !== "string" || !phone.trim()) return null;
  const digits = phone.replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function upsertContact(client, input) {
  const email = cleanText(input.email);
  const phone = cleanText(input.phone);
  const emailNorm = normalizeEmail(email);
  const phoneNorm = normalizePhone(phone);
  if (!emailNorm && !phoneNorm) {
    throw new Error("Contact requires an email or phone number");
  }

  const matches = await client.query(
    `SELECT * FROM contacts
     WHERE ($1::text IS NOT NULL AND email_norm = $1)
        OR ($2::text IS NOT NULL AND phone_norm = $2)
     FOR UPDATE`,
    [emailNorm, phoneNorm]
  );
  if (matches.rowCount > 1) {
    throw new Error("Email and phone match different contacts; manual review is required");
  }

  let contact = matches.rows[0];
  if (!contact) {
    const inserted = await client.query(
      `INSERT INTO contacts (email, email_norm, phone, phone_norm, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        email,
        emailNorm,
        phone,
        phoneNorm,
        cleanText(input.first_name),
        cleanText(input.last_name)
      ]
    );
    contact = inserted.rows[0];
  } else {
    const updates = {
      email: contact.email || email,
      email_norm: contact.email_norm || emailNorm,
      phone: contact.phone || phone,
      phone_norm: contact.phone_norm || phoneNorm,
      first_name: contact.first_name || cleanText(input.first_name),
      last_name: contact.last_name || cleanText(input.last_name)
    };

    const updated = await client.query(
      `UPDATE contacts
       SET email = $2, email_norm = $3, phone = $4, phone_norm = $5,
           first_name = $6, last_name = $7, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        contact.id,
        updates.email,
        updates.email_norm,
        updates.phone,
        updates.phone_norm,
        updates.first_name,
        updates.last_name
      ]
    );
    contact = updated.rows[0];
  }

  const companyName = cleanText(input.company_name);
  if (companyName && !contact.company_id) {
    const normalizedName = companyName.toLowerCase();
    const company = await client.query(
      `INSERT INTO companies (name, name_norm)
       VALUES ($1, $2)
       ON CONFLICT (name_norm) DO UPDATE SET name = companies.name
       RETURNING id`,
      [companyName, normalizedName]
    );
    const linked = await client.query(
      `UPDATE contacts SET company_id = $2, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [contact.id, company.rows[0].id]
    );
    contact = linked.rows[0];
  }

  return contact;
}

module.exports = { normalizeEmail, normalizePhone, upsertContact };
