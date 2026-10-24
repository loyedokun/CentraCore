# LaniCall backend — Twilio PSTN backend

A small, dependency-free Node.js backend (Node 18+) that turns the
simulated LaniCall prototype into real international calling.

## What it does

| Endpoint | Purpose |
|---|---|
| `GET /health` | Health check, and whether Twilio is configured (no secrets shown) |
| `POST /api/token` | Mints a Twilio Voice access token for the app, so the app can place calls over WiFi / mobile data |
| `POST /voice` | TwiML App webhook: answers an app call and dials the real phone number over PSTN |
| `POST /api/calls` | Server-initiated test call: Twilio dials a number and plays a greeting (proves PSTN works) |
| `GET /api/calls/:sid` | Call status, duration and price for a call |
| `POST /api/call-status` | Webhook Twilio calls as a call progresses (logged, no secrets) |
| `GET /api/rates/:iso` | Real Twilio outbound voice rates, e.g. `/api/rates/NG` |

Live app-to-phone conversations use the Voice SDK path:
app → `POST /api/token` → Twilio Voice SDK → TwiML App → `POST /voice`
→ `<Dial>` to the destination number. The person receiving needs no
app and no internet — they just answer a normal phone call.

## 1. Get your Twilio pieces (in the Twilio Console)

1. **Account SID + Auth Token** — Console dashboard.
2. **API key pair** — Account > API keys & tokens > Create API key.
   Keep the secret: it is shown only once. The token endpoint needs this
   pair, not just SID + Auth Token.
3. **A phone number** — Phone Numbers > Buy a number. This is your caller ID.
4. **A TwiML App** — Voice > TwiML Apps > Create.
   - Voice Request URL: `https://YOUR-BACKEND-URL/voice` (POST)
   - Leave the other fields at their defaults for now.

Trial accounts can only call numbers you have verified
(Phone Numbers > Verified Caller IDs), and the trial lasts 30 days.
Upgrade in the Console (add payment + funds) to call any number.

## 2. Run it locally

```bash
cp .env.example .env
# Fill in .env — never commit it, never paste it into chat
node server.js
curl http://localhost:3000/health
```

You should see `twilioConfigured` change to `true` once the SID and a
secret are set. `/api/token`, `/api/calls` and `/api/rates` will fail
with a clear configuration error until then — that is intentional, and
no secret is ever returned in an error.

## 3. Deploy it (Render example)

1. Push this folder to a Git repo.
2. Render > New > Web Service > connect the repo.
3. Build command: *(none — no dependencies)*
   Start command: `node server.js`
4. Add the environment variables from `.env.example` in Render's
   Environment settings. Set `BACKEND_API_KEY` to a long random string.
5. Copy your Render URL, e.g. `https://lanicall.onrender.com`.
6. Go back to your TwiML App and set its Voice Request URL to
   `https://lanicall.onrender.com/voice`.
7. Set `PUBLIC_URL` to the same Render URL and redeploy.
8. Test: `curl https://lanicall.onrender.com/health`

Railway, Fly.io and similar hosts work the same way: Node 18+,
`node server.js`, environment variables, a public URL.

## 4. Test a real call

Test call (server dials a verified number and plays a greeting):

```bash
curl -X POST https://YOUR-BACKEND-URL/api/calls \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_BACKEND_API_KEY" \
  -d '{"to": "+2348035550142"}'
```

Then check it:

```bash
curl https://YOUR-BACKEND-URL/api/calls/CALL_SID_HERE \
  -H "x-api-key: YOUR_BACKEND_API_KEY"
```

For a live app call, the frontend needs the Twilio Voice JS SDK:
fetch a token from `POST /api/token` with `{ "identity": "lekan" }`,
then use the SDK to connect with a `To` parameter set to the
destination number in E.164 format (`+` + country code + number).

## Security notes

- Secrets live only in hosting environment variables, never in code,
  never in the repo, never in chat.
- Set `BACKEND_API_KEY` in production, or anyone who finds the URL
  could mint tokens and spend your Twilio balance.
- In the app, restrict `ALLOWED_ORIGIN` to your app's origin.
- Turn on `REQUIRE_TWILIO_SIGNATURE=true` once `PUBLIC_URL` is stable,
  so `/voice` only accepts webhooks genuinely from Twilio.

## Next step after this backend

Point the prototype's dialer at this backend's `/api/token` and
`/voice` endpoints, replace the simulated call screen with the Twilio
Voice SDK, and deduct real call cost (from `/api/calls/:sid`) from the
app's credit balance instead of the simulated cost.
