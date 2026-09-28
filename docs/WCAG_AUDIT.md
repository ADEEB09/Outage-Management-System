# WCAG 2.1 AA accessibility self-audit (frontend/)

Status: real automated scan run against the live, authenticated app across
all 9 screens, real violations found and the safe ones fixed and
re-verified. Several genuine issues remain open because fixing them
correctly requires a design decision this audit is not authorized to make
unilaterally -- see "Open items" below.

**This is a self-audit by the developer/AI assistant working on this
codebase, not a substitute for a real accessibility audit by a qualified
specialist or disabled users testing with their own assistive
technology.** Automated scanners (axe-core in this case) catch roughly
30-40% of WCAG failures by design -- they cannot judge whether alt text is
*meaningful*, whether a tab order makes *sense*, or whether a screen
reader user can actually complete a real task. Treat this document as a
baseline sweep, not a certification.

## What was tested

- **Target**: `frontend/` (the real React app served by Vite at
  `localhost:5173`), not the legacy prototype at the repo root (`src/`,
  `index.js`) -- that tree is marked superseded in `LEGACY.md` and was
  intentionally excluded.
- **Method**: [axe-core](https://github.com/dequelabs/axe-core) 4.10.2,
  injected live into the running app via Chrome DevTools automation
  (`window.axe.run()`), logged in as a real `oms_operator` user through
  the actual Keycloak flow -- not a static HTML scan, not a mocked auth
  state. Rules run: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`.
- **Screens covered**: Dashboard, Network Map, Incidents (including the
  incident-detail drawer and the "New incident" drawer), Dispatch, Alarms,
  TCS/IVR, Complaints, Analytics, Admin -- i.e. every tab in the app's
  primary nav, not just the seven named in the original ask.
- **Interactive components checked**: the incident detail drawer (Radix/
  vaul-based), the "New incident" drawer, the crew-message input, the
  global toast notification stack, the profile dropdown (Radix
  `DropdownMenu`), and the incident search-and-clear control -- several of
  these only render conditionally (e.g. the search "clear" button only
  exists once you've typed something), so they were opened/triggered by
  hand before scanning; a scan of the idle page alone would have missed
  them.
- **Not covered by the automated pass**: the Leaflet-based Network Map
  canvas itself (axe can meaningfully evaluate the DOM controls around it,
  not the canvas/SVG rendering of the grid), and no manual screen-reader
  walkthrough (NVDA/VoiceOver) or keyboard-only walkthrough was performed
  beyond spot-checking tab order on the fixed elements. Both are real gaps
  in this audit's coverage, not things that were checked and passed.

## What was found, screen by screen (before fixes)

| Screen | Violations found |
|---|---|
| Dashboard | `color-contrast` (22 nodes, badges + KPI hints) · `scrollable-region-focusable` (1 node -- reliability card scroll area had no keyboard access) |
| Network Map | 0 automated violations (see caveat above -- the map canvas itself isn't meaningfully scannable) |
| Incidents | `color-contrast` (26 nodes) |
| Dispatch | `color-contrast` (4 nodes) · **`select-name`, critical, 62 nodes** -- every "assign nearest crew" dropdown on the page had no accessible name at all |
| Alarms | `color-contrast` (9 nodes) |
| TCS / IVR | `color-contrast` (36 nodes) |
| Complaints | `color-contrast` (1 node) |
| Analytics | `color-contrast` (5 nodes) |
| Admin | `color-contrast` (1 node) |
| Incident detail drawer | `color-contrast` (26 nodes, inherited from the underlying table) · **`label`, critical, 1 node** -- the restoration-ETA `datetime-local` input had no accessible label |

Issues found by manual inspection that the automated pass did **not**
flag (because the element only renders conditionally, or because axe's
ruleset doesn't check for it under an automated tag):

- The incident-detail drawer (`vaul`/Radix dialog) rendered with no
  accessible name -- a screen reader announces "dialog" with nothing to
  say which incident it's for.
- The incident search box's "clear" button (`IncidentSearch.jsx`) is
  icon-only and only exists once you've typed a query, so it never
  appeared during an idle-page scan; it had no `aria-label`.
- Two more icon-only close buttons (`Incidents.jsx`'s "New incident"
  drawer, `NetworkMap.jsx`'s feature-detail panel) had no `aria-label`,
  relying only on the visual "X" glyph.
- The global toast notification stack (`App.jsx`) had no
  `aria-live`/`role="status"` region, so a screen reader user gets no
  announcement when "Crew assigned" or an error toast appears -- they'd
  only find out by navigating to it manually, after the fact.

## What was fixed (and verified by re-running the scan)

All of the following were fixed using only the existing CSS variables/
tokens and standard HTML/ARIA attributes -- no new colors, no visual
redesign, no new component library. Each was re-scanned live in the
browser after the fix; results below are the actual before/after axe
output, not an assumption that the fix worked.

| Fix | File | Before | After |
|---|---|---|---|
| `select` elements on Dispatch had no accessible name -- added `aria-label="Select nearest crew to assign"` | `frontend/src/screens/Dispatch.jsx` | `select-name`, critical, 62 nodes | 0 |
| ETA `datetime-local` input had no label -- added `aria-label="Estimated restoration date and time"` | `frontend/src/screens/Incidents.jsx` | `label`, critical, 1 node | 0 |
| Dashboard's scrollable "Active incidents" table region had no keyboard access -- added `tabIndex={0} role="region" aria-label="Active incidents table"` | `frontend/src/screens/Dashboard.jsx` | `scrollable-region-focusable`, serious, 1 node | 0 |
| Incident detail drawer had no accessible name -- added `aria-label={`Incident ${inc.id} details`}` to `DrawerContent` | `frontend/src/screens/Incidents.jsx` | no name announced to AT (not flagged by automated tag, confirmed by reading the live DOM) | `aria-label="Incident INC-2026-000069 details"` confirmed present on the live element |
| Search box had no label; its icon-only clear button had no name -- added `aria-label="Search incidents"` and `aria-label="Clear search"` | `frontend/src/components/IncidentSearch.jsx` | textbox announced only via placeholder (lost once typing starts); clear button unnamed | both confirmed via live accessibility tree read (`textbox "Search incidents"`) |
| Crew-message input relied on placeholder only -- added `aria-label="Message the crew"` | `frontend/src/screens/Incidents.jsx` | placeholder-only | explicit label |
| "New incident" drawer close button and Network Map feature-panel close button were icon-only with no name -- added `aria-label="Close"` to both | `frontend/src/screens/Incidents.jsx`, `frontend/src/screens/NetworkMap.jsx` | unnamed icon buttons | `aria-label="Close"` |
| Toast notifications had no live region -- added `role="status" aria-live="polite" aria-atomic="true"` to the toast container and `role="alert"` to error toasts | `frontend/src/App.jsx` | silent to screen readers | announced on appearance |

Post-fix re-scan results (same axe ruleset, same live app):

- Dispatch: `select-name` violation count 62 -> **0**
- Incidents drawer: `label` violation count 1 -> **0**, drawer now
  reports `aria-label="Incident INC-2026-000069 details"` in the live DOM
- Dashboard: `scrollable-region-focusable` violation count 1 -> **0**
- Every screen re-scanned still shows the color-contrast findings below
  (expected -- those were deliberately left alone, see next section)

## Open items -- flagged, not fixed, and why

### Color contrast on the severity/status badge system (design decision needed)

Every screen surfaces the same "pastel badge" pattern -- a light tint
background with a saturated foreground color -- for severity (`sev-critical`,
`sev-high`, `sev-medium`), status (`st-open`, `st-dispatched`,
`st-in_progress`), and chip variants (`chip-crit`, `chip-major`,
`chip-minor`) used across Dashboard, Incidents, Dispatch, Alarms, TCS, and
Analytics. This is a single shared design system, not a one-off bug, which
is exactly the kind of thing this audit was told to flag rather than
silently repaint.

Measured contrast ratios (WCAG 2.1 AA requires **4.5:1** for normal text,
3:1 for large/bold text) using the actual hex values from
`frontend/src/index.css`:

| Token pair | Ratio | AA normal-text (4.5:1) |
|---|---|---|
| `--crit` (#d7382a) on `--crit-bg` (#fdeceb) | 4.09:1 | Fails (close) |
| `--high` (#e08a1e) on `--high-bg` (#fdf1de) | 2.40:1 | Fails |
| `--med` (#2f6fd6) on `--med-bg` (#e7f0fd) | 4.19:1 | Fails (close) |
| `--muted` (#64748b) on `--paper` (#eef1f4) | 4.20:1 | Fails (close) |
| `--faint` (#9fb0c4) on white | 2.21:1 | Fails badly |
| `--faint` (#9fb0c4) on `--paper` | 1.95:1 | Fails badly |

`--faint` in particular is used far beyond badges -- footer text, the live
event tape timestamps, KPI hint text, empty-state copy -- so darkening it
would touch the app's entire secondary-text hierarchy, not just one
component. `--crit`/`--high`/`--med` are the severity color language
operators rely on at a glance across every screen; changing them is a
brand/design-system decision, not a bug fix, even though the fix itself
(darkening each foreground a few percent, keeping the same hue) would be
small. **Recommendation**: whoever owns the design system should pick new
values for `--crit`, `--high`, `--med`, `--muted`, and `--faint` that hit
4.5:1 against their paired backgrounds, ideally checked with a real
contrast tool against the actual rendered UI, not just the swatch --
this audit did not make that call.

### Network Map canvas content

The Leaflet-rendered map (feeders, substations, incident markers) is
SVG/canvas content that an automated DOM scanner cannot meaningfully
evaluate for color-only encoding of meaning, marker contrast, or
zoom-control operability by keyboard. The layer-toggle checkboxes and
sidebar are real HTML and scanned clean, but the map surface itself needs
manual testing (keyboard-only pan/zoom, and confirming severity isn't
conveyed by color alone) -- out of scope for what an automated pass can
responsibly claim to have verified.

### No manual screen-reader or keyboard-only walkthrough

Everything above was verified with axe-core (automated) and targeted
live-DOM checks (accessible name/role confirmed via the browser's
accessibility tree). Nobody has yet driven this app end-to-end with
NVDA, JAWS, or VoiceOver, or attempted the full incident lifecycle
(create -> dispatch -> assign crew -> resolve) using only a keyboard.
That's the gap a real specialist audit would close.

## Files changed

- `frontend/src/screens/Dispatch.jsx`
- `frontend/src/screens/Incidents.jsx`
- `frontend/src/screens/Dashboard.jsx`
- `frontend/src/screens/NetworkMap.jsx`
- `frontend/src/components/IncidentSearch.jsx`
- `frontend/src/App.jsx`

No CSS files, color tokens, or visual layout were changed.
