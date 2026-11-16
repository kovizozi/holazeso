# PROGRESS.md

Ez a fájl a munka aktuális állapotát rögzíti, hogy egy új session (vagy egy
`/compact` utáni folytatás) pontosan onnan tudjon továbbmenni, ahol
abbamaradt. A `CLAUDE.md` az általános szabályokat és parancsokat írja le, az
`ARCHITECTURE.md` a rendszer működését - ez a fájl a **jelenlegi állapotot és
a nyitott szálakat**.

Utolsó frissítés: 2026-11-16 (ld. lent az "UX/UI audit" szakaszt - a 09-12-es
KV-migrációs szakasz AZÓTA eltelt, ellenőrizetlen történet, nem törölve).

## UX/UI audit (2026-11-16): mi valósult meg, mi maradt nyitva

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

- **Kereshető, teljes vízfolyás-felfedező a csatorna-térképhez.** Az A01
  billentyűzet-hozzáférési hibát a folyó-állomás lista (`#water-river-list`)
  és a "leghosszabb nevesített vízfolyások" statikus lista (ami már eddig is
  tiszta szöveg, tehát eleve elérhető) javítja - de a térkép MAGA (5000+
  feature) továbbra sem böngészhető/kereshető billentyűzettel vagy
  képernyőolvasóval, csak egérrel/érintéssel (hover/tap tooltip). Ehhez egy
  önálló, szűrhető/kereshető lista kellene, ami ugyanazt a nevet/hosszt/
  helyet adja vissza, mint a térkép - ez már architektúra-szintű munka
  (`buildChannelsMap`, `script.js`), nem egy kis javítás.
- **Mentett helyek, településspecifikus URL-ek, megosztható állomás-
  nézetek.** Az audit saját indoklása szerint is "feltételezett" igény
  (a visszatérő felhasználó mintájából következtetve), nem megfigyelt hiba -
  ezért nem önmagában ebből a menetből, külön megbeszélést igényel, mielőtt
  belevágnánk (állapotkezelés, URL-struktúra, esetleg hátteret igénylő
  megosztás).
- **Rövid oktató réteg a vízrajzi adatokhoz** (mi a különbség mérce/vízhozam/
  vízkészlet közt stb.) - az audit ezt is a "Later" körbe sorolta.
- **Teljesítmény-validáció valódi közepes kategóriás mobilon.** A T01
  javítás (lusta betöltés) megtörtént, de a cél-számok (LCP ≤2,5s,
  INP ≤200ms, CLS ≤0,1) **nincsenek lemérve** - ehhez valódi eszköz/profilozó
  kellene, nem csak a jelenlegi Playwright-alapú funkcionális teszt.
- **D01 teljes köre**: egyetlen "adatok frissítve: [idő]" sor került a
  vízadat-panel tetejére (a snapshot MÁR meglévő `generated_at` mezőjéből) -
  az audit viszont minden EGYES érték mellé forrás+idő+típus címkét kért
  volna (pl. "Becsült talajnedvesség · adat ideje: ..."). Ez egy jóval
  nagyobb, minden vízrajzi kártyát érintő tartalmi átalakítás lenne, nem
  illesztettük bele ebbe a menetbe.
- **D04 teljes köre**: a kétnyelvű OSM-névváltozatok (pl. "Duna" vs.
  "Dunaj / Duna") csak egy figyelmeztető mondatot kaptak a listában - az
  audit saját maga is óva intett az automatikus összevonástól, amíg a
  feature-azonosság nincs validálva (pl. hogy ugyanaz-e a folyó két oldalról
  nézve, vagy tényleg külön szakasz). Ehhez a `app/channels.py`
  (soil-moisture-mapper) adatpipeline-jában kellene egy azonosítási lépés.
- **Hivatalos WCAG megfelelőségi audit.** A jelentés maga is "élő interakciós
  audit, nem WCAG-tanúsítvány" - amit javítottunk, azt konkrét megfigyelt
  hibákra reagálva tettük, nem egy teljes checklist alapján.

**Emellett külön, nem az auditból, de a felhasználó által korábban
TÖBBSZÖR kért, még el sem kezdett funkció: domborzati/magassági réteg
(hillshading) a csatorna-térképhez.** Ehhez új adatforrás (pl. SRTM/
Copernicus DEM kivonat) és egy önálló tervezési kör kellene (adatméret,
megjelenítési mód), mielőtt belevágnánk - lásd a chat-előzményt, ha egy
új session ezt venné fel legközelebb.

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
