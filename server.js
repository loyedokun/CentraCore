// LaniCall backend — deployable Twilio PSTN backend
// Node.js, no dependencies. Requires Node 18+ (global fetch).
//
// What it does:
//   1. Mints Twilio Voice access tokens for the app (app -> Twilio Voice SDK)
//   2. Answers the TwiML App webhook and dials a real phone number (PSTN)
//   3. Creates server-initiated test calls and looks up their status / price
//   4. Looks up real Twilio outbound voice rates for a country
//
// Credentials are NEVER hard-coded here. They come only from environment
// variables on your hosting provider (Render, Railway, Fly.io, etc.).
// Never commit a real .env file, and never paste secrets into chat.

import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";

// ---------- Load .env (local development only) ----------
function loadEnvFile() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
// Preferred for API calls and for signing access tokens:
const API_KEY_SID = process.env.TWILIO_API_KEY_SID || "";
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || "";
const TWIML_APP_SID = process.env.TWILIO_TWIML_APP_SID || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const BACKEND_API_KEY = process.env.BACKEND_API_KEY || "";
const REQUIRE_TWILIO_SIGNATURE =
  (process.env.REQUIRE_TWILIO_SIGNATURE || "false").toLowerCase() === "true";

// Basic auth for the Twilio REST API. Prefer an API key pair; fall back to
// Account SID + Auth Token. Both are a username + password pair, which is
// why this backend (not a single-key connector) is the right home for them.
function twilioAuthHeader() {
  const user = API_KEY_SID || ACCOUNT_SID;
  const pass = API_KEY_SECRET || AUTH_TOKEN;
  if (!user || !pass) return null;
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function isConfigured() {
  return Boolean(ACCOUNT_SID && (API_KEY_SECRET || AUTH_TOKEN));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendXml(res, status, xml) {
  res.writeHead(status, {
    "Content-Type": "text/xml",
    "Content-Length": Buffer.byteLength(xml),
  });
  res.end(xml);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const type = (req.headers["content-type"] || "").toLowerCase();
  if (type.includes("application/json")) {
    try {
      return { raw, json: raw ? JSON.parse(raw) : {} };
    } catch {
      return { raw, json: null };
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    return { raw, form: Object.fromEntries(new URLSearchParams(raw)) };
  }
  return { raw, json: null, form: {} };
}

// Optional guard: if BACKEND_API_KEY is set, only your app may mint tokens
// or place calls. Without it, anyone who finds the URL could spend your
// Twilio balance — set it in production.
function checkBackendKey(req, res) {
  if (!BACKEND_API_KEY) return true;
  if (req.headers["x-api-key"] === BACKEND_API_KEY) return true;
  sendJson(res, 401, { error: "Unauthorized: missing or invalid x-api-key" });
  return false;
}

// Optional Twilio webhook signature check (off by default, because proxies
// can change the public URL Twilio signed). Turn it on once your public
// URL is stable: REQUIRE_TWILIO_SIGNATURE=true
function twilioSignatureValid(req, url, form) {
  if (!AUTH_TOKEN) return false;
  const signature = req.headers["x-twilio-signature"];
  if (!signature) return false;
  const data = url + Object.keys(form).sort().map((k) => k + form[k]).join("");
  const expected = crypto
    .createHmac("sha1", AUTH_TOKEN)
    .update(data)
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signJwt(payload, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" }));
  const body = base64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${header}.${body}.${sig}`;
}

const E164 = /^\+\d{7,15}$/;

async function twilioFetch(pathname, { method = "GET", form = null } = {}) {
  const auth = twilioAuthHeader();
  if (!auth) throw new Error("Twilio credentials are not configured");
  const url = `https://api.twilio.com${pathname}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data.message || `Twilio request failed (${res.status})`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

async function twilioPricingFetch(countryIso) {
  const auth = twilioAuthHeader();
  if (!auth) throw new Error("Twilio credentials are not configured");
  const res = await fetch(
    `https://pricing.twilio.com/v1/Voice/Countries/${countryIso}`,
    { headers: { Authorization: auth } },
  );
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.message || `Twilio pricing request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS — restrict this in production with ALLOWED_ORIGINS if you like.
    // For the prototype, the app origin is allowed.
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ----- Health check (safe: reveals no secrets) -----
    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "lanicall-backend",
        twilioConfigured: isConfigured(),
        hasCallerNumber: Boolean(TWILIO_PHONE_NUMBER),
        hasTwiMLApp: Boolean(TWIML_APP_SID),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // ----- Mint a Twilio Voice access token for the app -----
    // POST /api/token  { "identity": "lekan", "ttl": 3600 }
    // The app uses this token with the Twilio Voice JS SDK to place a call.
    if (req.method === "POST" && pathname === "/api/token") {
      if (!checkBackendKey(req, res)) return;
      const { json } = await readBody(req);
      if (!json || typeof json.identity !== "string" || !json.identity.trim()) {
        sendJson(res, 400, { error: "identity is required" });
        return;
      }
      if (!API_KEY_SID || !API_KEY_SECRET || !ACCOUNT_SID || !TWIML_APP_SID) {
        sendJson(res, 500, {
          error:
            "Twilio API key / TwiML App not configured. Set TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET and TWILIO_TWIML_APP_SID.",
        });
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const ttl = Math.min(Math.max(Number(json.ttl || 3600), 60), 86400);
      const token = signJwt(
        {
          jti: `${API_KEY_SID}-${now}-${crypto.randomBytes(8).toString("hex")}`,
          iss: API_KEY_SID,
          sub: ACCOUNT_SID,
          exp: now + ttl,
          grants: {
            identity: json.identity.trim(),
            voice: {
              outgoing: { application_sid: TWIML_APP_SID },
              incoming: { allow: true },
            },
          },
        },
        API_KEY_SECRET,
      );
      sendJson(res, 200, { identity: json.identity.trim(), token, expiresIn: ttl });
      return;
    }

    // ----- TwiML App webhook: Twilio calls this when the app dials -----
    // Twilio posts form fields, including the custom "To" parameter sent
    // by the Voice SDK. We answer with <Dial> to the real phone number.
    if (req.method === "POST" && pathname === "/voice") {
      const { form } = await readBody(req);
      const destination = (form.To || form.to || form.Dial || "").trim();
      if (REQUIRE_TWILIO_SIGNATURE) {
        const publicUrl = `${process.env.PUBLIC_URL || ""}/voice`;
        if (!twilioSignatureValid(req, publicUrl, form)) {
          sendJson(res, 403, { error: "Invalid Twilio signature" });
          return;
        }
      }
      if (!E164.test(destination)) {
        sendXml(
          res,
          200,
          `<Response><Say>Sorry, that number is not valid. Please dial in international format, starting with plus and the country code.</Say></Response>`,
        );
        return;
      }
      if (!TWILIO_PHONE_NUMBER) {
        sendXml(
          res,
          200,
          `<Response><Say>Sorry, no caller number is configured for this service.</Say></Response>`,
        );
        return;
      }
      sendXml(
        res,
        200,
        `<Response><Dial callerId="${xmlEscape(TWILIO_PHONE_NUMBER)}"><Number>${xmlEscape(destination)}</Number></Dial></Response>`,
      );
      return;
    }

    // ----- Server-initiated test call (PSTN connectivity check) -----
    // POST /api/calls  { "to": "+2348035550142" }
    // Twilio dials the number and plays a short greeting. This proves
    // PSTN termination works; live app-to-phone conversations use the
    // Voice SDK + /voice webhook above, not this endpoint.
    if (req.method === "POST" && pathname === "/api/calls") {
      if (!checkBackendKey(req, res)) return;
      const { json } = await readBody(req);
      const to = json?.to?.trim?.() || "";
      if (!E164.test(to)) {
        sendJson(res, 400, { error: "to must be in E.164 format, e.g. +2348035550142" });
        return;
      }
      if (!TWILIO_PHONE_NUMBER) {
        sendJson(res, 500, { error: "TWILIO_PHONE_NUMBER is not configured" });
        return;
      }
      const call = await twilioFetch(`/2010-04-01/Accounts/${ACCOUNT_SID}/Calls.json`, {
        method: "POST",
        form: {
          To: to,
          From: TWILIO_PHONE_NUMBER,
          Twiml: `<Response><Say voice="alice">Hello, this is a test call from LaniCall. Your international calling service is working.</Say></Response>`,
          StatusCallback: `${process.env.PUBLIC_URL || ""}/api/call-status`,
          StatusCallbackEvent: "initiated ringing answered completed",
        },
      });
      sendJson(res, 201, {
        sid: call.sid,
        status: call.status,
        to: call.to,
        from: call.from,
        direction: call.direction,
      });
      return;
    }

    // ----- Call lookup: status, duration, price -----
    if (req.method === "GET" && pathname.startsWith("/api/calls/")) {
      if (!checkBackendKey(req, res)) return;
      const sid = pathname.split("/")[3];
      if (!sid) {
        sendJson(res, 400, { error: "call SID is required" });
        return;
      }
      const call = await twilioFetch(`/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${sid}.json`);
      sendJson(res, 200, {
        sid: call.sid,
        status: call.status,
        direction: call.direction,
        to: call.to,
        from: call.from,
        durationSeconds: call.duration ? Number(call.duration) : null,
        price: call.price,
        priceUnit: call.price_unit,
        startTime: call.start_time,
        endTime: call.end_time,
      });
      return;
    }

    // ----- Call status webhook (Twilio posts here as a call progresses) -----
    if (req.method === "POST" && pathname === "/api/call-status") {
      const { form } = await readBody(req);
      // Log only non-sensitive fields. Never log tokens or secrets.
      console.log(
        `[call-status] sid=${form.CallSid || "?"} status=${form.CallStatus || "?"} to=${form.To || "?"} duration=${form.CallDuration || "?"} price=${form.Price || "?"}`,
      );
      res.writeHead(204);
      res.end();
      return;
    }

    // ----- Real Twilio outbound rates for a country -----
    // GET /api/rates/NG  -> { country, outbound: [{ prefixes, price, ... }] }
    if (req.method === "GET" && pathname.startsWith("/api/rates/")) {
      if (!checkBackendKey(req, res)) return;
      const iso = pathname.split("/")[3]?.toUpperCase();
      if (!/^[A-Z]{2}$/.test(iso || "")) {
        sendJson(res, 400, { error: "country must be a 2-letter ISO code, e.g. NG" });
        return;
      }
      const pricing = await twilioPricingFetch(iso);
      sendJson(res, 200, {
        country: pricing.country,
        isoCountry: pricing.iso_country,
        priceUnit: pricing.price_unit,
        outbound: pricing.outbound_prefix_prices || [],
        inbound: pricing.inbound_call_prices || [],
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    sendJson(res, err.status || 500, {
      error: err.message || "Internal server error",
    });
  }
});

server.listen(PORT, () => {
  console.log(`LaniCall backend listening on port ${PORT}`);
  if (!isConfigured()) {
    console.log("WARNING: Twilio credentials are not configured yet. See .env.example.");
  }
  if (!BACKEND_API_KEY) {
    console.log("WARNING: BACKEND_API_KEY is not set — /api/token and /api/calls are open. Set it in production.");
  }
});
