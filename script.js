// ---- Keresési rács ----
// Nincs fix településlista: a felhasználó koordinátája köré generálunk egy
// gyűrűkből álló ponthálót, és abban keressük a legközelebbi esőt. Ez minden
// országban egyformán pontos, nem csak Magyarországon vagy egy előre
// kiválasztott városlistán.
//
// Ha az első adagban (150 km-ig) nem találunk esőt, egyre távolabbi
// gyűrűket próbálunk, amíg nem találunk, vagy amíg el nem fogynak.
//
// Az adagok szűken indulnak és onnan tágulnak: az első csak 150 km-ig néz,
// a következők 150 km-enként lépnek kijjebb (300, 450), és csak utána
// gyorsul a lépés (900, 2500), hogy távoli eső esetén ne kelljen tucatnyi
// kört végigvárni.
// Így a radar induló képe a közvetlen környéket mutatja olvashatóan, nem
// egy 600 km-es, összezsúfolt áttekintést.
//
// Minden adag CSAK az új gyűrűt méri fel: a belső területet az előző adagok
// már lefedték, a radaron pedig azok zoomolnak összébb az új adag alá.
//
// Egy gyűrűn NEM fix számú irányt kérdezünk le, hanem annyit, amennyi a
// gyűrű kerületéhez illik. Korábban mindegyiken 12 irány volt, amitől a
// szomszédos pontok távolsága kifelé haladva elszállt: 30 km-en 16 km-re
// voltak egymástól, 9000 km-en viszont már 4712 km-re - vagyis kint egész
// esőrendszerek elfértek volna két pont között, miközben bent feleslegesen
// sűrű volt a háló. Ezért az irányok száma a sugárral együtt nő, így a
// pontok távolsága végig nagyságrendileg egyenletes marad (30 km-en 31 km,
// 450 km-en 88 km, 9000 km-en 1346 km).
//
// Minden adag egyetlen Open-Meteo hívás: [sugár km, irányok száma].
//
// A pontszámot az Open-Meteo kvótája korlátozza, és ez szigorúbb, mint
// elsőre látszik. A hivatalos súlyozás (ForecastApiResult.calculateQueryWeight)
// szerint MINDEN lekérdezett pont külön egységet ér, és 10 változó / 14 nap
// alatt a változók száma és a napok száma semmit nem módosít rajta. Vagyis
// hiába kérünk a rácspontokról csak "current=precipitation"-t: a súly
// ugyanannyi, mint a teljes órás előrejelzésnél. A limit IP-nként 600/perc,
// 5000/óra és 10000/nap.
//
// Ezért a legtávolabbi, 9000 km-es adagot kivettük (2500 km-en belül
// gyakorlatilag mindig van eső, és egy szándékosan ritka, félrevezető
// távoli háló rosszabb, mint ha nem is nézzük), a középső adagokat pedig
// ritkítottuk. A legrosszabb eset így 294 pont: két teljes keresés is
// belefér egy percbe, ami korábban 429-et adott volna.
const SEARCH_RINGS = [
  [[30, 6], [60, 10], [100, 14], [150, 18]],
  [[200, 16], [250, 18], [300, 20]],
  [[350, 20], [400, 22], [450, 24]],
  [[550, 20], [700, 22], [900, 24]],
  [[1200, 18], [1700, 20], [2500, 22]],
];

function ringBearings(count) {
  return Array.from({ length: count }, (_, i) => (i * 360) / count);
}

const RAIN_THRESHOLD_MM = 0.1; // ennél kevesebb csapadékot zajnak tekintünk

// Csapadék-erősség sávok (mm/óra), melléknévi és határozói alakkal együtt,
// hogy ne kelljen a végződést programból levezetni.
const INTENSITY_BANDS = [
  { max: 1, adj: "gyenge", adv: "gyengén" },
  { max: 4, adj: "közepes", adv: "közepesen" },
  { max: Infinity, adj: "erős", adv: "erősen" },
];

function intensityBand(mm) {
  return INTENSITY_BANDS.find(b => mm <= b.max);
}

function formatMm(mm) {
  return mm.toFixed(1).replace(".", ",");
}

// ---- Segédfüggvények ----

// Adott koordinátától egy irányszög (fok) és távolság (km) alapján kiszámolja
// a célpont koordinátáit (gömbi navigációs képlet).
function destinationPoint(lat, lon, bearingDeg, distKm) {
  const R = 6371;
  const bearing = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const dOverR = distKm / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dOverR) +
    Math.cos(lat1) * Math.sin(dOverR) * Math.cos(bearing)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(dOverR) * Math.cos(lat1),
    Math.cos(dOverR) - Math.sin(lat1) * Math.sin(lat2)
  );

  // A hosszúsági fokot vissza kell forgatni a [-180, 180] tartományba: a
  // legtávolabbi gyűrűk átlógnak a dátumvonalon (Magyarországtól 9000 km-re
  // keletre 199 fok jött ki), amit az Open-Meteo 400-as hibával utasít el.
  const lon2Deg = (((lon2 * 180 / Math.PI) % 360) + 540) % 360 - 180;
  return { lat: lat2 * 180 / Math.PI, lon: lon2Deg };
}

// Két koordináta közti valódi távolság kilométerben (haversine-képlet). A
// keresési rács pontjainak van saját "distance" mezőjük (mert a
// destinationPoint generálta őket), de a findNearbyName által talált,
// eltolt névadó pontnak nincs - ezt onnan számoljuk vissza.
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Két koordináta közti kezdő irányszög fokban (0 = észak, óramutató szerint).
function bearingBetween(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const COMPASS_POINTS = ["É", "ÉK", "K", "DK", "D", "DNy", "Ny", "ÉNy"];

function compassLabel(bearingDeg) {
  const idx = Math.round(bearingDeg / 45) % 8;
  return COMPASS_POINTS[idx];
}

// A felhasználó koordinátája köré generált keresési pontok egy adott
// gyűrűlistára, gyűrűnként növekvő távolsággal.
function generateSearchGrid(userLoc, rings) {
  const points = [];
  for (const [distance, bearingCount] of rings) {
    for (const bearing of ringBearings(bearingCount)) {
      const p = destinationPoint(userLoc.lat, userLoc.lon, bearing, distance);
      points.push({ lat: p.lat, lon: p.lon, distance, bearing });
    }
  }
  return points;
}

function saveLocation(loc) {
  try {
    localStorage.setItem("holazeso_location", JSON.stringify(loc));
  } catch (err) {
    console.error(err);
  }
}

function loadSavedLocation() {
  try {
    const raw = localStorage.getItem("holazeso_location");
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

// Település keresése az Open-Meteo Geocoding API-val (kézi keresés fallbackhez).
// Bármely ország találata elfogadott, nincs országra szűrés.
async function geocode(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=hu&format=json`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;
  const r = data.results[0];
  return { name: r.name, lat: r.latitude, lon: r.longitude, countryCode: r.country_code, countryName: r.country };
}

// Koordinátából településnév és ország az OpenStreetMap-alapú, kulcs nélküli
// BigDataCloud reverse geocoding API-val. Ha nem sikerül, üres mezőkkel térünk
// vissza, és általános szöveggel folytatjuk. A koordináta enélkül is elég a
// válaszhoz.
async function reverseGeocode(lat, lon) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=hu`;
  const res = await fetch(url);
  const data = await res.json();
  // Csak a "city" mezőt használjuk névnek: gyéren lakott pontokon a
  // "locality" mező BigDataCloud saját fallback-je miatt egy közigazgatási
  // egység nevére ugorhat (pl. "Anglia" az Egyesült Királyságban egy
  // konkrét helynév helyett), ami félrevezető lenne.
  return {
    name: data.city || null,
    countryCode: data.countryCode || null,
    countryName: data.countryName || null,
  };
}

// A böngésző helymeghatározását Promise-ba csomagolja.
function detectLocation() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("A böngésző nem támogatja a helymeghatározást."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { timeout: 10000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

// Lekéri a csapadék-előrejelzést tetszőleges pontlistára, egyetlen hívásban.
// A válasz ugyanabban a sorrendben jön vissza, ahogy küldtük a koordinátákat.
// A koordinátákat 4 tizedesre kerekítve küldjük. Ez kb. 11 méteres pontosság,
// nagyságrendekkel több, mint amit egy ~11 km-es rácsú időjárási modell
// használni tud, viszont felére rövidíti a lekérdezés URL-jét: a nyers
// float-okkal a legtávolabbi adag URL-je 8811 karakter lett, amit a szerver
// "414 Request-URI Too Large" hibával visszautasított.
const coord = value => value.toFixed(4);

const API_BASE = "https://api.open-meteo.com/v1/forecast";

async function openMeteo(url) {
  const res = await fetch(url);
  const data = await res.json();
  // Hibánál (pl. 429: percenkénti limit túllépve) az API nem előrejelzést,
  // hanem egy {reason, error} objektumot ad vissza. Ezt itt kell elkapni,
  // különben a hívó egy értelmezhetetlen alakon hasal el.
  if (!res.ok || data.error) {
    throw new Error(`Open-Meteo ${res.status}: ${data.reason || "ismeretlen hiba"}`);
  }
  return data;
}

// A rácspontokról CSAK azt kell tudnunk, esik-e ott MOST (isRainingNow). Az
// órás előrejelzés (mikor áll el, mekkora eséllyel) egyedül a felhasználó
// saját helyére kell, lásd fetchUserForecast. Korábban mind a 120+ rácspontra
// lekértük a két napnyi órás adatot is, amitől a kérés súlya az Open-Meteo
// percenkénti limitjét is átlépte (429).
async function fetchPrecipitation(points) {
  const lats = points.map(p => coord(p.lat)).join(",");
  const lons = points.map(p => coord(p.lon)).join(",");
  return openMeteo(`${API_BASE}?latitude=${lats}&longitude=${lons}&current=precipitation`);
}

// forecast_days=2, hogy a "hamarosan" (következő 3 óra) ablak éjfél körül is
// átnyúlhasson a következő napra, ne csak az aktuális nap 23:00-jánál vágja le.
async function fetchUserForecast(point) {
  return openMeteo(
    `${API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}` +
    `&current=precipitation&hourly=precipitation,precipitation_probability` +
    `&forecast_days=2&timezone=auto`
  );
}

// Az esős pontokat adja vissza egy pont- és előrejelzés-listából, távolság
// szerint növekvő sorrendben.
function sortRaining(points, forecasts) {
  return points
    .map((point, i) => ({ point, forecast: forecasts[i] }))
    .filter(({ forecast }) => isRainingNow(forecast))
    .map(({ point }) => point)
    .sort((a, b) => a.distance - b.distance);
}

// Ha egy pontnak (pl. mert tenger felett van) nincs neve, ezekben az egyre
// táguló sugarakban keresünk a közvetlen közelében megnevezhető helyet.
// Nem kell, hogy a talált hely maga is esős legyen - csak arra kell, hogy
// tudjuk emberi néven megjeleníteni, hol esik a ponthoz közel.
const LOCAL_NAME_RINGS_KM = [20, 60, 150];

// Megkeresi egy pont legközelebbi megnevezhető helyét. Előbb magát a pontot
// próbálja, majd ha nincs neve, körülötte egyre táguló, párhuzamosan
// lekérdezett gyűrűkben keres. A talált hely SAJÁT koordinátáját is
// visszaadja (lat/lon), mert az eltolódhat az eredeti ponttól akár 150 km-t
// is - a hívó félnek emiatt a talált helyhez, nem az eredeti ponthoz kell
// számolnia a távolságot/irányt, különben a kiírt adatok nem a mutatott
// névhez tartoznának. Ha semmit nem talál, üres nevű objektumot ad vissza
// az eredeti pont koordinátáival, amit a hívó fél az általános "egy közeli
// térségben" szöveggel helyettesít.
async function findNearbyName(point) {
  try {
    const place = await reverseGeocode(point.lat, point.lon);
    if (place.name) return { ...place, lat: point.lat, lon: point.lon };
  } catch (err) {
    console.error(err);
  }

  for (const radius of LOCAL_NAME_RINGS_KM) {
    const offsets = ringBearings(12).map(bearing => destinationPoint(point.lat, point.lon, bearing, radius));
    const results = await Promise.all(
      offsets.map(p =>
        reverseGeocode(p.lat, p.lon)
          .then(place => ({ ...place, lat: p.lat, lon: p.lon }))
          .catch(err => {
            console.error(err);
            return { name: null, countryCode: null, countryName: null, lat: p.lat, lon: p.lon };
          })
      )
    );
    const named = results.find(r => r.name);
    if (named) return named;
  }

  return { name: null, countryCode: null, countryName: null, lat: point.lat, lon: point.lon };
}

function isRainingNow(forecast) {
  return forecast.current.precipitation >= RAIN_THRESHOLD_MM;
}

// A "current.time" perc-pontosságú (pl. "...T18:45"), az "hourly.time" viszont
// csak egész órás bontású ("...T18:00"), ezért kerekítsük le óra-pontosságra egyezéshez.
function currentHourIndex(forecast) {
  const currentHour = forecast.current.time.slice(0, 13) + ":00";
  return forecast.hourly.time.indexOf(currentHour);
}

// Megkeresi a következő 3 órán belül az első órát, amikor esni fog, és
// visszaadja annak indexét az hourly tömbökben (vagy -1-et, ha egyikben sem esik).
function soonRainIndex(forecast) {
  const idx = currentHourIndex(forecast);
  if (idx === -1) return -1;
  for (let i = idx; i < Math.min(idx + 3, forecast.hourly.precipitation.length); i++) {
    if (forecast.hourly.precipitation[i] >= RAIN_THRESHOLD_MM) return i;
  }
  return -1;
}

function isRainingSoon(forecast) {
  return soonRainIndex(forecast) !== -1;
}

// Hány óra múlva áll el a jelenleg tartó eső (az hourly előrejelzés alapján
// megkeresi az első száraz órát). Null, ha nem talál száraz órát az
// előrejelzésben (2 napra nézünk előre).
function rainDurationHours(forecast) {
  const idx = currentHourIndex(forecast);
  if (idx === -1) return null;
  for (let i = idx; i < forecast.hourly.precipitation.length; i++) {
    if (forecast.hourly.precipitation[i] < RAIN_THRESHOLD_MM) {
      return i - idx;
    }
  }
  return null;
}

// ---- Radar vizualizáció ----
// A keresés közben ezt mutatjuk a "töltés…" szöveg helyett.
//
// Fontos, mit jelent itt az "adatvezérelt": egy kör összes pontja EGYETLEN
// Open-Meteo hívásban, egyszerre érkezik meg, és pont SOSEM villanhat fel
// előbb, mint ahogy az a válasz megjött. A megjelenítés viszont úgy működik,
// mint egy igazi radarernyőn: a pásztázó vonal festi fel a pontokat, ahogy
// elhalad az irányuk fölött (radarRevealTier). Ez tehát nem kitalált
// lekérdezési ütem, hanem a már meglévő adat festési módja. A sugár (a
// következő, távolabbi körre váltás) is csak akkor nő, ha az előző kör
// válasza megérkezett ÉS abban nem volt találat - nem egy fix idő után.
const RADAR_VIEWBOX = 350;
const RADAR_CENTER = RADAR_VIEWBOX / 2;
const RADAR_MAX_PX = 160;

let radarTierGroups = []; // { el, maxRadiusKm }

function radarPolarPoint(bearingDeg, distKm, maxRadiusKm) {
  const r = Math.min(distKm / maxRadiusKm, 1) * RADAR_MAX_PX;
  const theta = bearingDeg * Math.PI / 180;
  return {
    x: RADAR_CENTER + r * Math.sin(theta),
    y: RADAR_CENTER - r * Math.cos(theta),
  };
}

function radarReset() {
  document.getElementById("radar-tiers").innerHTML = "";
  radarTierGroups = [];
  clearRadarPlace();
}

// ---- Esős pont megkoppintása ----
// Az esős pontok kattinthatók: megmutatjuk, melyik település fölött vannak.
// Az országot csak akkor írjuk ki, ha eltér a felhasználó országától, hogy
// belföldi találatnál ne legyen felesleges zaj.
const radarPlaceCache = new Map();
let radarPlaceToken = 0;

function clearRadarPlace() {
  document.getElementById("radar-labels").innerHTML = "";
}

// A feliratot a pötty mellé írjuk. A pötty saját koordinátája a köre (tier)
// helyi rendszerében van, a régebbi körök viszont össze vannak zoomolva,
// ezért a tárolt nagyítással számoljuk vissza a tényleges helyet.
function radarLabelPosition(dot) {
  const tier = radarTierGroups.find(t => t.el === dot.parentNode);
  const scale = tier ? tier.scale : 1;
  return {
    x: RADAR_CENTER + (Number(dot.getAttribute("cx")) - RADAR_CENTER) * scale,
    y: RADAR_CENTER + (Number(dot.getAttribute("cy")) - RADAR_CENTER) * scale,
  };
}

function setRadarLabel(dot, text) {
  const labels = document.getElementById("radar-labels");
  labels.innerHTML = "";
  const { x, y } = radarLabelPosition(dot);
  // A radar jobb felén befelé, balra írjuk a nevet, különben kilógna a képből.
  const onRight = x > RADAR_CENTER;
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.classList.add("radar-label");
  label.setAttribute("x", onRight ? x - 12 : x + 12);
  label.setAttribute("y", y + 7);
  label.setAttribute("text-anchor", onRight ? "end" : "start");
  label.textContent = text;
  labels.appendChild(label);
}

async function showRadarPlace(dot) {
  const key = `${dot.dataset.lat},${dot.dataset.lon}`;

  if (radarPlaceCache.has(key)) {
    setRadarLabel(dot, radarPlaceCache.get(key));
    return;
  }

  // Ha közben másik pontra koppintanak, csak a legutolsó válasza kerüljön ki.
  const token = ++radarPlaceToken;
  setRadarLabel(dot, "…");
  let label;
  try {
    const place = await findNearbyName({
      lat: Number(dot.dataset.lat),
      lon: Number(dot.dataset.lon),
    });
    const isForeign = place.countryCode && currentLoc && currentLoc.countryCode &&
      place.countryCode !== currentLoc.countryCode;
    label = place.name
      ? (isForeign ? `${place.name}, ${place.countryName}` : place.name)
      : "névtelen térség";
    radarPlaceCache.set(key, label);
  } catch (err) {
    console.error(err);
    label = "a helynév most nem érhető el";
  }
  if (token === radarPlaceToken) setRadarLabel(dot, label);
}

document.getElementById("radar-tiers").addEventListener("click", (event) => {
  const dot = event.target.closest(".radar-dot.rain");
  if (dot) showRadarPlace(dot);
});

// A pásztázó vonal egy körbefordulásának ideje. Tartsd szinkronban a
// style.css #radar-sweep animációjának időtartamával: a pontok felfedése
// ehhez az értékhez igazítva számolja ki, mikor ér a vonal az adott
// irányhoz (lásd radarRevealTier).
const RADAR_SWEEP_MS = 1500;
let sweepStartedAt = 0;

function radarRestartSweep() {
  const sweep = document.getElementById("radar-sweep");
  sweep.style.animation = "none";
  sweep.getBoundingClientRect(); // kényszerített újraszámolás, hogy tényleg újrainduljon
  sweep.style.animation = "";
  sweepStartedAt = Date.now();
}

// Hol tart most a pásztázó vonal, fokban (0 = észak, óramutató szerint).
//
// A böngésző a háttérbe került lapon megállítja a CSS-animációt, a Date.now()
// viszont fut tovább. Ha csak órával számolnánk, visszatéréskor a felfestés
// elcsúszna a vonal valódi állásától, és a pontok rossz irányban villannának
// fel. A Web Animations API a tényleges animációs időt adja vissza, ami a
// megállást is figyelembe veszi; ha nem elérhető, marad az óra.
function sweepAngleNow() {
  const sweep = document.getElementById("radar-sweep");
  const animation = sweep.getAnimations ? sweep.getAnimations()[0] : null;
  const elapsed = animation && typeof animation.currentTime === "number"
    ? animation.currentTime
    : Date.now() - sweepStartedAt;
  return ((elapsed % RADAR_SWEEP_MS) / RADAR_SWEEP_MS) * 360;
}


// Új kört ad a radarhoz, a saját legnagyobb sugarához igazított skálán. A
// korábban hozzáadott köröket arányosan összébb zoomolja (CSS transition),
// hogy az új, nagyobb kör is beleférjen ugyanabba a fizikai méretbe.
function radarAddTier(points, maxRadiusKm) {
  // A radar átskálázódik, tehát a korábbi felirat rossz helyre mutatna.
  clearRadarPlace();
  radarTierGroups.forEach(tier => {
    tier.scale = tier.maxRadiusKm / maxRadiusKm;
    tier.el.style.transform = `scale(${tier.scale})`;
  });

  const svgNS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(svgNS, "g");
  g.classList.add("radar-tier-group");

  points.forEach((point, i) => {
    const { x, y } = radarPolarPoint(point.bearing, point.distance, maxRadiusKm);
    const dot = document.createElementNS(svgNS, "circle");
    dot.classList.add("radar-dot");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y);
    dot.setAttribute("r", 2.5);
    dot.dataset.index = i;
    dot.dataset.bearing = point.bearing;
    dot.dataset.lat = point.lat;
    dot.dataset.lon = point.lon;
    g.appendChild(dot);
  });

  document.getElementById("radar-tiers").appendChild(g);
  radarTierGroups.push({ el: g, maxRadiusKm, scale: 1 });
}

function revealDot(dot, isRain) {
  dot.classList.add("revealed");
  if (!isRain) return;
  dot.classList.add("rain");
  dot.setAttribute("r", 5);
  const pulse = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  pulse.setAttribute("cx", dot.getAttribute("cx"));
  pulse.setAttribute("cy", dot.getAttribute("cy"));
  pulse.setAttribute("r", 5);
  pulse.classList.add("radar-pulse", "pulsing");
  dot.parentNode.appendChild(pulse);
}

// Egy kör adata EGYBEN érkezik meg (egyetlen Open-Meteo hívás), a
// megjelenítés viszont úgy működik, mint egy igazi radarernyőn: a pásztázó
// vonal "festi fel" a pontokat, ahogy elhalad fölöttük. Minden pont akkor
// villan fel, amikor a vonal épp az ő irányához ér.
//
// Ettől a megjelenítés adatvezérelt marad: felvillanni csak olyan pont tud,
// aminek a válasza már megérkezett. A pásztázás a festés módja, nem a
// lekérdezés üteme - nem tesz úgy, mintha pontonként kérdeznénk le.
//
// A visszaadott promise akkor teljesül, amikor a vonal a kör összes pontját
// végigfestette, tehát a hívó megvárhatja, mielőtt a következő körre lép.
function radarRevealTier(rainingIndices, { instant = false } = {}) {
  const tier = radarTierGroups[radarTierGroups.length - 1];
  if (!tier) return Promise.resolve();
  const rainSet = new Set(rainingIndices);
  const dots = tier.el.querySelectorAll(".radar-dot");
  const isRain = dot => rainSet.has(Number(dot.dataset.index));

  if (instant) {
    dots.forEach(dot => revealDot(dot, isRain(dot)));
    return Promise.resolve();
  }

  const sweepAngle = sweepAngleNow();
  dots.forEach(dot => {
    const degreesAhead = (Number(dot.dataset.bearing) - sweepAngle + 360) % 360;
    setTimeout(() => revealDot(dot, isRain(dot)), (degreesAhead / 360) * RADAR_SWEEP_MS);
  });
  return new Promise(resolve => setTimeout(resolve, RADAR_SWEEP_MS));
}

// ---- Fő logika ----

// Ha két run() futna egyszerre (pl. a percenkénti automatikus frissítés
// pont akkor indulna, amikor egy korábbi keresés még nem ért véget), a
// kettő versenyhelyzetbe kerülne: az első befejeződő "finally"-ja elrejtené
// a radart a másik alól. Ezért csak egy run() futhat egyszerre - a többi
// hívás egyszerűen kimarad, amíg az aktuális be nem fejeződik.
let runInProgress = false;
let runToken = 0;

// A "silent" futás a percenkénti háttérfrissítés: ilyenkor NEM játsszuk újra
// a teljes koreográfiát (nem tűnik el a válasz, nem ugrik vissza a radar a
// kiinduló helyére), csak az adatok és a radar pontjai frissülnek a helyükön.
async function run(userLoc, { silent = false } = {}) {
  // A percenkénti háttérfrissítés nem szólhat bele egy futó keresésbe. Egy új
  // KÉRT keresés viszont mindig felülírja a folyamatban lévőt: a régi futás a
  // következő await után csendben kilép. Enélkül a helyszín módosítása után az
  // új keresés némán kimaradt volna, és a régi település válasza íródott volna
  // ki az új helyszín neve alá.
  if (silent && runInProgress) return;
  const token = ++runToken;
  const superseded = () => token !== runToken;
  runInProgress = true;
  if (silent) {
    radarReset();
  } else {
    beginSearchUI();
  }
  try {
    // Régebbi mentett helyzeteknél még hiányozhat az országkód (korábbi
    // verzióban nem tároltuk) - pótoljuk, hogy a külföldi találatoknál
    // helyesen tudjuk megjeleníteni az országot.
    if (!userLoc.countryCode) {
      try {
        const here = await reverseGeocode(userLoc.lat, userLoc.lon);
        userLoc.countryCode = here.countryCode;
        saveLocation(userLoc);
      } catch (err) {
        console.error(err);
      }
    }

    document.getElementById("q1-question").textContent =
      `Esik-e ${userLoc.name} környékén?`;

    // === 1. FÁZIS: esik-e a környéken? ===
    // Csak ezt keressük: a saját hely részletes előrejelzését és a legelső,
    // 150 km-es gyűrűt (ez a "környék"). A radar kört a hívás ELŐTT rajzoljuk
    // fel üresen, hogy a pásztázó vonal a várakozás alatt is fusson, és a
    // válasz megérkezésekor legyen mit felfestenie.
    const firstBatch = SEARCH_RINGS[0];
    const firstMaxRadius = firstBatch[firstBatch.length - 1][0];
    const firstGrid = generateSearchGrid(userLoc, firstBatch);
    radarAddTier(firstGrid, firstMaxRadius);
    const [userForecast, firstGridForecasts] = await Promise.all([
      fetchUserForecast(userLoc),
      fetchPrecipitation(firstGrid),
    ]);
    if (superseded()) return;
    const firstRainingIndices = firstGrid
      .map((_, i) => i)
      .filter(i => isRainingNow(firstGridForecasts[i]));
    await radarRevealTier(firstRainingIndices, { instant: silent });
    if (superseded()) return;

    // Ha nálad esik (vagy hamarosan fog), a "de hol esik pontosan?" kérdés
    // értelmetlen: a válasz az, hogy itt. Ilyenkor nincs 2. fázis.
    if (isRainingNow(userForecast)) {
      const mm = userForecast.current.precipitation;
      const band = intensityBand(mm);
      const duration = rainDurationHours(userForecast);
      const lines = [`${band.adv}, ${formatMm(mm)} mm/óra`];
      lines.push(duration === null ? null : duration <= 0 ? "hamarosan eláll" : `még kb. ${duration} óráig tart`);
      setHero("Most esik", lines);
      hideQ2();
      return;
    }
    if (isRainingSoon(userForecast)) {
      const idx = soonRainIndex(userForecast);
      const mm = userForecast.hourly.precipitation[idx];
      const prob = userForecast.hourly.precipitation_probability?.[idx];
      const band = intensityBand(mm);
      const probText = typeof prob === "number" ? `${Math.round(prob)}% eséllyel, ` : "";
      setHero("Hamarosan", `${probText}${band.adj} eső várható`);
      hideQ2();
      return;
    }

    let raining = sortRaining(firstGrid, firstGridForecasts);
    const answer = raining.length > 0 ? "Igen" : "Nem";

    // Csendes háttérfrissítésnél csak akkor megyünk tovább a távoli
    // keresésre, ha a környék helyzete meg is változott. A "hol esik
    // pontosan" válasz néhány perc alatt nem avul el annyira, hogy megérné
    // érte minden frissítéskor újra végigjárni az összes távoli gyűrűt is:
    // úgy egy nyitva hagyott lap napi több tízezer pontot kérne le.
    const unchanged = silent &&
      document.getElementById("q1-answer").textContent === answer;
    setHero(answer, null);
    showQ2("de hol esik pontosan?");
    if (unchanged) return;

    // Az 1. fázis vége: a radar lecsúszik eggyel, megjelenik a válasz és a
    // következő kérdés, és a keresés alatta folytatódik. Itt nincs külön
    // várakozás, mert a pontok felfestése már kitöltött egy teljes fordulatot.
    if (!silent) await revealPhase(PHASE_WHERE, 0);
    if (superseded()) return;

    // === 2. FÁZIS: de hol esik pontosan? ===
    for (let i = 1; i < SEARCH_RINGS.length && raining.length === 0; i++) {
      const batch = SEARCH_RINGS[i];
      const maxRadius = batch[batch.length - 1][0];
      const grid = generateSearchGrid(userLoc, batch);
      radarAddTier(grid, maxRadius);
      const forecasts = await fetchPrecipitation(grid);
      if (superseded()) return;
      const rainingIndices = grid
        .map((_, idx) => idx)
        .filter(idx => isRainingNow(forecasts[idx]));
      await radarRevealTier(rainingIndices, { instant: silent });
      if (superseded()) return;
      raining = sortRaining(grid, forecasts);
    }

    if (raining.length > 0) {
      const nearest = raining[0];
      const place = await findNearbyName(nearest);
      if (superseded()) return;
      showNearestRain(nearest, place, userLoc);
    } else {
      const maxKm = SEARCH_RINGS[SEARCH_RINGS.length - 1].at(-1)[0];
      setQ2Answer(`<p class="place-line">Sehol</p>
        <p class="context">${maxKm} km-en belül sem találtunk esőt</p>`);
    }
  } catch (err) {
    console.error(err);
    // Csendes háttérfrissítésnél NEM írjuk felül a meglévő, jó választ egy
    // hibaüzenettel: egy átmeneti hálózati hiba vagy 429 ilyenkor azonnal
    // letörölné a képernyőn álló érvényes eredményt.
    if (!silent && !superseded()) {
      setHero("Hiba", "Nem sikerült lekérni az adatokat. Próbáld újra kicsit később.");
      hideQ2();
    }
  } finally {
    if (!superseded()) {
      if (!silent) scheduleReveal();
      runInProgress = false;
    }
  }
}

function showNearestRain(nearest, place, userLoc) {
  // A kiírt kártya a MEGNEVEZETT helyről szól, ezért annak saját
  // koordinátáihoz kell számolni a távolságot/irányt/útvonalat - a névadó
  // pont a keresés során eltolódhatott az esős ponttól, így a kettő nem
  // feltétlenül ugyanaz.
  const isForeign = place.countryCode && userLoc.countryCode && place.countryCode !== userLoc.countryCode;
  const placeLabel = place.name
    ? (isForeign ? `${place.name}, ${place.countryName}` : place.name)
    : "egy közeli térségben";

  const targetLat = place.name ? place.lat : nearest.lat;
  const targetLon = place.name ? place.lon : nearest.lon;
  const displayDistance = place.name
    ? distanceKm(userLoc.lat, userLoc.lon, place.lat, place.lon)
    : nearest.distance;
  const displayBearing = place.name
    ? bearingBetween(userLoc.lat, userLoc.lon, place.lat, place.lon)
    : nearest.bearing;

  const direction = compassLabel(displayBearing);
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${userLoc.lat},${userLoc.lon}&destination=${targetLat},${targetLon}`;
  setQ2Answer(
    `<p class="place-line">${placeLabel}</p>
     <p class="context">${Math.round(displayDistance)} km innen
     <span class="direction-arrow" style="transform: rotate(${displayBearing}deg)" title="${direction} irányban" aria-label="${direction} irányban">↑</span></p>
     <a class="map-link" href="${mapsUrl}" target="_blank" rel="noopener">útvonal</a>`
  );
}

// A context egy string vagy stringek tömbje lehet: a "Most esik" állapotnál
// (erősség, időtartam) néha több sorra van szükség.
//
// Ezek a függvények CSAK a tartalmat írják. Hogy a tartalom mikor válik
// láthatóvá, azt egyedül a keresés koreográfiája dönti el (a #result
// data-phase attribútuma, lásd lent) - így nem tud két hely egymás ellen
// dolgozni, és a layout sem ugrik meg keresés közben.
function setHero(answer, context) {
  document.getElementById("q1-answer").textContent = answer;
  const lines = Array.isArray(context) ? context : [context];
  document.getElementById("q1-context").innerHTML = lines
    .filter(Boolean)
    .map(line => `<p class="context">${line}</p>`)
    .join("");
}

function showQ2(question) {
  document.getElementById("q2-block").hidden = false;
  document.getElementById("q2-question").textContent = question;
}

function setQ2Answer(html) {
  document.getElementById("q2-answer").innerHTML = html;
}

function hideQ2() {
  document.getElementById("q2-block").hidden = true;
  document.getElementById("q2-answer").innerHTML = "";
}

// ---- UI-vezérlés ----

// Telepített (standalone) módban nincs böngésző-frissítés gomb, ezért amíg az
// app látható és van kiválasztott helyszín, magunktól frissítünk. Háttérben
// (nem látható lapon) nem, hogy ne fogyjon feleslegesen az akkumulátor.
//
// Az ütem szándékosan 5 perc, nem 1: az Open-Meteo napi és órás kvótája
// pontban méri a használatot (lásd SEARCH_RINGS), és a percenkénti frissítés
// egy nyitva hagyott lapon egymagában felélte volna az órás keret felét.
// Időjáráshoz 5 perc bőven elég sűrű.
const AUTO_REFRESH_MS = 5 * 60 * 1000;
let currentLoc = null;

function runAndTrack(loc) {
  currentLoc = loc;
  run(loc);
}

function shouldAutoRefresh() {
  return (
    currentLoc &&
    document.visibilityState === "visible" &&
    !document.getElementById("result").hidden
  );
}

setInterval(() => {
  if (shouldAutoRefresh()) run(currentLoc, { silent: true });
}, AUTO_REFRESH_MS);

document.addEventListener("visibilitychange", () => {
  if (shouldAutoRefresh()) run(currentLoc, { silent: true });
});

// ---- A keresés koreográfiája ----
//
// A keresés két kérdésre válaszol, egymás után, és a radar mindkettő után
// lejjebb csúszik egy lépéssel. A #result data-phase attribútuma mondja meg,
// mi látszik éppen; a többit a CSS intézi.
//
// PHASE_LOCAL ("esik-e a környéken?"): csak a kérdés és a radar látszik.
//   A válasz és a második blokk ilyenkor a LAYOUTBAN SINCS benne, így a radar
//   a keresés teljes ideje alatt egy helyben marad. (Korábban itt volt egy
//   hiba: a válaszblokk már keresés közben helyet foglalt, és lelökte.)
// PHASE_WHERE ("de hol esik pontosan?"): az első válasz és a második kérdés
//   már látszik, a második válasz még nem. A radar egy lépéssel lejjebb
//   csúszott, és alatta folytatódik a keresés.
// PHASE_DONE: minden látszik, a radar a végleges helyén marad.
//
// Az első válasz ("Igen"/"Nem") nem várakozik külön: mire idáig érünk, a
// pásztázó vonal már körbeért egyszer, hiszen a pontokat pont ő festette fel
// (radarRevealTier egy teljes fordulat alatt végez). Ez önmagában elég idő a
// kör leolvasásához. A VÉGSŐ válasz előtt viszont marad a hosszabb
// várakozás, hogy a megtalált esőt is meg lehessen nézni a radaron.
const PHASE_LOCAL = "local";
const PHASE_WHERE = "where";
const PHASE_DONE = "done";
const REVEAL_DELAY_MS = 3000;
const REVEAL_SLIDE_MS = 600;
let revealTimer = null;
let revealResolve = null;

// A függőben lévő felfedés-ígéretet fel KELL oldani, amikor megszakítjuk,
// különben az await-elő run() örökre ott áll, a finally sosem fut le, és
// onnantól minden további keresés némán kimarad (az app újratöltésig halott).
function cancelReveal() {
  clearTimeout(revealTimer);
  revealTimer = null;
  if (revealResolve) {
    revealResolve();
    revealResolve = null;
  }
}

function beginSearchUI() {
  cancelReveal();
  const loading = document.getElementById("loading");
  const svg = document.getElementById("radar-svg");
  document.getElementById("result").dataset.phase = PHASE_LOCAL;
  document.getElementById("loading-text").textContent = "töltés…";
  loading.classList.remove("settled", "locating");
  loading.hidden = false;
  svg.style.transition = "";
  svg.style.transform = "";
  radarReset();
  radarRestartSweep();
}

// Vár a megadott ideig, majd átlép a megadott fázisba. A hívó await-elheti,
// hogy a keresés következő szakasza csak a lecsúszás után induljon el.
function revealPhase(phase, delayMs) {
  cancelReveal();
  return new Promise(resolve => {
    revealResolve = resolve;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      revealResolve = null;
      slideRadar(() => {
        document.getElementById("result").dataset.phase = phase;
        if (phase === PHASE_DONE) document.getElementById("loading").classList.add("settled");
      });
      resolve();
    }, delayMs);
  });
}

function scheduleReveal() {
  revealPhase(PHASE_DONE, REVEAL_DELAY_MS);
}

// A fázisváltáskor megjelenő szöveg egy ugrással lökné lejjebb a radart.
// Ezért FLIP-technikát használunk: megmérjük a radar helyét a változtatás
// ELŐTT és UTÁN, a különbséggel visszatoljuk oda, ahol volt, majd onnan
// animáljuk az új helyére. Így ugrás helyett szépen lecsúszik, miközben a
// szöveg beúszik fölötte.
function slideRadar(applyLayoutChange) {
  const svg = document.getElementById("radar-svg");
  const first = svg.getBoundingClientRect();

  applyLayoutChange();

  const last = svg.getBoundingClientRect();
  const scale = last.width ? first.width / last.width : 1;

  svg.style.transition = "none";
  svg.style.transformOrigin = "top left";
  svg.style.transform =
    `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${scale})`;
  svg.getBoundingClientRect(); // kényszerített újraszámolás, hogy legyen mihez animálni
  svg.style.transition = `transform ${REVEAL_SLIDE_MS}ms ease`;
  svg.style.transform = "translate(0, 0) scale(1)";
}

// Csak a helymeghatározás fázisához kell: radar nélküli, egyszerű szöveges
// töltésjelző, még mielőtt bármit tudnánk arról, hol keressünk.
function showLoading(on, text = "töltés…") {
  const loading = document.getElementById("loading");
  if (!on) {
    loading.hidden = true;
    return;
  }
  cancelReveal();
  loading.classList.remove("settled");
  loading.classList.add("locating");
  document.getElementById("loading-text").textContent = text;
  loading.hidden = false;
}

// Helyszín-módosításkor a lemaradt (settled) radart is el kell tüntetni,
// különben ott lógna a helyszín-kereső form alatt.
function hideLoadingImmediately() {
  cancelReveal();
  const loading = document.getElementById("loading");
  loading.hidden = true;
  loading.classList.remove("settled", "locating");
}

function showError(msg) {
  const el = document.getElementById("location-error");
  el.textContent = msg;
  el.hidden = false;
}

function showResult() {
  document.getElementById("location-picker").hidden = true;
  document.getElementById("result").hidden = false;
}

function showPicker() {
  document.getElementById("result").hidden = true;
  document.getElementById("location-picker").hidden = false;
  hideLoadingImmediately();
}

// Automatikus helymeghatározás: ez az alapértelmezett út. Ha a felhasználó
// megtagadja vagy nem támogatott, a kézi keresőre esünk vissza.
async function tryAutoLocate() {
  showLoading(true, "helymeghatározás…");
  try {
    const coords = await detectLocation();
    let place = { name: null, countryCode: null, countryName: null };
    try {
      place = await reverseGeocode(coords.lat, coords.lon);
    } catch (err) {
      console.error(err);
    }
    const loc = {
      name: place.name || "a jelenlegi helyzeted",
      lat: coords.lat,
      lon: coords.lon,
      countryCode: place.countryCode,
    };
    saveLocation(loc);
    showLoading(false);
    showResult();
    runAndTrack(loc);
  } catch (err) {
    console.error(err);
    showLoading(false);
    showPicker();
    showError("Nem sikerült automatikusan meghatározni a helyzeted. Add meg kézzel:");
  }
}

document.getElementById("location-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("location-input");
  const errorEl = document.getElementById("location-error");
  errorEl.hidden = true;

  let loc;
  try {
    loc = await geocode(input.value.trim());
  } catch (err) {
    console.error(err);
    showError("Nem sikerült elérni a helykereső szolgáltatást. Próbáld újra.");
    return;
  }
  if (!loc) {
    showError("Nem találtunk ilyen települést, próbáld pontosabban.");
    return;
  }
  saveLocation(loc);
  showResult();
  runAndTrack(loc);
});

// ---- Push-értesítés ----

const VAPID_PUBLIC_KEY = "BFDUfuycSz_U5WPPqthX4BsMFh_knI7mkH8DDz9R3BAhMtESzx-SxD_H_kmMST46v388RUMSGQjgc80vbgJ4Ryc";
const PUSH_WORKER_URL = "https://holazeso-push-worker.kovizozi.workers.dev";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function updateNotifyButton() {
  const btn = document.getElementById("notify-toggle");
  const enabled = localStorage.getItem("holazeso_notify_enabled") === "1";
  btn.textContent = enabled ? "értesítés kikapcsolása" : "értesíts, ha esni kezd";
}

async function enableNotifications(userLoc) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    alert("A böngésződ nem támogatja az értesítéseket.");
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    await fetch(PUSH_WORKER_URL + "/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        lat: userLoc.lat,
        lon: userLoc.lon,
        name: userLoc.name,
      }),
    });

    localStorage.setItem("holazeso_notify_enabled", "1");
  } catch (err) {
    console.error(err);
    alert("Nem sikerült bekapcsolni az értesítéseket. Próbáld újra.");
  }
  updateNotifyButton();
}

async function disableNotifications() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await fetch(PUSH_WORKER_URL + "/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
    }
  } catch (err) {
    console.error(err);
  }
  localStorage.removeItem("holazeso_notify_enabled");
  updateNotifyButton();
}

document.getElementById("notify-toggle").addEventListener("click", async () => {
  const enabled = localStorage.getItem("holazeso_notify_enabled") === "1";
  if (enabled) {
    await disableNotifications();
    return;
  }
  const loc = loadSavedLocation();
  if (loc) await enableNotifications(loc);
});

document.getElementById("change-location").addEventListener("click", () => {
  showPicker();
});

document.getElementById("retry-geo").addEventListener("click", () => {
  document.getElementById("location-error").hidden = true;
  tryAutoLocate();
});

// ---- Indítás ----

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(err => console.error(err));
}

updateNotifyButton();

const saved = loadSavedLocation();
if (saved) {
  showResult();
  runAndTrack(saved);
} else {
  tryAutoLocate();
}
