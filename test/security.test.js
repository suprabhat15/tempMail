'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { settings } = require('../src/config');
const { matchesSecret, hashToken, enqueueMail, InvalidRecipients } = require('../src/mail');
const plugin = require('../haraka/plugins/temp_mail');
const constants = require('haraka-constants');

test('configuration requires valid mail domains and bounded TTL', () => {
  assert.throws(() => settings({}), /MAIL_DOMAINS/);
  assert.throws(() => settings({ MAIL_DOMAINS: 'mail.example.com\nother' }), /MAIL_DOMAINS/);
  assert.throws(() => settings({ MAIL_DOMAINS: 'mail.example.com', INBOX_TTL_SECONDS: '-1' }));
  assert.deepEqual(settings({ MAIL_DOMAINS: 'MAIL.EXAMPLE.COM,mail.example.com' }).domains, ['mail.example.com']);
});

test('private tokens reject missing, wrong and differently sized credentials', () => {
  assert.equal(matchesSecret('correct', 'correct'), true);
  assert.equal(matchesSecret('', 'correct'), false);
  assert.equal(matchesSecret(undefined, 'correct'), false);
  assert.equal(matchesSecret(hashToken('correct'), hashToken('wrong')), false);
});

function connection(address = 'inbox@mail.example.com') {
  return {
    transaction: {
      mail_from: { address: () => 'sender@example.org' },
      rcpt_to: [{ address: () => address }],
      message_stream: { get_data: callback => callback(Buffer.from('Subject: test\r\n\r\nbody\r\n')) },
    },
  };
}

test('unserved domains are rejected without consulting storage', async () => {
  const result = await new Promise(resolve => plugin.validate_recipient.call({
    mailSettings: { domains: ['mail.example.com'] },
    pool: { query: () => { throw new Error('Must not query'); } },
  }, code => resolve(code), connection(), [{ host: 'outside.example', address: () => 'a@outside.example' }]));
  assert.equal(result, constants.deny);
});

test('database outages temporarily reject recipients', async () => {
  const result = await new Promise(resolve => plugin.validate_recipient.call({
    mailSettings: { domains: ['mail.example.com'] },
    pool: { query: async () => { throw new Error('offline'); } },
    logerror() {},
  }, code => resolve(code), connection(), [{ host: 'mail.example.com', address: () => 'a@mail.example.com' }]));
  assert.equal(result, constants.denysoft);
});

test('failed durable storage returns a temporary SMTP rejection', async () => {
  const result = await new Promise(resolve => plugin.store_message.call({
    mailSettings: { maxMessageBytes: 10485760 },
    pool: { connect: async () => { throw new Error('offline'); } },
    logerror() {},
  }, code => resolve(code), connection()));
  assert.equal(result, constants.denysoft);
});

test('SMTP success waits for COMMIT, and failed commits roll back', async () => {
  let finishCommit;
  let callbackCode;
  const queries = [];
  let released = false;
  const client = {
    query: async sql => {
      queries.push(sql);
      if (sql.startsWith('SELECT')) return { rows: [{ id: '11111111-1111-1111-1111-111111111111' }] };
      if (sql === 'COMMIT') await new Promise(resolve => { finishCommit = resolve; });
      return { rows: [] };
    },
    release: () => { released = true; },
  };
  const ctx = { mailSettings: { maxMessageBytes: 10485760 }, pool: { connect: async () => client }, logerror() {} };
  const completed = new Promise(resolve => plugin.store_message.call(ctx, code => { callbackCode = code; resolve(); }, connection()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbackCode, undefined);
  assert.ok(queries.includes('COMMIT'));
  finishCommit();
  await completed;
  assert.equal(callbackCode, constants.ok);
  assert.equal(released, true);

  client.query = async sql => {
    queries.push(sql);
    if (sql.startsWith('SELECT')) return { rows: [{ id: '11111111-1111-1111-1111-111111111111' }] };
    if (sql === 'COMMIT') throw new Error('disk full');
    return { rows: [] };
  };
  const failed = await new Promise(resolve => plugin.store_message.call(ctx, resolve, connection()));
  assert.equal(failed, constants.denysoft);
  assert.equal(queries.at(-1), 'ROLLBACK');
});

test('expiry between recipient acceptance and delivery rolls back the whole message', async () => {
  const queries = [];
  const client = { query: async sql => { queries.push(sql); return { rows: [] }; }, release() {} };
  await assert.rejects(enqueueMail({ connect: async () => client }, {
    envelopeFrom: '', recipients: ['expired@mail.example.com'], raw: Buffer.from('mail'),
  }), InvalidRecipients);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.some(sql => sql.startsWith('INSERT')), false);
});
