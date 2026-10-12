'use strict';

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Expected an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function settings(env = process.env) {
  const domains = [...new Set((env.MAIL_DOMAINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean))];
  if (!domains.length || domains.some(x => !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))) {
    throw new Error('MAIL_DOMAINS must contain comma-separated DNS domains');
  }
  return {
    domains,
    ttl: positiveInteger(env.INBOX_TTL_SECONDS, 3600, 604800),
    port: positiveInteger(env.API_PORT, 3000, 65535),
    host: env.API_HOST || '127.0.0.1',
    apiKey: env.API_KEY,
    maxMessageBytes: 10 * 1024 * 1024,
  };
}

module.exports = { settings, positiveInteger };
