# Network map: feeder line labels don't match physical continuity

Status: real defect found and measured in `backend/src/infra/network.json`.
Automated geometric-tracing fix was attempted and rejected as unsafe --
see "Why this can't be fixed by tracing" below. **Needs a corrected GIS
export from the data source, not a code fix.**

## The symptom

On the Network Map screen, clicking a feeder to highlight its circuit
(`pickFeeder()` in `frontend/src/screens/NetworkMap.jsx`) shows
disconnected fragments scattered across the map instead of one traced
line from substation to endpoint.

## Why: the data, not the rendering

`network.json`'s `feederLines` array holds 262 short (~12m average)
two-point pole-span segments, each tagged with a `feeder` name. The
frontend groups and draws these by that name -- that code is working
correctly. The problem is upstream: **on a real, physically continuous
run of line, the `feeder` label frequently changes from one segment to
the next.**

Measured directly: for every pair of segments whose endpoints sit within
3m of each other (i.e. physically the same wire, pole to pole), only
**128 pairs shared the same `feeder` name, vs. 464 pairs with different
names** -- roughly 3.6x more often wrong than right. Concretely, the
feeder `"33 kV I/C For PTR-2"` has 15 segments in the file, and the
*closest* any two of them get to each other is 150m -- they're isolated
stubs scattered across the whole 5-10km service area, not a traced
route.

## Why this can't be fixed by tracing (tried, rejected)

The obvious fix -- union segments whose endpoints are within a few
meters of each other into one connected circuit, then relabel the whole
circuit with its majority-vote name -- was implemented and tested against
the real file before touching anything. Two variants, both fail:

1. **Plain proximity tracing** (endpoints within 3m = same run): produces
   71 connected components from 262 segments. But the *largest* one (16
   segments) turned out to be every segment within 5-17m of the
   INDUSTRIAL AREA substation -- 12 genuinely different feeders (`PTR-1`,
   `PTR-2`, `NEW TIBRI`, `JAWALAPUR`, `INDIRA BASTI`, `MANCHANDA`, ...)
   that all physically originate from the same substation bus. Proximity
   alone can't distinguish "same feeder, next pole" from "different
   feeder, same substation" -- a substation is exactly where many feeders
   converge to nearly one point, so naive tracing merges them.
2. **Excluding anything within 25m of a substation before tracing**:
   fixes the false-merging (99% of resulting components end up with a
   single consistent label) but by barely merging anything at all -- 254
   components out of 262 segments, because for most segments the *only*
   nearby neighbor was at the substation hub just excluded. There's
   nothing left to trace into a real circuit.

The underlying issue: `feederLines` is a sparse set of representative
stub segments, not a dense pole-by-pole survey. Away from substations
there usually isn't another segment nearby to chain onto at all. Any
proximity threshold between these two extremes would just be an
unreliable heuristic dressed up as ground truth for a real grid's
topology -- not something this should silently do to operational GIS
data.

## What's actually needed

A corrected export from whoever produced `network.json` (or the original
survey/GIS tool), with feeder attribution captured correctly per span --
i.e. a continuous physical run should carry one consistent feeder label
along its whole length. This is a data-source fix, not a code fix.

## A separate, related finding worth knowing about

`feederLines[].feeder` (descriptive names like `"11 kV O/G MAIN BAZAR"`)
and `distTx[].feeder` (short operational codes like `"UPCL-JW-B"`, the
same style used for incidents/dispatch elsewhere in the app) are **two
entirely separate naming systems** with no field joining them. The map's
"feeder lines" visualization and the DTR-to-feeder attribution used in
`backend/src/infra/geo.js` (`resolve()`, for locating customer
complaints) never actually reference each other today -- worth keeping
in mind if a future fix tries to reconcile them at the same time as the
labeling issue above.
