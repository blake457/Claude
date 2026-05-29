// ============================================================
// Catalyst Building Walk — Cloudflare Worker Proxy v2
// ============================================================
//
// Proxies requests from the app to Google Apps Script.
// Solves CORS issues that prevent direct browser→GAS communication.
//
// SETUP (one-time):
// 1. Go to Cloudflare dashboard → Workers & Pages
// 2. Click on your existing "walk-proxy" Worker
// 3. Click "Edit code" or "Quick edit"
// 4. Delete ALL old code and paste this entire file
// 5. Click "Save and Deploy"
// ============================================================

const GAS_URL = 'https://script.google.com/macros/s/AKfycbxGNVQDhOrwzoJY26XnqwXnRTNAVtnfEP7uvRfxhnYy0b-PmwdlFrTGQBHGQA_ataig6Q/exec';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check
    if (request.method === 'GET') {
      try {
        const gasResponse = await fetch(GAS_URL, { method: 'GET', redirect: 'follow' });
        const body = await gasResponse.text();
        return new Response(body, {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      } catch (err) {
        return new Response(JSON.stringify({ status: 'proxy_running', gas_status: 'unreachable', error: err.message }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    // POST — forward to Google Apps Script
    if (request.method === 'POST') {
      try {
        const body = await request.text();

        // Forward to GAS — GAS is slow with large PDFs, so we wait but not forever
        const gasResponse = await fetch(GAS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: body,
          redirect: 'follow',
        });

        // Read the response body
        const responseText = await gasResponse.text();

        // Try to parse as JSON for cleaner forwarding
        let responseBody = responseText;
        try {
          const parsed = JSON.parse(responseText);
          responseBody = JSON.stringify(parsed);
        } catch (e) {
          // The Apps Script ALWAYS returns JSON on a real run (see doPost/doGet).
          // A non-JSON body means the request never reached our code — Google
          // served an HTML error / sign-in / "exceeded execution time" page, and
          // those come back with HTTP 200. Reporting that as success silently
          // drops the email, so we ALWAYS surface it as a failure regardless of
          // status, and let the app fall back to manual Gmail.
          responseBody = JSON.stringify({
            success: false,
            error: 'GAS did not return JSON (HTTP ' + gasResponse.status + ') — report not sent: ' + responseText.slice(0, 200)
          });
        }

        return new Response(responseBody, {
          status: gasResponse.ok ? 200 : gasResponse.status,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: 'Proxy error: ' + err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  },
};
