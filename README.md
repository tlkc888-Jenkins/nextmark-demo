# NextMark

An offshore race pilot that works with no signal. Build the day's course at the
briefing, then sail it with rounding that follows the sailing instructions.

- `race.html` — the app
- `index.html` — the original concept demo (kept as-is)

## Why it is built this way

Sunday offshore passage racing at Southport is **course X1**: *"a course set by
the Race Committee as advised at the Compulsory Skippers Briefing."* There is no
pre-published course to download. So the app's primary surface is a course
builder you drive from the board at 09:00, and everything else serves that.

Three clauses of the SIs shape the design:

| SI | What it says | What the app does |
|---|---|---|
| 10.2 | All marks to port unless stated (S) | Port is the default when you tap a mark |
| 10.3 | A mark missing or >200 m off station is rounded at its published coordinates | Positions always come from the SIs, never from a sighting; an off-station check is built in |
| 10.7 | A valid GPS fix inside a mark's 90° quadrant is deemed to have rounded it | Auto-advance is a quadrant test, not a proximity radius — so it is rule-correct, not just convenient |
| 20.8 | Within 15 min of rounding, text the RO the yacht name and a photo of an instrument showing the fix and time inside the quadrant | Generates exactly that card, ready to share |

## Two series, one app

The app ships two SYC course packs and a **Series** switcher on the Course tab:

- **Offshore Division 2026/27** — Sunday racing as above: the X1 builder,
  quadrant rounding, the 20.8 declaration.
- **Thursday Twilight 2026/27** — pursuit racing on the Broadwater. Fourteen
  published courses (Attachment D) load with one tap, each with its own
  Division 1 / Division 2 mark sequence and — new for this pack — a **finish
  line that is not the start line** (Wave-Break or Main Beach at either end).
  Course 15 is the Div 1 offshore option, set on the day, so it is a builder
  course like X1. The TT SIs publish no rounding quadrants and no declaration,
  so auto-advance falls back to proximity (~75 m) and the declaration UI stays
  out of the way. "Arm for" takes any clock time, because a pursuit start is
  your own handicap minute, with the preparatory signal 4 minutes before it.

A course shared to the crew carries its start and finish lines with it, and a
link from one series is refused by an app that has the other loaded.

## On the water

Nothing but an explicit **New race** discards a track. Changing the wind,
editing the course, or switching division never touches recorded fixes.

- **Start sequence** runs on the wall clock, not frame timing, so a locked screen
  or a backgrounded tab cannot make it drift.
- **Screen wake lock** is held while racing and re-acquired every time the app
  returns to the foreground.
- **A missed rounding is always recoverable** — *Next mark* advances by hand and
  records that it was manual, so the declaration never claims a quadrant fix it
  did not get.
- **A mark added over VHF** is typed in as coordinates, in the format the RC
  reads out (`28 11.200 S`), as decimal degrees, or pasted whole.

### The limit worth knowing

**No web app on iOS can record GPS while the screen is locked or the app is
backgrounded.** There is no background geolocation for web on iOS, and Android
throttles it. That is why the app holds the screen awake. If recording does
stop, the track resumes with a visible **gap** — never a straight line across
water the boat did not sail.

## Sharing the course to the crew

There is no server and no accounts, so eight phones are eight independent apps —
which means the course has to travel. **Share course to crew** puts the whole
course inside a link: marks, sides, any mark you added by hand, a pinned start
line. The crew tap it in the group chat and their app offers to load it.

A few things it is careful about:

- It rides in the URL **fragment**, so the course is never sent to the host and
  never lands in anyone's logs.
- It carries a **checksum**. Chat apps wrap, truncate and append to URLs, and a
  half-decoded course that still parsed would put the wrong marks on someone's
  chart. A damaged link is rejected with "ask for it again".
- Nothing is applied on arrival. The link opens a panel showing the course in
  full; the crew member taps to load it.
- A link made for a different club's pack, or by a newer version of the app, is
  refused rather than guessed at.

A six-mark course makes a link of about 285 characters.

### Crew mode

Carried by the share link, and switchable in Settings. On a boat one person
runs the start, so crew mode hides the start sequence, the line pin and all
course editing — eight phones cannot drift apart — and replaces them with a
single **Start recording**. Each crew member still gets their own track, their
own numbers and their own roundings, which is real redundancy if the helm's
phone goes over the side.

## Storage

Everything stays on the device that recorded it. Nothing is uploaded.

A fix is 20 bytes — lat/lon as scaled int32 (1.1 cm), ms offset, SOG, COG,
accuracy, flags. At 1 Hz that is **72 KB/hour**, so the 6-hour passage race time
limit is about **430 KB** and the full 17-day Offshore season is single-digit
megabytes. Fixes append into 512-fix chunks, flushed every 5 s, so a hard kill
costs seconds rather than the race.

On iOS, add the app to the Home Screen — Safari evicts storage for sites that
are merely bookmarked.

## Reading the briefing board

Optional, and never required. Photograph the board and it is kept on the device
so it can be zoomed on deck with no signal. If an API key is set in Settings,
the photo can also be read into a course — returned against a fixed schema as
marks and sides, not prose, with coordinates re-parsed locally and the result
shown as a **proposal you confirm** before it reaches the chart.

The key is stored on the device and sent straight to the API. Browser access to
the API is an explicit opt-in that exposes the key to the page, which is
acceptable for your own phone and your own key and not for distribution — set a
proxy URL instead when this goes to other boats.

## Charts anywhere

Two coastline layers, so the chart is never blank wherever the marks are:

- `data/coast-world.json` — Natural Earth 10m, simplified to 400 m and tiled at
  10°, ~1 MB for the planet, cached once by the service worker.
- `data/coast-syc.json` — OpenStreetMap at ~25 m, clipped to the race area.
  Drawn in preference wherever it covers the view.

Neither is for navigation.

## Build

The data files are committed; rebuild them only when a source changes.

```sh
cd tools
curl -L -o ne10m.geojson \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson
python build_coast.py 400                       # -> coast-world.json
curl -A "NextMark coastline-build" -X POST https://overpass-api.de/api/interpreter \
  --data-urlencode 'data=[out:json][timeout:90];way["natural"="coastline"](-28.32,153.28,-27.78,153.68);(._;>;);out body;' \
  -o osm_gc.json
python build_pack_coast.py osm_gc.json coast-syc.json 25
python build_pack_syc.py                        # -> syc-offshore-2627.json
python build_pack_syc_tt.py                     # -> syc-twilight-2627.json
```

The pack builders hold every mark transcribed verbatim from Attachment B of
their SIs as degrees-and-decimal-minutes; the decimal degrees the app uses are
derived there, so no conversion is done by hand. Course sequences are
transcribed as the SI writes them (`H E(s) G F(s) H(s)`) and parsed the same
way.

## Tests

```sh
node app/geo.test.mjs      # geometry, quadrants, coordinate parsing
node app/race.test.mjs     # pack, rounding engine, board ingest, codec
node app/share.test.mjs    # course share links: round trip, damage, refusal
node app/twilight.test.mjs # twilight pack, per-division courses, split lines
node app/wiring.test.mjs   # markup/script/style/service-worker wiring
```

## Source

Sailing Instructions 2026–2027 Offshore Division (incl. Amendment 1),
Southport Yacht Club Inc. — <https://southportyachtclub.com.au/offshore/>

Thursday Twilight 2026/27 Sailing Instructions, Southport Yacht Club Inc. —
<https://southportyachtclub.com.au/sailing/twilight-inshore/>

Not for navigation.
