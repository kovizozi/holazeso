# Cigánd reservoir feature: research and plan

Status: plan only, nothing implemented. Separate from `UX-PLAN.md` on purpose (that file is being implemented right now).

## 1. What actually happened (research, 2026-11-24)

| Fact | Value | Confidence |
|---|---|---|
| Date | Saturday 2026-11-21, morning | several sources agree |
| What | The sluices of the Cigándi árapasztó tározó were opened to let Tisza water in | several sources |
| Why | Water retention after this year's drought, not flood defence. The raised Tisza level is used | several sources |
| Volume | "közel 2 millió köbméter" (minister Gajdos László). The PM said "2-3 millió köbméter" in a video | conflicting, no measured figure published |
| First use | Built 2008 (handed over 2008-11-14), never used in 18 years, not even for floods | several sources |
| Reservoir size | 94 million m3 capacity, 24.7 km2, on the land of Cigánd, Nagyrozvágy, Pácin, Ricse | vizugy.hu project documents |
| Structure | Two-level concrete inlet/outlet structure at Cigánd; the lower openings exist exactly for "tájgazdálkodási" water | vizugy.hu project documents |
| Where the water goes | From the reservoir on into the Bodrogköz canal system, to small canals that were dry all summer | several sources |
| Detailed route | "tájgazdálkodási vápa" and Tiszakarádi-főcsatorna, then side canals | one source (boon.hu), could not be opened, VERIFY |
| Related, same days | Felsőberecki-főcsatorna (almost 12 km, fully dried) gets gravity replenishment; Vissi-Holt-Bodrog rose 129 cm in a week | MTI, 23 Nov. This is on the Bodrog side and is NOT stated to come from Cigánd |
| Next step | A manual operation on 28 November was mentioned | one search summary only, VERIFY |
| Not published anywhere | Flow (m3/s), volume let in so far, Tisza level at the gauge, level needed for gravity inflow, end date, number of gates, hectares | checked 9 articles |

**Important correction:** it is 2 million cubic metres, not 2 million litres. That is 2 billion litres, which fits the unit the page already uses ("milliárd liter").

**Honest scale, worth showing:**
- 2 million m3 is about 2 % of the reservoir's 94 million m3 capacity.
- Spread evenly over the 24.7 km2 it would be about 8 cm deep. In reality it fills the low depression and the canals, not the whole area.
- About 800 Olympic pools (2 500 m3 each).
- Compared with the page's own soil number: the driest soil cell holds about 84 billion litres, so this is about 2 % of one map cell. Small nationally, large locally, and significant as a first.

**No live data exists.** No official feed publishes the inflow. The local water directorate site (emvizig.hu) could not be read (certificate error). So the feature must separate three kinds of content clearly: announced facts (dated, sourced), measured context (river gauge, soil), and illustration (the animation).

**Geometry is available** from OpenStreetMap: the sluice at 48.2749 N, 21.8225 E, the reservoir dyke, the Tisza, Bodrog, Tiszakarádi-főcsatorna, Ricsei-főcsatorna, Karcsa-csatorna, Felsőberecki-főcsatorna.

## 2. What holagaz.hu and holadelej.hu do well (to copy)

Both are client-rendered, so only text and structure could be read, not the visuals.

1. A plain question as the heading ("Honnan jön, merre megy a gáz?").
2. A strip of 3 to 5 big numbers, each with a label, unit and a small sub-line with the date.
3. One map or diagram per idea, with flow shown as direction.
4. Human-scale comparisons ("ennyi háztartás", "ekkora kocka").
5. A one-sentence "what this is NOT" caveat ("Nem tartály, hanem kőzet.").
6. Every number tagged as measured, estimate, plan or fixed sample, with a dated source line under each block.
7. Short, direct sentences; technical terms explained inline.

## 3. The feature

### 3.1 Placement
At the top of the water panel, directly under the intro block (UX-PLAN 3.1) and above the local soil profile. Label it as current news with its date ("most történik · 2026. nov. 21."). Shown for Hungarian locations only, like the rest of the panel. Add it to the section index as "Cigánd".

When the event is over (flag in the data file), the block collapses to a one-line summary and moves below the national sections, so the top of the panel is not stuck on old news.

### 3.2 Content, top to bottom

**Heading (question style):** "Mi történt Cigándnál?"

**Lead, two sentences:** what, when, why. Draft: "November 21-én megnyitották a cigándi tározó zsilipjeit, 2008 óta először. Nem árvíz miatt: a megáradt Tisza vizéből közel 2 milliárd litert engednek a kiszáradt Bodrogközbe."

**Number strip (four tiles):**
| Tile | Value | Sub-line | Tag |
|---|---|---|---|
| mennyi víz | közel 2 milliárd liter | 2 millió m3; a kormányfő 2-3 milliót mondott | bejelentett |
| mióta nem használták | 18 év | 2008-ban adták át | tény |
| a tározó ekkora részét tölti ki | kb. 2 % | 94 millió m3 fér bele | számolt |
| a Tisza most | N cm, with trend arrow | nearest gauge, time of reading | mért |

The fourth tile needs a gauge near Cigánd (see 4.2). Until then show three tiles.

**The animated map** (section 3.3).

**"Mekkora ez valójában?" comparison row:** three small monochrome pictograms with one line each: about 800 olimpiai medence; about 8 cm, if it covered the whole reservoir; about 2 % of what the soil of one map cell holds today. Tagged "számolt".

**"Ez nem" caveat:** "Ez nem árvízi elárasztás: a tározó 2 százalékáról van szó, a víz a mélyebb részekbe és a csatornákba jut." And about the data: "Élő mérés nincs róla: a számok a kormány bejelentései."

**Timeline (short, vertical, dated):** 2008 átadás; 2026 nyár, aszály, kiszáradt csatornák; nov. 21. zsilipnyitás; nov. 23. a Vissi-Holt-Bodrog 129 cm-t emelkedett egy hét alatt (marked as a related Bodrogköz measure, not as an effect of Cigánd); next step if confirmed.

**Source line:** minister's and PM's statements via MTI with dates, vizugy.hu project documents for the reservoir data, OpenStreetMap for the map, hydroinfo.hu for the gauge.

### 3.3 The animated map

A schematic SVG map of the Bodrogköz, about 720 px wide on desktop (the "medium" figure width from UX-PLAN 3.2), monochrome, in the same visual language as the other maps.

**Static layer:** the Tisza (thick line) along the south, the Bodrog along the north-west, the reservoir outline with its dyke, the sluice as a marked gate symbol, the main canals as thin lines, and labels for Cigánd, Ricse, Pácin, Nagyrozvágy, Sárospatak, Tisza, Bodrog, and the canal names. A small inset shows where this is in Hungary. Scale bar.

**Animation, five steps, about 10 seconds in total, each step with a one-line caption under the map:**
1. "megárad a Tisza": the Tisza line thickens slightly.
2. "nyílik a zsilip": the gate symbol opens (two bars slide apart).
3. "a víz beáramlik": moving dashes run from the Tisza through the gate (animated `stroke-dashoffset`).
4. "megtelik a mélyedés": a hatch pattern grows inside the lowest part of the reservoir, not the whole polygon, and a small counter runs up to "közel 2 milliárd liter".
5. "tovább a csatornákba": the dashes continue along the Tiszakarádi-főcsatorna and side canals, which change from dashed (dry) to solid (wet).

**Behaviour:**
- Starts once when scrolled into view; a "lejátszás újra" button and five step dots allow stepping manually.
- `prefers-reduced-motion`: no animation, the final state is shown with all five captions as a numbered list.
- On mobile the map is full width and the step captions sit below it.
- Hover or tap on the reservoir, the gate and each canal shows a small popup with name and one fact, reusing the popup component from UX-PLAN 4.2.
- A visible tag on the figure: "szemléltető ábra, nem élő mérés". The fill level in step 4 follows the announced volume, not a measurement.

**Monochrome rule:** water is shown by line weight, dashes and hatching, never by blue.

## 4. Data and implementation

### 4.1 Static event file (no backend change)
`cigand.json` in the site repo, edited by hand when news arrives:
- `active` flag and `updated` date;
- facts: date, announced volume (with the low and high figures), capacity, area;
- timeline entries: date, text, source name and URL, kind (tény / bejelentett / mért);
- sources list.

`cigand-geo.json`: simplified geometry extracted once from OpenStreetMap (reservoir dyke, sluice point, Tisza and Bodrog sections, four or five canals, six towns), projected with the same helper as the channel map. Target size under 30 kB.

This alone is enough to ship the whole block except the fourth tile.

### 4.2 Collector change for the measured tile (optional, second step)
The rivers snapshot has no gauge between Tiszabecs and Kisköre. Add the nearest Tisza gauge to Cigánd from hydroinfo.hu (Dombrád is the closest candidate, Záhony or Tiszabercel as fallbacks; check which one hydroinfo lists) to `app/rivers.py` in soil-moisture-mapper. It then arrives in the existing `rivers-snapshot` with history and forecast, and the tile gets a sparkline for free. Needs a rebuild of the collector container; no worker change.

A Bodrog gauge (Sárospatak) could be added the same way for the timeline's Bodrog side.

### 4.3 Not recommended
- Satellite water-extent imagery (Sentinel): heavy, cloud-dependent in November, breaks the monochrome design.
- Estimating the inflow ourselves from gauge levels: no published gate geometry, the number would look measured but would be a guess.

### 4.4 Size of the work
- Geometry extraction and simplification: small script, run once.
- Block markup, tiles, timeline, comparison row: mostly reuse of components that UX-PLAN introduces (cards from 2.4, popup from 4.2, figure widths from 3.2). Should be built after those land.
- The animation: the only genuinely new piece; SVG plus about 150 lines of JS and CSS.
- Cache-busting `?v=N` bump, no em dashes, Fibonacci spacing as usual.

## 5. To verify before publishing
1. The route: does the water go through the "tájgazdálkodási vápa" into the Tiszakarádi-főcsatorna, and which side canals? (boon.hu article "Vízmegtartás, így nyitották ki a zsilipeket Cigándnál!", blocked for automated reading; open in a browser.)
2. Whether the 28 November step is real, and what it is.
3. Whether the Felsőberecki-főcsatorna and Vissi-Holt-Bodrog measures are fed from Cigánd or from the Bodrog. Until known, keep them as "related" only.
4. Which volume figure to lead with. Recommendation: "közel 2 millió m3" (the minister's written figure), with the 2-3 million in the sub-line.
5. Whether emvizig.hu publishes daily data on the operation (the site could not be reached automatically).

## 6. Decisions needed
1. Placement: above the local soil profile (recommended while it is current news), or below it.
2. Ship in two steps (static block first, gauge tile after the collector change), or wait for both.
3. Who keeps `cigand.json` up to date as news arrives: by hand on request (recommended), no automation.

## Sources
- https://www.agrarszektor.hu/noveny/20261122/ilyen-meg-nem-volt-magyarorszagon-2-millio-kobmeter-vizet-engedtek-ki-a-tajba-65849
- https://www.portfolio.hu/gazdasag/20261121/meglepte-a-kormany-amit-2008-ota-meg-senki-878248
- https://www.portfolio.hu/gazdasag/20261122/latvanyos-videon-a-tortenelmi-lepes-magyarorszagon-masfel-evtized-utan-eloszor-nyitottak-meg-a-cigandi-tarozo-zsilipjeit-878274
- https://magyarhirlap.hu/gazdasag/20261121-megnyilt-a-cigandi-tarozo-kozel-ketmillio-kobmeter-viz-juthat-a-bodrogkozbe
- https://borsodihir.hu/hir/ujra-elettel-telik-meg-a-bodrogkoz
- https://www.penzcentrum.hu/hellovidek/20261123/tobb-mint-egy-metert-emelkedett-a-vizszint-egy-het-alatt-visszater-az-elet-a-hazai-folyovolgybe-1209518
- https://borsod24.hu/2026/11/23/hetvegen-tortenelmet-irt-a-cigandi-viztarozo/
- https://www.szeretlekmagyarorszag.hu/hirek/magyar-peter-cigandi-tarozo-zsilipek-megnyitasa-video/
- https://www.boon.hu/helyi-kozelet/2026/11/vizmegtartas-zsilip-cigand-tisza (not readable automatically)
- https://www3.vizugy.hu/uploads/csatolmanyok/160/cigand_tajekoztato_szakmai_a5.pdf
- https://holagaz.hu and https://holadelej.hu (style reference)
