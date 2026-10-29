import http from 'node:http';

/**
 * Native, zero-dependency stub server for Zarinpal payment gateway.
 */
export function createFakeGateway() {
  let authorityCounter = 1000;
  let config = {
    requestCode: 100,
    verifyCode: 100,
    verifySubsequentCode: 101,
    fail: false
  };

  const verifiedAuthorities = new Set();
  const calls = [];

  const server = http.createServer(async (req, res) => {
    let bodyRaw = '';
    req.on('data', (c) => { bodyRaw += c; });
    await new Promise((r) => req.on('end', r));

    let body = {};
    try { body = JSON.parse(bodyRaw || '{}'); } catch (_) {}

    const callInfo = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body
    };
    calls.push(callInfo);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (config.fail) {
      res.writeHead(500);
      res.end(JSON.stringify({ errors: { code: -50, message: 'Simulated Gateway Failure' } }));
      return;
    }

    if (req.method === 'POST' && req.url === '/pg/v4/payment/request.json') {
      if (config.requestCode === 100) {
        authorityCounter++;
        const authority = `A00000000000000000000000000${authorityCounter}`;
        res.writeHead(200);
        res.end(JSON.stringify({
          data: {
            code: 100,
            message: 'Success',
            authority,
            fee_type: 'Merchant',
            fee: 0
          },
          errors: []
        }));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({
          data: [],
          errors: { code: config.requestCode, message: 'Request rejected' }
        }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/pg/v4/payment/verify.json') {
      const auth = body.authority;
      const isSubsequent = verifiedAuthorities.has(auth);

      if (config.verifyCode === 100) {
        if (isSubsequent) {
          res.writeHead(200);
          res.end(JSON.stringify({
            data: {
              code: config.verifySubsequentCode, // typically 101 (already verified)
              message: 'Already verified',
              card_pan: '6037********1234',
              ref_id: 12345678
            },
            errors: []
          }));
        } else {
          verifiedAuthorities.add(auth);
          res.writeHead(200);
          res.end(JSON.stringify({
            data: {
              code: 100,
              message: 'Verified successfully',
              card_pan: '6037********1234',
              ref_id: 12345678
            },
            errors: []
          }));
        }
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({
          data: [],
          errors: { code: config.verifyCode, message: 'Verification rejected' }
        }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ message: 'Not found' }));
  });

  return {
    server,
    configure(opts) {
      Object.assign(config, opts);
    },
    reset() {
      calls.length = 0;
      verifiedAuthorities.clear();
      config = {
        requestCode: 100,
        verifyCode: 100,
        verifySubsequentCode: 101,
        fail: false
      };
    },
    getCalls() {
      return [...calls];
    },
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, resolve));
      const addr = server.address();
      const actualPort = typeof addr === 'object' ? addr.port : port;
      return {
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((resolve) => server.close(resolve))
      };
    }
  };
}
