# Architektúra és működés

Ez a dokumentum a `README.md`-nél részletesebben leírja, *hogyan* működik
belülről a rendszer, és felsorolja azokat az üzemeltetési buktatókat, amiket
menet közben fedeztünk fel. A `README.md` a "hogyan futtasd/deployold"
kérdésekre válaszol, ez a fájl a "hogyan működik belülről és mire figyelj"
kérdésekre.

## Áttekintés: három rész

Az oldal maga statikus, de mögötte van egy kis backend, két darabból:

- **`holazeso-v0/`** (ez a repó): a statikus weboldal (HTML/CSS/JS, build
  nélkül). GitHub → Cloudflare Pages, Git-integrációval automatikus deploy
  minden `main` push-ra. Az esőkeresést, a "részletek és statisztika"
  panelt és a saját hely talajprofilját a böngésző közvetlenül kéri le
  (Open-Meteo, BigDataCloud).
- **`holazeso-push-worker/`** (külön repó, Cloudflare Worker + KV): a
  backend publikus része. Két feladata van:
  1. push-értesítések: `/subscribe`, `/unsubscribe`, és egy percenkénti cron,
     ami az Open-Meteótól lekéri a feliratkozók helyének csapadékát;
  2. a vízadat-panel adatainak kiszolgálása: a `/*-snapshot` végpontok a
     KV-ben tárolt pillanatképeket adják vissza a böngészőnek (`GET`), és
     fogadják a frissítést az otthoni jobtól (`POST`, Bearer token).
  Deploy kézzel: `npx wrangler deploy`.
- **`soil-moisture-mapper`** (külön repó, otthoni gépen, Docker
  containerben): a backend adatgyűjtő része. Óránként lekéri az országos
  talajnedvesség-rácsot (Open-Meteo, ~350 pont) és lekaparja a hydroinfo.hu
  folyó- és tó-vízállás tábláit, majd a pillanatképeket `POST`-olja a
  workernek. A csatorna-térkép (`app/channels.py`) és a domborzat
  (`app/elevation.py`) egyszeri, kézzel futtatott szkript. Azért fut
  otthon és nem a böngészőben, mert egy országos lekérés látogatónként
  felélné az Open-Meteo kvótát, a hydroinfo.hu-nak pedig nincs CORS-a.

Adatfolyam a vízadatokhoz:

```
hydroinfo.hu, Open-Meteo
        │  óránként
        ▼
soil-moisture-mapper (otthon, Docker) ──POST, Bearer──▶ push-worker KV
                                                          │ GET (CORS: csak éles origin)
                                                          ▼
                                                  böngésző (script.js)
```

Ha az otthoni gép áll, az oldal tovább működik: a vízadat-panel az utolsó
feltöltött pillanatképet mutatja, a "frissítve" sor jelzi, mennyire régi.
A Pages és a Worker a `Kovizozi@gmail.com's Account` Cloudflare fiók alatt
fut.

## A esőkereső algoritmus (`script.js`)

Nincs fix településlista. A `run(userLoc)` a felhasználó koordinátája köré
dinamikusan generál egy keresési **rácsot** (`generateSearchGrid`): gyűrűk ×
irányok, a gömbi navigációs képlettel (`destinationPoint`) kiszámolt
pontokkal. Ez azért jobb, mint egy fix településlista, mert bárhol a Földön
egyformán pontos.

**Fokozatosan táguló keresés** (`SEARCH_RINGS`): hat adag, mindegyik egyetlen
Open-Meteo hívás. Az első csak 150 km-ig néz (48 pont), a következők 150
km-enként lépnek kijjebb (300, majd 450 km), és csak utána gyorsul a lépés
(900, 2500, végül 9000 km), hogy távoli eső esetén se kelljen tucatnyi kört
végigvárni. Minden adag CSAK az új gyűrűt méri fel, a belsőt az előzőek már
lefedték. Ez azért kell, mert egy fix, szűk rács sokszor "Sehol"-t mondott
volna olyankor is, amikor valójában volt eső, csak a rács nem talált rá.

**A gyűrűk pontsűrűsége**: egy gyűrűn nem fix számú irányt kérdezünk le,
hanem annyit, amennyi a kerületéhez illik (6-tól 42-ig). Fix 12 iránnyal a
szomszédos pontok 30 km-en 16 km-re, 9000 km-en viszont már 4712 km-re estek
egymástól, vagyis kint egész esőrendszerek elfértek volna két pont között.

### API-terhelés és kvóta

Ezt fontos pontosan érteni, mert a keresés méretét ez korlátozza, nem a
sebesség. Az Open-Meteo ingyenes limitje **IP-nként 600/perc, 5000/óra,
10000/nap**. A súlyozás a szerver forrásából (`calculateQueryWeight`):

```
súly = Σ pontonként  max(1, max(V/10, (V/10) × (nap/14)))
```

Vagyis **minden lekérdezett pont külön 1 egységet ér**, és 10 változó / 14 nap
alatt a változók száma és a napok száma **semmit nem módosít rajta**. Ebből
két, első ránézésre meglepő következmény:

- Hiába kérünk a rácspontokról csak `current=precipitation`-t: a kvóta
  szempontjából ez ugyanannyi, mint a teljes órás előrejelzés. (A szétválasztás
  ettől még hasznos: kisebb válasz, rövidebb URL, gyorsabb hálózat.)
- Egy kérést több kérésre bontani sem segít: csak a pontok száma számít.

Ezért a teljes keresés **295 pont**, és ezért frissítünk 5 percenként, nem
percenként. A csendes háttérfrissítés ráadásul csak az 1. fázist futtatja le
(49 pont), és csak akkor megy tovább a távoli keresésre, ha a környék válasza
meg is változott.

**Egyéb API-buktatók**: a koordinátákat 4 tizedesre kerekítve küldjük
(`coord`), különben a legtávolabbi adag URL-je túllépi a szerver 8 KB-os
korlátját (414). A `destinationPoint` a hosszúsági fokot visszaforgatja a
[-180, 180] tartományba, mert a legtávolabbi gyűrűk átlógnak a dátumvonalon
(enélkül a távoli keresés egyáltalán nem működött). Egy kérésben legfeljebb
1000 pont lehet (nem dokumentált szerver-beállítás).

**Névfeloldás (`findNearbyName`)**: a legközelebbi esős rácspontnak gyakran
nincs neve (pl. tenger felett van). Ilyenkor a pont körül egyre táguló
gyűrűkben (20/60/150 km) keresünk nevesíthető helyet, párhuzamos
lekérdezésekkel. **Fontos**: ha a névadó pont eltolódott az eredeti esős
ponttól, a kiírt távolságot/irányt/térkép-linket a **névadó pont**
koordinátáihoz kell számolni (`distanceKm`, `bearingBetween`), nem az eredeti
esős ponthoz, különben a kiírt szám nem egyezik a mutatott névvel. (Ez egy
valós hiba volt, amit javítottunk: egy angliai teszt esetén 300 km-t írt ki
"Mattishall" mellé, miközben Mattishall valójában csak 150 km-re volt.)

### Országhatárok a radaron (`borders.json`)

A radar **azimutális ekvidisztáns vetület** a felhasználó körül: minden pont a
valódi távolsága és iránya szerint kerül a helyére. Ezért a határvonalakhoz
nem kell külön térképvetület, ugyanaz a `distanceKm` + `bearingBetween` pár
vetíti őket, mint a rácspontokat.

- **Forrás**: Natural Earth 1:50m `admin_0_countries` (közkincs, nem kér
  feltüntetést). Az ország-poligonok körvonalát használjuk, tehát a
  tengerpartok is megjelennek, nem csak a szárazföldi határok.
- **Előállítás**: Douglas-Peucker ritkítás 0,08 fokos tűréssel, a 0,4 foknál
  kisebb szigetek elhagyva, koordináták 2 tizedesre kerekítve. Ezután
  delta-kódolás: 0,01 fokos egész egységek, gyűrűnként az előző ponthoz
  képest. Ez 289 KB-ról 137 KB-ra viszi a fájlt (gzippel 97 KB helyett 52 KB).
  99613 csúcsból 20262 marad.
- **Betöltés**: lusta, a keresés indulásakor, és SOSEM várakoztatja a választ.
  Ha nem érkezik meg vagy hibázik, a radar határok nélkül működik tovább.
- **Rajzolás**: a határréteg mindig az aktuális legnagyobb sugárhoz igazodik,
  ezért a köröktől eltérően nem zoomoljuk, hanem minden új körnél
  újrarajzoljuk. A látható körből kilépő szakaszokat megszakítjuk (nem a
  peremre lapítjuk). Olcsó szélesség szerinti előszűrés előzi meg a gömbi
  számolást, különben kis sugárnál feleslegesen menne végig mind a 20 ezer
  csúcson.
- **Minimális vizuális sugár** (`RADAR_MIN_VISUAL_RADIUS_KM`, `script.js`):
  a tényleges keresési sugár (ahol a legközelebbi esőt találtuk) gyakran
  kisebb, mint ami a határ felismeréséhez kellene. Magyarország
  legeldugottabb pontja (a határtól legtávolabb eső hely) kb. 112 km-re van
  bármelyik határtól, ezért 220 km-es alsó korlát biztosítja, hogy a radar
  MINDIG mutasson legalább egy darab határt, bárhol állunk az országban.
  A `radarAddTier` ezt MINDEN körnél érvényesíti (a kör saját sugara a
  pontok vetítésére marad, csak a KIJELZETT `radarMaxRadiusKm` legalább 220
  km), így a keretezés a keresés elejétől a végéig nem ugrik. (Korábban a
  `radarEnsureMinRadius()` a keresés végén húzta ki a kört.)
- **Az alaptérkép a keresés indulásakor megjelenik** (`radarDrawBase`):
  határok, folyók/Balaton, városfeliratok és a RainViewer-kép nem várnak
  adatra, csak a felhasználó helyétől és a kijelzett sugártól függenek. Korábban
  egy `bordersVisible` jelző a keresés végéig elrejtette őket (a radar
  keresés közben csak a pásztázó vonalat mutatta, ~10 mp-ig). A rétegek
  lusta adatai (`borders.json`, `water-geo.json`, `places-hu.json`, RainViewer
  katalógus) megérkezéskor maguk rajzolják ki a saját rétegüket. A
  `radarDrawBase` csak akkor rajzol újra, ha a hely vagy a sugár változott
  (különben a rétegek belépő animációja a keresés végén újraindulna). Csak a
  találati pontokra vonatkozik a 6. szabály: azok továbbra is csak a válasz
  megérkezése után, a pásztázó vonal által festve jelennek meg. A nagyítás
  (`radarZoomTo`) alapsugara (`radarBaseRadiusKm`) továbbra is a keresés
  végén áll be, addig a +/- gombok rejtettek.
- **Találati pontok piktogramként** (`addRainDot`): a pont a csapadék
  típusának jele (`#ico-rain` csepp, `#ico-snow` hópehely, `#ico-ice` csepp
  kivágott jégcsillaggal; az index.html `#radar-svg` `<defs>` részében, `--accent`
  színnel). A `radarRevealTier` térképe `index -> { mm, kind }` (`rainHits`).
  Az intenzitás továbbra is méretben (`dotRadius`) és átlátszóságban látszik;
  a pásztázó időzítés és a koppintásos helynév változatlan (a `g.radar-dot`
  `data-cx/cy` adja a felirat helyét).
  Sűrítés: `glyphIndexes` képernyőn ~16 px-es cellánként csak a legerősebb
  találatot rajzolja piktogramnak, a többi sima kis pötty (`radar-dot-plain`),
  különben a sűrű csoport összefüggő folt lenne; az időzítést ez nem érinti.
  A `#result` `z-index: 1` és saját háttérrel áll a radar fölött, hogy a
  fázisváltáskor lecsúszó (FLIP) alaptérkép ne takarja a megjelenő választ.

### Folyók és a Balaton a radaron (`water-geo.json`)

Ugyanazzal az azimutális vetítéssel és lusta betöltési mintával, mint a
határok (`loadWaterGeo`/`radarDrawWaterGeo`, lásd a közös
`radarProjectRingsToPath` segédfüggvényt), csak más forrásfájlból.

- **Forrás**: Natural Earth 1:10m `rivers_lake_centerlines` (Duna, Tisza,
  Dráva) és `lakes` (Balaton). A Tisza középső szakasza az NE-adatban nem
  kapott nevet (`rivernum: 330`, `name: null`), ezért a 3 folyót
  `rivernum` alapján válogattuk ki (25/363+330/303), nem a `name` mezővel.
  A Fertő-tó és a Velencei-tó NINCS ebben a rétegben: 10m felbontáson a
  Natural Earth lakes-adata nem tartja nyilván őket külön tóként (a
  dedikált Tavak-szakasz saját, kézzel rajzolt ábrája ettől függetlenül
  mindháromat mutatja).
- **Előállítás**: ugyanaz a Douglas-Peucker + delta-kódolás, mint a
  határoknál (0,015 fok tűrés a folyóknál, 0,01 a Balatonnál, mert az
  kisebb és közelről néznénk). A fájl ~1,8 KB (12 folyó-szakasz, 1 tó-
  gyűrű) - nem kellett a határokéhoz hasonló méretoptimalizálás.
- **Rajzolás**: a folyók NYITOTT vonalként (nem gyűrűként), a Balaton ZÁRT
  gyűrűként, de mindkettő csak körvonalként (nincs kitöltés, a projekt
  monokróm/sík-design szabálya miatt) - a Balatont a folyóktól és a
  határtól egy szaggatott mintázat különbözteti meg, nem szín.

## A válasz két szakaszban (`run`)

A keresés két kérdésre válaszol, egymás után, és a radar mindkettő után
lejjebb csúszik egy lépéssel (`#result` `data-phase` attribútuma vezérli, mi
látszik; a FLIP-animációt a `slideRadar` intézi):

1. **"Esik-e X környékén?"** Ehhez csak a saját pont előrejelzése és a legelső,
   150 km-es gyűrű kell. Válasz: `Most esik` / `Hamarosan` (nálad), `Igen`
   (a környéken esik), `Nem`. Az első kettőnél nincs második szakasz: ha
   nálad esik, a "hol esik pontosan" kérdés értelmetlen.
2. **"De hol esik pontosan?"** Csak az első válasz kimondása UTÁN indul, és
   csak akkor, ha nálad nem esik. Innen tágul kifelé a keresés, amíg talál,
   majd névfeloldás után kiírja a helyet, a távolságot és az irányt. Ha
   sehol nem talált, a válasz "Sehol".

Az első szakasz válasza szándékosan nem függ a távoli kereséstől: enélkül nem
lehetne két szakaszra bontani, mert a "Közelben/Távolban/Sehol" típusú válasz
csak a teljes keresés végén derülne ki. A közel/távol információt most a
második szakasz kiírt távolsága hordozza.

## Részletek-panel és vízadat-panel

A végleges válasz (`revealPhase(PHASE_DONE)`) után két további blokk jelenik
meg a radar alatt. Mindkettő a **keresett helyre** (`currentLoc`) szól, nem
arra a településre, ahol a radar esőt talált.

### "részletek és statisztika" (`#stats-panel`, `buildStatsPanel`)

Mindig látható `<section>` (nincs nyitógomb, nincs localStorage-állapot); a
`revealPhase(PHASE_DONE)` mutatja meg, és ekkor kér le (31+ napos
csapadék-história, az elmúlt 3 év ugyanezen időszaka, előrejelzés,
hőmérséklet, órás csapadék/esély/hó), keresésenként
egyszer (a `statsRunId` eldobja az elavult választ). Nem fut bele az 5
percenkénti automatikus frissítésbe. A tetején a `#stats-place` sor
("Az adatok helye: <név>") mondja ki, melyik helyre vonatkoznak a számok.
Minden adata Open-Meteo-alapú, ezért bármely országban működik.

Négy kártya: Csapadék, Előrejelzés, Hőmérséklet és **Következő 12 óra**
(`fillNext12hStats`). Az utóbbi a korábbi "Víz" kártya (talajskála és
legközelebbi folyó vízhozama) helyén áll, mert az nem mondott újat, a részletek
a vízpanelben vannak; a talaj-sáv, a Flood API hívás és a hozzá tartozó
kód ki lett törölve. A kártya a `fetchUserStats` MÁR meglévő órás
csapadékát és esélyét használja, kérés csak egy új órás mezővel (`snowfall`)
bővült, a `soil_moisture_0_to_1cm` kikerült. Az aktuális órától 12 oszlop
(`--accent`), felettük az mm, alattuk az óra (háromóránként, az első "most") és
az esély (csak a csapadékos órákra); a havazásos órák (órás `snowfall > 0`)
sraffozott, körvonalas oszlopot kapnak, és ekkor egy jelmagyarázat-sor
jelenik meg. Ha mind nulla: "A következő 12 órában nem várható csapadék." és a
lapos diagram.

### Vízadat-panel (`#water-panel`, `buildWaterPanel`)

**A kód külön fájlban van, lustán töltődik** (SEO-PLAN 4. fázis). A panel
teljes logikája (folyók, tavak, talaj, csatornák, Cigánd, a térképek, kb. 219
kB) a `/water.js`-ben van, a `script.js` (kb. 117 kB) csak a vékony lusta
betöltőt tartalmazza (`requestWaterPanel`, `startWaterPanel`, `loadWaterJs`,
`resetWaterPanel`). A `water.js` KLASSZIKUS script (nem modul), ezért a
`script.js` legfelső szintű nevei (`openMeteo`, `loadWaterGeo`, `loadBorders`,
`loadPlaces`, `placesList`, `waterGeo`, `elevationGrid`, `distanceKm` stb.)
közös globális lexikális környezetben közvetlenül láthatók benne, külön
névtér nem kell; fordítva a `script.js` csak a `buildWaterPanel`-t és a
`resetWaterPanelNow`-t hívja a `water.js`-ből. Ami mindkettőnek kell
(`loadPlaces`/`placesList`), a `script.js`-ben maradt. A `water.js` csak
deklarációkat tartalmaz, betöltéskor semmit nem futtat. Ha a `water.js`-ben
olyan nevet használsz, ami a `script.js`-ben van, a két fájl betöltési
sorrendje (előbb `script.js`) garantálja a meglétét; fordítva TILOS
legfelső szinten hivatkozni a `water.js`-re a `script.js`-ben.

Mikor töltődik be: a keresés végén a panel azonnal látható (helyfoglaló
vázzal), de a `requestWaterPanel` csak azután figyeli IntersectionObserverrel
(`rootMargin: 600px 0px`), hogy a statisztika-panel felépült (vagy 6 mp
eltelt); a `water.js` és a vízadat-pillanatképek lekérése a panel
közelébe érkezéskor indul. Azonnal indul a betöltés tartalomjegyzék-linkre
(`a[href^="#water-"]` kattintás), `hashchange`-re és ha az oldal `#water-...`
hash-sel nyílt (a build után a cél szakaszra görget). Új keresés/reset
(`waterBuildToken`) eldobja a függő betöltést. A `sw.js`-en nincs teendő: a
`water.js?v=N` azonos eredetű GET, ugyanúgy stale-while-revalidate és a `?v=`
miatt az `activate` takarítja.

**Csak magyarországi helyszínnél jelenik meg** (`currentLoc.countryCode ===
"HU"`), mert minden adata Magyarországra vonatkozik. Ismeretlen országkódnál
sem jelenik meg; a `run()` addigra már megpróbálja pótolni reverse
geocodinggal. Külföldi helynél a hozzá tartozó lekérések sem futnak le. A
`resetWaterPanel()` minden keresés elején elrejti.

Nem lenyíló: a radar után rögtön, nyitva jelenik meg. Sorrend:

1. **Saját hely** (`#water-local-section`): a keresett pont 5 mélységi
   talajnedvesség-profilja (Open-Meteo, `fetchUserSoilProfile`), az
   országos átlaghoz mérve. Legfelül, mert ez szól a keresett helyre. A
   lekérése a snapshotokkal együtt, ugyanabban a `Promise.all`-ban indul
   (saját `.catch`-csel), és elsőként rajzolódik ki, hogy később ne ugorjon
   be az országos adatok fölé. Ha nem jön meg, csak ez a szekció marad
   rejtve.
2. **Országos adatok** ("mennyi víz van összesen az országban?" cím és
   tartalomjegyzék alatt): talajvíz Balatonokban, talajnedvesség-dombormű,
   folyóhálózat, élő folyó-mércék, csatorna-térkép (lustán, látótérbe
   érve tölt), vízmérleg, tavak.

**Adatforrás**: a `holazeso-push-worker` KV-jében tárolt pillanatképek
(`GET /soil-snapshot`, `/rivers-snapshot`, `/lakes-snapshot`,
`/channels-snapshot`). Ezeket egy külön repó, a `soil-moisture-mapper`
otthoni gépen futó jobja tölti fel óránként (a csatornákat alkalmanként,
kézzel), Bearer tokenes `POST`-tal. A folyó- és tó-vízállás a hydroinfo.hu
(OVF) méréseiből, a talajnedvesség az Open-Meteo modelljéből jön. Statikus
fájlok mellette: `water-geo.json` (folyók, Balaton), `borders.json`
(országhatár), `elevation.json` (domborzat a csatorna-térképhez).

**Lokális tesztelés**: a worker CORS-a csak az éles originekre válaszol, ezért
`localhost`-ról a vízadat-panel "a vízadatok most nem érhetők el" üzenettel
áll meg. Ez nem hiba. Teszteléshez a kéréseket éles `Origin` fejléccel kell
továbbítani (pl. Playwright `page.route`).

## Push-értesítés rendszer

### Kliens oldal (`script.js`, `sw.js`)

A "értesíts, ha esni kezd" gomb a `Notification.requestPermission()` +
`PushManager.subscribe()` böngésző API-kat használja, a VAPID nyilvános
kulccsal (`VAPID_PUBLIC_KEY` konstans a `script.js`-ben). A feliratkozást
(endpoint + kulcsok + mentett hely) elküldi a Worker `/subscribe`
végpontjának. A `sw.js` egy `push` eseménykezelőt tartalmaz, ami megjeleníti
az OS-szintű értesítést.

**iOS-korlát**: iPhone/iPad-en a Safari csak akkor engedélyezi a
`PushManager`-t, ha az oldal telepített (kezdőképernyőre kitett) appként fut,
sima böngészőfülben a `PushManager` API elérhetetlen. Ez Apple szándékos
platformkorlátozása, nem javítható a kódunkból. Mac-es Safari-n (16+) ez a
korlátozás nincs, ott böngészőfülben is működik.

### Worker (`holazeso-push-worker/src/index.js`)

Egy Cloudflare Worker `fetch` (HTTP: `/subscribe`, `/unsubscribe`, valamint
a vízadat-panel pillanatképei: `GET`/`POST /soil-snapshot`, `/rivers-snapshot`,
`/lakes-snapshot`, `/channels-snapshot`, ld. "Vízadat-panel" fent) és
`scheduled` (Cron Trigger, percenként) handlerrel. A snapshot-`POST`
szerver-szerver hívás, a `SOIL_SNAPSHOT_TOKEN` secret-tel hitelesítve, nem a
CORS-allowlist-tel.

**Tárolás: EGYETLEN KV kulcs.** Eredetileg minden feliratkozás saját KV
kulcs alatt volt (`endpoint` → rekord), és a cron minden körben
`list()`-elt, minden kulcsot egyenként `get()`-elt, majd minden rekordot
feltétel nélkül visszaírt (`put()`). Ez **egyetlen feliratkozóval, percenkénti
cron mellett is** túllépte a Cloudflare KV ingyenes csomagjának napi 1000
írás/listázás limitjét (1440 tick/nap > 1000). Ezért most **egyetlen KV
kulcs** (`subscriptions`) alatt egy JSON tömbben van minden feliratkozás:
körönként 1 olvasás, és írás **csak akkor**, ha ténylegesen változott
valami (nem minden tick-nél). Ez a napi művelet-számot gyakorlatilag
függetlenné teszi a feliratkozók számától.

**Cooldown-logika**: minden feliratkozásnak van egy `state` mezője
(`"dry"` vagy `"wet_notified"`) és egy `dryStreakStart` időbélyege.
Értesítés csak akkor megy ki, ha esik ÉS legalább 2 órája
(`DRY_STREAK_REQUIRED_MS`) száraz volt előtte; ez akadályozza meg, hogy egy
hosszan tartó esőnél percenként új értesítés menjen. Küldés után a
feliratkozás "wet_notified" állapotba kerül, és csak akkor tér vissza
"dry"-ra (és kezdi újra számolni a száraz streaket), amikor tényleg eláll az
eső. **Csak sikeres (201-es) küldés után** áll be "wet_notified"-ra; ha a
küldés hibázik (nem lejárt előfizetés, csak pl. átmeneti hálózati hiba), a
következő percben újra próbálkozik.

**Titkosítás**: `@pushforge/builder` csomag, natív Web Crypto API-t használ
(nem Node.js `crypto`-t), ezért `nodejs_compat` flag nélkül is fut
Cloudflare Workers-en. A VAPID privát kulcs Wrangler secret-ként van tárolva
(`VAPID_PRIVATE_KEY`), nincs commitolva sehova.

**CORS**: csak a `holazeso.hu`/`holazeső.hu`/`xn--holazes-8mb.hu` originek
engedélyezettek.

## PWA (`manifest.json`, `sw.js`, ikonok)

Telepíthető appként (Android "Install", iOS "Add to Home Screen"). A
`sw.js` egy egyszerű stale-while-revalidate cache-t tart fenn a saját
eredetű statikus fájlokra.

**Fontos csapda, amit javítottunk**: a service worker eredetileg **minden**
azonos eredetű GET-et cache-elt, beleértve magát a navigációs kérést
(`index.html`-t) is. Mivel az `index.html` hordozza a `script.js?v=N` /
`style.css?v=N` cache-busting hivatkozásokat (lásd lent), ez azt
jelenthette, hogy egy telepített app **örökre megragad egy régi
verziónál**: a cache-elt régi `index.html` mindig a régi `?v=N`-re
hivatkozna. Ezért a `sw.js` mostantól sosem cache-eli a navigációs
kéréseket (`event.request.mode === "navigate"`), és `skipWaiting()` +
`clients.claim()` segítségével a service worker frissítése is azonnal
átveszi az irányítást, nem várja meg, hogy az app minden nyitott példánya
bezáródjon.

**Automatikus frissítés**: mivel telepített (standalone) módban nincs
böngésző-frissítés gomb, az app percenként újralekérdezi az időjárást,
amíg látható (`shouldAutoRefresh()`: csak akkor fut, ha a lap látható ÉS
van kiválasztott hely ÉS az eredmény-nézet aktív), plusz azonnal frissít,
amikor visszaválasztod az appot (`visibilitychange`).

## Design-rendszer

Szigorúan monokróm (fekete/fehér, sötét módban megfordítva
`prefers-color-scheme`-mel), tipográfia-vezérelt, nincs szín/gradiens/
árnyék. A bal felső sarokban eredetileg egy nagybetűs, ritkított
"HOLAZESO.HU" felirat volt, ezt (mint tipikus SaaS-sablon mintát)
eltávolítottuk; a domain csak a láblécben szerepel.

**Térköz-rendszer**: nem egyenletesen nagyobb margók, hanem egy
Fibonacci-skála (`--sp-1` … `--sp-6`: 8/13/21/34/55/89 px), szerep szerint
kiosztva: szoros távolság (8-13px) egy szemantikailag összetartozó
elempáron belül (pl. kérdés → rá adott válasz), arányosan nagyobb ugrás
(34px) csoportváltásnál (fő válasz blokk → pontos hely blokk), legnagyobb
(89px) a tartalomtól teljesen független részek előtt (pl. lábléc).

### Layout-stabilitás (CLS)

A `#app` `min-height: 100svh` (style.css): a keresés fázisai közben az app
magassága többször nő, és az alatta lévő `.seo-content` addig a látható
területen kezdődött, így minden növekedés "ugrásként" mérődött (ez volt a
CLS túlnyomó része). Most a hajtás alatt kezdődik. Mockolt Playwright-méréssel
(3 futás mediánja, 14 mp) a főoldal 375 px-en 1,46-ról 0,154-re, 1280 px-en
0,76-ról 0,17-re, a `/eso/kecskemet/` 375 px-en 1,39-ről 0,154-re esett.
A maradék két ugrás a "egy kérdés, egy válasz" felfedés VELEJÁRÓJA: amikor a
válasz-szöveg (q1, majd q2) megjelenik a radar FÖLÖTT, a #loading doboza
layoutban lejjebb kerül és a `.settled`/where állapot `padding-top`-ja is
változik; a `slideRadar` FLIP-je ezt vizuálisan eltünteti, a metrika viszont a
layout-dobozt nézi. Ennek megszüntetése a radar-koreográfia CSS-mechanizmusát
(CLAUDE.md 6. szabály) érintené, ezért szándékosan marad. A vízpanel
(`.water-skeleton`) és a statisztika-panel helyfoglalása egyenletes
görgetésnél mérten ~0 ugrást ad (a panelek a hajtás alatt töltenek).

## Üzemeltetési buktatók

### `?v=N` cache-busting: KÖTELEZŐ minden script.js/style.css módosításnál

A `holazeso.hu` custom domain (ismeretlen okból, Cloudflare Pages-kvirk)
**nem veszi figyelembe** a `_headers` fájl `no-cache` szabályát
`script.js`/`style.css`-re, a böngészők akár 4 óráig a régi verziót
cache-elhetik. Az `index.html`-ben ezért `script.js?v=N` / `style.css?v=N`
szerepel: **minden alkalommal, amikor módosítod ezeket a fájlokat, bővítsd a
megfelelő `?v=N` számot** az `index.html`-ben. Az `index.html` maga mindig
frissen töltődik (`max-age=0, must-revalidate`), ezzel nincs teendő.

A `water.js` ugyanígy verziózott, de a hivatkozása nem az `index.html`-ben,
hanem a `script.js` `WATER_JS_URL` konstansában van (`/water.js?v=N`, a
lusta betöltő hozza létre a script-elemet): a `water.js` módosításakor
emeld a `?v=`-t ott, és mivel ezzel a `script.js` is változik, az
`index.html`-ben a `script.js?v=`-t is.

Diagnosztizálva, de nem megoldva: miért nem tartja tiszteletben a domain a
`_headers`-t. A direkt `*.pages.dev` URL helyesen `no-cache`-t ad, csak a
custom domainen keresztül nem, valamilyen Cloudflare Pages
custom-domain-routing sajátosság, nem zóna-szintű cache-beállítás
(Page Rules, Cache Rules egyike sem érintett, purge sem oldja meg tartósan).

### Cloudflare KV ingyenes limitek

Napi **1000 írás/listázás/törlés**, napi **100 000 olvasás**, lásd fentebb
a "Tárolás: EGYETLEN KV kulcs" szakaszt. Ha valaha nagyon sok feliratkozó
lenne (több ezer), a jelenlegi egyetlen-blob megoldás mérete és a
körönkénti Open-Meteo hívások darabszáma (100-as csoportokban) újra
átgondolandó, de hobbi-projekt méretben bőven elég.

### KV write-migráció óvatosan

Ha valaha újra átalakul a KV tárolási formátum, a régi adatokat explicit
migrálni kell (kiolvasni a régi formátumban, beírni az újban); automatikus
migráció nincs beépítve, és a napi limit alatt kell maradni a migráció
közben is.

## SEO

`robots.txt`, `sitemap.xml`, JSON-LD (`WebSite` schema), Open
Graph + Twitter card meta tagek, generált `og-image.png` (1200×630,
monokróm, a felhő-favicon nagyított változatával). A tényleges válasz-
tartalom kliens-oldalon, a felhasználó helyzete alapján generálódik, ezért
keresőrobot szempontjából nincs "indexelhető" tartalma az egyes
válaszoknak (ez a projekt jellegéből adódik, nem hiba); a SEO itt a
márka/domain felismerhetőségéről szól, nem tartalom-rangsorolásról.

## Generált oldalak (`tools/build_pages.py`)

Egyetlen Python-generátor (csak standard könyvtár) állítja elő az aloldalakat az `index.html`-ből mint sablonból. A kimenet a repóban van (mint a `cigand-news.json`), a `.github/workflows/build-pages.yml` futtatja (push, ha `index.html`, `places-hu.json`, `climate-hu.json`, `tools/**` változik; napi cron 05:23; kézi indítás), és csak változás esetén kommitol (`git pull --rebase` a push előtt).

- **Sablon-jelölők az `index.html`-ben**: `<!--GEN:content-->` (a `<footer>` előtti statikus szakasz: h1, bevezető) és benne `<!--GEN:places-->` (a főoldali "Települések" lista). A főoldal maga az `index.html`, a generátor csak a lista részt írja újra benne.
- **`render_page(ctx, path=, title=, description=, h1=, content_html=, boot_script=, indexable=)`**: a közös függvény. Átírja a title/description/canonical/og/twitter/JSON-LD fejlécet, kicseréli a content blokkot, a sablon relatív asset-hivatkozásait gyökér-abszolútra írja (`/style.css?v=N`), és a `script.js` elé beszúrja a boot-szkriptet. `indexable=False` `noindex` meta-t ad (widget).
- **Oldaltípusok**: `PAGE_BUILDERS` lista, minden builder `Ctx`-ből `Page` listát ad. Most: `build_home`, `build_town_pages` (`/eso/<slug>/`), `build_cigand_page` (`/cigand/`), `build_water_pages` (`/vizallas/`, `/vizallas/<slug>/`). A 3. fázis oldalai: `build_snow_page` (`/ho/`) és `build_widget_page` (`/widget/`).
- **Adatok**: `places-hu.json` (`slug`, `loc` = helyhatározós alak kézzel; `n`, `lat`, `lon`, `r`), `climate-hu.json` (éves átlagos csapadék, legcsapadékosabb hónap, esős napok/év; Open-Meteo archive API, 2013-2024, napi csapadék; "esős nap" >= 1 mm). A klímát csak a `--fetch-climate` kéri le, csak a hiányzó helyekre, 4-es csomagokban, 15 s várakozással; hibánál (pl. 429) leáll, és a hiányzó helyek oldaláról egyszerűen kimarad a klíma-szöveg.
- **`sitemap.xml`**: a generátor írja; a `lastmod` csak akkor változik, ha az oldal tartalom-hash-e (a `<!--h:...-->` komment az url-ben) változott. A `robots.txt` hivatkozik rá.
- **Településoldal boot**: `window.HOLAZESO_PLACE = {name, lat, lon, countryCode}` a `script.js` előtt. A `script.js` indításkor ezt használja a mentett és az automatikus hely helyett, de nem menti el és nem módosítja az URL-t; a helyszín-váltó ugyanúgy működik. A megosztó gomb `/eso/<slug>/` linket ad, ha a hely 3 km-en belül egy listás település.
- **Útvonalak**: a `script.js` minden `fetch`-e és a service worker regisztrációja (`/sw.js`, scope `/`) gyökér-abszolút. A `sw.js` navigációt nem cache-el, ezért az `/eso/x/` oldalakat sosem a főoldali `index.html`-lel szolgálja ki.

### Vízállás- és Cigánd-oldalak (2. fázis)

- **Könnyű sablon**: ezek szöveges oldalak, nem az esőalkalmazás. A `doc_page()` a `render_page()` fejét (meta, canonical, JSON-LD, `style.css?v=N`) használja, a törzs saját: fejléc (főoldal-link, Vízállás, Cigánd), `<main class="doc-main">`, lábléc, GoatCounter. Nincs `script.js` (az esőalkalmazás); kivétel a `/cigand/`: a törzs tetején a térkép-animáció és a "mennyi fér bele" metszet, amit a `cigand-page.js` (kicsi betöltő) tölt, lásd lent. Stílus: `style.css` végén a `.doc-*`, `.vz-*`, `.spark-*`, `.cg-*` osztályok.
- **Adat**: `--fetch-water` (az Action ezt használja) a worker `/rivers-snapshot` és `/lakes-snapshot` végpontját kéri `Origin: https://holazeso.hu` fejléccel; `--water-dir DIR` teszthez (DIR/rivers.json, lakes.json). Ha nincs kapcsoló vagy a worker nem elérhető/hibás, a vízoldalak NEM íródnak újra, és a `sitemap.xml` megtartja a meglévő `/vizallas/` bejegyzéseket (üres oldal sosem készül). A `/cigand/` csak repóbeli fájlokból (`cigand.json`, `cigand-news.json`) épül, hálózat nélkül.
- **Oldalak**: `/vizallas/` (táblázat), `/vizallas/<slug>/`: `duna`, `tisza`, `raba`, `maros`, `harmas-koros`, `drava`, `balaton`, `velencei-to`, `ferto` (a `RIVER_PAGES` / `LAKE_PAGES` listák; a helyhatározós állomásnevek az `STATION_LOC` táblában, kézzel). `EXCLUDE`: a generátorban az ellenőrzésen elbukott állomások neve (most üres).
- **Mondat és változás**: "A Tisza vízállása Szegednél ma 266 cm, 154 cm-rel magasabb, mint egy hete." A változás a `history`-ból a ~7 nappal korábbi mintához képest, csak ha a history legrégebbi mintája legfeljebb 1 órával a cél (utolsó minta - 7 nap) után van; különben a tagmondat elmarad. A tavaknak nincs history-juk, ott csak a mai érték áll. A kijelzett dátum a pillanatkép `generated_at` napja (Budapest-idő), órát nem írunk ki, hogy a második futás ne változtasson semmit; a hydroinfo értékei amúgy is naponta változnak.
- **Sparkline**: statikus inline SVG (`.spark`, a vonal `--accent`, nincs JS), a history ~64 mintájából.
- **Adatellenőrzés (2026-11-24)**: a worker pillanatképeit a hydroinfo.hu táblázataival (`tables/ENG/tohid.html`, `tishid_a.html`, `dunhid_a.html`) vetettük össze, minden vizsgált állomás egyezett (Siófok 44, Balatonakali 38, Tihany rév 41, Agárd 16, Fertőrákos 2, Szeged 266, Szolnok 317, Budapest 98, Mohács 89, Szarvas 498, Makó 4, Győr 170, Tiszabecs -76, Őrtilos -120, Drávaszabolcs -33, Nagybajcs 36, Kisköre alsó 300). A Balaton alacsony értéke (44 cm) tehát valódi, nem gyűjtő-hiba. A history-t (heti változás) a hydroinfo nem archiválja nyilvánosan, ezt csak a gyűjtő saját mintái adják.
- **Workflow**: a `build-pages.yml` a `--fetch-water` kapcsolóval fut (napi cron 05:23 frissíti a vizet), és a `cigand.json` / `cigand-news.json` változására is indul. A `cigand-news.yml` kommit után `gh workflow run build-pages.yml`-t hív (`actions: write` jogosultság, `GH_TOKEN`), mert a `GITHUB_TOKEN`-nel végzett push nem indít másik workflow-t.
- **Főoldali linkek**: a vízpanel alján (`nav.water-links`, a "honnan vannak a számok?" nyitó előtt) két kis szöveges link: `/vizallas/` és `/cigand/`.

- **Cigánd-ábrák a `/cigand/` oldalon**: a törzs a szöveg felett a főoldali panel ábráit mutatja (térkép + 5 lépéses animáció, metszet), ugyanazokkal az id-kkal (`CIGAND_FIGURES` a `build_pages.py`-ban; a szöveg továbbra is statikus HTML, SEO). A `cigand-page.js?v=N` (az oldal `extra_scripts`-e) deklarálja az egyetlen hiányzó script.js-globálist (`borderRings = null`, ezért a sarok-áttekintő térkép elmarad), majd betölti a `water.js?v=N`-t és hívja a `buildCigandPage()`-et. A `water.js`-ben a rajz a `buildCigandFigures(data, geo)` függvénybe került, amit a `buildCigand` (főoldal, változatlan viselkedés) és a `buildCigandPage` is hív. Az ábrák csak a `cigand.json` és `cigand-geo.json` fájlokat kérik (azonos eredet): worker-pillanatkép nem kell, így CORS-gond sincs. Hiba esetén a `#cigand-figures` doboz elrejtődik. A `water.js?v=` most két helyen van: `script.js` `WATER_JS_URL` és `cigand-page.js`; mindkettőt együtt kell emelni. Az oldal hírblokkja "Legfrissebb hírek", az AI-összefoglalóról szóló megjegyzés csak akkor áll ott, ha van összefoglaló; AI nélküli hír is megjelenik (cím, forrás, dátum).

### Funkciók (3. fázis)

- **Mikor áll el / mikor ér ide**: a `fetchUserForecast` kérése kibővült `minutely_15=precipitation`-nel (nincs új hívás; a rácspontos kérések nem kapják). `minutelyOutlook()`: a `current.time` 15 percre lefelé kerekített szelete után az első szelet, ami átbillen a 0,1 mm küszöbön (a `minutely_15` az előző 15 perc összege), a hátralévő perc 15-re kerekítve: "Még kb. 45 percig eshet.", "Kb. 30 perc múlva ideérhet." Hiányzó (nem szám) érték vagy hiányzó szelet: semmi nem íródik ki (4 órán belül nincs változás esőnél: "A következő órákban is eshet.", szárazon semmi). A sor a fő válasz alatti első `.context` sor; ha van, kiváltja az órás "még kb. N óráig tart" és az órás "becslés szerint kb. N óra múlva" sort. Hómódban nincs 15 perces sor. A radar logikához nem nyúl: a hívás a már meglévő `fetchUserForecast`-ban van, a rács-körök, a `radarRevealTier` és a `RADAR_SWEEP_MS` változatlanok.
- **Hó és ónos eső**: a `current` mezői kibővültek (`precipitation,snowfall,weather_code`, a rácskérésekben is; az Open-Meteo pontszám-súlyát a változók száma nem módosítja). `precipKind()`: `weather_code` 56, 57, 66, 67 = "ice" ("Ónos eső esik"), `snowfall > 0` VAGY havas `weather_code` (71, 73, 75, 77, 85, 86) = "snow" ("Havazik"), egyébként "rain" (a régi szövegek). A havas kód azért kell, mert az Open-Meteo a `snowfall`-t 0,01 cm-re kerekíti: gyenge havazásnál 0 jöhet, miközben a `precipitation` már küszöb fölött van, és az ilyen találat esőként íródott ki. A találati pontok `kind` mezőt kapnak (`sortRaining`, `rainHits`), így a legközelebbi hely kártyáján is típus szerinti a szöveg; a "de hol esik pontosan?" kérdés is igazodik (`whereQuestion`: "de hol havazik pontosan?", "de hol esik ónos eső pontosan?"), a végleges találat típusa (`showNearestRain`) felülírja az első gyűrűét.
- **Hómód `/ho/`**: a generált oldal `window.HOLAZESO_MODE = "ho"`-t állít a `script.js` előtt; `SNOW_MODE` esetén az `isRainingNow` csak `snowfall > 0`-t fogad el (ennyi a különbség a keresésben, a radar és minden más ugyanaz), a szövegek: "Havazik-e X környékén?", "Nálad nem havazik.", "a legközelebbi havazás:". A főoldalon a footer elején a `#snow-link` (`hidden`) csak november 1. és március 31. között (kliensoldali dátum) jelenik meg.
- **Widget `/widget/`**: a `build_widget_page` egyetlen, önálló HTML-t ír (saját inline CSS/JS, NEM tölti a `script.js`-t és a `style.css`-t), `noindex`, nincs a sitemapben. `?hely=<slug>` (a `places-hu.json`-ból) vagy `?lat&lon&name`; egyetlen Open-Meteo `current` hívás: "Ónos eső" / "Havazik" / "Igen" (>= 0,1 mm/óra) / "Nem"; hibánál "?". `prefers-color-scheme` szerint világos/sötét, 320x120-ban elfér. A `_headers` `/widget/*` szabálya `Content-Security-Policy: frame-ancestors *`, így bárhol iframe-be tehető (a többi oldalon nincs framing-tiltás). A településoldalakon a `<details class="embed-box">` "Tedd ki az oldaladra" adja a másolható iframe-kódot.

## UX-átalakítás (2026. nov.): új statikus fájlok és komponensek

- `places-hu.json`: kb. 140 magyar település (n, lat, lon, r = rang 1-3). A radar, a talajtérkép és a csatorna-térkép feliratai és a talajcellák nevei használják (`loadPlaces`).
- `counties-hu.json`: megyehatárok (geoBoundaries, CC BY 4.0, egyszerűsítve), a nagyított csatorna-térképen pontvonal.
- `cigand.json` (kézzel karbantartott: tények, időrend, források, `active`, `updated`) és `cigand-geo.json` (OpenStreetMap-kivonat, egyszer előállítva): a vízpanel tetején álló Cigánd-blokk (`buildCigand`). `active: false` esetén egy soros összefoglalóvá zsugorodik és az országos szakaszok alá költözik. A negyedik, mért csempe csak akkor jelenik meg, ha a rivers-snapshotban van "Dombrád" állomás.
  A Cigánd-térkép zsilipje a tározó DK-i csücskében áll (OSM way 851514123, a Tiszán Cigánd felett); a geo-fájl `sluice`, `inlet` (Tisza-pont) és `vapa` (a beáramlás vonala a tározón belül, a Tiszakarádi-főcsatornáig) mezői adják az animációt; a 4. lépés vonalkázása e sáv mentén nő. Az útvonalat a vízügy közlése erősíti meg (pecaverzum.hu, 2026-11-22). A `cigand.json` `faq` tömbje (q, a, kind, opcionális source) az "amit érdemes tudni" listát adja; a `kind: "nem közölt"` szaggatott körvonalú címkét kap. A "mennyi fér bele" metszet (`buildCigandSection`) séma: a magasság túlozott, a "most" víz számolt, nem mért.
- Helyi talajszelvény (`renderSoilCoreProfile`, `#water-soil-core`): tájkép-metszet, felül a keresett hely ismert épületének sziluettje (`SOIL_LANDMARKS`: Budapest, Szeged, Debrecen, Pécs, Győr, Esztergom, Eger, Kecskemét, Sopron; név vagy 8 km-en belüli koordináta alapján), egyébként általános falusi kép; alatta a rétegek mélység-arányosan, liter/m² felirattal. A tengerszint feletti magasság az Open-Meteo talajválasz `elevation` mezőjéből jön (nincs külön hívás). Talajvizet nem rajzol (nincs adat).
- Akcentusszín: a `style.css` `--accent` változója az EGYETLEN hely, ahol a kék hangolható; kitöltött sávok, víz, vonalkázás és jelölők használják, a szöveg, a vékony keretek és a határok `--fg` maradnak.
- Ábraszélességek: `.fig-narrow/.fig-medium/.fig-wide` (420/720/960 px) és a `--ar` képarány a magasságot a nézet 70%-ára korlátozza.
- Közös buborék: `mapPopupShow` / `popupSparklineSvg` (talajtérkép, folyóhálózat, csatorna-térkép, Cigánd-térkép).
- A radar nagyítása (`radarZoomTo`) csak a keresés VÉGE után a megjelenített sugarat (`radarMaxRadiusKm`) változtatja; a `RADAR_SWEEP_MS`-t és a pásztázó animációt nem érinti. A feliratok méretét a `--k` (képpont/viewBox-egység) tartja állandóan.
- A csatorna-térkép egy kattintásra aktiválódik (`is-active`), utána a sima görgő nagyít; Escape vagy kívülre kattintás elengedi.
- A 0 literes (adat nélküli) talajcellák nincs-adatnak számítanak a talajtérképen és a fejsorban.
- A Tisza-tó nincs a tó-kártyák között (nincs valódi tó-mérce); a Velencei-tó körvonala kézzel rajzolt séma.

## Cigánd-hírfigyelő

- A `.github/scripts/cigand_news.py` (csak Python-standard könyvtár) nyolc magyar hírportál RSS-csatornáját olvassa (telex.hu, HVG, Index, 444, Magyar Nemzet, Portfolio, Agrárszektor, BOON; a lista a script tetején van). Az a hír találat, amelynek címében vagy (HTML nélküli) leírásában szerepel a "cigánd" (a "cigándi" is). Egy hibás csatorna csak naplózódik, nem állítja meg a futást.
- Hírenként csak cím, link, forrásnév, megjelenés ideje és első észlelés kerül a `cigand-news.json`-ba. Cikkszöveget sosem tárolunk (szerzői jog).
- A hírlista 2026-11-25-én kézzel feltöltve (backfill) a `cigand.json` forrásai közül hat 2026-os cikkel (cím és dátum az oldalak og:title / datePublished mezőjéből), mert a nov. 21-23-i cikkek a watcher indulása előtt kikerültek az RSS-ből; `ai` mező nélkül, így a következő Action-futás DeepSeekkel dolgozza fel őket (futásonként max. 10).
- A csatornák csak az utolsó ~20-60 elemet tartják, ezért a script minden futásnál összefésüli az új találatokat a meglévő fájllal: dedupe a normalizált link (query és záró perjel nélkül) és az azonos (kisbetűs) cím szerint, legújabb elöl, legfeljebb 30 elem.
- A `.github/workflows/cigand-news.yml` óránként (`17 * * * *`) és kézzel is futtatható. A fájlt csak akkor írja újra, ha a hírlista változott, és csak akkor kommitol (`github-actions[bot]`), így nincs óránkénti zajos commit. Emiatt az `updated` mező az utolsó VÁLTOZÁS ideje, nem az utolsó ellenőrzésé. Egy kommit Cloudflare Pages deployt indít.
- A böngésző `cigand-news.json?h=ÉÉÉÉHHNNÓÓ` címet kér (óránként új kulcs, a custom-domain gyorsítótár miatt); a `sw.js` ezt a fájlt nem gyorsítótárazza. Hiba vagy 0 hír esetén a "Friss hírek" rész nem jelenik meg.
- Miért nem Google News RSS: a felhasználási feltételei tiltják a weboldalon való megjelenítését.

### AI-lépés a hírfigyelőben

- A még fel nem dolgozott hírekre fut (az újakra; sikertelen próbálkozás után újra, hírenként legfeljebb 3 kísérlet az `ai_attempts` számlálóval; a feldolgozott, `ai: true` elemeket sosem dolgozza újra), futásonként legfeljebb 10 hívás. Szolgáltató: DeepSeek (`deepseek-chat`), sima `urllib` POST az OpenAI-kompatibilis `https://api.deepseek.com/chat/completions` címre, JSON módban (`response_format: json_object`, `temperature: 0`); SDK és pip nincs. A rendszerüzenet tartalmazza a várt JSON alakot példával (a JSON mód ezt megköveteli). A script letölti a cikket (ha nem sikerül, a cím és az RSS-leírás marad), nyers szöveggé alakítja (max. ~12 ezer karakter), majd egy hívásban kér `relevant`, `summary` (magyar, max. 2 mondat) és `facts` mezőket. Hibás JSON vagy hiányzó mező esetén az elem feldolgozatlan marad.
- A modellnek nem hiszünk: a `facts` csak akkor marad meg, ha az `evidence` szó szerint (szóköz- és kisbetű-normalizálva) szerepel a letöltött szövegben; a `stored_volume_m3` csak akkor, ha a szám az evidence-ben is megtalálható (felismeri: "2 millió", "2,5 millió", "2 000 000", "kétmillió", "2 millió 300 ezer") és 0 és 94 millió m³ között van; a `gate_status` csak akkor, ha az evidence tartalmazza a nyit/zár tövet. A nem releváns hírek `relevant: false` jelzéssel megmaradnak, a frontend elrejti őket. Cikkszöveg nem kerül tárolásra.
- A `latest_status` a legújabb, ellenőrzött tényt tartalmazó releváns hírből készül, és csak újabb tény érkezésekor cserélődik. A frontend ezt egy sorban mutatja a Cigánd-blokk tetején ("Legfrissebb hír szerint: ..."), ha újabb a kézzel vezetett `cigand.json` adatánál; azt nem írja felül, a tározó-ábrát nem érinti.
- Hiányzó `DEEPSEEK_API_KEY` vagy API-hiba esetén a script AI-mezők nélkül, a korábbi módon működik (figyelmeztetés stderr-re, kilépési kód 0). Beállítás: GitHub repo, Settings, Secrets and variables, Actions, New repository secret, név: `DEEPSEEK_API_KEY`.
- Teszt API nélkül: `CIGAND_NEWS_FAKE_AI=1` előre gyártott választ ad (a "HALLUCINATE" szöveget tartalmazó cikknél a szám nem egyezik az evidence-szel, ezért el kell dobódnia).
