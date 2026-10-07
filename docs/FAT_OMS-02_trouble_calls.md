# FAT OMS-02 — Trouble Call Management (calls part)

Covers two FAT sentences:

1. *"Create trouble calls of each priority category (Normal / Critical / Premium-VIP / Medical); verify ticket grouping by Area of Responsibility."*
2. *"SCADA-generated outages logged distinctly; ticket table grouped by Area of Responsibility (Unassigned / Assigned / Incident / Trouble Calls / Outages / Completed / Rejected / Closed)."*

Not covered here (later step): reclose auto-close, callback, downstream prediction.

## Setup

- Fresh seed so every tab has demo data: `cd backend; npm run seed -- --force` (this wipes and reseeds the `oms` database).
- Start backend and frontend, sign in as a user with the `oms_operator` or `system_admin` realm role, open **TCS / IVR**.
- Area of Responsibility = the substation (e.g. "BHOOPATWALA"). A call's area becomes the incident's substation when it is promoted.
- The tab a call sits in is **derived** from its linked incident, not stored.

| Tab | A call is here when |
|---|---|
| Unassigned | not rejected, no incident raised |
| Incident | incident exists, still `open`/`scheduled`, no crew |
| Assigned | incident `dispatched` / `in_progress` / `pending`, or has a crew (and is not resolved/closed/cancelled) |
| Completed | incident `resolved` |
| Closed | incident `closed` |
| Rejected | rejected by an operator, **or** its incident was `cancelled` (false alarm) |
| Trouble Calls | every call |
| Outages | not calls: every incident with source `SCADA` |

## Part 1 — Create calls of each priority; verify grouping

| # | Action | Expected |
|---|---|---|
| 1 | Open **TCS / IVR**. | Eight tabs show with counts: Unassigned, Assigned, Incident, Trouble Calls, Outages, Completed, Rejected, Closed. A **Log a call** button is top-right. |
| 2 | Click **Trouble Calls** tab. | All calls listed in groups by area (header = area name and count). Calls with no area are in a **No area** group, last. Within a group the order is Medical, Critical, Premium-VIP, Normal. |
| 3 | Click **Log a call**. Customer `FAT Medical`, phone `9000000001`, address `1 Test Rd`, Priority **Medical**, Area **BHOOPATWALA**. Click **Log call**. | Toast "Call CALL-xxxxx logged". Drawer closes. |
| 4 | Repeat step 3 with Priority **Critical**, **Premium-VIP**, **Normal** (customers `FAT Critical`, `FAT VIP`, `FAT Normal`), all in area **BHOOPATWALA**. | Four toasts. Each call appears at once, no reload (live refresh). |
| 5 | Click **Unassigned** tab. | A **BHOOPATWALA** group contains the four new calls, in the order Medical (red chip), Critical (orange), Premium-VIP (blue), Normal (yellow). The group header count matches. |
| 6 | Log one more call, Priority Normal, Area **MAYAPUR**, customer `FAT Mayapur`. | It appears in a separate **MAYAPUR** group. Calls are never mixed between areas. |
| 7 | Log a call leaving Area on **No area**. | It appears in the **No area** group, which is the last group. |
| 8 | Click **Log a call**, clear the Customer field, submit. | Toast "Customer, phone and address are required". Nothing created. |

## Part 2 — Ticket table by state, SCADA outages shown distinctly

| # | Action | Expected |
|---|---|---|
| 9 | **Unassigned** tab: on `FAT Normal`, click **Raise incident**. | Toast "Incident INC-… raised from call". The call leaves **Unassigned** and appears under **Incident** in the **BHOOPATWALA** group (an incident raised from a Medical or Critical call has severity critical, from a Premium-VIP call high, from a Normal call medium). |
| 10 | Open the **Incidents** screen, find the new incident, **Dispatch** a crew to it. Return to **TCS / IVR**. | Without a reload the call has moved from **Incident** to **Assigned**. |
| 11 | In **Incidents**, move that incident to `in_progress`, `pending`, `resolved`. After `resolved`, check **TCS / IVR**. | The call is in **Completed** (it keeps its crew but Completed wins). |
| 12 | Close the incident (`closed`). | The call moves to **Closed**. |
| 13 | **Unassigned** tab: on `FAT Critical` click **Reject**. Try to submit an empty reason. | **Reject call** stays disabled until the reason has at least 3 characters. |
| 14 | Enter reason `Caller hung up, no fault`, click **Reject call**. | Toast "Call … rejected". Call leaves **Unassigned**. |
| 15 | Click **Rejected** tab. | The call is there with a **Rejected** chip and the line "Caller hung up, no fault". The seed call CALL-007 (duplicate) and CALL-009 ("Incident cancelled (false alarm)") are also there. |
| 16 | Click **Unassigned**. Calls that already have an incident show no **Reject** button. | Only unassigned calls have **Raise incident** and **Reject**. |
| 17 | Click **Outages** tab. | Only SCADA-generated incidents are listed, each with a red **SCADA** badge, grouped by substation with counts. Calls and manually raised incidents are not here. |
| 18 | Compare **Outages** and **Trouble Calls**. | Outages show Incident / Source / Type / Severity / Status / Customers / Opened. Calls show Priority / Customer / Phone / Address / Status / Received. The two are visibly different tables. |
| 19 | Check the counts on all eight tabs. | Each tab's number equals the rows listed in it. Unassigned + Assigned + Incident + Completed + Rejected + Closed = Trouble Calls. |

## Permissions (can be shown with a test user)

- **Log a call** and **Reject**: roles `call_centre_attendant`, `oms_operator`, `system_admin`. Any other role gets HTTP 403.
- **Raise incident**: `oms_operator`, `system_admin` only. A `call_centre_attendant` gets 403.
  (Behaviour change: raising an incident from a call used to be open to any signed-in user.)

## Automated evidence

`cd backend; npm test` runs against a scratch database. It covers category validation, required fields, reject rules, every derived state, area copy on promote, severity mapping, `GET /calls` shape and the 403s.
