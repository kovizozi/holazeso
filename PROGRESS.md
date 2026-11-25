# PROGRESS.md

Ez a fájl a munka aktuális állapotát rögzíti, hogy egy új session (vagy egy
`/compact` utáni folytatás) pontosan onnan tudjon továbbmenni, ahol
abbamaradt. A `CLAUDE.md` az általános szabályokat és parancsokat írja le, az
`ARCHITECTURE.md` a rendszer működését - ez a fájl a **jelenlegi állapotot és
a nyitott szálakat**.

Utolsó frissítés: 2026-11-21 (ld. lent az "UX/UI audit" szakaszokat -
a 09-12-es KV-migrációs szakasz AZÓTA eltelt, ellenőrizetlen történet, nem
törölve).

## SEO-PLAN 4. fázis: teljesítmény (2026-11-24)

**KÉSZ a munkafában, nincs commitolva.**

- **`water.js` kiszervezve**: a vízpanel teljes kódja (folyók, tavak, talaj,
  csatornák, Cigánd, térképek) `/water.js` (219 kB), a `script.js` 330 kB-ról
  117 kB-ra esett. Lusta betöltés: IntersectionObserver (600 px), `#water-`
  tartalomjegyzék-link, hashchange vagy hash-es megnyitás. Klasszikus script,
  a `script.js` globáljait közvetlenül látja (nincs `window.HZ`). Részletek:
  ARCHITECTURE.md "Vízadat-panel". `?v=` szabály: CLAUDE.md 3. szabály.
- **Mért (mockolt Open-Meteo, Playwright, 3 futás mediánja)**: átvitt JS
  a főoldalon görgetés nélkül 339,6 kB -> 126,0 kB (a `count.js` 9,2 kB-tal);
  a vízpanelhez görgetve 344,7 kB (a `water.js` ekkor jön). CLS (14 mp):
  főoldal 375 px 1,46 -> 0,154; főoldal 1280 px 0,76 -> 0,17;
  `/eso/kecskemet/` 375 px 1,39 -> 0,154.
- **CLS oka és javítása**: a fő ugrás (0,55-0,63) a `.seo-content` eltolódása
  volt, amikor a script megjelenítette az eredményt; `#app { min-height:
  100svh }` a hajtás alá tolja. A korábbi 0,297-es Lighthouse-érték ugyanez a
  családja. **Marad** (~0,10 + ~0,05): a radar fölé beúszó válasz-szöveg
  layout-ugrása, ami a felfedés koreográfiájának része, lásd ARCHITECTURE.md
  "Layout-stabilitás (CLS)". **Megoldva 2026-11-25**: lásd a fájl végén, "CLS
  0 a keresés-felfedésnél".

## Vízadat-panel: csak magyar helynél, saját hely legfelül (2026-11-21)

**KÉSZ, élesítve** (`c63f2a3`, `69a2d3f`).

- **Csak magyarországi helyszín**: a felhasználó kérte, hogy külföldi helynél
  a magyar vízadat-panel ne is jelenjen meg. `revealPhase` csak
  `currentLoc.countryCode === "HU"` esetén nyitja meg és hívja a
  `buildWaterPanel`-t. Ismeretlen országkódnál sem jelenik meg (szándékos,
  óvatosabb döntés; ha a felhasználó mást kér, itt kell lazítani).
- **Melyik helyre szólnak az adatok**: a "részletek és statisztika" panel
  tetején új sor: "Az adatok helye: <név>" (`#stats-place`). A felhasználó
  nem tudta, hogy a keresett vagy az esőt talált település adatai-e (a
  keresettéi).
- **Saját hely talajprofilja legfelül**: `#water-local-section` a
  `#water-body` elejére került, utána jön az országos cím és a
  tartalomjegyzék. A lekérés a snapshotokkal egy `Promise.all`-ba került,
  hogy ne ugorjon be később az országos adatok fölé.
- **Ellenőrizve**: Playwright, Szeged (HU) és Bécs (AT). A worker CORS-a
  localhostot nem enged, ezért a teszt a kéréseket `page.route`-tal, éles
  `Origin`-nel továbbította (ld. ARCHITECTURE.md, "Vízadat-panel").
- **Dokumentáció**: ARCHITECTURE.md új "Részletek-panel és vízadat-panel"
  fejezet, README.md adatforrások pontosítva.

## Domborzat (hillshade) a csatorna-térképhez, 3. kör (2026-11-16)

A felhasználó a 2. kör után külön kérte: "put elevation overlay" - ez a
PROGRESS.md-ben (és a chat-előzményben) többször is külön, még el nem
kezdett tételként szerepelt.

**KÉSZ, élesítve.** A terv Open-Meteo `/v1/elevation` végponttal indult
(ugyanaz a szolgáltató, mint minden máshoz ezen az oldalon) - ez a ~3600
pontos, egyszeri rács-lekérésnél "Daily API request limit exceeded"-be
futott, egy önálló, egypontos kéréssel is megerősítve utána. A
felhasználó jóváhagyásával lecserélve Copernicus DEM GLO-30-ra (30m,
közkincs), közvetlenül a nyilvános `copernicus-dem-30m` AWS S3-bucketből,
GDAL `/vsicurl/` HTTP range-kéréssel (rasterio-n keresztül) - ez csak a
ténylegesen kért pixeleket olvassa, sosem egy teljes (~44MB) csempét, és
nincs hívásonkénti kvótája.

- **Adat**: `soil-moisture-mapper/app/elevation.py` (új, egyszeri szkript,
  mint channels.py - NEM az órás ciklus része). 90x40-es, 0,08 fokos
  (~8km) rács, a határpolygonra NEM vágva (a lejtő-számításhoz minden
  cellának kell a valódi szomszédja). Szerver oldalon kiszámolt, szabványos
  GIS hillshade (lejtés+kitettség, ÉNy-i 45 fokos napállás) - a
  frontendnek csak ki kell rajzolnia. Kontraszt-nyújtva: a nyers hillshade
  élesben csak a 0-255 skála szűk sávjában mozgott (Magyarország nagyrészt
  sík), ami szürke foltnak látszott volna domborzat helyett.
  `app/grid.py`-ban a `generate_grid()` mostantól elfogad `step_deg`/
  `buffer_km` felülírást (alapértelmezve a settings sajátjára, a meglévő
  órás hívót nem érinti).
- **Kimenet**: `holazeso-v0/elevation.json` (14,4 KB nyersen, ~3,9 KB gzip)
  - statikus fájl, mint borders.json/water-geo.json, NEM megy a
    push-worker KV-n át (a domborzat sosem változik).
- **Frontend**: `script.js` `buildChannelsMap` - egyetlen `<canvas>`-ból
  kapott data URL-kép, a böngésző saját natív nagyításával simítva, az
  ország körvonalára vágva (ugyanaz a clip-path trükk, mint a dombormű-
  térképen), a projekciót minden render()-nél (zoom/pan) újraszámolva.
  Félig áttetsző (opacity 0,45), sötét módban `filter: invert(1)`.
  Ellenőrizve: élő PNG-előnézet (felismerhető magyar domborzat: északi/
  nyugati dombvidék, lapos Alföld), majd Playwright-tal light/dark módban
  és nagyítás előtt/után is (a kép pozíciója helyesen újraszámolódik).
- **Mellékesen észlelt, NEM saját hiba**: a munka közbeni Open-Meteo
  teszthívások kimerítették ennek a sandboxnak a napi Open-Meteo-kvótáját
  (minden Open-Meteo-hívás itt 429-et ad mára) - ez csak EZT a sandboxot
  érinti, a valódi látogatók saját böngészőjükből, saját IP-ről hívják az
  API-t (ld. ARCHITECTURE.md), tehát őket nem érinti. Közben viszont azt is
  észre lehetett venni, hogy az ÉLES push-worker `soil-snapshot`-ja üres
  (`points: []`, `generated_at` órák óta nem frissült) - ez egy a
  produkciós (otthoni gépen futó) órás ciklusban lévő, ettől a sessiontől
  FÜGGETLEN probléma, nem ellenőriztük tovább, mert nem ez volt a kérés.

## UX/UI audit, 2. kör (2026-11-16): a "Later roadmap" tételek

A felhasználó az 1. kör után kérte: "implement all in order" - vagyis a
lent, "szándékosan NEM valósult meg" címszó alatt felsorolt tételeket is.
Ami ebben a körben ELKÉSZÜLT:

- **Kereshető vízfolyás-felfedező a csatorna-térképhez** (`#water-channels-
  search-input`/`-results`, `script.js` `buildChannelsMap` vége): a
  feature-öket NÉV+TÍPUS szerint csoportosítva (ld. lent, miért típus is
  kell), gépeléskor élőben szűrt, legfeljebb 25 találatos lista, valódi
  `<button>`-ökkel - aktiváláskor a térkép odaugrik (`setView`) és egy
  állapot-sor (aria-live) kiírja a nevet/típust/hosszt/durva helyet.
- **Mentett helyek + megosztható link**: `loadRecentLocations`/
  `rememberRecentLocation` (localStorage, max 5, legújabb elöl) - a
  helyszín-választóban egy koppintással visszaválthatók. `?lat=&lon=&name=
  &cc=` URL-paraméter induláskor közvetlenül azt a helyet tölti be (előbbre
  való, mint a mentett/automatikus), és egy "megosztható link" gomb
  (`#share-location`) a vágólapra másolja a jelenlegi helyszín ilyen
  linkjét.
- **Rövid oktató bekezdés** a `#water-methodology`-ban: vízállás (mérce) vs.
  vízhozam (m³/s) vs. vízkészlet (liter/km³) - a leggyakoribb fogalmi
  keveredésre, amit a D02 (tó-mérce) hiba is mutatott.
- **D01, kibővítve**: a talajnedvesség-becslés most explicit "(becslés,
  Open-Meteo talajmodell)"-ként van jelölve; a dombormű-térkép legendája
  korábban TÉVESEN "mért" szót használt a modellezett talajadatra (javítva:
  "modell-becslés, nem mérés") - ez tényleges tartalmi pontatlanság volt,
  nem csak hiányzó részlet; a folyó-szakasz forrása (hydroinfo.hu) is kiírva.
  A minden egyes számhoz külön időbélyeg (a riport eredeti, teljes kérése)
  továbbra sem készült el - az egyetlen "adatok frissítve" sor maradt az
  arányos megoldás, ld. lent.
- **D04, VALÓDI adatpipeline-javítással** (`app/channels.py`,
  `soil-moisture-mapper`): kipróbáltunk egy ÁLTALÁNOS, "/"-re és " - "-ra
  bontó heurisztikát - ez a VALÓDI adaton hamis találatokat adott (pl.
  "Igali 55/1. csatorna" egy számozást nézett nyelvi elválasztónak, és egy
  teljesen más csatornával olvadt össze; "Kanal Karašica - Drava", egy a
  Drávától FÜGGETLEN csatorna, tévesen a Dráva alá került volna). Emiatt ez
  egy véges, kézzel jóváhagyott szinonima-tábla lett (`RIVER_NAME_SYNONYMS`,
  ugyanaz a lista a channels.py-ban ÉS a script.js-ben), ÉS típus-érzékeny
  (egy "Duna" nevű ÁROK, 4 way/0,09 km, és egy "Dunaj" nevű CSATORNA, 1
  way/15,7 km - mindkettő VALÓDI, a folyótól független objektum ugyanazzal
  a névvel - emiatt a kulcs (név, típus) pár, nem csak név). **ÉLESÍTVE**
  (a felhasználó jóváhagyásával): `python -m app.channels` lefutott, a
  push-worker `channels-snapshot` KV-ja frissült (`generated_at`
  2026-11-16T14:20Z), a "leghosszabb" lista most duplikátum nélküli
  (Tisza 715,8 km, Duna 480,0 km, ...). A soil-moisture-mapper repóban
  lokálisan commitolva (`66fb28a`, nincs remote).
- **"Hivatalos WCAG audit" - automatizált kör lefutott**: `axe-core`
  (`@axe-core/playwright`) a teljes oldalon, összecsukott ÉS minden
  lenyíló/térkép/folyó-sor kinyitott állapotában: **0 violation**
  mindkétszer. Ez NEM helyettesíti a valódi, kézi/képernyőolvasós
  tesztelést (axe a WCAG-hibák kb. 30-50%-át fogja meg automatikusan), de
  konkrét, megerősítő adat, nem puszta állítás.
- **Teljesítmény-validáció.** Valódi közepes kategóriás mobilra nincs
  hozzáférés ebben a környezetben, DE élő Lighthouse-méréssel (holazeso.hu,
  mobil emuláció) lefutott: LCP 1,5s (cél alatt), TBT 10ms (jó, az INP is
  valószínűleg alacsony lesz), **CLS 0,297 - a 0,1-es célérték fölött**.
  Oka megtalálva (nem csak sejtés): a `#loading` elem `.settled` osztálynál
  történő `padding-top` váltása (8rem -> var(--sp-3), ld. style.css) VALÓDI
  layout-ugrás, amit a `slideRadar` FLIP/transform-trükkje csak a FESTÉST
  nézve tüntet el - a Layout Instability API a transformot figyelmen kívül
  hagyva, a nyers layout-dobozt nézi, tehát a CLS-t nem javítja, akármekkora
  a vizuális simaság. Kipróbáltuk a FLIP célpontját a svg helyett a teljes
  #loading dobozra váltani - PerformanceObserver-rel megmérve UGYANÚGY
  jelezte a shiftet, tehát ez nem egyszerű kódhiba, hanem a jelenlegi
  padding-alapú architektúra valódi korlátja. Egy tényleges javítás a
  `.loading`/`.settled` párt teljesen transform-alapúra cserélné (fix
  magasságú doboz, a tartalom csak `translateY`-nal mozogna benne, a
  layout-doboz sosem változna) - ez a keresés-koreográfia (CLAUDE.md 6.
  szabály) CSS-mechanizmusát érintő, nagyobb átalakítás lenne, amit
  SZÁNDÉKOSAN NEM végeztünk el egy becsült, nem tesztelt refaktorral,
  nehogy hibát vigyen a védett, adatvezérelt viselkedésbe - ld. a
  `slideRadar` fejkommentjét a script.js-ben a pontos méréshez/indokláshoz.

**Ami még MINDIG nyitva maradt** a 2. kör után:

- ~~**CLS** a radar-reveal choreográfiánál~~ - **KÉSZ** 2026-11-25: 0,154 ->
  0 (mockolva), ld. a fájl végén.
- **D01 teljes köre**: minden EGYES értékhez külön forrás+idő+típus címke
  (az audit eredeti, teljes kérése) - csak a legfontosabb pontatlanságok
  (talaj: "mért" -> "modell-becslés") és egy aggregált időbélyeg készült el,
  nem egy teljes, minden kártyát érintő tartalmi átalakítás.
- ~~D04 adat élesbe tolása~~ - **KÉSZ**, ld. fent (2026-11-16 14:20Z).
- ~~Domborzati/magassági réteg (hillshading)~~ - **KÉSZ**, ld. a fájl
  tetején, "Domborzat (hillshade) a csatorna-térképhez, 3. kör" szakasz.
- **Kézi/képernyőolvasós (nem csak automatizált axe) akadálymentességi
  átvizsgálás** - az axe-core 0 violation jó jel, de nem helyettesíti.

## UX/UI audit, 1. kör (2026-11-16): mi valósult meg, mi maradt nyitva

Egy külső, élő UX/UI audit (`holazeso-ux-audit-2026-11-16.html`, feltöltve a
sessionbe) 20+ konkrét hibát/hiányosságot talált. A kvíz-wineket és a
P0/P1 súlyosságúakat ugyanebben a menetben megvalósítottuk (commitok:
`dd800e8` és a rákövetkező `d6e7731` hotfix, lásd a git historyt a pontos
tartalomért - fejléc-hierarchia, billentyűzettel elérhető folyó-sorok,
"Hamarosan" szétválasztva a jelen/előrejelzésre, a csatorna-térkép nem nyeli
el a görgetést, Mégse-gomb a helyszín-választón, valódi 404, lusta betöltés
a csatorna-térképnek, Magyarország határa/a 3 nagy folyó mind a MÁR meglévő,
pontosabb adatpipeline-geometriára cserélve minden térképen).

**Szándékosan NEM valósult meg** (az audit saját "Later roadmap"
szakaszában is 3-6 hónapos, önálló funkcióként szerepelt, nem egy
gyors javításként):

(A konkrét lista itt az 1. kör végén még nyitva volt: kereshető
vízfolyás-felfedező, mentett helyek/megosztható link, oktató réteg,
teljesítmény-validáció, D01/D04 teljes köre, WCAG-audit, domborzati réteg.
**A 2. kör ezeket dolgozta fel** - ld. a fájl tetején, "UX/UI audit, 2. kör"
szakaszt a pontos, naprakész státuszért, ne ezt a bekezdést.)

## Legfontosabb: nyitott, befejezetlen teendő

**A push-worker KV-migrációja még mindig nincs befejezve.** Ehhez a
2026-09-11 és 09-12 közötti munka egyáltalán nem nyúlt hozzá, tehát az
alábbi állapot változatlan, de **ellenőrizni kell, mielőtt bármit lépnél**,
mert több nap telt el azóta.

Történet:

1. A KV-tárolást átalakítottuk kulcsonkénti rekordokról egyetlen
   `subscriptions` kulcs alatti JSON tömbre (lásd `ARCHITECTURE.md`,
   "Tárolás: EGYETLEN KV kulcs" szakasz) - a régi felépítés a napi 1000
   írás/listázás limitet lépte túl percenkénti cronnal.
2. A 4 meglévő (régi formátumú) feliratkozást kiolvastuk a régi
   per-endpoint kulcsokból, de az új `subscriptions` kulcsba **nem sikerült
   beírni** őket, mert épp akkor merült ki a napi KV írási kvóta.
3. A régi per-endpoint kulcsokat **nem töröltük**, tehát az adat még ott
   van, csak a `scheduled` handler kizárólag a `subscriptions` kulcsot
   olvassa, ami üres/nem létezik - **egy feliratkozó sem kap értesítést**,
   amíg ezt nem javítjuk.

**Mit kell tenni:**

1. Először LISTÁZD a namespace kulcsait, és nézd meg, mi van most ott
   (`.../storage/kv/namespaces/<id>/keys`) - lehet, hogy azóta változott.
   Account ID: `c61cb06c1083cbbcf897a3e1afa23647`, namespace ID:
   `b930cf16ba13431787bccd98a88257f0`.
2. Olvasd ki a régi per-endpoint kulcsok értékét, és írd be egy tömbként a
   `subscriptions` kulcs alá.
3. Ellenőrizd a végeredményt, majd (ha minden migrált) töröld a régi
   per-endpoint kulcsokat, hogy tiszta legyen a namespace.

## Ami a legutóbbi munkamenetben történt (2026-09-11 / 09-12)

Az egész menet a keresés vizualizációjáról és a helyességéről szólt. A
tanulság, ami a `CLAUDE.md`-be és a memóriába is bekerült: **a vizuális
panaszok mögött itt sorra valódi kódhibák voltak**, nem animációs ízlésbeli
kérdések. Amíg a tünetet állítgattam (időzítés, térköz, fade), semmi nem
javult; amikor végigolvastam a láncot és MÉRTEM, előkerült három API-hiba és
hat lappangó hiba.

### A keresés koreográfiája (a felhasználó által kért végállapot)

1. **1. fázis, "Esik-e X környékén?"**: csak ezt keressük (saját pont + a
   150 km-es első gyűrű). A radar végig egy helyben áll, mert a még nem
   esedékes válasz a LAYOUTBAN SINCS benne (`#result` `data-phase`).
2. Amint megvan, a radar **azonnal** lecsúszik egy lépéssel (nincs külön
   várakozás: a pontok felfestése már kitöltött egy teljes pásztázó
   fordulatot, ~1,8 mp az egész), kiíródik a válasz, és megjelenik a
   "de hol esik pontosan?" kérdés.
3. **2. fázis**: a keresés a radar alatt folytatódik kifelé.
4. Ha megvan, **3 mp várakozás** (hogy a találat leolvasható legyen a
   radarról), majd a radar újra lecsúszik, és fölötte megjelenik a hely, a
   távolság és az útvonal.

A lecsúszás FLIP-animáció (`slideRadar`), különben a megjelenő szöveg
ugrással lökné odébb a radart. A radar NEM tűnik el és NEM zsugorodik.

A pásztázó vonal **festi fel** a pontokat, ahogy elhalad az irányuk fölött
(`radarRevealTier`). Ez a felhasználó kifejezett kérése volt; az
adatvezéreltség attól marad meg, hogy pont sosem villanhat fel előbb, mint
ahogy a valódi válasz megérkezett.

### Válasz-szókincs (tudatos változtatás, a felhasználó tud róla)

A kétfázisú bontás miatt az első válasz nem függhet a távoli kereséstől,
ezért a régi `Közelben`/`Távolban`/`Sehol` hármas helyett:

- 1. fázis: `Most esik` / `Hamarosan` (nálad) / `Igen` / `Nem`
- 2. fázis: a hely neve, a tényleges távolság és az útvonal, vagy `Sehol`

A felhasználónak felajánlottam, hogy visszahozom a régi szavakat, ha
szeretné - erre még nem válaszolt.

### Három API-hiba, ami miatt a keresés részben NEM MŰKÖDÖTT

1. **414 Request-URI Too Large**: a legtávolabbi adag URL-je 8811 karakter
   volt a nyers float koordinátáktól. Javítva: 4 tizedesre kerekítés
   (`coord`).
2. **429 Minutely API request limit exceeded**: lásd lent, a kvóta szakaszt.
3. **400 Longitude must be in range of -180 to 180**: a legtávolabbi gyűrűk
   átlógnak a dátumvonalon. Javítva: `destinationPoint` visszaforgatja a
   hosszúsági fokot.

### Az API-kvóta, amit rosszul feltételeztem

Utánanézve (hivatalos súlyozó képlet, `calculateQueryWeight`): **minden
lekérdezett pont külön 1 egységet ér**, és 10 változó / 14 nap alatt a
változók száma és a napok száma NEM módosít rajta. Limit IP-nként 600/perc,
5000/óra, 10000/nap; egy kérésben max. 1000 pont.

Ebből: a rácsra a `current=precipitation` szétválasztása gyorsít és rövidíti
az URL-t, de a kvótán **nem segít**. Ezért a keresés mérete 573-ról **295
pontra** csökkent (a 9000 km-es adag kiesett), a frissítés **5 percenként**
fut, és a csendes frissítés csak az 1. fázist futtatja (49 pont), kivéve ha
a környék válasza megváltozott. Részletek az `ARCHITECTURE.md`-ben.

### Hat lappangó hiba (kódátvizsgálásból, mind javítva)

1. **Végleges befagyás**: a `revealPhase` ígéretét megszakításkor senki nem
   oldotta fel, így keresés közbeni helyszínváltás után a `run()` örökre ott
   állt, és onnantól minden keresés némán kimaradt. Javítva: `cancelReveal`.
2. Az új helyszín keresése elveszett a `runInProgress` őrön. Javítva:
   futás-token, az új keresés felülírja a régit.
3. Csendes frissítés hibája letörölte a képernyőn álló jó választ.
4. Háttérbe került lapon elcsúszott a felfestés a pásztázó vonaltól (a CSS
   animáció megáll, a `Date.now()` nem). Javítva: Web Animations API.
5. Elavult komment a radar szakaszban.
6. A service worker gyorsítótára verzióról verzióra nőtt.

## Ellenőrzés: mivel teszteltem

Böngésző-automatizálás nincs ebben a környezetben, ezért **jsdom-os
állapotgép-tesztekkel** dolgozom, a valódi `index.html` + `script.js`
betöltésével (`new Function`-nel, a lenti "Indítás" blokkot levágva). A
tesztfájlok a session scratchpad mappájában vannak, nem a repóban. Ez a
módszer több valódi hibát talált (pl. hogy SVG elemen nincs `.hidden`
property), tehát érdemes folytatni.

Amit érdemes újra lefuttatni változtatás után: a fázis-átmenetek
(local → where → done) mind a négy ágon (nálad esik / környéken esik /
távolabb esik / sehol), a pásztázás-szinkron (a felfedett pontok száma
lineárisan követi-e a vonal szögét), és a biztonsági ágak (helyszínváltás
keresés közben, csendes hiba).

Egy 30 kiindulópontos (sarkok, dátumvonal, óceánok) geometriai stressz-teszt
~103 000 rácspontra hibátlan volt, éles lekérésekkel együtt.

## Nyitott ötletek (felmerültek, de NEM valósítottuk meg)

- Országhatárok megjelenítése a radaron nagy sugárnál.
- Pontossági jelzés a helymeghatározásnál (ha a böngésző csak IP-alapú,
  pontatlan helyzetet ad).
- Sötét/világos mód kézi váltása (jelenleg csak `prefers-color-scheme`).
- A push-értesítés teljes végpontos tesztje valós esőeseménnyel.
- A régi `Közelben`/`Távolban` szavak visszahozása, ha a felhasználó
  mégis hiányolja őket.

## Instrukció a `/compact`-hoz

```
/compact Tartsd meg: a push-worker KV-migráció befejezetlen állapotát és a
pontos azonosítókat (account c61cb06c1083cbbcf897a3e1afa23647, KV namespace
b930cf16ba13431787bccd98a88257f0), a CLAUDE.md összes "Kritikus szabály"
pontját (főleg az em dash tilalmat és a ?v=N cache-busting kötelezettséget),
az Open-Meteo kvóta tényeit (pontonként 1 egység, 600/perc, 5000/óra,
10000/nap), és azt a munkamódszert, hogy vizuális panasznál előbb a kódot
kell végigolvasni és mérni. A keresési rács konkrét számai, a radar-logika
és a push cooldown ne kerüljön be szó szerint, mert az ARCHITECTURE.md-ben
és a kódban megvan - elég rájuk hivatkozni.
```

## CLS 0 a keresés-felfedésnél (2026-11-25)

**KÉSZ, nincs commitolva.** A maradék két layout-ugrás (`loading|radar-svg`,
~0,105 a local->where, ~0,05 a where->done váltásnál) megszűnt: a layout a
keresés elejétől végleges, csak transform mozog (ARCHITECTURE.md "Layout-
stabilitás (CLS)").

- **Mit változtattunk**: rejtett válaszok `visibility: hidden` (`display: none`
  helyett), állandó `.loading` padding, `#q2-answer` min-height a tipikus
  válaszra, a régi megjelenést `positionRadar` (translateY a `#loading`-on,
  a régi elrendezés pillanatnyi visszakapcsolásával mérve) adja vissza,
  a `#result` háttere a látható elemeken, helymeghatározás alatt a `#result`
  helye is lefoglalt (`.pending`), a `data-none` a q2 nélküli ("Most esik")
  esethez. `?v=`: style.css 68, script.js 92.
- **Mért (mockolt, 3 futás mediánja, 14 mp)**: főoldal 375 px 0,154 -> 0;
  1280 px 0,172 -> 0; `/eso/kecskemet/` 375 px 0,154 -> 0; `/ho/` 375 px 0,31 ->
  0,015; 1280 px 0,57 -> 0,02. 390 px-en eső/hó/ónos eső/nincs találat: 0,14-0,16
  -> 0,0004; "Most esik" 0,091 -> 0,047 (1280 px: 0,028).
- **Megmaradó, ismert**: a vízpanelhez görgetéskor ~0,0129 (a panel kitöltése,
  nem a keresésé); "Most esik" állapotban a q1-context (2 sor) és a q2-block
  kiesése; a `/ho/` helymeghatározás->keresés váltásánál a töltésjelző
  szövege (~0,015-0,02). Hosszabb-rövidebb válasz a foglalásnál (pl. "Most
  nem esik" 2 soros 375 px-en) kis ugrást ad.
- **INP (longtask, mockolt, 375 px)**: a keresés alatt nincs 50 ms feletti
  feladat; az egyetlen jelentős a vízpanelhez görgetéskor jön (water.js
  build) 309 ms (4x CPU-lassítással 1151 ms): kényszerített layout
  (`getBoundingClientRect`) a `renderSoilCoreProfile`-ban (~130 ms) és a
  `apply`-ban (water.js ~1034. sor, ~114 ms), plusz `nearestRealAt` ~108 ms.
  Nincs egyetlen >200 ms-os forró pont, ezért nem nyúltunk hozzá.
