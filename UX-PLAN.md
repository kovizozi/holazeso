# UX improvement plan for holazeso.hu

Based on an inspection of the live site on 2026-11-24 (Szeged, desktop 1440x900 and mobile 390x844) and a read of the code behind each problem. Nothing in this plan is implemented yet.

Constraints kept throughout (from `CLAUDE.md`): strictly monochrome, no em dashes, Fibonacci spacing scale, radar animation stays data-driven, `?v=N` bump on every `script.js` / `style.css` change.

## What the page looks like today

| | Desktop | Mobile |
|---|---|---|
| Total page height | 11 253 px (about 13 screens) | 7 923 px (about 10 screens) |
| Rain radar | 350 x 220 px on a 1440 px screen | 350 x 220 px |
| Soil map, channel map, water balance, lake figures | each 1258 x 786 px, taller than the visible area | fit the screen |
| Stats panel | closed, plain text, left-aligned across 1258 px | closed, plain text |

The root cause of "too big" is one rule: `.water-figure svg { width: 100% }` inside a 1300 px wide `#app`. Every figure scales up to the full content width, and the SVG text scales with it (river names render at about 40 px, chart axis labels at about 35 px).

## Phase 1: bugs (wrong or broken output)

### 1.1 "legkevesebb: 0 milliárd liter"
- **Cause:** one grid cell (46.94 N, 18.04 E) lies on Lake Balaton. Open-Meteo has no soil there, so the collector stores `liters_total: 0`. The real minimum today is 84 billion litres.
- **Side effects:** the colour scale runs 0 to 290 instead of 84 to 290, so the whole country looks flat mid-grey, and a white blob is drawn around the Balaton.
- **Fix, collector (`soil-moisture-mapper`):** mark cells with no soil data as `no_data: true` instead of 0, and leave them out of `country_total_liters`.
- **Fix, site (`buildReliefMap`, headline at `script.js:3954`):** ignore `no_data` / zero cells for min, max and the colour scale; fill them from the nearest real cell (the `valueAt` fallback already does this for missing cells). The site-side fix works alone, so it can ship before the collector is redeployed.

### 1.2 Unfilled white areas at the top right and bottom of the soil map
- **Cause:** the raster covers only the bounding box of cell centres that fall inside Hungary. The real border extends up to half a cell past that box (north-east tip, southern edge near Baranya), so the clip shape has nothing behind it.
- **Fix:** pad the raster by one cell on every side. `valueAt` already extrapolates from the nearest real cell, so only the canvas size and the `<image>` origin change.

### 1.3 Soil map legend is broken on desktop
- The gradient bar sits far left while "kevesebb" and "több" are pushed to the two page edges. Rebuild as one centred row: `84 mrd l [bar] 290 mrd l`, with real numbers on the ends.

### 1.4 Balaton gauge label overlap
- The axis tick "40" and the current value "38 cm" print on top of each other. Hide axis ticks that fall within about 12 px of the current-value label.

### 1.5 Lake numbers need a data check
- Velencei-tó shows 16 cm against an ideal band of 140 to 170 cm, Fertő shows 2 cm, Balaton 38 cm against a 110 to 120 cm regulation band. These may be real, but all three being so far below their bands suggests the hydroinfo.hu scrape reads a different column or datum than the bands assume. Verify `app/lakes.py` against the source page before redesigning this section.
- The subtitle "a siófoki mércén mért országos átlag" is self-contradictory (the value is the lake-wide average, not the Siófok gauge). Reword.

### 1.6 Worker bug found in the earlier code review
- With exactly one push subscriber, notifications never fire (`fetchPrecipitationBatched` expects an array, Open-Meteo returns an object for one coordinate). Not a UX-visible item, but it makes the "értesíts" button silently useless. One-line fix plus `wrangler deploy`.

## Phase 2: top of the page

### 2.1 Header: icons instead of three text links
- Replace "értesíts, ha esni kezd", "megosztható link", "helyszín módosítása" with three inline SVG icon buttons (bell, share, location pin), monochrome, 44 x 44 px touch targets, right-aligned.
- Each keeps an `aria-label` and a `title` tooltip. The bell gets a filled state when notifications are on. Share shows a short "link másolva" confirmation next to the icon.
- On mobile this removes the current two-line wrapped header (saves about 40 px above the answer).

### 2.2 Rain radar: bigger and zoomable
- Desktop: raise `#radar-svg` max-width from 350 px to about 720 px (aspect ratio unchanged, viewBox unchanged, so the sweep geometry and `RADAR_SWEEP_MS` stay in sync). Mobile stays full width.
- Zoom: add `+` / `-` / reset buttons and wheel / pinch zoom after the search has finished (not during the sweep, so the data-driven animation is untouched). Zoom changes the search radius shown, redraws borders, rivers and the RainViewer image at the matching tile zoom (`radarImageZoom` already picks a zoom from a radius).
- Add a few city labels (see 4.1, shared place list) so the map is readable without knowing the border shapes.

### 2.3 Remove the "útvonal" link
- Delete the Google Maps directions link from `showNearestRain` (`script.js:1349` and `1361`) and its `.map-link` CSS.

### 2.4 "részletek és statisztika": open by default and visual
- Open automatically when the radar finishes (`revealPhase(PHASE_DONE)`), keep the summary as a collapse control, and remember a manual collapse in `localStorage`.
- Centre it and cap the width at about 46em like other text blocks (today it is left-aligned across the whole 1258 px).
- Replace plain lines with a 2 x 2 grid of cards on desktop (one column on mobile):
  - **Csapadék:** three large figures (24 h, 7 nap, 30 nap), each with a small "vs. szokásos" bar (actual against the 3-year average), then the 30-day bar chart with date labels on the axis and a visible hover / tap state.
  - **Előrejelzés:** next 3 days as columns: weekday, probability as a filled bar, expected mm.
  - **Hőmérséklet:** current value large, today and tomorrow as min-max range bars on a shared scale, frost warning as a marked line.
  - **Víz:** soil state as a 4-step scale with a marker (száraz ... nedves) plus trend arrow; nearest river discharge with its name (today it says only "a legközelebbi folyó").
- All in black, white and the existing grey tiers.

## Phase 3: structure of the water part

### 3.1 Give the water part a proper opening
- Today it starts with a bare "adatok frissítve" line right after the stats link. Add an intro block: a section title ("Víz Magyarországon"), one sentence on what follows and where the data comes from, then the update time, then the section index.
- Turn the section index into a sticky, compact bar while the reader is inside the water part, with the current section marked.

### 3.2 One figure size system
- Introduce three figure widths and assign every figure to one: narrow (420 px), medium (720 px), wide (960 px). Nothing goes to the full 1258 px.
- Cap figure height at about 70% of the viewport height so a map always fits on screen with its title and legend.
- Proposed sizes: soil map medium, river network medium, channel map wide, water balance medium, Balaton tiles medium, lake figures medium, river chart medium.
- Expected result: desktop page height drops from about 11 250 px to roughly 6 500 px.

### 3.3 Section order and headings
- The headings repeat ("és a folyók?" then "és a folyók, csatornák, árkok, tavak?"). Rename so each asks one distinct question.
- Merge "river network map" and "river gauge list" into one section (see 4.3), so rivers appear once.
- Long explanatory captions (the soil map caption is 60 words) move into a "hogyan olvasd?" disclosure under each figure; the figure keeps a one-line caption.

## Phase 4: the maps

### 4.1 Shared place list (new static file)
- Add `places-hu.json`: about 150 Hungarian towns with lat, lon and a size rank. Used by four features below: cell naming on the soil map, city labels on the radar, city labels on the channel map, and labels on the river map. One file, loaded once, cached.

### 4.2 Soil moisture map
- **Size:** medium width (720 px).
- **Labels on the map:** names for Duna, Tisza and Balaton along their lines; 6 to 8 city labels; the searched location marked with its name.
- **Marker legend directly under the map:** hollow ring = river gauge, filled diamond = lake gauge, double ring = searched location. Today this is only buried in the long caption.
- **Hover / tap:**
  - highlight the cell under the pointer with an outline (the smooth raster stays, the outline shows the actual 33 x 33 km sample area);
  - popup shows the place name ("Kecskemét környéke", nearest town from the place list), litres, average moisture %, and a small sparkline of the last 7 days;
  - works on touch (tap to pin, tap elsewhere to close); today only `mousemove` is handled, so mobile users get nothing;
  - hovering a gauge marker shows the station name and current level.
- **Data needed for the sparkline:** the snapshot has no history per cell. Collector change: request `past_days=7` in the existing Open-Meteo call and store 7 daily averages per Hungarian cell (123 cells x 7 numbers, about 5 KB extra). No extra API calls.
- **Headline:** replace "legtöbb víz: 290 milliárd liter egy cellában" with something a reader can place, for example "legnedvesebb: Zala (38%), legszárazabb: Nyírség (19%)", using the place list.

### 4.3 River map
- **Size:** medium width; label font sizes fixed so they no longer scale up with the figure.
- **Hover / tap on a river:** highlight the line, popup with name, average discharge, the current level at its gauge(s), and a small sparkline of the last 8 days plus the 6-day forecast. The data is already in `rivers-snapshot` (`history`, `forecast_cm`).
- **Merge with the gauge list:** clicking a river on the map opens the same chart that the list opens today; the list stays below as the accessible alternative, in a 2-column grid on desktop instead of 1258 px wide rows.
- **Chart fixes:** cap width at 720 px, normal label size, draw the history as a line without a dot on every hourly sample (hydroinfo values change once a day, so today it is 200 overlapping dots), label "most" and the forecast end clearly.
- The 6 rivers listed as "nincs pontos adat" get a muted style on the map too, so the missing data is visible where the reader looks.

### 4.4 Channel (belvíz) map
- **Size:** wide (960 px), height capped.
- **Scroll zoom:** today the wheel only zooms with Ctrl held (`script.js:3265`), which nobody discovers. Change to: click or tap the map once to activate it, then plain wheel zooms and drag pans; Escape or clicking outside releases it. This gives Google Maps style zoom without hijacking page scroll. Show a short "kattints a térképre a nagyításhoz" hint until first use. Pinch zoom on touch stays.
- **Orientation when zoomed in:** add layers that appear by zoom level:
  - city and town labels from the place list (large towns first, smaller ones as you zoom);
  - names of rivers and main channels along their lines from zoom level 2;
  - county borders as thin dotted lines;
  - a scale bar (km) and a small inset of Hungary showing the current view rectangle.
- **Satellite imagery:** not recommended. It breaks the monochrome rule, needs an external tile provider (key, quota, attribution), and makes the thin channel lines unreadable. Alternative that fits the design: optional greyscale OpenStreetMap tiles under the lines from zoom level 3, behind a "térkép háttér" toggle. To be decided before building.
- **Legend:** the swatches for csatorna, folyó and belvízelvezető look identical. Give each type a clearly different stroke (weight plus dash pattern) and explain the large black dots (lakes), which are unlabelled today. Reuse the common legend component from 5.1.
- **Search box:** on selecting a result, zoom and pan to it and highlight it (verify current behaviour, then fix).

### 4.5 "Honnan jön a víz" (water balance)
- Medium width (720 px) with fixed label sizes; today the labels render at about 26 px.
- The 91 Balaton tiles below it: cap to medium width and draw them in rows of 10 so the count is readable at a glance ("9 sor + 1").

## Phase 5: lakes

### 5.1 One common legend and one common gauge design
- Today there are four different visual languages in one section: tilted Balaton outline with a ruler, three silhouettes, a horizontal bar for Velencei-tó, and two empty dashed lines for Tisza-tó and Fertő that show no information at all.
- Replace with one row of three or four identical lake cards (stacked on mobile). Each card:
  - the lake silhouette, filled from the bottom in proportion to the level within its regulation band;
  - current level in cm, large;
  - one shared horizontal gauge: axis, hatched "ideális sáv", marker for the current level, same scale logic for every lake;
  - one status line: "x cm-rel az ideális sáv alatt / benne / felett";
  - a 7-day trend sparkline (needs lake history in the collector, same mechanism as rivers already have).
- One legend for the whole section, above the cards: filled = jelenlegi szint, hatched = ideális sáv, dashed outline = teli meder.
- Lakes without a known band (Tisza-tó, Fertő): show the card without the band and say so in one muted line, instead of an empty dashed gauge. For Tisza-tó, either find a real lake gauge or drop the river gauge at Kisköre, which the page itself says is not comparable.
- Keep the same-scale size comparison as a small caption figure, with all labels on one baseline (the Tisza-tó label sits higher than the others today).

## Phase 6: other things found during the inspection

- **Local soil profile:** the leader lines for the top three layers (0-1, 1-3, 3-9 cm) cross each other and all show the same value. Merge layers thinner than a few pixels into one label ("0-9 cm: 28%") and make the figure narrower on desktop.
- **Soil profile and Balaton stack:** these two figures show the same five depth layers in two different ways. Put them side by side on desktop under one heading (local left, country right).
- **Tooltips:** 11 px text; raise to the body size and use the same popup component everywhere (soil map, river map, channel map, stats chart).
- **Water panel on slow load:** only "töltés…" is shown. Reserve the figure heights with skeleton boxes so the page does not jump.
- **Localhost:** the water panel does not load from localhost (worker CORS). Add `http://localhost:*` handling behind a dev flag, or document the Playwright workaround, so the redesign can be developed and tested locally.
- **Keyboard:** the map popups and river lines must be reachable by Tab and announce their values (`aria-label`), since hover-only information is invisible to keyboard and screen reader users.
- **Dark mode:** every new element must use the existing `--fg`, `--bg`, `--t0`..`--t4` variables; check each phase in both modes.

## Work that touches the backend

| Change | Where | Needs |
|---|---|---|
| `no_data` flag for lake cells | `soil-moisture-mapper` | rebuild container |
| 7-day history per soil cell | `soil-moisture-mapper` (`open_meteo.py`, `snapshot.py`) | rebuild container |
| History for lake gauges | `soil-moisture-mapper` (`lakes.py`, `history.py`) | rebuild container |
| Lake scrape check | `soil-moisture-mapper` (`lakes.py`) | compare with hydroinfo.hu |
| Single-subscriber push fix, token guard | `holazeso-push-worker` | `wrangler deploy` |

The worker needs no schema change for the new fields: its validators only check the top-level arrays.

## Suggested order

1. **Phase 1** (bugs): small, independent, visible immediately.
2. **Phase 3.2** (figure sizes) and **2.3** (remove útvonal): one CSS change fixes most "too big" complaints.
3. **Phase 2.1, 2.2, 2.4** (header icons, radar, stats panel).
4. **Phase 4.1, 4.2, 4.3** (place list, soil map, river map), with the collector changes.
5. **Phase 4.4** (channel map zoom and labels).
6. **Phase 5** (lakes), after the data check in 1.5.
7. **Phase 3.1, 3.3, 6** (intro, headings, remaining polish).

Each step is a separate commit with its own `?v=N` bump and a desktop plus mobile screenshot check against the live data.

## Decisions needed before building

1. Channel map background when zoomed in: labels and county borders only (recommended), or also optional greyscale OSM tiles.
2. Stats panel: always open, or open by default with the collapse remembered (recommended).
3. Tisza-tó: drop it from the gauges until a real lake gauge is found (recommended), or keep the Kisköre river gauge with a note.
4. Whether the collector changes (history per cell and per lake) are in scope now; without them the soil and lake popups ship without sparklines.
