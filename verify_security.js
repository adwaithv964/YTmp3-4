// Security verification script
const BASE_URL = 'http://localhost:3000/api/v1/media';

async function verifySecurity() {
  console.log('=== Verifying Security Controls ===\n');

  const testCases = [
    { name: 'Reject Localhost', body: { url: 'http://localhost:8080' }, expectCode: 'BLOCKED_SOURCE' },
    { name: 'Reject 127.0.0.1', body: { url: 'http://127.0.0.1:3000' }, expectCode: 'BLOCKED_SOURCE' },
    { name: 'Reject AWS Metadata IP (169.254.169.254)', body: { url: 'http://169.254.169.254/latest/meta-data' }, expectCode: 'BLOCKED_SOURCE' },
    { name: 'Reject Non-YouTube Host', body: { url: 'https://attacker.com/malicious' }, expectCode: 'UNSUPPORTED_DOMAIN' },
    { name: 'Reject File Scheme', body: { url: 'file:///etc/passwd' }, expectCode: 'BLOCKED_SOURCE' },
    { name: 'Reject Credentials in URL', body: { url: 'https://user:pass@youtube.com/watch?v=abc' }, expectCode: 'BLOCKED_SOURCE' },
    { name: 'Reject Non-standard Port', body: { url: 'https://youtube.com:8443/watch?v=abc' }, expectCode: 'BLOCKED_SOURCE' },
    { name: 'Reject Path Traversal in Job ID', urlPath: '/jobs/..%2F..%2Fetc%2Fpasswd', expectStatus: 404 },
  ];

  let passed = 0;

  for (const tc of testCases) {
    let res;
    if (tc.urlPath) {
      res = await fetch(`${BASE_URL}${tc.urlPath}`);
    } else {
      res = await fetch(`${BASE_URL}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tc.body),
      });
    }

    const data = await res.json().catch(() => ({}));
    const codeMatches = tc.expectCode ? data.error?.code === tc.expectCode : true;
    const statusMatches = tc.expectStatus ? res.status === tc.expectStatus : res.status === 400;

    if (codeMatches && statusMatches) {
      console.log(`[PASS] ${tc.name} -> Rejected (${data.error?.code || res.status})`);
      passed++;
    } else {
      console.error(`[FAIL] ${tc.name} -> Expected ${tc.expectCode || tc.expectStatus}, got ${res.status}:`, data);
    }
  }

  // Check Security Headers on GET /
  const headerRes = await fetch('http://localhost:3000/');
  const h = headerRes.headers;

  const headerChecks = [
    { name: 'Content-Security-Policy', ok: Boolean(h.get('content-security-policy')) },
    { name: 'X-Content-Type-Options: nosniff', ok: h.get('x-content-type-options') === 'nosniff' },
    { name: 'Cross-Origin-Opener-Policy: same-origin', ok: h.get('cross-origin-opener-policy') === 'same-origin' },
    { name: 'Cross-Origin-Resource-Policy: same-origin', ok: h.get('cross-origin-resource-policy') === 'same-origin' },
    { name: 'Permissions-Policy present', ok: Boolean(h.get('permissions-policy')) },
    { name: 'X-Powered-By removed', ok: h.get('x-powered-by') === null },
  ];

  console.log('\n=== Verifying Security Headers ===');
  for (const hc of headerChecks) {
    if (hc.ok) {
      console.log(`[PASS] ${hc.name}`);
      passed++;
    } else {
      console.error(`[FAIL] ${hc.name}`);
    }
  }

  console.log(`\nSecurity Verification: ${passed}/${testCases.length + headerChecks.length} checks PASSED.`);
}

verifySecurity().catch(console.error);
