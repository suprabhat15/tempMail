'use strict';

const http = require('node:http');
const { settings, positiveInteger } = require('./config');
const { createPool } = require('./db');
const { createInbox, matchesSecret, hashToken, isUuid } = require('./mail');

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw Object.assign(new Error('Expected a JSON object'), { status: 400 }); }
}

function createServer(pool, config) {
  if (!config.apiKey || config.apiKey.length < 32) throw new Error('API_KEY must contain at least 32 characters');
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const token = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(request.headers.authorization || '')?.[1];
      if (request.method === 'GET' && url.pathname === '/health') {
        await pool.query('SELECT 1');
        return sendJson(response, 200, { status: 'ok', receivingService: 'haraka' });
      }
      if (request.method === 'POST' && url.pathname === '/inboxes') {
        if (!matchesSecret(token, config.apiKey)) return sendJson(response, 401, { error: 'Invalid API key' });
        const body = await readJson(request);
        const domain = typeof body.domain === 'string' ? body.domain.toLowerCase() : config.domains[0];
        if (!config.domains.includes(domain)) return sendJson(response, 400, { error: 'Domain is not configured' });
        let ttl;
        try { ttl = positiveInteger(body.ttlSeconds, config.ttl, config.ttl); }
        catch { return sendJson(response, 400, { error: `ttlSeconds must be an integer from 1 to ${config.ttl}` }); }
        return sendJson(response, 201, await createInbox(pool, domain, ttl));
      }
      const route = /^\/inboxes\/([^/]+)(?:\/messages(?:\/([^/]+)(\/raw)?)?)?$/.exec(url.pathname);
      if (!route || !isUuid(route[1]) || (route[2] && !isUuid(route[2]))) {
        return sendJson(response, 404, { error: 'Not found' });
      }
      const { rows } = await pool.query('SELECT id, address, expires_at, token_hash FROM inboxes WHERE id = $1 AND expires_at > now()', [route[1]]);
      const inbox = rows[0];
      if (!inbox || !token || !matchesSecret(hashToken(token), inbox.token_hash)) {
        return sendJson(response, 404, { error: 'Inbox not found' });
      }
      if (request.method === 'DELETE' && url.pathname === `/inboxes/${inbox.id}`) {
        await pool.query('DELETE FROM inboxes WHERE id = $1', [inbox.id]);
        response.writeHead(204); return response.end();
      }
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' });
      if (!url.pathname.includes('/messages')) {
        return sendJson(response, 200, { id: inbox.id, address: inbox.address, expires_at: inbox.expires_at });
      }
      if (route[2]) {
        const raw = Boolean(route[3]);
        const columns = raw ? 'm.raw' : 'm.id, m.received_at, m.state, m.subject, m.sender, m.envelope_from, m.text_body, m.attachments';
        const result = await pool.query(`SELECT ${columns} FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.inbox_id = $1 AND m.id = $2`, [inbox.id, route[2]]);
        if (!result.rows.length) return sendJson(response, 404, { error: 'Message not found' });
        if (!raw) return sendJson(response, 200, result.rows[0]);
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${route[2]}.eml"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return response.end(result.rows[0].raw);
      }
      let limit, offset;
      try {
        limit = positiveInteger(url.searchParams.get('limit') ?? undefined, 50, 100);
        offset = Number(url.searchParams.get('offset') || '0');
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error();
      } catch { return sendJson(response, 400, { error: 'Invalid pagination' }); }
      const result = await pool.query(
        'SELECT m.id, m.received_at, m.state, m.subject, m.sender FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE d.inbox_id = $1 ORDER BY m.received_at DESC, m.id DESC LIMIT $2 OFFSET $3',
        [inbox.id, limit, offset],
      );
      return sendJson(response, 200, { messages: result.rows, limit, offset });
    } catch (error) {
      if (error.status) return sendJson(response, error.status, { error: error.message });
      console.error('API request failed:', error.code || error.name);
      sendJson(response, 503, { error: 'Service temporarily unavailable' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (require.main === module) {
  const config = settings();
  const pool = createPool();
  const server = createServer(pool, config);
  server.listen(config.port, config.host, () => console.log(`Inbox API listening on ${config.host}:${config.port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => { server.close(() => pool.end()); });
  }
}

module.exports = { createServer };
