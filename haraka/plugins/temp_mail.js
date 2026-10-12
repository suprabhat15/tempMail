'use strict';

const { ok: OK, deny: DENY, denysoft: DENYSOFT } = require('haraka-constants');
const { settings } = require('../../src/config');
const { createPool } = require('../../src/db');
const { enqueueMail, InvalidRecipients } = require('../../src/mail');

exports.register = function () {
  this.mailSettings = settings();
  this.register_hook('init_master', 'init_database');
  this.register_hook('init_child', 'init_database');
  this.register_hook('rcpt', 'validate_recipient');
  this.register_hook('queue', 'store_message');
};

exports.init_database = function (next) {
  this.pool = createPool();
  this.pool.query('SELECT 1').then(() => next()).catch(error => {
    this.logerror('Database unavailable', error.code || error.name);
    next(DENYSOFT, 'Database unavailable');
  });
};

exports.validate_recipient = function (next, connection, params) {
  if (connection.transaction.rcpt_to.length >= 100) return next(DENY, 'Maximum 100 recipients per message');
  const recipient = params[0];
  const address = recipient.address().toLowerCase();
  if (!this.mailSettings.domains.includes(recipient.host.toLowerCase())) {
    return next(DENY, 'Recipient domain is not served here');
  }
  this.pool.query('SELECT id FROM inboxes WHERE address = $1 AND expires_at > now()', [address])
    .then(({ rows }) => next(rows.length ? OK : DENY, rows.length ? undefined : 'Unknown or expired inbox'))
    .catch(error => {
      this.logerror('Recipient lookup failed', error.code || error.name);
      next(DENYSOFT, 'Recipient lookup unavailable; try again later');
    });
};

exports.store_message = function (next, connection) {
  const transaction = connection.transaction;
  transaction.message_stream.get_data(raw => {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (bytes.length > this.mailSettings.maxMessageBytes) return next(DENY, 'Message exceeds 10 MiB limit');
    enqueueMail(this.pool, {
      envelopeFrom: transaction.mail_from.address(),
      recipients: transaction.rcpt_to.map(recipient => recipient.address()),
      raw: bytes,
    }).then(id => next(OK, `Stored as ${id}`)).catch(error => {
      if (error instanceof InvalidRecipients) return next(DENY, 'Recipient expired or does not exist');
      this.logerror('Durable message storage failed', error.code || error.name);
      next(DENYSOFT, 'Storage unavailable; try again later');
    });
  }, { dot_stuffed: false, encoding: null });
};

exports.shutdown = function () {
  if (this.pool) this.pool.end().catch(() => {});
};
