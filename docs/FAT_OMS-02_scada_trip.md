# FAT OMS-02 / OMS-04 — SCADA trip, reclose, callback, MAIFI

Covers:

- OMS-02: *"Trip a protective device to verify auto-ticket generation and downstream prediction; reclose device and verify auto-ticket closure and callback initiation."*
- OMS-04: automatic IEEE 1366 calculation of SAIDI, CAIDI, SAIFI and **MAIFI**.

## How it works (what the tester should expect)

| Event | Result |
|---|---|
| Trip (CRITICAL/TRIP on a device tag) | Auto-ticket (source SCADA), or the trip is merged into an open ticket at the same substation. The device tag is recorded as **still open** on that ticket. A downstream prediction is stored and shown. |
| Reclose of that tag | The tag is removed. When **no tripped device remains open** on the ticket, it is restored. |
| Restored ≤ `MOMENTARY_MAX_MIN` (default 5) min after the ticket opened | **Momentary**: Resolved → Closed automatically, badge *Momentary* + *Restored by SCADA*. Counted in **MAIFI** only, not SAIFI/SAIDI. |
| Restored later | **Sustained**: Resolved, badge *Restored by SCADA*, `resolved_at` = reclose time. Counted in **SAIFI/SAIDI/CAIDI** with the real duration. |
| Any restore | Callback SMS to every linked trouble call / complaint (opt-outs honoured, numbers masked). Timeline: "Callback initiated to N customers". No DMS restoration command (the DMS already knows the device closed). |

Prediction (feeder-level): every distribution transformer on the tripped feeder in the network model. Customers are allocated by the feeder's share of installed kVA out of `CUSTOMERS_SERVED` (18,500). It is an estimate, not a meter count; switching state is unknown, so it is the whole feeder.

## Setup (once)

1. Backend `.env`: add `ENABLE_SCADA_SIMULATION=true` (test/FAT only, never in production) and `SIMULATOR=off`
   (the background simulator raises random trips at random substations, which would merge into the demo tickets),
   then restart the backend. Without the flag, the trigger below returns 403 "SCADA simulation is disabled...".
2. Optional fresh demo data: `cd backend; node -e "import('./src/infra/seed.js').then(m=>m.seed({force:true})).then(r=>{console.log(r);process.exit(0)})"`
3. Sign in to the web app as a `system_admin` user. Keep **Incidents**, **TCS / IVR** and **Analytics** handy.
4. Trigger helper — paste into a PowerShell window. It asks for **your** Keycloak password (hidden input, nothing is stored).
   Access tokens expire after a few minutes; if a call returns 401, run the first block again.

```powershell
$api = "http://localhost:14000/api"     # backend port from backend/.env
$kc  = "http://localhost:18080/realms/oms-upcl/protocol/openid-connect/token"
$user = Read-Host "Keycloak username (system_admin)"
$pw   = Read-Host "Password" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
$tok = (Invoke-RestMethod -Method Post $kc -Body @{ grant_type='password'; client_id='oms-web'; username=$user; password=$plain }).access_token
Remove-Variable plain, pw
$H = @{ Authorization = "Bearer $tok" }
function Sim($tag, $event, $feeder) {
  $b = @{ tag = $tag; event = $event }; if ($feeder) { $b.feeder = $feeder }
  Invoke-RestMethod -Method Post "$api/scada/simulate" -Headers $H -ContentType 'application/json' -Body ($b | ConvertTo-Json)
}
```

The demo uses substations that have no open seeded incident (Jwalapur-III, Laljiwala, Kankhal-3), so each trip makes a clean ticket.

## Part 1 — Trip → auto-ticket + downstream prediction; reclose ≤ 5 min → auto-closure, MAIFI up

| # | Action | Expected |
|---|---|---|
| 1 | Open **Analytics**. Note **MAIFI**. | On fresh seed data MAIFI is `0` (no momentary events yet). |
| 2 | PowerShell: `Sim "JWL3.FDRB.CB1.TRIP" trip "UPCL-JP-B"` | Response `accepted: True`. |
| 3 | **Incidents** (refreshes live). | A new incident at the top: source SCADA, zone `33/11 kV JWALAPUR-III S/s`, feeder `UPCL-JP-B`, ~**556** customers, status Open. |
| 4 | Click it. | Detail shows **Predicted downstream: 50 transformers, ~556 customers (feeder-level)** (hover for the basis text) and **Devices still open: JWL3.FDRB.CB1.TRIP**. Timeline: "Auto-detected from SCADA CRITICAL…" and "Predicted downstream: 50 transformers, ~556 customers (feeder-level, 8302 kVA on UPCL-JP-B)". |
| 5 | **TCS / IVR → Outages** tab. | The incident is listed with a red **SCADA** badge under **JWALAPUR-III**. |
| 6 | Within 5 minutes of step 2: `Sim "JWL3.FDRB.CB1.TRIP" reclose` | Response `accepted: True`. |
| 7 | **Incidents** → the same incident. | Status **Closed**, badges **Momentary** and **Restored by SCADA**. Timeline: "Open - Resolved - JWL3.FDRB.CB1.TRIP reclosed after N min (momentary)" then "Resolved - Closed - auto-closed as momentary interruption". No "Restoration command sent to DMS" entry. |
| 8 | **Analytics**. | **MAIFI = 0.03** (556 / 18,500 = 0.030). SAIFI/SAIDI unchanged by this event. |

## Part 2 — Callback initiation (reclose of a device on a customer-reported ticket)

| # | Action | Expected |
|---|---|---|
| 9 | **TCS / IVR → Log a call**: customer `FAT Callback`, phone `9000000099`, address `Laljiwala`, priority Normal, area **LALJIWALA**. Log call. | Call appears under **Unassigned → LALJIWALA**. |
| 10 | On that call click **Raise incident**. | Call moves to **Incident**. |
| 11 | Within 5 minutes: `Sim "LALJ.FDRA.CB1.TRIP" trip "UPCL-LW-A"` | The trip is merged into the call's incident (same substation). In **Incidents**, that incident shows **Devices still open: LALJ.FDRA.CB1.TRIP** and **Predicted downstream: 7 transformers, ~191 customers (feeder-level)**. Timeline: "Correlated SCADA CRITICAL on LALJ.FDRA.CB1.TRIP (deduplicated)". |
| 12 | `Sim "LALJ.FDRA.CB1.TRIP" reclose` | Incident **Closed**, **Momentary**, **Restored by SCADA**. Timeline: **"Callback initiated to 1 customer"**. Backend console: `CALLBACK SMS (console only) -> ******0099 (CALL-…)` (number masked). |
| 13 | **TCS / IVR → Closed** tab. | The `FAT Callback` call shows **Closed** and the line **"Callback sent Ns ago"**. |
| 14 | Run step 12's command again. | Nothing new: no second callback, no second timeline entry (callbacks are once per customer per incident). |

Optional: with two devices on one feeder, e.g. `Sim "LALJ.FDRA.CB1.TRIP" trip "UPCL-LW-A"` and `Sim "LALJ.FDRA.REC2.TRIP" trip "UPCL-LW-A"`, reclosing only one leaves the ticket open ("…reclosed; still open: …"); it restores when the second recloses.

## Part 3 — Trip held > 5 min, then restored → sustained, SAIDI up

| # | Action | Expected |
|---|---|---|
| 15 | **Analytics**: note **SAIDI** and **SAIFI**. | Baseline values. |
| 16 | `Sim "KNK3.FDRA.CB1.TRIP" trip "UPCL-KI-A"` | New SCADA incident at `33/11 kV KANKHAL- 3 S/s`, ~**184** customers, prediction **9 transformers, ~184 customers (feeder-level)**. Analytics SAIFI rises slightly (in-progress outage). |
| 17 | Wait **more than 5 minutes** (6 is safe). Re-run the token block if needed. Then `Sim "KNK3.FDRA.CB1.TRIP" reclose` | |
| 18 | **Incidents** → that incident. | Status **Resolved** (not Closed), badge **Restored by SCADA**, **no** Momentary badge. Timeline: "Open - Resolved - KNK3.FDRA.CB1.TRIP reclosed after 6.x min (sustained)". No DMS restoration command entry. |
| 19 | **Analytics**. | SAIDI is higher than at step 15 by about 184 × duration / 18,500 (≈ 0.06 min for 6 min). MAIFI unchanged from Part 1/2. |
| 20 | (Crew variant, optional) Repeat 16, assign a crew from the incident drawer, wait > 5 min, reclose. | Incident Resolved; the crew's job is untouched; timeline: **"Restored by SCADA while crew C00x assigned - confirm whether the crew is still needed"**. |

## Notes for the FAT record

- `/api/scada/simulate` is the test hook (system_admin + `ENABLE_SCADA_SIMULATION=true`). The real ingestion route `/api/scada/fault` takes the same `event: trip|reclose` field and is limited to `scada_operator` / `system_admin`; the DNP3 adapter now emits a reclose when a monitored point returns to closed.
- Callbacks are console-logged SMS (no SMS gateway yet) recorded in the `notifications` table with masked numbers.
- Automated evidence: `cd backend; npm test` (scratch database) — trip/prediction, dedup, momentary vs sustained, two-device restore, merge into a customer ticket, callbacks/opt-out/idempotency, DMS skip, IEEE 1366 hand-worked MAIFI example, route guards.
