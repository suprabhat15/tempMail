'use strict';

const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { simpleParser } = require('mailparser');

const hashToken = token => createHash('sha256').update(token).digest('hex');
const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function matchesSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(hashToken(actual), 'hex');
  const b = Buffer.from(hashToken(expected), 'hex');
  return timingSafeEqual(a, b);
}

async function createInbox(pool, domain, ttl) {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const address = `${randomBytes(16).toString('hex')}@${domain}`;
  const { rows } = await pool.query(
    'INSERT INTO inboxes (id, address, token_hash, expires_at) VALUES ($1, $2, $3, now() + $4 * interval \'1 second\') RETURNING id, address, expires_at',
    [id, address, hashToken(token), ttl],
  );
  return { ...rows[0], token };
}

class InvalidRecipients extends Error {}

async function enqueueMail(pool, { envelopeFrom, recipients, raw, id = randomUUID() }) {
  const addresses = [...new Set(recipients.map(x => x.toLowerCase()))];
  if (!addresses.length) throw new InvalidRecipients('No recipients');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id FROM inboxes WHERE address = ANY($1::text[]) AND expires_at > now() FOR KEY SHARE', [addresses],
    );
    if (rows.length !== addresses.length) throw new InvalidRecipients('Recipient expired or does not exist');
    await client.query('INSERT INTO messages (id, envelope_from, raw) VALUES ($1, $2, $3)', [id, envelopeFrom, raw]);
    await client.query('INSERT INTO deliveries (inbox_id, message_id) SELECT unnest($1::uuid[]), $2::uuid', [rows.map(x => x.id), id]);
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function processOne(pool) {
  const client = await pool.connect();
  let message;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "SELECT id, raw, attempts FROM messages WHERE state = 'pending' AND retry_at <= now() ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    message = rows[0];
    if (!message) { await client.query('COMMIT'); return false; }
    // A worker crash rolls back the row lock, allowing another worker to retry.
    let parsed;
    try {
      parsed = await simpleParser(message.raw, { skipHtmlToText: true, skipTextToHtml: true });
    } catch (error) {
      const attempts = message.attempts + 1;
      await client.query(
        "UPDATE messages SET attempts = $2, state = $3, retry_at = now() + $4 * interval '1 second' WHERE id = $1",
        [message.id, attempts, attempts >= 5 ? 'failed' : 'pending', Math.min(300, 2 ** attempts)],
      );
      await client.query('COMMIT');
      console.error('MIME parsing failed for message', message.id, error.name);
      return true;
    }
    // Return plain text through the API. Raw HTML remains in the downloadable MIME.
    const attachments = parsed.attachments.map(a => ({ filename: a.filename || null, contentType: a.contentType, size: a.size }));
    await client.query(
      "UPDATE messages SET state = 'ready', attempts = attempts + 1, subject = $2, sender = $3, text_body = $4, attachments = $5 WHERE id = $1",
      [message.id, parsed.subject || '', parsed.from?.text || '', parsed.text || '', JSON.stringify(attachments)],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupExpired(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM inboxes WHERE expires_at <= now()');
    await client.query('DELETE FROM messages m WHERE NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id)');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { createInbox, enqueueMail, processOne, cleanupExpired, hashToken, matchesSecret, isUuid, InvalidRecipients };
