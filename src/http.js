// Minimal HTTPS client: JSON in, { statusCode, body } out, with an overall timeout and a response size cap.
// Errors never carry request or response bodies (they may contain tokens).

const https = require('https');

const REQUEST_TIMEOUT = 8 * 1000;
const MAX_BODY = 2 * 1024 * 1024;

function httpsRequest(options, postData, { timeoutMs = REQUEST_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          req.destroy(new Error(`response from ${options.hostname} too large`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          /* not JSON: keep the text */
        }
        done(resolve, { statusCode: res.statusCode, body });
      });
      res.on('error', (err) => done(reject, err));
    });

    const timer = setTimeout(() => req.destroy(new Error(`request to ${options.hostname} timed out`)), timeoutMs);
    req.on('error', (err) => done(reject, err));
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = { httpsRequest, REQUEST_TIMEOUT };
