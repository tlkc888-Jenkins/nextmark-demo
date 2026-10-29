"""Build the SYC Thursday Twilight 2026/27 course pack.

Every coordinate below is transcribed verbatim from Attachment B of
"THURSDAY TWILIGHT 2026/27 - SAILING INSTRUCTIONS", Southport Yacht Club,
as degrees + decimal minutes. The decimal degrees the app uses are derived
here so no conversion is done by hand. Course sequences are transcribed from
Attachment D and parsed here for the same reason.

Source PDF:
https://southportyachtclub.com.au/wp-content/uploads/2026/04/TT-26-27-Sailing-Instructions.pdf
"""
import json, re

SI_URL = ("https://southportyachtclub.com.au/wp-content/uploads/2026/04/"
          "TT-26-27-Sailing-Instructions.pdf")


def ddm(s):
    """'27 55.676 S' -> -27.927933 . Accepts the SI's own notation."""
    m = re.match(r"^\s*(\d+)\s+([\d.]+)\s*([NSEW])\s*$", s)
    if not m:
        raise ValueError("bad coord: %r" % s)
    deg, mins, hemi = int(m.group(1)), float(m.group(2)), m.group(3)
    v = deg + mins / 60.0
    return -v if hemi in "SW" else v


def mk(id, name, lat, lon, note=None, kind="course"):
    m = {"id": id, "name": name, "kind": kind,
         "si_lat": lat, "si_lon": lon,
         "lat": round(ddm(lat), 6), "lon": round(ddm(lon), 6)}
    if note:
        m["note"] = note
    return m


# Attachment B - SYC TWILIGHT MARKS. The courses in Attachment D write the
# start simply as "WBS"; the SIs publish two Wave-Break start lines, so both
# are here and WBS1 is the default. Pin the actual line on the water.
WBS_NOTE = ("Attachment D courses say just 'WBS' - the RC anchors the line at "
            "WBS1 or WBS2 on the day. Pin the line ends on the water.")
MARKS = [
    mk("WBS1", "Wave-Break Start 1", "27 55.676 S", "153 25.057 E",
       note="Between the first port/starboard laterals, near the southern end "
            "of Carters Bank. " + WBS_NOTE, kind="line"),
    mk("WBS2", "Wave-Break Start 2", "27 55.321 S", "153 24.895 E",
       note="Between the second port/starboard laterals, north of WBS1. " + WBS_NOTE,
       kind="line"),
    mk("WBF", "Wave-Break Finish", "27 56.393 S", "153 25.213 E",
       note="Between the port lateral and the special mark (yellow cross).",
       kind="line"),
    mk("MBSF", "Main Beach Start/Finish", "27 58.304 S", "153 25.348 E",
       note="Port/starboard laterals opposite the SYC D-arm jetty.", kind="line"),
    mk("C", "Crab Island", "27 53.940 S", "153 25.136 E",
       note="Port lateral. SI 10.1: an IALA navigation mark - keep a safe clearance."),
    mk("E", "SYC Mark", "27 55.092 S", "153 24.659 E",
       note="SYC inflatable cylinder buoy."),
    mk("F", "Deep Hole", "27 54.980 S", "153 24.842 E",
       note="Starboard lateral. SI 10.1: an IALA navigation mark - keep a safe clearance."),
    mk("G", "South Stradbroke Stbd", "27 55.654 S", "153 25.085 E",
       note="Starboard lateral. SI 10.1: an IALA navigation mark - keep a safe clearance."),
    mk("H", "Seaway East Cardinal", "27 56.170 S", "153 25.328 E",
       note="East cardinal. SI 10.1: an IALA navigation mark - keep a safe clearance."),
    mk("J", "South Stradbroke Port", "27 55.698 S", "153 25.019 E",
       note="Port lateral. SI 10.1: an IALA navigation mark - keep a safe clearance."),
]


def seq(text):
    """'C J(s) E H(s)' -> [["C","P"],["J","S"],["E","P"],["H","S"]].

    Attachment D: all marks to port unless indicated by (s).
    """
    out = []
    for tok in text.split():
        m = re.match(r"^([A-Z]+)(\(s\))?$", tok, re.I)
        if not m:
            raise ValueError("bad course token: %r" % tok)
        out.append([m.group(1).upper(), "S" if m.group(2) else "P"])
    return out


# Attachment D - SYC TWILIGHT COURSES & MARK ROUNDINGS, transcribed verbatim
# minus the start/finish tokens, which become the course's start/finish lines.
# (id, wind, start, finish, div1 marks, div1 nm, div2 marks, div2 nm)
COURSES = [
    ("1", "S", "WBS1", "WBF",
     "F(s) C F J F(s) C E C E H(s)", 6.8, "C J C E H(s)", 5.5),
    ("2", "S", "MBSF", "WBF",
     "H E(s) G F(s) C F H(s)", 7.1, "H E(s) G F(s) H(s)", 6.3),
    ("3", "S", "MBSF", "WBF",
     "H F(s) C E G E H(s)", 7.5, "H C E G E H(s)", 7.1),
    ("4", "S", "MBSF", "WBF",
     "H E(s) C(s) F J(s) E(s) F(s) J(s) E(s) H(s)", 7.9,
     "H E(s) C(s) J(s) E(s) F(s) H(s)", 6.7),
    ("5", "S", "MBSF", "WBF",
     "H F(s) C E C E G F(s) C F H(s)", 8.3, "H C E G C H(s)", 6.9),
    ("6", "S", "MBSF", "WBF",
     "H F(s) C E G F(s) C E H(s)", 8.3, "H C E C E H(s)", 7.2),
    ("7", "S", "MBSF", "WBF",
     "H F(s) C F J(s) E(s) F(s) J(s) E(s) F(s) H(s)", 8.4,
     "H C J(s) E(s) J(s) E(s) H(s)", 7.8),
    ("8", "S", "MBSF", "WBF",
     "H F(s) C E G F(s) C E G E H(s)", 9.5, "H C E G C E H(s)", 8.4),
    ("9", "N", "WBS1", "WBF",
     "E(s) C(s) F J(s) E(s) C(s) F J(s) E(s) H(s)", 6.8,
     "E(s) C(s) J(s) C(s) F H(s)", 5.4),
    ("10", "N", "WBS1", "MBSF",
     "E(s) F(s) J(s) E(s) F(s) J(s) E(s) H(s)", 7.1,
     "E(s) F(s) J(s) E(s) H(s)", 5.8),
    ("11", "N", "WBS1", "MBSF",
     "E(s) C(s) F G(s) E(s) G(s) E(s) H(s)", 7.7,
     "E(s) C(s) G(s) E(s) H(s)", 6.6),
    ("12", "N", "WBS1", "MBSF",
     "F(s) C E G E J F(s) C E H(s)", 8.1, "C E G E H(s)", 6.8),
    ("13", "N", "WBS1", "MBSF",
     "E(s) C(s) F J(s) E(s) C(s) F J(s) E(s) F(s) H(s)", 9.0,
     "E(s) C(s) J(s) E(s) J(s) E(s) H(s)", 8.0),
    # The SI leaves course 14's wind column blank, so no wind is claimed here.
    ("14", None, "WBS1", "MBSF",
     "F(s) C E G E J F(s) C E G F(s) H(s)", 9.2, "C E G C E H(s)", 7.5),
]

WIND = {"S": "southerly", "N": "northerly"}


def course(cid, wind, start, finish, d1, nm1, d2, nm2):
    c = {
        "id": cid,
        "name": ((WIND[wind] + " · ") if wind else "") +
                ("Wave-Break" if start == "WBS1" else "Main Beach") + " start, " +
                ("Wave-Break" if finish == "WBF" else "Main Beach") + " finish",
        "type": "PURSUIT",
        "start": start,
        "finish": finish,
        "div": {
            "D1": {"seq": seq(d1), "si_nm": nm1},
            "D2": {"seq": seq(d2), "si_nm": nm2},
        },
    }
    if wind:
        c["wind"] = wind
    return c


courses = [course(*c) for c in COURSES]
courses.append({
    "id": "15",
    "name": "Offshore - set on the day (Div 1)",
    "type": "OFFSHORE",
    "builder": True,
    "si": ("SI 9.3 - when the OA decides to race Div 1 offshore, the course, "
           "start and finish lines and mark roundings come with the briefing email."),
    "seq": [],
})


def thursdays(dates, label, kind="PURSUIT"):
    return [{"date": d, "name": label % (i + 1), "type": kind}
            for i, d in enumerate(dates)]


# TT schedule, page 2. The SI prints "Winter 5/13 Thursday 4th May 2026" - 4 May
# 2026 is a Monday and the slot sits between 28 May and 11 June, so it is
# transcribed as Thursday 4 June 2026 (the SI's own sequence), flagged below.
SCHEDULE = (
    thursdays(["2026-05-07", "2026-05-14", "2026-05-21", "2026-05-28",
               "2026-06-04", "2026-06-11", "2026-06-18", "2026-06-25",
               "2026-07-02", "2026-07-09", "2026-07-16",
               "2026-08-27", "2026-09-03"], "Winter Twilight %d/13")
    + thursdays(["2026-09-10", "2026-09-17", "2026-09-24",
                 "2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29",
                 "2026-11-05", "2026-11-12", "2026-11-19", "2026-11-26",
                 "2026-12-03", "2026-12-10"], "Spring Twilight %d/14")
    + [{"date": "2026-12-17", "name": "Fun Race & Christmas Party", "type": "PURSUIT"}]
    + thursdays(["2027-01-14", "2027-01-21", "2027-01-28",
                 "2027-02-04", "2027-02-11", "2027-02-18", "2027-02-25",
                 "2027-03-04", "2027-03-11", "2027-03-18",
                 "2027-04-01", "2027-04-08", "2027-04-15", "2027-04-22"],
                "Summer Twilight %d/14")
)
SCHEDULE[4]["note"] = "The SI prints this date as 4 May 2026; 4 June is the Thursday in sequence."

EVENTS = [
    {"from": "2026-05-09", "to": "2026-05-09", "name": "Julian Rocks (rescheduled)"},
    {"from": "2026-06-06", "to": "2026-06-06", "name": "Flat Rock Yacht Race"},
    {"from": "2026-07-30", "to": "2026-07-30", "name": "GCCM Gold Coast Mackay Yacht Race"},
    {"from": "2026-09-05", "to": "2026-09-05", "name": "Sail Past & Blessing of the Fleet"},
    {"from": "2026-09-06", "to": "2026-09-06", "name": "Breaking of the Flag & Da$h 4 Ca$h"},
    {"from": "2026-10-03", "to": "2026-10-05", "name": "The Yacht Sales Co. Sail Paradise Regatta"},
    {"from": "2026-11-01", "to": "2026-11-01", "name": "Cook Island Yacht Race"},
    {"from": "2026-11-21", "to": "2026-11-22", "name": "John Macnamara Memorial Race"},
    {"from": "2027-01-23", "to": "2027-01-24", "name": "Ted Elkes Memorial Regatta"},
    {"from": "2027-02-06", "to": "2027-02-06", "name": "Surf to City"},
    {"from": "2027-03-13", "to": "2027-03-13", "name": "Julian Rocks Yacht Race"},
    {"from": "2027-03-20", "to": "2027-03-20", "name": "Ladies Day Race"},
    {"from": "2027-03-21", "to": "2027-03-21", "name": "DUX Birthday Celebrations"},
    {"from": "2027-04-24", "to": "2027-04-24", "name": "Burleigh Bash"},
]

# SI 10.4 - Wonder Reef prohibited area, four yellow special marks. Only in
# play when Div 1 races offshore (course 15). The SI prints the SE corner as
# "27 57 806 S" - the decimal point is restored.
WONDER = [("27 57.593 S", "153 27.187 E"),   # NW
          ("27 57.589 S", "153 27.429 E"),   # NE
          ("27 57.806 S", "153 27.434 E"),   # SE
          ("27 57.805 S", "153 27.189 E")]   # SW

pack = {
    "id": "syc-twilight-2627",
    "name": "SYC Thursday Twilight 2026/27",
    "club": "Southport Yacht Club",
    "club_url": "https://southportyachtclub.com.au/sailing/twilight-inshore/",
    "country": "Australia",
    "state": "QLD",
    "datum": "WGS84",
    "source": {
        "title": "Thursday Twilight 2026/27 Sailing Instructions",
        "url": SI_URL,
        "authority": "Southport Yacht Club Inc.",
        "rrs": "Racing Rules of Sailing 2025-2028",
        "category": "AS SR Part 1 - Category 4 (Div 1), Category 7 Plus (Div 2)",
    },
    "course_note": (
        "Thursday Twilights are pursuit races on the Broadwater: every boat has her "
        "own handicap start time and starts no earlier than it. The course number "
        "comes with the briefing email and is flown on the start boat - load it "
        "below and the published marks come with it. Course 15 (Div 1 offshore) is "
        "set on the day; build it here from the briefing."),
    "divisions": [
        {"id": "D1", "name": "Division 1",
         "note": "AS SR Category 4. May be sent offshore (course 15) at the RC's "
                 "discretion. VHF 10."},
        {"id": "D2", "name": "Division 2",
         "note": "AS SR Category 7 Plus. Broadwater courses only. VHF 09."},
    ],
    "rules": {
        "default_rounding": "P",
        "default_rounding_si":
            "Attachment D - all marks to be left/passed to port unless indicated "
            "by (s), in which case to starboard.",
        "start_si":
            "SI 11 - pursuit race. A boat shall start no earlier than her allocated "
            "handicap start time; her preparatory signal is 4 minutes before it "
            "(changes RRS 26). Keep clear of the line and the course side for the "
            "5 minutes before your time (SI 11.4, 20% ENP).",
        "prep_signal_sec": 240,
        "arm_presets": [["4:00 (TT prep)", 240], ["3:00", 180],
                        ["1:00", 60], ["0:20 test", 20]],
        "first_start_hint": "15:30",
        "series_times": {
            "Winter": {"first_start": "15:00", "finish_by": "18:00"},
            "Spring": {"first_start": "15:30", "finish_by": "18:30"},
            "Summer": {"first_start": "15:30", "finish_by": "18:30"},
        },
        "vhf_race": "10 Div 1 · 09 Div 2",
        "min_crew": 2,
        "iala_si":
            "SI 10.1-10.2 - keep a safe clearance from all IALA navigation marks "
            "and mind the tide when rounding them.",
        "sail_si":
            "SI 7 - no spinnakers, gennakers, code zeros or any purpose-built "
            "downwind sail. Poling out a headsail is allowed.",
        "penalty_si":
            "SI 14.1 - the Two-Turns Penalty is replaced by a One-Turn Penalty "
            "(changes RRS 44.1).",
        "entry_si":
            "SI 2.4 / 4.2 - enter via TopYacht by 1400 Tuesday; confirm intention "
            "to race by 1400 on race day or you may be excluded from starting.",
        "shorten_si":
            "SI 12 - a shortened course finishes between the RC vessel flying "
            "code flag S and a prominent feature of your choice.",
    },
    "marks": MARKS,
    "courses": courses,
    "zones": [{
        "id": "wonder-reef",
        "name": "Wonder Reef",
        "type": "prohibited",
        "si": "SI 10.4 - prohibited area and obstruction. A boat shall not enter.",
        "poly": [v for la, lo in WONDER for v in
                 (round(ddm(la), 6), round(ddm(lo), 6))],
    }],
    "schedule": SCHEDULE,
    "events": EVENTS,
}

out = json.dumps(pack, indent=1, ensure_ascii=False)
with open("data/syc-twilight-2627.json", "w", encoding="utf-8") as f:
    f.write(out)
print("marks %d  courses %d  races %d  bytes %d" %
      (len(MARKS), len(courses), len(SCHEDULE), len(out.encode())))
