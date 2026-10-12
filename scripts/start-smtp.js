'use strict';

const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');

const hostname = process.env.MAIL_HOSTNAME;
if (!hostname || !/^[a-z0-9.-]+$/i.test(hostname)) throw new Error('Set MAIL_HOSTNAME to your SMTP hostname');
writeFileSync(resolve(__dirname, '../haraka/config/me'), `${hostname}\n`);
const child = spawn(process.execPath, [require.resolve('haraka/bin/haraka'), '-c', resolve(__dirname, '../haraka')], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code || 0; });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
