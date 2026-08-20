const fs = require('fs');
const path = require('path');

const siteKey = String(process.env.SILKREAD_TURNSTILE_SITE_KEY || '').trim();
if (!siteKey) {
  throw new Error('SILKREAD_TURNSTILE_SITE_KEY must be set for the website build.');
}

const output = path.join(__dirname, '..', 'turnstile-config.js');
const content = `window.SILKREAD_TURNSTILE_SITE_KEY = ${JSON.stringify(siteKey)};\n`;
fs.writeFileSync(output, content, 'utf8');
