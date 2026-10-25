"""Build the SYC Offshore Division 2026/27 course pack.

Every coordinate below is transcribed verbatim from Attachment B of
"SAILING INSTRUCTIONS 2026 - 2027 OFFSHORE DIVISION (incl. Amendment 1)",
Southport Yacht Club, as degrees + decimal minutes. The decimal degrees the
app uses are derived here so no conversion is done by hand.

Source PDF:
https://southportyachtclub.com.au/wp-content/uploads/2026/08/OD-26-27-Sailing-Instructions-Including-Amendment-1-final.pdf
"""
import json, re

SI_URL = ("https://southportyachtclub.com.au/wp-content/uploads/2026/08/"
          "OD-26-27-Sailing-Instructions-Including-Amendment-1-final.pdf")


def ddm(s):
    """'27 56.400 S' -> -27.94 . Accepts the SI's own notation."""
    m = re.match(r"^\s*(\d+)\s+([\d.]+)\s*([NSEW])\s*$", s)
    if not m:
        raise ValueError("bad coord: %r" % s)
    deg, mins, hemi = int(m.group(1)), float(m.group(2)), m.group(3)
    v = deg + mins / 60.0
    return -v if hemi in "SW" else v


def mk(id, name, lat=None, lon=None, quad=None, note=None, kind="course"):
    m = {"id": id, "name": name, "kind": kind}
    if lat is not None:
        m["si_lat"], m["si_lon"] = lat, lon
        m["lat"], m["lon"] = round(ddm(lat), 6), round(ddm(lon), 6)
    else:
        m["lat"] = m["lon"] = None
    if quad:
        m["quadrants"] = quad
    if note:
        m["note"] = note
    return m


# SI 10.7 rounding quadrants. Two bearings 90 deg apart measured FROM the mark;
# a valid GPS fix inside that quadrant proves the mark was passed correctly.
# dir "S"/"N" selects by the bearing of the leg arriving at the mark;
# dir "*" applies in any direction.
COASTAL_QUAD = [
    {"dir": "S", "b1": 180, "b2": 270, "si": "180 and 270 when heading in a Southerly direction"},
    {"dir": "N", "b1": 0,   "b2": 270, "si": "0 and 270 when heading in a Northerly direction"},
]
ANY_SW = [{"dir": "*", "b1": 180, "b2": 270, "si": "180 and 270"}]

MARKS = [
    mk("SF", "Offshore Start/Finish", "27 56.400 S", "153 27.230 E",
       note="Approx. 1 NM south of the Sand Pump Jetty. Line position is confirmed at the "
            "Compulsory Skippers Briefing and may differ from the SI diagram (SI 12.3).",
       kind="line"),
    mk("A", "Surfers Mark", "28 00.135 S", "153 26.800 E", COASTAL_QUAD),
    mk("B", "Burleigh Mark", "28 05.100 S", "153 27.800 E", COASTAL_QUAD),
    mk("C", "Currumbin Mark", "28 07.300 S", "153 29.500 E", COASTAL_QUAD),
    mk("D", "Cook Island Mark", "28 11.200 S", "153 34.300 E", ANY_SW),
    mk("E", "Laid Mark", note="Position as described at the Compulsory Skippers Briefing.",
       kind="laid"),
    mk("F1", "Offshore FAD1", "27 59.33 S", "153 31.75 E"),
    mk("M", "Mermaid Mark", "28 2.596 S", "153 27.293 E"),
    mk("MSW", "Mermaid Seaward Mark", "28 2.593 S", "153 29.504 E"),
    mk("N", "Northern Mark", "27 53.560 S", "153 28.610 E", ANY_SW),
    mk("S", "Snapper Mark", "28 09.330 S", "153 33.000 E", ANY_SW),
    mk("SW", "Seaward Mark", "27 57.805 S", "153 28.536 E", ANY_SW),
    mk("X", "Laid Clearance Buoy", note="If used: approx. 0.8 NM to windward of the start line.",
       kind="laid"),
]

# Relative marks for W/L and triangular racing, laid on the day (Attachment D).
REL_MARKS = [
    {"id": "1", "name": "Mark 1 (windward)", "rel": "windward", "note": "Laid to windward of the start line."},
    {"id": "1a", "name": "Mark 1a (windward, Div 2)", "rel": "windward",
     "note": "The RC may designate 1a as the windward mark for Division 2 in place of Mark 1 "
             "(advised at the briefing and/or on the course board)."},
    {"id": "2", "name": "Mark 2 (reaching)", "rel": "reach", "note": "Triangle reaching mark."},
    {"id": "3p", "name": "Gate 3p", "rel": "leeward", "note": "Leeward gate, port-hand mark."},
    {"id": "3s", "name": "Gate 3s", "rel": "leeward", "note": "Leeward gate, starboard-hand mark."},
]

# Attachment C. "P" = leave to port, "S" = starboard. SI 10.2: port unless stated.
# "3s/3p" is a gate: either mark may be taken.
COURSES = [
    {"id": "X1", "name": "RC-set passage course", "type": "PASSAGE", "builder": True,
     "si": "A course set by the Race Committee as advised at the Compulsory Skippers Briefing.",
     "seq": []},
    {"id": "W1", "name": "START - 1 - FINISH", "type": "W/L",
     "seq": [["1", "P"]]},
    {"id": "W2", "name": "START - 1 - 3s/3p - 1 - FINISH", "type": "W/L",
     "seq": [["1", "P"], ["3s|3p", "G"], ["1", "P"]]},
    {"id": "W3", "name": "START - 1 - 3s/3p - 1 - 3s/3p - 1 - FINISH", "type": "W/L",
     "seq": [["1", "P"], ["3s|3p", "G"], ["1", "P"], ["3s|3p", "G"], ["1", "P"]]},
    {"id": "T1", "name": "START - 1 - 2 - FINISH", "type": "W/L",
     "seq": [["1", "P"], ["2", "P"]]},
    {"id": "TL2", "name": "START - 1 - 2 - 3p - 1 - FINISH", "type": "W/L",
     "seq": [["1", "P"], ["2", "P"], ["3p", "P"], ["1", "P"]]},
    {"id": "TL3", "name": "START - 1 - 2 - 3p - 1 - 3p/3s - 1 - 2 - FINISH", "type": "W/L",
     "seq": [["1", "P"], ["2", "P"], ["3p", "P"], ["1", "P"], ["3p|3s", "G"], ["1", "P"], ["2", "P"]]},
]

ZONES = [
    {"id": "wonder-reef", "name": "Wonder Reef", "type": "prohibited",
     "si": "SI 11.3 - continuing obstruction and prohibited area. A boat shall not sail in.",
     "poly": [ddm("27 57.453 S"), ddm("153 27.188 E"),   # NW
              ddm("27 57.459 S"), ddm("153 27.432 E"),   # NE
              ddm("27 57.742 S"), ddm("153 27.431 E"),   # SE
              ddm("27 57.749 S"), ddm("153 27.187 E")]}, # SW
]
WAVE_BUOYS = [
    ("Brisbane wave buoy", "27 29.230 S", "153 37.900 E"),
    ("Gold Coast wave buoy", "27 57.914 S", "153 26.555 E"),
    ("Palm Beach wave buoy", "28 05.956 S", "153 29.073 E"),
    ("Bilinga wave buoy", "28 08.581 S", "153 30.646 E"),
]
for nm, la, lo in WAVE_BUOYS:
    ZONES.append({"id": nm.lower().replace(" ", "-"), "name": nm, "type": "exclusion",
                  "si": "SI 11.4 - enforceable 100 m exclusion zone. A boat shall not sail in.",
                  "lat": round(ddm(la), 6), "lon": round(ddm(lo), 6), "radius_m": 100})

FINISH_OPTIONS = [
    {"id": "15.1.1", "desc": "Blue flag on the finishing boat (eastern end) to the finishing mark (western end)."},
    {"id": "15.1.2", "desc": "End of the Sand Pumping Jetty to the finishing mark."},
    {"id": "15.1.3", "desc": "End of the Sand Pumping Jetty to a blue flag on the finishing boat."},
    {"id": "15.1.4", "desc": "Imaginary line from the eastern end of the Sand Pumping Jetty to 27 56.315 S 153 26.500 E.",
     "lat": round(ddm("27 56.315 S"), 6), "lon": round(ddm("153 26.500 E"), 6)},
]

SCHEDULE = [
    # Offshore Division schedule, May 2026 - April 2027 (SI p.2)
    ("2026-05-17", "Winter Passage - Day 1/6", "PASSAGE"),
    ("2026-05-31", "Winter W/L | Short Passage - Day 1/2 | IRC Super Series Day 1/6", "W/L"),
    ("2026-06-21", "Winter Passage - Day 2/6", "PASSAGE"),
    ("2026-07-05", "Winter Passage - Day 3/6 (POSTPONED)", "PASSAGE"),
    ("2026-07-19", "Winter W/L | Short Passage - Day 2/2 | IRC Super Series Day 2/6", "W/L"),
    ("2026-08-30", "Winter Passage - Day 4/6", "PASSAGE"),
    ("2026-09-13", "Winter Passage - Day 3/6 (RESCHEDULED)", "PASSAGE"),
    ("2026-09-27", "Summer Passage - Day 1/5", "PASSAGE"),
    ("2026-10-18", "Summer W/L | Short Passage - Day 1/4 | IRC Super Series Day 3/6", "W/L"),
    ("2026-11-15", "Summer Passage - Day 2/5", "PASSAGE"),
    ("2026-11-29", "Summer W/L | Short Passage - Day 2/4 | IRC Super Series Day 4/6", "W/L"),
    ("2026-12-13", "Summer Passage - Day 3/5", "PASSAGE"),
    ("2027-01-10", "Summer Passage - Day 4/5", "PASSAGE"),
    ("2027-02-14", "Summer Passage - Day 5/5", "PASSAGE"),
    ("2027-02-28", "Summer W/L | Short Passage - Day 3/4 | IRC Super Series Day 5/6", "W/L"),
    ("2027-04-04", "Summer W/L | Short Passage - Day 4/4 | IRC Super Series Day 6/6", "W/L"),
    ("2027-04-18", "Summer spare race day", "PASSAGE"),
]
EVENTS = [
    # Additional SYC special events (SI p.3)
    ("2026-10-03", "2026-10-05", "The Yacht Sales Co. Sail Paradise Regatta"),
    ("2026-11-01", "2026-11-01", "Cook Island Yacht Race"),
    ("2026-12-26", "2026-12-31", "Sydney Hobart Yacht Race"),
    ("2027-01-23", "2027-01-24", "Ted Elkes Memorial Regatta"),
    ("2027-02-06", "2027-02-06", "Surf to City"),
    ("2027-03-13", "2027-03-13", "Julian Rocks Yacht Race"),
    ("2027-03-20", "2027-03-20", "Ladies Day Race"),
    ("2027-03-21", "2027-03-21", "DUX Birthday Celebrations"),
    ("2027-03-26", "2027-03-29", "Brisbane to Gladstone Yacht Race"),
    ("2027-04-24", "2027-04-24", "Burleigh Bash"),
]

pack = {
    "id": "syc-offshore-2627",
    "name": "SYC Offshore Division 2026/27",
    "club": "Southport Yacht Club",
    "club_url": "https://southportyachtclub.com.au/offshore/",
    "country": "Australia",
    "state": "QLD",
    "datum": "WGS84",
    "source": {
        "title": "Sailing Instructions 2026-2027 Offshore Division (incl. Amendment 1)",
        "url": SI_URL,
        "authority": "Southport Yacht Club Inc.",
        "rrs": "Racing Rules of Sailing 2025-2028",
        "category": "AS SR Part 1 Offshore, Category 4",
    },
    "divisions": [
        {"id": "D1", "name": "Division 1", "flag": "Numeral Pennant 1",
         "scoring": "ORC Club, IRC, PHS", "windward_mark": "1"},
        {"id": "D2", "name": "Division 2", "flag": "Numeral Pennant 2",
         "scoring": "ORC Club, IRC, PHS", "windward_mark": "1",
         "note": "RC may designate Mark 1a as the windward mark for Division 2 in place of Mark 1."},
        {"id": "IRC", "name": "IRC Super Series", "flag": "Numeral Pennant 3",
         "scoring": "IRC", "windward_mark": "1"},
    ],
    "rules": {
        "default_rounding": "P",
        "default_rounding_si": "SI 10.2 - all marks to be rounded to Port unless stated (S).",
        "off_station_m": 200,
        "off_station_si": "SI 10.3 - if a mark is missing or has shifted more than 200 m from its "
                          "GPS position, round the position using the SI coordinates.",
        "quadrant_si": "SI 10.7 - a valid GPS fix within the mark's 90 degree rounding quadrant is "
                       "deemed to have rounded or passed the mark on the correct side.",
        "declaration_si": "SI 20.8 - when advised at the briefing, within 15 minutes of rounding or "
                          "passing a Waypoint Mark, notify the Race Officer by text/MMS with the "
                          "yacht's name AND a photograph of an instrument displaying the fix and "
                          "time of the rounding within the rounding quadrant.",
        "declaration_window_min": 15,
        "start_si": "SI 12.1 - RRS 26, warning signal 5 minutes before the starting signal.",
        "warning_signal_sec": 300,
        "vhf_race": "09",
        "vhf_seaway": "73",
        "briefing": {"summer": "09:00", "winter": "10:00",
                     "start_not_before": {"summer": "11:00", "winter": "12:00"}},
        "time_limits": {
            "Short Passage": {"mark1_min": 45, "race_h": 4, "window_min": 45},
            "Passage": {"mark1_min": 150, "race_h": 6, "window_min": 120},
            "W/L": {"mark1_min": 45, "race_h": 2, "window_min": 45},
        },
    },
    "marks": MARKS,
    "relative_marks": REL_MARKS,
    "courses": COURSES,
    "zones": ZONES,
    "finish_options": FINISH_OPTIONS,
    "schedule": [{"date": d, "name": n, "type": t} for d, n, t in SCHEDULE],
    "events": [{"from": a, "to": b, "name": n} for a, b, n in EVENTS],
}

txt = json.dumps(pack, indent=1)
open("syc-offshore-2627.json", "w", encoding="utf-8").write(txt)

print("marks:")
for m in MARKS:
    if m["lat"] is None:
        print("  %-4s %-28s  (position given on the day)" % (m["id"], m["name"]))
    else:
        print("  %-4s %-28s  %10.6f %11.6f   <- %s %s"
              % (m["id"], m["name"], m["lat"], m["lon"], m["si_lat"], m["si_lon"]))
print("courses: %d   zones: %d   race days: %d   events: %d"
      % (len(COURSES), len(ZONES), len(SCHEDULE), len(EVENTS)))
print("bytes %d" % len(txt.encode()))
