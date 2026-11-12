// ---- Keresési rács ----
// Nincs fix településlista: a felhasználó koordinátája köré generálunk egy
// gyűrűkből álló ponthálót, és abban keressük a legközelebbi esőt. Ez minden
// országban egyformán pontos, nem csak Magyarországon vagy egy előre
// kiválasztott városlistán.
//
// Ha az első adagban (60 km-ig) nem találunk esőt, egyre távolabbi
// gyűrűket próbálunk, amíg nem találunk, vagy amíg el nem fogynak.
//
// Az adagok szűken indulnak és onnan tágulnak: az első csak 60 km-ig néz,
// a következők 150 km-enként lépnek kijjebb (300, 450), és csak utána
// gyorsul a lépés (900, 2500), hogy távoli eső esetén ne kelljen tucatnyi
// kört végigvárni.
// Így a radar induló képe a közvetlen környéket mutatja olvashatóan, nem
// egy 600 km-es, összezsúfolt áttekintést.
//
// AZ ELSŐ ADAG (SEARCH_RINGS[0]) nemcsak az első API-hívás kötege, hanem ez
// dönti el az "Esik-e X környékén?" Igen/Nem válaszát is (lásd run()). Ezt
// korábban az egész 150 km-es tartomány adta, de egy 100-150 km-es találat
// senkinek nem érződik "a környéknek" - ezért az Igen/Nem most csak 60 km-ig
// terjed, és egy 100-150 km-es találatot már a 2. fázis ("de hol esik
// pontosan?") mutat meg, nem az 1. kérdés válasza.
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
  [[30, 6], [60, 10]],
  [[100, 14], [150, 18]],
  [[200, 16], [250, 18], [300, 20]],
  [[350, 20], [400, 22], [450, 24]],
  [[550, 20], [700, 22], [900, 24]],
  [[1200, 18], [1700, 20], [2500, 22]],
];

// A 60 km-es "környék"-határ (SEARCH_RINGS[0] vége) az Igen/Nem válasz
// szemantikáját adja, de NEM azt, amennyit a radaron látni akarunk: ha a
// találat 60 km-en belül van, a radar vizuálisan ennél messzebb kell
// mutasson, különben az országhatár (ami csak a settled fázisban rajzolódik
// ki, ld. revealPhase) sosem fér bele látható méretbe egy ilyen kis körben.
// Lásd a run() "Igen" ágát: ott, ha szükséges, egy tisztán vizuális,
// újrakeresés nélküli radarAddTier hívással kijjebb húzzuk a kört.
const RADAR_MIN_VISUAL_RADIUS_KM = 150;

function ringBearings(count) {
  return Array.from({ length: count }, (_, i) => (i * 360) / count);
}

// A durva háló egy gyűrűpontján akadunk rá az esőre, de az esőterület hozzánk
// legközelebbi széle bárhol lehet az előző (üres) gyűrű és a találat között,
// és oldalra is a szomszédos irányok félútjáig. Ezért a találat köré küldünk
// még egy kis, sűrű hálót: 20 pont, egyetlen hívás. Ez a távoli találatoknál
// több száz kilométeres bizonytalanságot visz le néhány tízre, és sokkal
// olcsóbb, mint az egész hálót sűríteni (azt a kvóta amúgy sem bírná).
const REFINE_DISTANCES = 4;
const REFINE_BEARINGS = 5;
const ALL_RINGS = SEARCH_RINGS.flat();

function refinementGrid(userLoc, hit) {
  const idx = ALL_RINGS.findIndex(([km]) => km === hit.distance);
  if (idx < 0) return [];
  const innerKm = idx > 0 ? ALL_RINGS[idx - 1][0] : 0;
  const bearingSpan = 360 / ALL_RINGS[idx][1];
  const points = [];
  for (let i = 1; i <= REFINE_DISTANCES; i++) {
    const distance = innerKm + (hit.distance - innerKm) * (i / REFINE_DISTANCES);
    for (let j = 0; j < REFINE_BEARINGS; j++) {
      const offset = bearingSpan * (j / (REFINE_BEARINGS - 1) - 0.5);
      const bearing = (hit.bearing + offset + 360) % 360;
      const p = destinationPoint(userLoc.lat, userLoc.lon, bearing, distance);
      points.push({ lat: p.lat, lon: p.lon, distance, bearing });
    }
  }
  return points;
}

const RAIN_THRESHOLD_MM = 0.1; // ennél kevesebb csapadékot zajnak tekintünk

// Csapadék-erősség sávok (mm/óra), melléknévi és határozói alakkal együtt,
// hogy ne kelljen a végződést programból levezetni.
// A "key" és a "dotRadius" a radar pöttyeihez kell: a gyengébb esőt halványabb
// és kisebb pötty jelzi. Itt tartjuk, hogy az intenzitás-sávoknak egyetlen
// forrása legyen, és a szöveg meg a rajz ne csúszhasson szét egymástól.
const INTENSITY_BANDS = [
  { max: 1, key: "light", dotRadius: 4, adj: "gyenge", adv: "gyengén" },
  { max: 4, key: "medium", dotRadius: 5, adj: "közepes", adv: "közepesen" },
  { max: Infinity, key: "heavy", dotRadius: 6, adj: "erős", adv: "erősen" },
];

function intensityBand(mm) {
  return INTENSITY_BANDS.find(b => mm <= b.max);
}

function formatMm(mm) {
  return mm.toFixed(1).replace(".", ",");
}

function formatC(celsius) {
  return celsius.toFixed(1).replace(".", ",");
}

// A talajnedvesség (soil_moisture_0_to_1cm, m³/m³) talajtípustól függ, nincs
// egyetlen "helyes" skála - ez egy durva, laikusnak szóló közelítés, nem
// kalibrált érték.
const SOIL_MOISTURE_BANDS = [
  { max: 0.15, label: "száraz" },
  { max: 0.35, label: "nedves" },
  { max: Infinity, label: "vizes" },
];

function soilMoistureLabel(value) {
  return SOIL_MOISTURE_BANDS.find(b => value <= b.max).label;
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

// A "részletek és statisztika" panelhez EGYETLEN pontra (a felhasználó
// helyére) kérünk bővített adatot: múltbeli napi/órás csapadékot, pár napos
// előrejelzést, hőmérsékletet és talajnedvességet. Ez külön függvény a
// fetchUserForecast-tól, mert azt az 5 percenkénti automatikus frissítés is
// lefuttatja - oda nem kell ez a jóval nehezebb lekérdezés. Egyetlen pontra
// a grid-kvóta aggálya (lásd SEARCH_RINGS fenti kommentje) nem vonatkozik.
async function fetchUserStats(point) {
  return openMeteo(
    `${API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}` +
    `&past_days=31&forecast_days=4` +
    `&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min,snowfall_sum` +
    `&hourly=precipitation,precipitation_probability,soil_moisture_0_to_1cm` +
    `&current=temperature_2m,precipitation,snowfall&timezone=auto`
  );
}

// "Szokásos" csapadék-bázis: az előző néhány év ugyanarra a mai napra
// végződő 30 napos ablakára lekért, VALÓDI mért napi összeg (nem modell-
// előrejelzés). Ez nem egy hivatalos, sokéves klimatológiai normál, csak az
// elmúlt néhány év átlaga - ezért a megjelenő szöveg is így fogalmaz.
const USUAL_PRECIP_YEARS_BACK = 3;
const ARCHIVE_API_BASE = "https://archive-api.open-meteo.com/v1/archive";

async function fetchUsualPrecipitation(point) {
  const today = new Date();
  const years = Array.from({ length: USUAL_PRECIP_YEARS_BACK }, (_, i) => i + 1);
  const windows = await Promise.all(years.map(async yearsBack => {
    const end = new Date(today);
    end.setFullYear(end.getFullYear() - yearsBack);
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    const toIso = d => d.toISOString().slice(0, 10);
    const data = await openMeteo(
      `${ARCHIVE_API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}` +
      `&start_date=${toIso(start)}&end_date=${toIso(end)}&daily=precipitation_sum&timezone=auto`
    );
    return data.daily.precipitation_sum;
  }));
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const avg = arr => arr.reduce((a, b) => a + sum(b), 0) / arr.length;
  return {
    usual7d: avg(windows.map(w => w.slice(-7))),
    usual30d: avg(windows),
  };
}

// Folyó-vízhozam (m³/s) a felhasználó helyéhez legközelebbi modellezett
// folyószakaszra. A flood-api rácsa ritka: kisebb patakoknál a legközelebbi
// pont messze lehet, vagy zajszintű (nulla közeli) értéket ad. Ezért a hívó
// félnek külön ellenőriznie kell a visszaadott rács-pont távolságát és a
// vízhozam nagyságát, mielőtt megjelenítené - lásd buildStatsPanel.
const FLOOD_API_BASE = "https://flood-api.open-meteo.com/v1/flood";

async function fetchRiverDischarge(point) {
  return openMeteo(
    `${FLOOD_API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}&daily=river_discharge&forecast_days=2`
  );
}

// Az esős pontokat adja vissza egy pont- és előrejelzés-listából, távolság
// szerint növekvő sorrendben.
// A csapadék mennyiségét is rátesszük a pontra: enélkül a hívó már nem tudná
// visszakeresni, mennyire esik a megtalált helyen, és csak a helynevet meg a
// távolságot tudnánk kiírni.
function sortRaining(points, forecasts) {
  return points
    .map((point, i) => ({ point, forecast: forecasts[i] }))
    .filter(({ forecast }) => isRainingNow(forecast))
    .map(({ point, forecast }) => ({ ...point, mm: currentPrecipRate(forecast) }))
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

// A "current.precipitation" NEM mm/óra: az Open-Meteo a modell saját
// frissítési közét ("current.interval", másodpercben) adja vissza, ami a
// legtöbb európai pontra 900 (15 perc), nem 3600 (1 óra). Felszorzás nélkül
// a valós óránkénti csapadék negyedét mutattuk volna, ezért a kiírt érték
// mindig irreálisan alacsonynak ("0,x mm") tűnt, és a 0,1 mm/órás küszöb is
// a négyszeresére, kb. 0,4 mm/órára szigorult.
function currentPrecipRate(forecast) {
  const { precipitation, interval } = forecast.current;
  return precipitation * 3600 / interval;
}

function isRainingNow(forecast) {
  return currentPrecipRate(forecast) >= RAIN_THRESHOLD_MM;
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

// Hány órája tart a MOST zajló esőzés: a rainDurationHours tükörképe,
// visszafelé pásztázva az első száraz óráig. Null, ha az órás tömb nem ér
// el addig (pl. past_days nem fedte le), vagy az aktuális óra maga sem esős.
function rainEventStartIndex(forecast) {
  const idx = currentHourIndex(forecast);
  if (idx === -1 || forecast.hourly.precipitation[idx] < RAIN_THRESHOLD_MM) return null;
  let start = idx;
  while (start > 0 && forecast.hourly.precipitation[start - 1] >= RAIN_THRESHOLD_MM) {
    start--;
  }
  return start;
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
// A képernyő TÉGLALAP, nem kör. A lépték mindkét irányban ugyanaz (különben
// a térkép torzulna), ezért a keresési sugár a FÉL MAGASSÁGnak felel meg, és
// oldalra ennél messzebbre látunk: a sarkokban a fél átló arányában, kb. a
// sugár kétszereséig. A tartalmat a viewBox vágja el a széleknél.
const RADAR_W = 350;
const RADAR_H = 220;
const RADAR_CENTER_X = RADAR_W / 2;
const RADAR_CENTER_Y = RADAR_H / 2;
const RADAR_MAX_PX = 100; // ennyi képpont felel meg a keresési sugárnak
const RADAR_CORNER_FACTOR = Math.hypot(RADAR_CENTER_X, RADAR_CENTER_Y) / RADAR_MAX_PX;

let radarTierGroups = []; // { el, maxRadiusKm }

function radarPolarPoint(bearingDeg, distKm, maxRadiusKm) {
  return radarProject(bearingDeg, Math.min(distKm, maxRadiusKm), maxRadiusKm);
}

// Vágás nélküli vetítés: a folytonos rétegeknek (radarkép, országhatárok) a
// kör sugarán TÚL is kell pont, mert a téglalap sarkai messzebbre látnak.
function radarProject(bearingDeg, distKm, maxRadiusKm) {
  const r = (distKm / maxRadiusKm) * RADAR_MAX_PX;
  const theta = bearingDeg * Math.PI / 180;
  return {
    x: RADAR_CENTER_X + r * Math.sin(theta),
    y: RADAR_CENTER_Y - r * Math.cos(theta),
  };
}

// ---- Országhatárok a radaron ----
// A radar azimutális ekvidisztáns vetület a felhasználó körül: minden pont a
// VALÓDI távolsága és iránya szerint kerül a helyére. Ezért a határvonalakat
// is pontosan ugyanazzal a két függvénnyel vetítjük, amivel a rácspontokat
// (distanceKm és bearingBetween) - nem kell hozzá külön térképvetület.
//
// Az adat lusta betöltésű és sosem várakoztatja a választ: ha nem érkezik meg
// vagy hibázik, a radar egyszerűen határok nélkül működik tovább.
const BORDERS_URL = "borders.json?v=1";
let borderRings = null;
let bordersLoading = null;
let radarOrigin = null;
let radarMaxRadiusKm = 0;
// A határok csak a keresés legvégén, a végleges válasszal együtt jelennek
// meg: keresés közben a radar maradjon tiszta, csak a pontokkal.
let bordersVisible = false;

function loadBorders() {
  if (bordersLoading) return bordersLoading;
  bordersLoading = fetch(BORDERS_URL)
    .then(res => res.json())
    .then(encoded => {
      // Delta-kódolt egészek 0,01 fokos egységekben, gyűrűnként halmozva.
      // Ez a felére csökkenti a fájlt a nyers koordinátalistához képest.
      borderRings = encoded.map(flat => {
        const ring = [];
        let x = 0;
        let y = 0;
        for (let i = 0; i < flat.length; i += 2) {
          x += flat[i];
          y += flat[i + 1];
          ring.push([x / 100, y / 100]);
        }
        return ring;
      });
      radarDrawBorders();
    })
    .catch(err => {
      console.error(err);
      borderRings = [];
    });
  return bordersLoading;
}

// ---- Radarkép a radaron ----
// A csapadékképet a RainViewer publikus radarcsempéiből rakjuk össze.
//
// FONTOS, mit jelent ez és mit nem: ez CSAK KÉP. A válasz továbbra is az
// Open-Meteo adatán alapul, nem ezen. A kettő eltérhet, és le is mértük, hogy
// eltér: a radar a magasban lévő visszaverődést látja, beleértve a talajzavart
// és a leérés előtt elpárolgó csapadékot, az Open-Meteo pedig a felszíni
// csapadékot modellezi. A csempe átlátszó pixele ráadásul kétértelmű: jelenthet
// "nem esik"-et és "itt nincs radarlefedettség"-et is. Ezért a radarkép
// tájékoztató háttér, nem döntési alap.
//
// Monokróm marad: a csempék színes palettáját nem vesszük át, a pixel
// erősségét a saját előtérszínünk átlátszóságára képezzük le.
const RAINVIEWER_INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json";
const RADAR_IMAGE_MAX_TILES = 9;
const RADAR_IMAGE_INK = 0.45; // mennyire erős legyen a kép a pontok alatt
let radarFrame = null;
let radarFrameLoading = null;

function loadRadarFrame() {
  if (radarFrameLoading) return radarFrameLoading;
  radarFrameLoading = fetch(RAINVIEWER_INDEX_URL)
    .then(res => res.json())
    .then(data => {
      const past = data.radar && data.radar.past;
      radarFrame = past && past.length
        ? { host: data.host, path: past[past.length - 1].path }
        : null;
    })
    .catch(err => {
      console.error(err);
      radarFrame = null;
    });
  return radarFrameLoading;
}

function lonLatToWorldPx(lon, lat, zoom) {
  const size = 256 * 2 ** zoom;
  const s = Math.min(Math.max(Math.sin(lat * Math.PI / 180), -0.9999), 0.9999);
  return {
    x: (lon + 180) / 360 * size,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size,
  };
}

// Akkora nagyítást választunk, hogy a csempe felbontása nagyjából a radar
// saját felbontásához illjen, de a letöltött csempék száma korlátos maradjon.
function radarImageZoom(lat, maxRadiusKm) {
  const kmPerRadarPx = maxRadiusKm / RADAR_MAX_PX;
  const equatorKm = 40075 * Math.cos(lat * Math.PI / 180);
  let zoom = Math.round(Math.log2(equatorKm / (256 * kmPerRadarPx)));
  zoom = Math.max(1, Math.min(7, zoom));
  // A téglalap sarkai a sugárnál messzebbre látnak, tehát a letöltendő
  // terület is ekkora: a becslésnek ezzel kell számolnia, különben a
  // csempeszám túllépi a korlátot.
  const reachKm = maxRadiusKm * RADAR_CORNER_FACTOR;
  while (zoom > 1) {
    const tileKm = equatorKm / 2 ** zoom;
    if ((2 * reachKm / tileKm + 1) ** 2 <= RADAR_IMAGE_MAX_TILES) break;
    zoom -= 1;
  }
  return zoom;
}

function loadTileImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // enélkül a canvas "megfertőződne", és nem lehetne pixelt olvasni
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function foregroundRgb() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--fg").trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) return [17, 17, 17];
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

async function drawRadarImage() {
  const el = document.getElementById("radar-image");
  el.removeAttribute("href");
  if (!bordersVisible || !radarFrame || !radarOrigin || !radarMaxRadiusKm) return;

  const zoom = radarImageZoom(radarOrigin.lat, radarMaxRadiusKm);
  const world = 256 * 2 ** zoom;
  const tiles = 2 ** zoom;
  const centre = lonLatToWorldPx(radarOrigin.lon, radarOrigin.lat, zoom);
  const kmPerTilePx = 40075 * Math.cos(radarOrigin.lat * Math.PI / 180) / world;
  const radiusPx = (radarMaxRadiusKm * RADAR_CORNER_FACTOR) / kmPerTilePx;
  const tx0 = Math.floor((centre.x - radiusPx) / 256);
  const tx1 = Math.floor((centre.x + radiusPx) / 256);
  const ty0 = Math.floor((centre.y - radiusPx) / 256);
  const ty1 = Math.floor((centre.y + radiusPx) / 256);

  const stitched = document.createElement("canvas");
  stitched.width = (tx1 - tx0 + 1) * 256;
  stitched.height = (ty1 - ty0 + 1) * 256;
  const stitchedCtx = stitched.getContext("2d", { willReadFrequently: true });
  const loads = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= tiles) continue;
      const wrapped = ((tx % tiles) + tiles) % tiles;
      const url = `${radarFrame.host}${radarFrame.path}/256/${zoom}/${wrapped}/${ty}/2/1_1.png`;
      loads.push(loadTileImage(url).then(img => {
        if (img) stitchedCtx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256);
      }));
    }
  }
  await Promise.all(loads);
  if (!bordersVisible) return; // közben új keresés indulhatott

  const source = stitchedCtx.getImageData(0, 0, stitched.width, stitched.height);
  const out = document.createElement("canvas");
  out.width = RADAR_W;
  out.height = RADAR_H;
  const outCtx = out.getContext("2d");
  const target = outCtx.createImageData(RADAR_W, RADAR_H);
  const [fr, fg, fb] = foregroundRgb();

  // A radar azimutális ekvidisztáns vetület, a csempék Mercator-vetületűek,
  // ezért pixelenként visszaszámoljuk, melyik koordináta tartozik ide.
  for (let y = 0; y < RADAR_H; y++) {
    for (let x = 0; x < RADAR_W; x++) {
      const dx = x - RADAR_CENTER_X;
      const dy = y - RADAR_CENTER_Y;
      const r = Math.hypot(dx, dy);
      const bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
      const point = destinationPoint(radarOrigin.lat, radarOrigin.lon, bearing,
        r / RADAR_MAX_PX * radarMaxRadiusKm);
      const w = lonLatToWorldPx(point.lon, point.lat, zoom);
      let sx = Math.round(w.x - tx0 * 256);
      const sy = Math.round(w.y - ty0 * 256);
      if (sx < 0) sx += world;
      if (sx >= world) sx -= world;
      if (sx < 0 || sy < 0 || sx >= stitched.width || sy >= stitched.height) continue;
      const alpha = source.data[(sy * stitched.width + sx) * 4 + 3];
      if (!alpha) continue;
      const di = (y * RADAR_W + x) * 4;
      target.data[di] = fr;
      target.data[di + 1] = fg;
      target.data[di + 2] = fb;
      target.data[di + 3] = Math.round(alpha * RADAR_IMAGE_INK);
    }
  }
  outCtx.putImageData(target, 0, 0);
  el.setAttribute("href", out.toDataURL());
}

function radarDrawBorders() {
  const layer = document.getElementById("radar-borders");
  layer.innerHTML = "";
  if (!bordersVisible || !borderRings || !radarOrigin || !radarMaxRadiusKm) return;

  // Olcsó előszűrés szélesség szerint: kis sugárnál a csúcsok túlnyomó része
  // eleve kiesik, így nem kell rájuk gömbi távolságot számolni. A téglalap
  // sarkai a sugárnál messzebbre látnak, ezért a sávot ki kell tágítani.
  const reachKm = radarMaxRadiusKm * RADAR_CORNER_FACTOR;
  const latSpan = (reachKm / 111) * 1.4 + 1;
  let d = "";
  for (const ring of borderRings) {
    let connected = false;
    for (const [lon, lat] of ring) {
      let projected = null;
      if (Math.abs(lat - radarOrigin.lat) <= latSpan) {
        const dist = distanceKm(radarOrigin.lat, radarOrigin.lon, lat, lon);
        if (dist <= reachKm) {
          const bearing = bearingBetween(radarOrigin.lat, radarOrigin.lon, lat, lon);
          const p = radarProject(bearing, dist, radarMaxRadiusKm);
          // A téglalapon kívülre eső csúcsok kimaradnak: a viewBox amúgy is
          // levágná őket, de így a szakaszok is helyesen szakadnak meg.
          if (p.x >= 0 && p.x <= RADAR_W && p.y >= 0 && p.y <= RADAR_H) projected = p;
        }
      }
      if (!projected) {
        connected = false; // a látható területről kilépő szakaszt megszakítjuk
        continue;
      }
      d += `${connected ? "L" : "M"}${projected.x.toFixed(1)} ${projected.y.toFixed(1)}`;
      connected = true;
    }
  }
  if (!d) return;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.classList.add("radar-border");
  layer.appendChild(path);
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
    x: RADAR_CENTER_X + (Number(dot.getAttribute("cx")) - RADAR_CENTER_X) * scale,
    y: RADAR_CENTER_Y + (Number(dot.getAttribute("cy")) - RADAR_CENTER_Y) * scale,
  };
}

function setRadarLabel(dot, text) {
  const labels = document.getElementById("radar-labels");
  labels.innerHTML = "";
  const { x, y } = radarLabelPosition(dot);
  // A radar jobb felén befelé, balra írjuk a nevet, különben kilógna a képből.
  const onRight = x > RADAR_CENTER_X;
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
  const dot = event.target.closest(".radar-dot");
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
function radarAddTier(points, maxRadiusKm, userLoc) {
  // A radar átskálázódik, tehát a korábbi felirat rossz helyre mutatna.
  clearRadarPlace();
  // A határréteg mindig az aktuális, legnagyobb sugárhoz igazodik, ezért a
  // korábbi körökkel ellentétben nem zoomoljuk, hanem újrarajzoljuk.
  radarOrigin = userLoc;
  radarMaxRadiusKm = maxRadiusKm;
  radarDrawBorders();
  drawRadarImage().catch(err => console.error(err));
  radarTierGroups.forEach(tier => {
    tier.scale = tier.maxRadiusKm / maxRadiusKm;
    tier.el.style.transform = `scale(${tier.scale})`;
  });

  // A lekérdezett pontokat NEM rajzoljuk ki: a radarkép már mutatja, hol van
  // csapadék, a mintavételi háló kirajzolva csak zaj lenne. Pötty csak oda
  // kerül, ahol tényleg esik (lásd radarRevealTier), ezért a kört üresen
  // hozzuk létre, és a pontokat csak megjegyezzük hozzá.
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.classList.add("radar-tier-group");
  document.getElementById("radar-tiers").appendChild(g);
  radarTierGroups.push({ el: g, maxRadiusKm, scale: 1, points });
}

// Egyetlen esős pötty létrehozása. A mérete és árnyalata az intenzitás-sávot
// követi, és rákoppintva megmutatja a helynevet (lásd showRadarPlace).
function addRainDot(tier, index, mm) {
  const point = tier.points[index];
  if (!point) return;
  const band = intensityBand(mm);
  const { x, y } = radarPolarPoint(point.bearing, point.distance, tier.maxRadiusKm);
  const svgNS = "http://www.w3.org/2000/svg";

  const dot = document.createElementNS(svgNS, "circle");
  dot.classList.add("radar-dot", `rain-${band.key}`);
  dot.setAttribute("cx", x);
  dot.setAttribute("cy", y);
  dot.setAttribute("r", band.dotRadius);
  dot.dataset.lat = point.lat;
  dot.dataset.lon = point.lon;
  tier.el.appendChild(dot);

  const pulse = document.createElementNS(svgNS, "circle");
  pulse.setAttribute("cx", x);
  pulse.setAttribute("cy", y);
  pulse.setAttribute("r", band.dotRadius);
  pulse.classList.add("radar-pulse", "pulsing");
  tier.el.appendChild(pulse);
}

// A rainByIndex egy Map: rácspont indexe -> csapadék mm/órában. Minden pötty
// akkor jelenik meg, amikor a pásztázó vonal az ő irányához ér, tehát a vonal
// "festi fel" őket. Az ígéret egy teljes fordulat után teljesül, akkor is, ha
// ebben a körben nem volt eső: így a vonal láthatóan végigpásztázza a kört,
// mielőtt a keresés kijjebb lép.
function radarRevealTier(rainByIndex, { instant = false } = {}) {
  const tier = radarTierGroups[radarTierGroups.length - 1];
  if (!tier) return Promise.resolve();

  if (instant) {
    rainByIndex.forEach((mm, index) => addRainDot(tier, index, mm));
    return Promise.resolve();
  }

  const sweepAngle = sweepAngleNow();
  rainByIndex.forEach((mm, index) => {
    const point = tier.points[index];
    if (!point) return;
    const degreesAhead = (point.bearing - sweepAngle + 360) % 360;
    setTimeout(() => addRainDot(tier, index, mm), (degreesAhead / 360) * RADAR_SWEEP_MS);
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
    // 60 km-es gyűrűt (ez a "környék"). A radar kört a hívás ELŐTT rajzoljuk
    // fel üresen, hogy a pásztázó vonal a várakozás alatt is fusson, és a
    // válasz megérkezésekor legyen mit felfestenie.
    const firstBatch = SEARCH_RINGS[0];
    const firstMaxRadius = firstBatch[firstBatch.length - 1][0];
    const firstGrid = generateSearchGrid(userLoc, firstBatch);
    radarAddTier(firstGrid, firstMaxRadius, userLoc);
    const [userForecast, firstGridForecasts] = await Promise.all([
      fetchUserForecast(userLoc),
      fetchPrecipitation(firstGrid),
    ]);
    if (superseded()) return;
    const firstRain = new Map(firstGrid
      .map((_, i) => i)
      .filter(i => isRainingNow(firstGridForecasts[i]))
      .map(i => [i, currentPrecipRate(firstGridForecasts[i])]));
    let raining = sortRaining(firstGrid, firstGridForecasts);

    // A helynév-lekérést már a felfestés ALATT elindítjuk. Enélkül a radar a
    // kész kép fölött pörögne tovább, amíg a geokódoló válaszol: a pontok
    // mind kint vannak, mégsem történik semmi.
    const rainsAtUser = isRainingNow(userForecast) || isRainingSoon(userForecast);
    let lookup = !rainsAtUser && raining.length > 0 ? startLookup(userLoc, raining[0]) : null;

    await radarRevealTier(firstRain, { instant: silent });
    if (superseded()) return;

    // Ha nálad esik (vagy hamarosan fog), a "de hol esik pontosan?" kérdés
    // értelmetlen: a válasz az, hogy itt. Ilyenkor nincs 2. fázis.
    if (isRainingNow(userForecast)) {
      const mm = currentPrecipRate(userForecast);
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

    // Lásd RADAR_MIN_VISUAL_RADIUS_KM: ha a találat a 60 km-es "környék"-en
    // belül volt, a radart vizuálisan kijjebb húzzuk (nem keresünk újra, a
    // meglévő pontokat skálázzuk át), hogy a majd megjelenő országhatár ne
    // egy túl kis körbe szoruljon.
    if (!silent && answer === "Igen" && firstMaxRadius < RADAR_MIN_VISUAL_RADIUS_KM) {
      radarAddTier(firstGrid, RADAR_MIN_VISUAL_RADIUS_KM, userLoc);
    }

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
      radarAddTier(grid, maxRadius, userLoc);
      const forecasts = await fetchPrecipitation(grid);
      if (superseded()) return;
      const rainByIndex = new Map(grid
        .map((_, idx) => idx)
        .filter(idx => isRainingNow(forecasts[idx]))
        .map(idx => [idx, currentPrecipRate(forecasts[idx])]));
      raining = sortRaining(grid, forecasts);
      if (raining.length > 0) lookup = startLookup(userLoc, raining[0]);
      await radarRevealTier(rainByIndex, { instant: silent });
      if (superseded()) return;
    }

    if (raining.length > 0) {
      const { refined, place } = await lookup;
      if (superseded()) return;
      // A finomító pontokat ugyanazon a léptéken mutatjuk, mint az aktuális
      // kört (azonos maxRadius mellett a radarAddTier nem zoomol át semmit).
      if (!silent && refined.points.length > 0) {
        radarAddTier(refined.points, radarMaxRadiusKm, userLoc);
        await radarRevealTier(refined.rain);
        if (superseded()) return;
      }
      showNearestRain(refined.nearest, place, userLoc);
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

// Lefuttatja a finomító hálót, és megkeresi benne a hozzánk legközelebbi esős
// pontot. Ha a finomítás nem talál esőt (előfordul: kis cella, amit a durva
// háló épp eltalált), marad az eredeti találat.
async function refineNearest(userLoc, hit) {
  const points = refinementGrid(userLoc, hit);
  if (points.length === 0) return { points, rain: new Map(), nearest: hit };
  const forecasts = await fetchPrecipitation(points);
  const rain = new Map(points
    .map((_, i) => i)
    .filter(i => isRainingNow(forecasts[i]))
    .map(i => [i, currentPrecipRate(forecasts[i])]));
  const closest = sortRaining(points, forecasts)[0];
  return {
    points,
    rain,
    nearest: closest && closest.distance < hit.distance ? closest : hit,
  };
}

// A finomítást és a rá épülő helynév-keresést EGYBEN indítjuk, még a kör
// felfestése előtt. Így mindkettő a pásztázás alatt fut le, és mire az utolsó
// pötty a helyére kerül, a végleges válasz általában készen van.
function startLookup(userLoc, hit) {
  return refineNearest(userLoc, hit).then(async refined => ({
    refined,
    place: await findNearbyName(refined.nearest),
  }));
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
  // Az erősség a megtalált esős PONTRA vonatkozik, nem a névadó településre:
  // a kettő eltérhet, ha a legközelebbi esős pontnak nem volt neve.
  const band = typeof nearest.mm === "number" ? intensityBand(nearest.mm) : null;
  const intensity = band
    ? `<p class="context">${band.adv} esik, ${formatMm(nearest.mm)} mm/óra</p>`
    : "";
  setQ2Answer(
    `<p class="place-line">${placeLabel}</p>
     <p class="context">${Math.round(displayDistance)} km innen
     <span class="direction-arrow" style="transform: rotate(${displayBearing}deg)" title="${direction} irányban" aria-label="${direction} irányban">↑</span></p>
     ${intensity}
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

// ---- "Részletek és statisztika" panel ----
// Ez a panel csak kinyitva tölt be (lásd a #stats-panel "toggle" figyelőt
// lent) - nem fut bele az 5 percenkénti automatikus frissítésbe, mert jóval
// nehezebb lekérdezés (31+ napos história, több évnyi archív összehasonlítás),
// mint amire a fő keresés épül. Minden nyitásnál újra lekér, nincs cache:
// egyetlen pontra vonatkozó hívásokról van szó, ez megengedhető egyszerűsítés.
let statsLoading = false;

async function buildStatsPanel(point) {
  if (statsLoading) return;
  statsLoading = true;
  const statusEl = document.getElementById("stats-status");
  statusEl.hidden = false;
  statusEl.textContent = "töltés…";
  try {
    const [stats, usual, flood] = await Promise.all([
      fetchUserStats(point),
      fetchUsualPrecipitation(point).catch(err => { console.error(err); return null; }),
      fetchRiverDischarge(point).catch(err => { console.error(err); return null; }),
    ]);
    const todayIdx = stats.daily.time.indexOf(stats.current.time.slice(0, 10));
    fillPrecipStats(stats, usual, todayIdx);
    fillForecastStats(stats, todayIdx);
    fillTempStats(stats, todayIdx);
    fillWaterStats(stats, flood, point);
    statusEl.hidden = true;
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Nem sikerült lekérni a statisztikát. Próbáld újra kicsit később.";
  } finally {
    statsLoading = false;
  }
}

// A "szokásos"-hoz képesti eltérés csak akkor értelmes, ha a bázis-érték nem
// elhanyagolhatóan kicsi - egy majdnem száraz időszakhoz képest 1 mm is
// "+300%" lenne, ami félrevezető, nem informatív.
function formatUsualDiff(actual, usual) {
  if (!(usual > 0.5)) return null;
  const diff = Math.round(((actual - usual) / usual) * 100);
  if (diff === 0) return "kb. annyi, mint szokott";
  return `${Math.abs(diff)}%-kal ${diff > 0 ? "több" : "kevesebb"}, mint szokott`;
}

function fillPrecipStats(stats, usual, todayIdx) {
  const idx = currentHourIndex(stats);
  const hourly = stats.hourly.precipitation;

  const eventEl = document.getElementById("stats-precip-event");
  const eventStart = idx === -1 ? null : rainEventStartIndex(stats);
  if (eventStart === null) {
    eventEl.hidden = true;
  } else {
    const eventSum = hourly.slice(eventStart, idx + 1).reduce((a, b) => a + b, 0);
    const hours = idx - eventStart + 1;
    eventEl.hidden = false;
    eventEl.textContent = `Ez alatt az esőzés alatt (${hours} órája tart): ${formatMm(eventSum)} mm`;
  }

  const sum24h = idx === -1 ? null : hourly.slice(Math.max(0, idx - 23), idx + 1).reduce((a, b) => a + b, 0);
  document.getElementById("stats-precip-24h").textContent =
    sum24h === null ? "" : `Elmúlt 24 órában: ${formatMm(sum24h)} mm`;

  const daily = stats.daily.precipitation_sum;
  const sum7d = daily.slice(Math.max(0, todayIdx - 6), todayIdx + 1).reduce((a, b) => a + b, 0);
  const sum30d = daily.slice(Math.max(0, todayIdx - 29), todayIdx + 1).reduce((a, b) => a + b, 0);
  const diff7 = usual && formatUsualDiff(sum7d, usual.usual7d);
  const diff30 = usual && formatUsualDiff(sum30d, usual.usual30d);

  document.getElementById("stats-precip-7d").textContent =
    `Elmúlt 7 napban: ${formatMm(sum7d)} mm${diff7 ? ` (${diff7})` : ""}`;
  document.getElementById("stats-precip-30d").textContent =
    `Elmúlt 30 napban: ${formatMm(sum30d)} mm${diff30 ? ` (${diff30}, az elmúlt ${USUAL_PRECIP_YEARS_BACK} év ilyenkor átlagához képest)` : ""}`;

  const from = Math.max(0, todayIdx - 29);
  renderSparkline(
    document.getElementById("stats-precip-chart"),
    stats.daily.time.slice(from, todayIdx + 1),
    daily.slice(from, todayIdx + 1)
  );
}

// Kézzel épített, monokróm mini oszlopdiagram a radar-rajzoláshoz hasonló
// stílusban (createElementNS, külön könyvtár nélkül). A száraz napok is
// kapnak egy halvány alapvonalat, hogy a diagram üresen ne tűnjön hibásnak.
// Minden oszlop kattintható/koppintható (touch screenen is - a "click"
// esemény mindkettőre lefut): megnyitja a buborékot az adott nap dátumával
// és csapadékával. A látható sáv keskeny (0,7*barWidth), ezért egy átlátszó,
// szélesebb körvonal adja a tényleges koppintási célterületet - ugyanaz a
// trükk, mint a radar-pöttyök "stroke: transparent; stroke-width" megoldása.
function renderSparkline(svgEl, dates, values) {
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  hideSparklineTooltip();
  const svgNS = "http://www.w3.org/2000/svg";
  const max = Math.max(...values, 1);
  const barWidth = 300 / values.length;
  values.forEach((v, i) => {
    const h = Math.max((v / max) * 40, 1);
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", i * barWidth + barWidth * 0.15);
    rect.setAttribute("y", 40 - h);
    rect.setAttribute("width", Math.max(barWidth * 0.7, 1));
    rect.setAttribute("height", h);
    rect.setAttribute("fill", "var(--fg)");
    rect.setAttribute("opacity", v > 0 ? 0.85 : 0.15);
    rect.classList.add("stats-bar");
    rect.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSparklineTooltip(i, dates[i], v, values.length);
    });
    svgEl.appendChild(rect);
  });
}

function formatStatsDate(dateIso) {
  return new Date(dateIso + "T00:00:00").toLocaleDateString("hu-HU", { month: "short", day: "numeric" });
}

let openTooltipBarIndex = null;

function toggleSparklineTooltip(index, dateIso, mm, barCount) {
  if (openTooltipBarIndex === index) {
    hideSparklineTooltip();
    return;
  }
  openTooltipBarIndex = index;
  const tooltip = document.getElementById("stats-precip-tooltip");
  const wrap = document.getElementById("stats-precip-chart").parentElement;
  const leftPercent = ((index + 0.5) / barCount) * 100;
  tooltip.textContent = `${formatStatsDate(dateIso)}: ${formatMm(mm)} mm`;
  tooltip.style.left = `${leftPercent}%`;
  tooltip.hidden = false;
}

function hideSparklineTooltip() {
  openTooltipBarIndex = null;
  const tooltip = document.getElementById("stats-precip-tooltip");
  if (tooltip) tooltip.hidden = true;
}

// Bárhova máshova kattintva (nem egy oszlopra) a buborék eltűnik - az
// oszlopok saját click-figyelője stopPropagation-nel előzi meg, hogy rögtön
// visszazáródjon, amikor épp megnyitjuk.
document.addEventListener("click", hideSparklineTooltip);

const FORECAST_DAY_LABELS = ["Holnap", "Holnapután"];
const HU_WEEKDAYS = ["vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"];

function fillForecastStats(stats, todayIdx) {
  const list = document.getElementById("stats-forecast-days");
  list.innerHTML = "";
  for (let offset = 1; offset <= 3; offset++) {
    const dayIdx = todayIdx + offset;
    if (dayIdx >= stats.daily.time.length) break;
    const label = FORECAST_DAY_LABELS[offset - 1] ||
      HU_WEEKDAYS[new Date(stats.daily.time[dayIdx]).getUTCDay()];
    const prob = stats.daily.precipitation_probability_max[dayIdx];
    const sum = stats.daily.precipitation_sum[dayIdx];
    const probText = typeof prob === "number" ? `${Math.round(prob)}% eséllyel, ` : "";
    const li = document.createElement("li");
    li.textContent = `${label}: ${probText}kb. ${formatMm(sum)} mm`;
    list.appendChild(li);
  }
}

function fillTempStats(stats, todayIdx) {
  document.getElementById("stats-temp-now").textContent =
    `Most: ${formatC(stats.current.temperature_2m)} °C`;

  const todayMin = stats.daily.temperature_2m_min[todayIdx];
  const todayMax = stats.daily.temperature_2m_max[todayIdx];
  const tomorrowIdx = todayIdx + 1;
  const tomorrowMin = stats.daily.temperature_2m_min[tomorrowIdx];
  const tomorrowMax = stats.daily.temperature_2m_max[tomorrowIdx];
  const tomorrowText = tomorrowMax === undefined
    ? ""
    : `, holnap: ${formatC(tomorrowMin)}–${formatC(tomorrowMax)} °C`;
  document.getElementById("stats-temp-minmax").textContent =
    `Ma: ${formatC(todayMin)}–${formatC(todayMax)} °C${tomorrowText}`;

  const frostToday = todayMin <= 0;
  const frostTomorrow = tomorrowMin !== undefined && tomorrowMin <= 0;
  const snowingNow = stats.current.snowfall > 0;
  const snowSoon = (stats.daily.snowfall_sum[todayIdx] > 0) ||
    (stats.daily.snowfall_sum[tomorrowIdx] > 0);

  const frostEl = document.getElementById("stats-temp-frost");
  const notes = [];
  if (snowingNow) notes.push("most havazik");
  else if (snowSoon) notes.push("havazás várható");
  if (frostToday && frostTomorrow) notes.push("fagyveszély ma és holnap éjjel is");
  else if (frostToday) notes.push("fagyveszély ma éjjel");
  else if (frostTomorrow) notes.push("fagyveszély holnap éjjel");
  frostEl.hidden = notes.length === 0;
  frostEl.textContent = notes.join(", ");
}

// A folyó-vízhozamot csak akkor mutatjuk, ha a flood-api által visszaadott
// legközelebbi modellezett folyószakasz valóban közel van ÉS a vízhozam nem
// zajszintű - lásd a fetchRiverDischarge komment je fenti, és a PROGRESS/terv
// dokumentált mérései (Budapest/Szeged ad értelmes számot, több kisváros nem).
const RIVER_MAX_DISTANCE_KM = 15;
const RIVER_MIN_DISCHARGE = 2;

function fillWaterStats(stats, flood, point) {
  const idx = currentHourIndex(stats);
  const soil = idx === -1 ? undefined : stats.hourly.soil_moisture_0_to_1cm[idx];
  const soilEl = document.getElementById("stats-water-soil");
  if (typeof soil !== "number") {
    soilEl.hidden = true;
  } else {
    const prevSoil = idx >= 24 ? stats.hourly.soil_moisture_0_to_1cm[idx - 24] : null;
    let trend = "";
    if (typeof prevSoil === "number") {
      const delta = soil - prevSoil;
      trend = delta > 0.02 ? ", nő" : delta < -0.02 ? ", csökken" : ", stabil";
    }
    soilEl.hidden = false;
    soilEl.textContent = `A talaj felső rétege most ${soilMoistureLabel(soil)}${trend}`;
  }

  const riverEl = document.getElementById("stats-water-river");
  if (!flood || !flood.daily || !flood.daily.river_discharge) {
    riverEl.hidden = true;
    return;
  }
  const dist = distanceKm(point.lat, point.lon, flood.latitude, flood.longitude);
  const [todayDischarge, tomorrowDischarge] = flood.daily.river_discharge;
  if (dist > RIVER_MAX_DISTANCE_KM || !(todayDischarge >= RIVER_MIN_DISCHARGE)) {
    riverEl.hidden = true;
    return;
  }
  let trend = "stabil";
  if (typeof tomorrowDischarge === "number") {
    const relChange = (tomorrowDischarge - todayDischarge) / todayDischarge;
    trend = relChange > 0.05 ? "emelkedő" : relChange < -0.05 ? "csökkenő" : "stabil";
  }
  riverEl.hidden = false;
  riverEl.textContent = `A legközelebbi folyó vízhozama: ${Math.round(todayDischarge)} m³/s, ${trend}`;
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
// kör leolvasásához. A VÉGSŐ válasz előtt is csak egy rövid szünet van: a
// pontok addigra mind kint vannak, és a helynév-lekérés is a felfestéssel
// párhuzamosan futott, tehát a radar nem pörög üresen a kész kép fölött.
const PHASE_LOCAL = "local";
const PHASE_WHERE = "where";
const PHASE_DONE = "done";
const REVEAL_DELAY_MS = 1200;
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

// A statisztika-panel az előző keresés eredményéhez tartozott: új keresés
// (új helyszín, vagy ugyanannak újraindítása) kezdetén el kell rejteni és be
// kell csukni, különben a radar alatt egy másik hely elavult adatai
// lógnának, amíg az új válasz meg nem érkezik.
function resetStatsPanel() {
  const panel = document.getElementById("stats-panel");
  panel.hidden = true;
  panel.open = false;
  hideSparklineTooltip();
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
  bordersVisible = false; // keresés közben tiszta radar, csak a pontokkal
  resetStatsPanel();
  resetWaterPanel();
  radarReset();
  radarRestartSweep();
  document.getElementById("radar-image").removeAttribute("href");
  loadBorders();     // lusta betöltés, a választ sosem várakoztatja
  // A radarkép 10 percenként frissül, ezért keresésenként újrakérjük a
  // katalógust. Ha nem jön meg, a radar egyszerűen kép nélkül működik tovább.
  radarFrameLoading = null;
  loadRadarFrame();
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
      if (phase === PHASE_DONE) {
        // A határok és a radarkép csak most, a végleges válasszal együtt
        // jelennek meg. A radarkép hálózatról jön, ezért nem várjuk meg.
        bordersVisible = true;
        radarDrawBorders();
        drawRadarImage().catch(err => console.error(err));
        // A statisztika-panel is csak most, hogy a radar véglegesen betöltött:
        // zárva marad (a felhasználó nyitja ki), csak a láthatósága nyílik meg.
        document.getElementById("stats-panel").hidden = false;
        // A vízadat-panel viszont NEM gombra nyílik: a radar után rögtön
        // megjelenik, nyitva, mert a felhasználó szerint ez folytatja az
        // oldalt, nem egy elrejtendő mellékes részlet.
        document.getElementById("water-panel").hidden = false;
        if (currentLoc) buildWaterPanel(currentLoc);
      }
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
  resetStatsPanel();
  resetWaterPanel();
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

document.getElementById("stats-panel").addEventListener("toggle", (event) => {
  if (event.target.open && currentLoc) buildStatsPanel(currentLoc);
});
// A water-panel már nem <details>, nincs toggle esemény: megjelenését és
// feltöltését a revealPhase(PHASE_DONE) ág intézi.

document.getElementById("retry-geo").addEventListener("click", () => {
  document.getElementById("location-error").hidden = true;
  tryAutoLocate();
});

// ============================================================================
// Vízadatok: talaj, folyók, tavak, vízmérleg
//
// Három, otthoni gépen (soil-moisture-mapper, külön repó) óránként frissített
// pillanatkép a push-worker KV-jéből: GET /soil-snapshot, /rivers-snapshot,
// /lakes-snapshot (ugyanaz a PUSH_WORKER_URL, ami a push-értesítésekhez is
// kell, ld. fentebb). A panel csak megnyitáskor tölt, és minden megnyitáskor
// újra - mint a #stats-panel (lásd a toggle-wiringot a fájl végén).
// ============================================================================

const BALATON_LITERS = 1.9e12; // ~1,9 km³, több forrásból is megerősített érték
const WATER_DEPTH_BANDS = [[0, 1, 0.01], [1, 3, 0.02], [3, 9, 0.06], [9, 27, 0.18], [27, 81, 0.54]];

// A Balaton körvonala (Natural Earth-ből, korábban egy design-canvasban
// kinyerve), egy 640 széles rajzterületen. A rétegezett (talajvíz) és a
// feltöltéses (tavak) ábra is ugyanezt a path-ot használja.
const BALATON_PATH = "M216.6 230.6 L209.8 231.6 L202.6 234.2 L196.8 237.6 L194.5 241.2 L187.1 242.4 L171.1 239.5 L155.7 239.7 L150 249.7 L150 335.1 L154 338.9 L160.4 339.3 L173.6 337 L190.1 337.2 L219.8 340 L236.2 339.1 L242.3 337.6 L258 331.9 L263.7 328.5 L270 326 L377.5 302.9 L386.7 298.6 L398 295.3 L403.6 291 L405.6 289.8 L410.4 290.4 L413 290.2 L466 281 L481.4 276.5 L487.9 273.1 L495.2 265 L500.7 260.3 L500.7 174.9 L500.4 171.7 L494.1 167.9 L485.7 164.6 L478.8 162.5 L462.2 159.5 L454 158.8 L450.4 159.8 L448.9 164.2 L444.9 168.7 L439.6 172.7 L434.5 175.7 L422.6 180.4 L384.9 191 L384.9 192.9 L384.9 201.8 L376.9 198.3 L374.5 197.6 L368.2 201.4 L320.4 211 L315.4 211.4 L311.3 212.7 L306.5 215.7 L299.1 221.6 L294.6 222.9 L274.7 224.4 L263.8 227.2 L244.3 234.5 L237.9 232.3 L231 231.2Z";
const BALATON_BBOX = { x: 150, y: 153.8, width: 350.7, height: 186.6 };

// Kis, azonos-léptékű körvonalak (ugyanabból a design-canvasból) a "többi
// nagy tó" összevető ábrájához: Balaton, Fertő, Tisza-tó, egy 400x140-es
// rajzterületen.
const LAKE_COMPARE_PATHS = {
  balaton: { d: "M142 65.2 L136.5 70.4 L72 98.1 L68.2 101.2 L64.8 105.2 L55.4 112.1 L51.7 113.9 L41.9 114.9 L24.1 111.5 L14.2 111.3 L6.2 114 L2.4 113.6 L0 109.1 L3.4 97.1 L12.6 96.9 L22.2 100.3 L26.7 98.9 L28.1 94.5 L31.6 90.5 L35.9 87.4 L40 86.2 L48.6 86.9 L52.8 88.3 L56.6 90.9 L68.3 82.1 L74.8 78.7 L86.8 76.9 L89.4 75.4 L93.9 68.4 L96.8 64.6 L99.3 63.2 L102.2 62.7 L130.9 51.2 L134.7 46.6 L136.2 47.5 L143.9 54.2 L147.2 54.7 L149.3 50.9 L147.8 46.5 L144.5 42.8 L140.9 40.9 L140.9 38.7 L163.6 25.9 L170.7 20.3 L173.8 16.7 L176.9 11.9 L179.4 6.5 L180.2 1.2 L182.4 0 L187.3 0.9 L197.3 4.5 L201.4 6.9 L206.4 10.9 L210.2 15.5 L210.4 19.3 L207.1 24.9 L202.8 34.7 L198.9 38.7 L189.6 44.1 L157.8 55.2 L156.2 55.4 L153.4 54.7 L152.1 56.1 L148.8 61.3 L142 65.2Z", transform: "" },
  ferto: { d: "M24.6 31.9 L17.6 43.9 L13.9 51.7 L12.5 55.4 L10.5 65.6 L11.4 74.7 L16 74.5 L20.5 72.5 L24.8 77.1 L26 82.4 L24.7 85.7 L23.2 87.2 L20.2 84.5 L17.3 83.8 L12.1 81.7 L8.8 73.4 L6.1 65.8 L3.3 64.6 L3.7 70.3 L2.4 74.2 L0 70.2 L1 64.1 L3.8 61.9 L4.6 59.6 L2.8 57.2 L2.6 49.1 L5.2 39.5 L7.6 33.2 L8.6 23.3 L9.7 17.5 L12.7 11.4 L18.4 4.8 L26.2 1.6 L32.9 0 L36 2.4 L35.7 9.6 L33.4 18.6 L29.9 25.1 L27.9 27.9 L24.6 31.9Z", transform: "translate(250,10)" },
  tiszato: { d: "M0 25.5 L3.9 13.1 L7.6 5.2 L10.2 2.9 L14.7 0.1 L19.6 0 L20.6 4.1 L20.7 7.1 L18 11.4 L14.7 15.7 L11.9 20.8 L8.6 25 L2.1 27.4 L0 25.5Z", transform: "translate(330,70)" },
};

function waterNum(n, maxDecimals = 1) {
  return n.toLocaleString("hu-HU", { maximumFractionDigits: maxDecimals });
}

function waterBalatonCount(liters, decimals = 1) {
  return waterNum(liters / BALATON_LITERS, decimals);
}

// Vonalkázás-sűrűség = "mennyire nedves": minél kisebb a mintaegység, annál
// sűrűbb a vonal. 5 fokozat, a már meglévő SOIL_MOISTURE_BANDS szellemében,
// csak finomabb bontásban (ez egy ábrához kell, nem egy szöveges címkéhez).
const WATER_HATCH_TILE_PX = [12, 8, 6, 4.5, 3.5];

function waterHatchIndex(fraction0to1) {
  const pct = fraction0to1 * 100;
  if (pct < 15) return 0;
  if (pct < 25) return 1;
  if (pct < 32) return 2;
  if (pct < 40) return 3;
  return 4;
}

function waterHatchDefs() {
  return WATER_HATCH_TILE_PX.map((tile, i) => `
    <pattern id="wh${i}" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="${tile}" height="${tile}" fill="var(--bg)"></rect>
      <line x1="${tile / 2}" y1="0" x2="${tile / 2}" y2="${tile}" stroke="var(--fg)" stroke-width="1.2"></line>
    </pattern>`).join("");
}

// ---- 1. Talajvíz: Balaton-alakú rétegek ----
//
// Minden mélységi sáv egy VÍZSZINTES CSÍKJA a Balaton körvonalának, a sáv
// liter-arányos magasságú (clipPath-tel vágva, nem a path újrarajzolásával -
// ez garantálja, hogy minden csík pontosan a megfelelő, torzítatlan darabja
// a tó alakjának). A legmélyebb sáv alul, a legfelső (0-1cm) felül, mint egy
// talajszelvény.
function renderBalatonStack(svgEl, depthBandsCm, litersByDepth, moistureByDepth) {
  const counts = litersByDepth.map(l => l / BALATON_LITERS);
  const dataSum = counts.reduce((a, b) => a + b, 0) || 1;
  const MIN_FRACTION = 0.06; // a legkisebb sáv is látszódjon
  const floorSum = MIN_FRACTION * counts.length;
  const remaining = Math.max(0, 1 - floorSum);
  const fractions = counts.map(c => MIN_FRACTION + remaining * (c / dataSum));
  const fracSum = fractions.reduce((a, b) => a + b, 0) || 1;
  const normFractions = fractions.map(f => f / fracSum);

  const order = [4, 3, 2, 1, 0]; // legmélyebb alul .. legfelső (0-1cm) felül
  const bottom = BALATON_BBOX.y + BALATON_BBOX.height;
  let cursorY = bottom;
  const rows = {};
  for (const i of order) {
    const h = normFractions[i] * BALATON_BBOX.height;
    rows[i] = { top: cursorY - h, height: h, mid: cursorY - h / 2 };
    cursorY -= h;
  }

  let defs = `<defs>${waterHatchDefs()}<clipPath id="wbstack-outline"><path d="${BALATON_PATH}"></path></clipPath>`;
  for (const i of order) {
    defs += `<clipPath id="wbstack-slice-${i}"><rect x="0" y="${rows[i].top.toFixed(1)}" width="640" height="${(rows[i].height + 0.5).toFixed(1)}"></rect></clipPath>`;
  }
  defs += "</defs>";

  const bands = order.map(i => {
    const hatch = waterHatchIndex(moistureByDepth[i]);
    return `<g clip-path="url(#wbstack-slice-${i})"><path d="${BALATON_PATH}" fill="url(#wh${hatch})" stroke="var(--fg)" stroke-width="1" stroke-linejoin="round" clip-path="url(#wbstack-outline)"></path></g>`;
  }).join("");

  const labels = order.map(i => {
    const [lo, hi] = depthBandsCm[i];
    const pct = Math.round(moistureByDepth[i] * 100);
    return `<g font-size="13" text-anchor="start">
      <text x="520" y="${(rows[i].mid - 4).toFixed(1)}" fill="var(--fg)" font-weight="600">${lo}–${hi} cm</text>
      <text x="520" y="${(rows[i].mid + 11).toFixed(1)}" fill="var(--muted)">${waterBalatonCount(litersByDepth[i], 2)} Balaton · ${pct}% víz</text>
    </g>`;
  }).join("");

  svgEl.innerHTML = defs + bands + labels;
}

// ---- 2. Országtérkép: talajnedvesség-dombormű + folyók + tavak ----
//
// Izometrikus kocka-rács: minden Magyarországon belüli talaj-cella egy
// kocka, a magassága a cella liter-összegéből. A folyó- és tó-mérőállomások
// UGYANAZZAL a lat/lon -> rács -> képernyő vetítéssel kerülnek a térképre,
// tehát pontosan a megfelelő helyre esnek. A puffer/szomszéd-pontok (ld.
// soil-moisture-mapper in_hungary=false) NEM jelennek meg ezen a térképen -
// túlzsúfolt lenne, és a jóváhagyott design sem különbözteti meg őket.
const WATER_CELL_W = 20;
const WATER_SKEW_X = 10;
const WATER_SKEW_Y = 14;
// Lapos: a korábbi 100/10 px-es magasság-tartomány a cellák közti 14 px-es
// sor-eltolódáshoz képest annyira magas volt, hogy a kockák egymásra
// tornyosulva elnyelték az ország alakját (a felhasználó szerint "nem
// látszik a forma"). Alacsonyabb magasság-tartomány mellett a rács
// FÖLDRAJZI körvonala (ahol egyáltalán van/nincs kocka) marad a fő
// olvasat, a magasság csak finom kiegészítő jelzés.
const WATER_MAX_CUBE_H = 26;
const WATER_MIN_CUBE_H = 4;

function waterProjectRowCol(row, col, originX, originY) {
  return { x: originX + col * WATER_CELL_W - row * WATER_SKEW_X, y: originY + row * WATER_SKEW_Y };
}

function waterIsoCube(x, yBase, h, tierIndex) {
  const w = WATER_CELL_W, skx = WATER_SKEW_X, sky = WATER_SKEW_Y;
  const yTop = yBase - h;
  const topOpacity = [0.1, 0.22, 0.36, 0.52, 0.7][tierIndex];
  return (
    `<path d="M${x.toFixed(1)} ${yBase.toFixed(1)}h${w}v${-h.toFixed(1)}h${-w}z" fill="var(--fg)" fill-opacity="0.78" stroke="var(--bg)" stroke-width="0.5"></path>` +
    `<path d="M${(x + w).toFixed(1)} ${yBase.toFixed(1)}l${skx} ${-sky}v${-h.toFixed(1)}l${-skx} ${sky}z" fill="var(--fg)" fill-opacity="0.56" stroke="var(--bg)" stroke-width="0.5"></path>` +
    `<path d="M${x.toFixed(1)} ${yTop.toFixed(1)}h${w}l${skx} ${-sky}h${-w}z" fill="var(--fg)" fill-opacity="${topOpacity}" stroke="var(--bg)" stroke-width="0.5"></path>`
  );
}

function waterMarker(x, y, label, sublabel) {
  return `<g>
    <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.3"></circle>
    <text x="${x.toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="11" text-anchor="middle" fill="var(--fg)" stroke="var(--bg)" stroke-width="3" paint-order="stroke" font-weight="600">${label}</text>
    <text x="${x.toFixed(1)}" y="${(y + 13).toFixed(1)}" font-size="10" text-anchor="middle" fill="var(--muted)" stroke="var(--bg)" stroke-width="3" paint-order="stroke">${sublabel}</text>
  </g>`;
}

function buildReliefMap(svgEl, legendEl, soilSnapshot, riverStations, lakeStations, highlightLoc) {
  const cells = soilSnapshot.points.filter(p => p.in_hungary);
  if (!cells.length) {
    svgEl.innerHTML = "";
    legendEl.textContent = "a dombormű-adat jelenleg nem érhető el";
    return;
  }

  const step = soilSnapshot.grid_step_deg;
  const lats = cells.map(p => p.lat), lons = cells.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons);
  const toRowCol = (lat, lon) => ({ row: (maxLat - lat) / step, col: (lon - minLon) / step });

  const litersValues = cells.map(p => p.liters_total);
  const minL = Math.min(...litersValues), maxL = Math.max(...litersValues);
  const tierFor = liters => {
    if (maxL <= minL) return 2;
    return Math.min(4, Math.floor(((liters - minL) / (maxL - minL)) * 5));
  };
  const heightFor = liters => {
    if (maxL <= minL) return (WATER_MAX_CUBE_H + WATER_MIN_CUBE_H) / 2;
    return WATER_MIN_CUBE_H + ((liters - minL) / (maxL - minL)) * (WATER_MAX_CUBE_H - WATER_MIN_CUBE_H);
  };

  // A rács befoglaló méretéből skálát és origót számolunk, hogy a teljes
  // dombormű (kockák + a legmagasabb kocka magassága) beleférjen a
  // viewBox-ba, a tetején elég hellyel a folyó-/tó-feliratoknak.
  const rowsAll = cells.map(p => toRowCol(p.lat, p.lon).row);
  const colsAll = cells.map(p => toRowCol(p.lat, p.lon).col);
  const maxRow = Math.max(...rowsAll), maxCol = Math.max(...colsAll);
  const gridPixelWidth = (maxCol + 1) * WATER_CELL_W + maxRow * WATER_SKEW_X;
  const originX = Math.max(20, (640 - gridPixelWidth) / 2 + maxRow * WATER_SKEW_X);
  const originY = 70;

  let cubesMarkup = "";
  let maxCell = cells[0], minCell = cells[0];
  for (const cell of cells) {
    if (cell.liters_total > maxCell.liters_total) maxCell = cell;
    if (cell.liters_total < minCell.liters_total) minCell = cell;
    const { row, col } = toRowCol(cell.lat, cell.lon);
    const { x, y } = waterProjectRowCol(Math.round(row), Math.round(col), originX, originY);
    cubesMarkup += waterIsoCube(x, y, heightFor(cell.liters_total), tierFor(cell.liters_total));
  }

  const projectLatLon = (lat, lon) => {
    const { row, col } = toRowCol(lat, lon);
    return waterProjectRowCol(row, col, originX, originY);
  };

  let markersMarkup = "";
  for (const station of riverStations) {
    const { x, y } = projectLatLon(station.lat, station.lon);
    markersMarkup += waterMarker(x, y, station.name, `${waterNum(station.level_cm, 0)} cm`);
  }
  for (const station of lakeStations) {
    if (station.station === "Balaton average") continue; // a 3 mérce elég, az átlag külön szekcióban van
    const { x, y } = projectLatLon(station.lat, station.lon);
    markersMarkup += waterMarker(x, y, station.station, `${waterNum(station.level_cm, 0)} cm`);
  }

  if (highlightLoc) {
    const { x, y } = projectLatLon(highlightLoc.lat, highlightLoc.lon);
    markersMarkup += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="none" stroke="var(--fg)" stroke-width="1.5"></circle>`;
  }

  svgEl.innerHTML = `<defs></defs>${cubesMarkup}${markersMarkup}`;

  legendEl.innerHTML = `Minden kocka egy kb. ${Math.round(step * 111)} × ${Math.round(step * 111)} km-es cella, olyan magas, amennyi víz van alatta. Nem domborzat: a magasság a víz. A pontok a folyók és a tavak mai vízállását mutatják, centiméterben.`;
}

// ---- 2b. Folyók: önálló lista, kattintható állomások ----
//
// Minden sor koppintásra nyit/csuk, és csak ELSŐ nyitáskor rajzolja fel a
// grafikonját (nem mindegyiket előre, ha a felhasználó sosem nyitja ki).
// A grafikon a hydroinfo.hu 6 napos előrejelzését (ingyen jön a már
// amúgy is lekért táblából) és a soil-moisture-mapper saját historikus
// naplójából visszaolvasott korábbi vízállást (history.jsonl, ld. a
// rivers-snapshot station.history mezőjét) köti össze egy közös
// grafikonon, "most" elválasztóval.
function buildRiverList(container, stations) {
  container.innerHTML = "";
  for (const station of stations) {
    const row = document.createElement("div");
    row.className = "water-river-row";
    const head = document.createElement("div");
    head.className = "water-river-row-head";
    head.innerHTML =
      `<span class="water-river-name">${station.river} · ${station.name}</span>` +
      `<span class="water-river-level">${waterNum(station.level_cm, 0)} cm</span>`;
    const chartWrap = document.createElement("div");
    chartWrap.className = "water-river-chart-wrap";
    const chartSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chartSvg.setAttribute("viewBox", "0 0 400 110");
    chartSvg.setAttribute("preserveAspectRatio", "none");
    chartWrap.appendChild(chartSvg);

    let built = false;
    head.addEventListener("click", () => {
      row.classList.toggle("open");
      if (row.classList.contains("open") && !built) {
        renderRiverChart(chartSvg, station);
        built = true;
      }
    });

    row.appendChild(head);
    row.appendChild(chartWrap);
    container.appendChild(row);
  }
}

function renderRiverChart(svgEl, station) {
  const historyVals = (station.history || []).map(h => h.level_cm);
  const forecastVals = station.forecast_cm || [];
  const series = [...historyVals, station.level_cm, ...forecastVals];
  const todayIdx = historyVals.length;

  if (series.length < 2) {
    svgEl.innerHTML = `<text x="10" y="55" font-size="12" fill="var(--muted)">még nincs elég adat a grafikonhoz</text>`;
    return;
  }

  const minV = Math.min(...series), maxV = Math.max(...series);
  const span = Math.max(maxV - minV, 1);
  const padX = 8, padY = 14, w = 400 - padX * 2, h = 110 - padY * 2 - 12;
  const xFor = i => padX + (i / (series.length - 1)) * w;
  const yFor = v => padY + h - ((v - minV) / span) * h;

  const pastPoints = series.slice(0, todayIdx + 1).map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`);
  const futurePoints = series.slice(todayIdx).map((v, i) => `${xFor(todayIdx + i).toFixed(1)},${yFor(v).toFixed(1)}`);
  const todayX = xFor(todayIdx).toFixed(1);

  let dots = "";
  for (let i = 0; i < series.length; i++) {
    dots += `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(series[i]).toFixed(1)}" r="1.5" fill="var(--muted)"></circle>`;
  }

  svgEl.innerHTML = `
    <line x1="${todayX}" y1="${padY}" x2="${todayX}" y2="${(padY + h).toFixed(1)}" stroke="var(--border)" stroke-width="1"></line>
    <text x="${todayX}" y="${(padY - 3).toFixed(1)}" font-size="10" fill="var(--muted)" text-anchor="middle">most</text>
    <polyline points="${pastPoints.join(" ")}" fill="none" stroke="var(--fg)" stroke-width="1.5"></polyline>
    <polyline points="${futurePoints.join(" ")}" fill="none" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="3 3"></polyline>
    ${dots}
    <circle cx="${todayX}" cy="${yFor(station.level_cm).toFixed(1)}" r="2.5" fill="var(--fg)"></circle>
    <text x="${padX}" y="${(padY + h + 12).toFixed(1)}" font-size="10" fill="var(--muted)">${historyVals.length > 0 ? "múlt" : ""}</text>
    <text x="${(padX + w).toFixed(1)}" y="${(padY + h + 12).toFixed(1)}" font-size="10" fill="var(--muted)" text-anchor="end">6 napos előrejelzés</text>`;
}

// ---- 3. Személyes: a keresett helyszín talajminta-profilja ----
//
// Mélység-arányos (nem liter-arányos) talajminta-ábra: a sávok tényleges
// vastagsága (0-1, 1-3, 3-9, 9-27, 27-81 cm) adja a magasságot, a
// vonalkázás-sűrűség a víz%-ot. Nincs liter-összeg kiírva (az területhez
// kötött, egy tetszőleges ponthoz nincs értelmes "cella-terület"), csak a
// víztartalom-arány és egy országos átlaghoz mért összevetés.
async function fetchUserSoilProfile(point) {
  const vars = "soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm";
  const data = await openMeteo(
    `${API_BASE}?latitude=${coord(point.lat)}&longitude=${coord(point.lon)}&hourly=${vars}&forecast_days=1&timezone=UTC`
  );
  const times = data.hourly.time;
  const now = Date.now();
  let bestIdx = 0, bestDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(new Date(`${t}:00Z`).getTime() - now);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });
  return WATER_DEPTH_BANDS.map(([lo, hi], i) => {
    const key = `soil_moisture_${lo}_to_${hi}cm`;
    return data.hourly[key][bestIdx];
  });
}

function waterCountryAvgMoisture(soilSnapshot) {
  const areaM2 = soilSnapshot.country_area_km2 * 1e6;
  return soilSnapshot.country_total_by_depth.map((liters, i) => {
    const thicknessM = WATER_DEPTH_BANDS[i][2];
    return liters / (areaM2 * thicknessM * 1000);
  });
}

function waterWeightedAvg(moistureByDepth) {
  const thicknesses = WATER_DEPTH_BANDS.map(b => b[2]);
  const totalThickness = thicknesses.reduce((a, b) => a + b, 0);
  const weighted = moistureByDepth.reduce((sum, m, i) => sum + m * thicknesses[i], 0);
  return weighted / totalThickness;
}

function renderSoilCoreProfile(svgEl, moistureByDepth) {
  const totalDepth = 81;
  const plotTop = 16, plotHeight = 324;
  let y = plotTop;
  const boxes = WATER_DEPTH_BANDS.map(([lo, hi]) => {
    const h = ((hi - lo) / totalDepth) * plotHeight;
    const box = { lo, hi, y, h };
    y += h;
    return box;
  });

  const rects = boxes.map((box, i) => {
    const hatch = waterHatchIndex(moistureByDepth[i]);
    return `<rect x="60" y="${box.y.toFixed(1)}" width="55" height="${box.h.toFixed(1)}" fill="url(#wh${hatch})" stroke="var(--fg)" stroke-width="1"></rect>`;
  }).join("");

  const ticks = [0, 9, 27, 81].map(cm => {
    const yy = plotTop + (cm / totalDepth) * plotHeight;
    return `<line x1="52" y1="${yy.toFixed(1)}" x2="58" y2="${yy.toFixed(1)}" stroke="var(--muted)" stroke-width="1"></line>
      <text x="48" y="${(yy + 4).toFixed(1)}" font-size="13" fill="var(--muted)" text-anchor="end">${cm} cm</text>`;
  }).join("");

  const labels = boxes.map((box, i) => {
    const mid = box.y + box.h / 2;
    const pct = Math.round(moistureByDepth[i] * 100);
    return `<line x1="130" y1="${mid.toFixed(1)}" x2="150" y2="${mid.toFixed(1)}" stroke="var(--fg)" stroke-width="0.75"></line>
      <text x="156" y="${(mid - 3).toFixed(1)}" font-size="14" fill="var(--fg)" font-weight="600">${box.lo}–${box.hi} cm</text>
      <text x="156" y="${(mid + 14).toFixed(1)}" font-size="14" fill="var(--muted)">${pct}% víz</text>`;
  }).join("");

  svgEl.innerHTML = `<defs>${waterHatchDefs()}</defs>${rects}${ticks}${labels}`;
}

// ---- 4. Vízmérleg (sokéves átlag) + "hány Balaton" ----
//
// A fő összegek ellenőrzött, sokéves országos átlagok (MEK, ICPDR, Vízügyi
// Közlemények - ld. a honlap "honnan vannak a számok?" szövegét), NEM napi
// adat - ez statikus marad, csak a "talajban most" szám él.
const WATER_SANKEY_SVG = `
  <defs>
    <pattern id="wsk-air" width="4.5" height="4.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="4.5" height="4.5" fill="var(--bg)"></rect>
      <line x1="2.25" y1="0" x2="2.25" y2="4.5" stroke="var(--fg)" stroke-width="1.2" stroke-opacity="0.45"></line>
    </pattern>
  </defs>
  <g fill="var(--fg)" fill-opacity="0.24">
    <path d="M154 20C208 20 208 72.5 262 72.5V194.5C208 194.5 208 142 154 142Z"></path>
    <path d="M154 208.8C208 208.8 208 235.4 262 235.4V248.1C208 248.1 208 221.6 154 221.6Z"></path>
    <path d="M154 247.7C208 247.7 208 255.5 262 255.5V262.5C208 262.5 208 254.7 154 254.7Z"></path>
    <path d="M154 284.2C208 284.2 208 268.6 262 268.6V274.7C208 274.7 208 290.2 154 290.2Z"></path>
    <path d="M154 320.7C208 320.7 208 284.2 262 284.2V289.1C208 289.1 208 325.7 154 325.7Z"></path>
    <path d="M378 72.5C432 72.5 432 48.5 486 48.5V181.5C432 181.5 432 205.5 378 205.5Z"></path>
    <path d="M378 259.7C432 259.7 432 267.7 486 267.7V308.5C432 308.5 432 300.5 378 300.5Z"></path>
  </g>
  <g fill="var(--fg)" fill-opacity="0.14">
    <path d="M154 154C208 154 208 194.5 262 194.5V235.4C208 235.4 208 194.8 154 194.8Z"></path>
    <path d="M154 229.5C208 229.5 208 248.1 262 248.1V255.5C208 255.5 208 236.9 154 236.9Z"></path>
    <path d="M154 266.2C208 266.2 208 262.5 262 262.5V268.6C208 268.6 208 272.2 154 272.2Z"></path>
    <path d="M154 300.4C208 300.4 208 274.7 262 274.7V284.2C208 284.2 208 309.9 154 309.9Z"></path>
    <path d="M378 205.5C432 205.5 432 197.5 486 197.5V251.7C432 251.7 432 259.7 378 259.7Z"></path>
  </g>
  <path d="M154 341.7C208 341.7 208 289.1 262 289.1V399.3C208 399.3 208 451.9 154 451.9Z" fill="url(#wsk-air)"></path>
  <path d="M378 300.5C432 300.5 432 324.5 486 324.5V423.3C432 423.3 432 399.3 378 399.3Z" fill="url(#wsk-air)"></path>
  <g fill="var(--fg)">
    <rect x="148" y="20" width="6" height="122"></rect>
    <rect x="148" y="154" width="6" height="40.9"></rect>
    <rect x="148" y="208.8" width="6" height="12.7"></rect>
    <rect x="148" y="229.5" width="6" height="7.4"></rect>
    <rect x="148" y="247.7" width="6" height="7"></rect>
    <rect x="148" y="266.2" width="6" height="6.1"></rect>
    <rect x="148" y="284.2" width="6" height="6.1"></rect>
    <rect x="148" y="300.4" width="6" height="9.5"></rect>
    <rect x="148" y="320.7" width="6" height="4.9"></rect>
    <rect x="486" y="48.5" width="6" height="133"></rect>
    <rect x="486" y="197.5" width="6" height="54.1"></rect>
    <rect x="486" y="267.7" width="6" height="40.9"></rect>
  </g>
  <g stroke="var(--fg)" stroke-width="1">
    <rect x="148.5" y="342.2" width="5" height="109.2" fill="url(#wsk-air)"></rect>
    <rect x="486.5" y="325" width="5" height="97.8" fill="url(#wsk-air)"></rect>
  </g>
  <rect x="262" y="72.5" width="116" height="326.8" rx="4" fill="var(--bg)" stroke="var(--fg)" stroke-width="1"></rect>
  <g text-anchor="middle">
    <text x="320" y="200" font-size="13" fill="var(--muted)">Magyarország</text>
    <text x="320" y="224" font-size="20" font-weight="700" fill="var(--fg)">172 km³</text>
    <text x="320" y="242" font-size="13" fill="var(--muted)">egy év alatt</text>
    <text x="320" y="278" font-size="12" fill="var(--muted)">a talajban most</text>
    <text x="320" y="294" font-size="13" font-weight="600" fill="var(--fg)" id="water-sankey-soil-now">…</text>
  </g>
  <g font-size="13" text-anchor="end">
    <text x="140" y="77" fill="var(--fg)" font-weight="600">64,2 km³</text>
    <text x="140" y="93" fill="var(--muted)">Duna</text>
    <text x="140" y="171" fill="var(--fg)" font-weight="600">21,5 km³</text>
    <text x="140" y="187" fill="var(--muted)">Dráva, a Murával</text>
    <text x="140" y="219" fill="var(--muted)">Tisza, Tiszabecs · 6,7</text>
    <text x="140" y="237" fill="var(--muted)">Szamos · 3,9</text>
    <text x="140" y="255" fill="var(--muted)">Bodrog · 3,7</text>
    <text x="140" y="273" fill="var(--muted)">Sajó és Hernád · 3,2</text>
    <text x="140" y="291" fill="var(--muted)">Körösök · 3,2</text>
    <text x="140" y="309" fill="var(--muted)">Maros · 5,0</text>
    <text x="140" y="327" fill="var(--muted)">többi folyó · 2,6</text>
    <text x="140" y="393" fill="var(--fg)" font-weight="600">58,0 km³</text>
    <text x="140" y="409" fill="var(--muted)">eső és hó</text>
  </g>
  <g font-size="13">
    <text x="500" y="111" fill="var(--fg)" font-weight="600">70,0 km³</text>
    <text x="500" y="127" fill="var(--muted)">Duna, Mohácsnál</text>
    <text x="500" y="221" fill="var(--fg)" font-weight="600">28,5 km³</text>
    <text x="500" y="237" fill="var(--muted)">Tisza, Szegednél</text>
    <text x="500" y="284" fill="var(--fg)" font-weight="600">21,5 km³</text>
    <text x="500" y="300" fill="var(--muted)">Dráva, a határon</text>
    <text x="500" y="370" fill="var(--fg)" font-weight="600">52,0 km³</text>
    <text x="500" y="386" fill="var(--muted)">párolgás</text>
    <text x="500" y="402" fill="var(--muted)">talaj, növények, tavak</text>
  </g>
  <g font-size="12" fill="var(--muted)">
    <text x="148" y="466">be: 172 km³</text>
    <text x="492" y="466" text-anchor="end">ki: 172 km³</text>
  </g>`;

function waterBalatonTilesSvg(count) {
  const tileW = 40, tileH = 24, rowCount = 600 / tileW; // 15 csempe/sor
  const fullRows = Math.floor(count / rowCount);
  const remainder = count - fullRows * rowCount;
  const fullHeight = fullRows * tileH;
  const remWidth = remainder * tileW;
  let markup = `<defs><pattern id="wbal-tile" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse"><path transform="translate(2.5,2.5) scale(0.5)" fill="var(--fg)" d="M47.3 21.7 L45.5 23.5 L24 32.7 L22.7 33.7 L21.6 35.1 L18.5 37.4 L17.2 38 L14 38.3 L8 37.2 L4.7 37.1 L2.1 38 L0.8 37.9 L0 36.4 L1.1 32.4 L4.2 32.3 L7.4 33.4 L8.9 33 L9.4 31.5 L10.5 30.2 L12 29.1 L13.3 28.7 L16.2 29 L17.6 29.4 L18.9 30.3 L22.8 27.4 L24.9 26.2 L28.9 25.6 L29.8 25.1 L31.3 22.8 L32.3 21.5 L33.1 21.1 L34.1 20.9 L43.6 17.1 L44.9 15.5 L45.4 15.8 L48 18.1 L49.1 18.2 L49.8 17 L49.3 15.5 L48.2 14.3 L47 13.6 L47 12.9 L54.5 8.6 L56.9 6.8 L57.9 5.6 L59 4 L59.8 2.2 L60.1 0.4 L60.8 0 L62.4 0.3 L65.8 1.5 L67.1 2.3 L68.8 3.6 L70.1 5.2 L70.1 6.4 L69 8.3 L67.6 11.6 L66.3 12.9 L63.2 14.7 L52.6 18.4 L52.1 18.5 L51.1 18.2 L50.7 18.7 L49.6 20.4 L47.3 21.7Z"></path></pattern></defs>`;
  markup += `<rect x="0" y="0" width="600" height="${fullHeight}" fill="url(#wbal-tile)"></rect>`;
  if (remWidth > 0) markup += `<rect x="0" y="${fullHeight}" width="${remWidth.toFixed(1)}" height="${tileH}" fill="url(#wbal-tile)"></rect>`;
  return markup;
}

// ---- 5. Tavak részletesen ----

function renderBalatonFill(svgEl, levelCm) {
  const yFor0cm = 330, pxPerCm = (330 - 186) / 120; // a design vízmércéjének skálája
  const fillTopY = yFor0cm - levelCm * pxPerCm;
  const summerLimitY = yFor0cm - 120 * pxPerCm;
  const winterLimitY = yFor0cm - 110 * pxPerCm;
  svgEl.innerHTML = `
    <defs><clipPath id="wbfill-outline"><path d="${BALATON_PATH}"></path></clipPath></defs>
    <path d="${BALATON_PATH}" fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" stroke-linejoin="round"></path>
    <g clip-path="url(#wbfill-outline)">
      <rect x="0" y="${fillTopY.toFixed(1)}" width="640" height="400" fill="var(--fg)"></rect>
    </g>
    <line x1="${BALATON_BBOX.x}" y1="${summerLimitY.toFixed(1)}" x2="${BALATON_BBOX.x + BALATON_BBOX.width}" y2="${summerLimitY.toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"></line>
    <line x1="${BALATON_BBOX.x}" y1="${winterLimitY.toFixed(1)}" x2="${BALATON_BBOX.x + BALATON_BBOX.width}" y2="${winterLimitY.toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="1 3"></line>
    <g stroke="var(--fg)" stroke-width="1">
      <line x1="566" y1="330" x2="566" y2="186"></line>
      <line x1="562" y1="330" x2="570" y2="330"></line>
      <line x1="562" y1="282" x2="570" y2="282"></line>
      <line x1="562" y1="234" x2="570" y2="234"></line>
      <line x1="562" y1="198" x2="570" y2="198"></line>
      <line x1="562" y1="186" x2="570" y2="186"></line>
    </g>
    <g font-size="12" fill="var(--muted)">
      <text x="576" y="334">0</text>
      <text x="576" y="286">40</text>
      <text x="576" y="190">120 nyár</text>
      <text x="576" y="208">110 tél</text>
    </g>
    <text x="576" y="${(fillTopY + 4).toFixed(1)}" font-size="13" font-weight="600" fill="var(--fg)">${waterNum(levelCm, 0)} cm</text>`;
}

const WATER_LAKE_BANDS = {
  "Velencei-tó": { lowCm: 140, highCm: 170, axisMin: 0, axisMax: 200 },
  "Tisza-tó": { lowCm: 730, highCm: 740, axisMin: 700, axisMax: 760 },
  "Fertő": { lowCm: null, highCm: null, axisMin: -50, axisMax: 50 },
};

function renderLakeGauge(container, name, levelCm, noteExtra) {
  const band = WATER_LAKE_BANDS[name];
  const wrap = document.createElement("div");
  const valueText = levelCm === null ? "[nincs adat]" : `${waterNum(levelCm, 0)} cm`;
  let gaugeSvg = "";
  if (band.lowCm !== null && levelCm !== null) {
    const span = band.axisMax - band.axisMin;
    const toX = cm => ((cm - band.axisMin) / span) * 400;
    const bandX = toX(band.lowCm), bandW = toX(band.highCm) - bandX;
    const fillW = Math.max(0, Math.min(400, toX(levelCm)));
    gaugeSvg = `<svg viewBox="0 0 400 44" style="display:block;width:100%;height:auto;margin-top:var(--sp-2)" role="img" aria-label="${name}: ${valueText}">
      <rect x="${bandX.toFixed(1)}" y="4" width="${bandW.toFixed(1)}" height="16" fill="var(--bg)" stroke="var(--fg)" stroke-width="0.75" stroke-dasharray="2 2"></rect>
      <rect x="0" y="8" width="${fillW.toFixed(1)}" height="8" fill="var(--fg)"></rect>
      <line x1="0" y1="20" x2="400" y2="20" stroke="var(--muted)" stroke-width="1"></line>
      <g font-size="12" fill="var(--muted)">
        <text x="0" y="38">${band.axisMin}</text>
        <text x="${bandX.toFixed(1)}" y="38" text-anchor="middle">${band.lowCm}</text>
        <text x="${(bandX + bandW).toFixed(1)}" y="38" text-anchor="middle">${band.highCm}</text>
      </g>
    </svg>`;
  }
  wrap.innerHTML = `
    <p class="water-lake-gauge-label">${name}</p>
    <p class="water-lake-gauge-value">${valueText}</p>
    ${gaugeSvg}
    <p class="water-lake-gauge-note">${noteExtra}</p>`;
  container.appendChild(wrap);
}

// ---- Fő összerakó: lekéri a három snapshotot, feltölti a szekciókat ----

async function fetchWaterSnapshot(name) {
  const res = await fetch(`${PUSH_WORKER_URL}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

function findRiverStation(stations, river, name) {
  return stations.find(s => s.river === river && s.name === name);
}

function findLakeStation(stations, lake, station) {
  return stations.find(s => s.lake === lake && s.station === station);
}

async function buildWaterPanel(point) {
  const statusEl = document.getElementById("water-status");
  statusEl.hidden = false;
  statusEl.textContent = "töltés…";

  try {
    const [soil, rivers, lakes] = await Promise.all([
      fetchWaterSnapshot("soil-snapshot"),
      fetchWaterSnapshot("rivers-snapshot"),
      fetchWaterSnapshot("lakes-snapshot"),
    ]);

    // 1. Talajvíz: országos
    const totalCount = waterBalatonCount(soil.country_total_liters, 1);
    document.getElementById("water-soil-balaton-count").textContent = totalCount;
    document.getElementById("water-soil-balaton-label").textContent = "Balatonnyi, 81 cm mélységig";
    document.getElementById("water-soil-exact").textContent =
      `kb. ${waterNum(soil.country_total_liters / 1e9, 0)} milliárd liter`;
    const avgMoisture = waterCountryAvgMoisture(soil);
    renderBalatonStack(
      document.getElementById("water-balaton-stack"),
      soil.depth_bands_cm,
      soil.country_total_by_depth,
      avgMoisture
    );
    document.getElementById("water-soil-section").hidden = false;

    // 2. Országtérkép
    const hungaryCells = soil.points.filter(p => p.in_hungary);
    const maxCell = hungaryCells.reduce((a, b) => (b.liters_total > a.liters_total ? b : a), hungaryCells[0]);
    const minCell = hungaryCells.reduce((a, b) => (b.liters_total < a.liters_total ? b : a), hungaryCells[0]);
    document.getElementById("water-map-headline").textContent =
      `legtöbb víz: ${waterNum(maxCell.liters_total / 1e9, 0)} milliárd liter egy cellában`;
    document.getElementById("water-map-detail").textContent =
      `legkevesebb: ${waterNum(minCell.liters_total / 1e9, 0)} milliárd liter`;
    buildReliefMap(
      document.getElementById("water-relief-map"),
      document.getElementById("water-map-legend"),
      soil,
      rivers.stations,
      lakes.stations,
      point
    );
    document.getElementById("water-map-section").hidden = false;

    // 2b. Folyók: önálló lista, kattintható állomások
    const riverCount = rivers.stations.length;
    const riverNames = [...new Set(rivers.stations.map(s => s.river))];
    document.getElementById("water-rivers-headline").textContent =
      `${riverCount} mérőállomás, ${riverNames.length} nagyobb folyón`;
    document.getElementById("water-rivers-detail").textContent =
      "koppints egy folyóra az előrejelzéshez és a korábbi vízálláshoz";
    buildRiverList(document.getElementById("water-river-list"), rivers.stations);
    document.getElementById("water-rivers-section").hidden = false;

    // 3. Személyes
    document.getElementById("water-local-question").textContent = `és ${point.name || "a keresett helyszín"} környékén?`;
    try {
      const localMoisture = await fetchUserSoilProfile(point);
      const localAvgPct = Math.round(waterWeightedAvg(localMoisture) * 100);
      const countryAvgPct = Math.round(waterWeightedAvg(avgMoisture) * 100);
      document.getElementById("water-local-total").textContent = `${localAvgPct}% átlagos víztartalom`;
      document.getElementById("water-local-compare").textContent =
        localAvgPct >= countryAvgPct
          ? `az országos átlag (${countryAvgPct}%) felett`
          : `az országos átlag (${countryAvgPct}%) alatt`;
      const surfacePct = Math.round(localMoisture[0] * 100);
      const deepPct = Math.round(localMoisture[4] * 100);
      document.getElementById("water-local-profile-text").textContent =
        surfacePct > deepPct
          ? "felül nedvesebb, mélyebben alig van víz"
          : surfacePct < deepPct
            ? "mélyebben van több víz, mint felül"
            : "a mélység mentén egyenletes a víztartalom";
      renderSoilCoreProfile(document.getElementById("water-soil-core"), localMoisture);
      document.getElementById("water-local-section").hidden = false;
    } catch (err) {
      console.error(err);
      document.getElementById("water-local-section").hidden = true;
    }

    // 4. Vízmérleg
    document.getElementById("water-sankey").innerHTML = WATER_SANKEY_SVG;
    document.getElementById("water-sankey-soil-now").textContent =
      `${waterNum(soil.country_total_liters / 1e12, 2)} km³`;
    const balanceBalatonCount = 172e9 / (BALATON_LITERS / 1e3); // 172 km³ = 172e9 m³
    const balanceWhole = Math.floor(balanceBalatonCount);
    const balanceFraction = balanceBalatonCount - balanceWhole;
    document.getElementById("water-balance-balaton-count").textContent =
      balanceFraction >= 0.4 && balanceFraction < 0.6
        ? `${balanceWhole} és fél`
        : waterNum(balanceBalatonCount, 1);
    document.getElementById("water-balaton-tiles").innerHTML = waterBalatonTilesSvg(balanceBalatonCount);
    document.getElementById("water-balance-section").hidden = false;

    // 5. Tavak
    const balatonAvg = findLakeStation(lakes.stations, "Balaton", "Balaton average");
    if (balatonAvg) {
      document.getElementById("water-balaton-level").textContent = `${waterNum(balatonAvg.level_cm, 0)} cm`;
      document.getElementById("water-balaton-detail").textContent = "a siófoki mércén mért országos átlag";
      renderBalatonFill(document.getElementById("water-balaton-fill"), balatonAvg.level_cm);
    }
    document.getElementById("water-lake-compare").innerHTML =
      `<g fill="var(--fg)">` +
      Object.values(LAKE_COMPARE_PATHS).map(p => `<path${p.transform ? ` transform="${p.transform}"` : ""} d="${p.d}"></path>`).join("") +
      `</g><g font-size="12" fill="var(--muted)" text-anchor="middle">` +
      `<text x="105" y="134">Balaton</text><text x="268" y="134">Fertő</text><text x="340" y="114">Tisza-tó</text></g>`;

    const gaugesEl = document.getElementById("water-lake-gauges");
    gaugesEl.innerHTML = "";
    const velencei = findLakeStation(lakes.stations, "Velencei-tó", "Agárd");
    renderLakeGauge(gaugesEl, "Velencei-tó", velencei ? velencei.level_cm : null, "ideális legalább 140 cm, felső határ 170 cm");
    const tiszato = findRiverStation(rivers.stations, "Tisza", "Kisköre alsó");
    renderLakeGauge(gaugesEl, "Tisza-tó", tiszato ? tiszato.level_cm : null, "a Kisköre alsó mérce adata, nem feltétlenül a tó üzemvízszintjével egyező skálán");
    const ferto = findLakeStation(lakes.stations, "Fertő", "Fertőrákos");
    renderLakeGauge(gaugesEl, "Fertő", ferto ? ferto.level_cm : null, "a fertőrákosi mérce napi vízállása");
    document.getElementById("water-lakes-section").hidden = false;

    statusEl.hidden = true;
  } catch (err) {
    console.error(err);
    statusEl.textContent = "a vízadatok most nem érhetők el";
  }
}

function resetWaterPanel() {
  const panel = document.getElementById("water-panel");
  panel.hidden = true;
  for (const id of ["water-soil-section", "water-map-section", "water-rivers-section", "water-local-section", "water-balance-section", "water-lakes-section"]) {
    document.getElementById(id).hidden = true;
  }
  document.getElementById("water-status").hidden = false;
  document.getElementById("water-status").textContent = "töltés…";
}

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
