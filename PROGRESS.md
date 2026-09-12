# PROGRESS.md

Ez a fájl a munka aktuális állapotát rögzíti, hogy egy új session (vagy egy
`/compact` utáni folytatás) pontosan onnan tudjon továbbmenni, ahol
abbamaradt. A `CLAUDE.md` az általános szabályokat és parancsokat írja le, az
`ARCHITECTURE.md` a rendszer működését - ez a fájl a **jelenlegi állapotot és
a nyitott szálakat**.

Utolsó frissítés: 2026-09-12.

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
