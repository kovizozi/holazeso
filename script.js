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

// A keresési sugár (SEARCH_RINGS) azt dönti el, mennyire kell távol keresni
// esőt, de NEM azt, amennyit a radaron látni akarunk: ha a találat közel van
// (akár a 60 km-es "környék"-en, akár csak a 100-150 km-es gyűrűn belül), a
// radar vizuálisan ennél messzebb kell mutasson, különben az országhatár (és
// most már a folyók/Balaton, ld. radarDrawWaterGeo) sosem fér bele látható
// méretbe egy ilyen kis körben - a felhasználó nem látja, az ország melyik
// részén áll. Magyarország legeldugottabb pontja (a határtól legtávolabb eső
// hely, kb. Szolnok térségében) kb. 112 km-re van bármelyik határtól, ezért a
// 220 km-es alsó korlát bőséges ráhagyással mindenhonnan mutat határt.
// Ezt a radarEnsureMinRadius() érvényesíti, MINDEN keresés végén (ld.
// revealPhase PHASE_DONE ága), nem csak egy adott fázisban: nem keresünk
// újra, csak egy tisztán vizuális, radarAddTier hívással kijjebb húzzuk a
// kört.
const RADAR_MIN_VISUAL_RADIUS_KM = 220;

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
  rememberRecentLocation(loc);
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

// UX-audit "mentett helyek" (PROGRESS.md, Later roadmap): nem fiókos
// kedvencek, hanem az utoljára HASZNÁLT (nem a Budapest-tartalék, ld.
// tryAutoLocate catch ága) helyszínek, legfeljebb 5, legújabb elöl - a
// visszatérő látogató egy koppintással válthat köztük, újbóli gépelés
// nélkül, a #location-picker alján.
const RECENT_LOCATIONS_KEY = "holazeso_recent_locations";
const RECENT_LOCATIONS_MAX = 5;

function rememberRecentLocation(loc) {
  try {
    const recent = loadRecentLocations().filter(r => r.name !== loc.name);
    recent.unshift(loc);
    localStorage.setItem(RECENT_LOCATIONS_KEY, JSON.stringify(recent.slice(0, RECENT_LOCATIONS_MAX)));
  } catch (err) {
    console.error(err);
  }
}

function loadRecentLocations() {
  try {
    const raw = localStorage.getItem(RECENT_LOCATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error(err);
    return [];
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
const BORDERS_URL = "borders.json?v=2";
// A fájl Magyarország gyűrűjét 0,001 fokos egységben kódolja (nem a többi
// ország 0,01-es egységében), hogy a valódi, 848 pontos hazai körvonal (a
// soil-moisture-mapper app/data/hungary_border.json-jéből, ld. ARCHITECTURE)
// ne vágjon le finom részletet a kerekítéssel - ld. decodeDeltaRings hívás.
const BORDERS_SCALE = 1000;
let borderRings = null;
let bordersLoading = null;
let radarOrigin = null;
let radarMaxRadiusKm = 0;
// A határok (és ugyanígy a folyók/Balaton, ld. radarDrawWaterGeo) csak a
// keresés legvégén, a végleges válasszal együtt jelennek meg: keresés közben
// a radar maradjon tiszta, csak a pontokkal.
let bordersVisible = false;

// Delta-kódolt egészek 0,01 fokos egységekben, gyűrűnként/vonalanként
// halmozva. Ez a felére csökkenti a fájlt a nyers koordinátalistához képest.
// Közös a borders.json és a water-geo.json formátuma, csak a tartalmuk más.
function decodeDeltaRings(encoded, scale = 100) {
  return encoded.map(flat => {
    const ring = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < flat.length; i += 2) {
      x += flat[i];
      y += flat[i + 1];
      ring.push([x / scale, y / scale]);
    }
    return ring;
  });
}

function loadBorders() {
  if (bordersLoading) return bordersLoading;
  bordersLoading = fetch(BORDERS_URL)
    .then(res => res.json())
    .then(encoded => {
      borderRings = decodeDeltaRings(encoded, BORDERS_SCALE);
      radarDrawBorders();
    })
    .catch(err => {
      console.error(err);
      borderRings = [];
    });
  return bordersLoading;
}

// ---- Folyók és a Balaton a radaron (water-geo.json) ----
// Ugyanaz az azimutális vetület és ugyanaz a lusta betöltés, mint a
// határoknál - csak másik forrásfájl, amiben nem minden ország, hanem a 3
// legnagyobb folyó (Duna, Tisza, Dráva) és a Balaton valódi körvonala van.
// A folyók (korábban Natural Earth 1:50m "rivers_lake_centerlines", kb. 300
// pont összesen, sok 2-8 pontos töredékkel) a UX-audit "a többi térkép
// folyói undetailed-nek tűnnek" észrevétele miatt ÚJRA lettek generálva: a
// csatorna-térkép adatpipeline-ja (app/channels.py) már amúgy is kinyeri a
// Duna/Tisza/Dráva MINDEN névvel egyező OSM-szakaszát (103 szakasz, kb. 2000
// pont) sokkal finomabb (0,0003 fokos RDP) felbontásban - ezt a MÁR meglévő
// geometriát használjuk itt is, nem kell hozzá új OSM-kivonat. A Balaton
// (lakes) VÁLTOZATLAN marad: az már eddig is jó felbontású volt. A Fertő-tó
// és a Velencei-tó nem szerepel benne: a Tavak-szakasz saját, kézzel
// rajzolt ábrája ettől függetlenül mutatja mindháromat.
const WATER_GEO_URL = "water-geo.json?v=2";
// A folyók finomabb (0,001 fokos) egységben vannak kódolva, mint a tavak
// (0,01) - ld. a fenti kommentet és decodeDeltaRings hívását lent.
const WATER_GEO_RIVER_SCALE = 1000;
let waterGeo = null;
let waterGeoLoading = null;

function loadWaterGeo() {
  if (waterGeoLoading) return waterGeoLoading;
  waterGeoLoading = fetch(WATER_GEO_URL)
    .then(res => res.json())
    .then(encoded => {
      waterGeo = {
        rivers: decodeDeltaRings(encoded.rivers, WATER_GEO_RIVER_SCALE),
        lakes: decodeDeltaRings(encoded.lakes),
      };
      radarDrawWaterGeo();
    })
    .catch(err => {
      console.error(err);
      waterGeo = { rivers: [], lakes: [] };
    });
  return waterGeoLoading;
}

// ---- Domborzat (hillshade) a csatorna-térkép hátterében ----
// A felhasználó többször kérte ("terrarians"/"elevation overlay") - statikus
// fájl, mint a borders.json/water-geo.json, NEM a push-worker KV-n megy át
// (a domborzat sosem változik). A soil-moisture-mapper app/elevation.py-ja
// generálja (ld. ott a fejkommentet): Open-Meteo magassági API, egy 90x40-es
// rács, SZERVER OLDALON előre kiszámolt hillshade (0-255 szürkeárnyalat) -
// a frontendnek csak ki kell rajzolnia, nem kell újraszámolnia a
// lejtő-matekot.
const ELEVATION_URL = "elevation.json?v=1";
let elevationGrid = null;
let elevationLoading = null;

function loadElevation() {
  if (elevationLoading) return elevationLoading;
  elevationLoading = fetch(ELEVATION_URL)
    .then(res => res.json())
    .then(data => { elevationGrid = data; })
    .catch(err => {
      console.error(err);
      elevationGrid = null;
    });
  return elevationLoading;
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
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) return [17, 17, 17];
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

let radarImageToken = 0;

async function drawRadarImage() {
  const el = document.getElementById("radar-image");
  el.removeAttribute("href");
  // Gyors egymás utáni nagyításnál a régebbi kép később is megérkezhet: csak
  // a legutolsó kérés rajzolhat.
  const imageToken = ++radarImageToken;
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
  if (!bordersVisible || imageToken !== radarImageToken) return; // közben új keresés/nagyítás indulhatott

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

// Közös vetítő a határokhoz ÉS a folyókhoz/Balatonhoz: mindkettő ugyanúgy
// lon/lat gyűrűkből (zárt vagy nyitott vonalakból) áll, és ugyanúgy kell
// SVG path "d" attribútummá alakítani, a látható területről kilépő
// szakaszokat megszakítva, nem a peremre lapítva.
function radarProjectRingsToPath(rings) {
  // Olcsó előszűrés szélesség szerint: kis sugárnál a csúcsok túlnyomó része
  // eleve kiesik, így nem kell rájuk gömbi távolságot számolni. A téglalap
  // sarkai a sugárnál messzebbre látnak, ezért a sávot ki kell tágítani.
  const reachKm = radarMaxRadiusKm * RADAR_CORNER_FACTOR;
  const latSpan = (reachKm / 111) * 1.4 + 1;
  let d = "";
  for (const ring of rings) {
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
  return d;
}

function radarDrawBorders() {
  const layer = document.getElementById("radar-borders");
  layer.innerHTML = "";
  if (!bordersVisible || !borderRings || !radarOrigin || !radarMaxRadiusKm) return;

  const d = radarProjectRingsToPath(borderRings);
  if (!d) return;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.classList.add("radar-border");
  layer.appendChild(path);
}

function radarDrawWaterGeo() {
  const layer = document.getElementById("radar-water");
  layer.innerHTML = "";
  if (!bordersVisible || !waterGeo || !radarOrigin || !radarMaxRadiusKm) return;

  const riverD = radarProjectRingsToPath(waterGeo.rivers);
  if (riverD) {
    const riverPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    riverPath.setAttribute("d", riverD);
    riverPath.classList.add("radar-river");
    layer.appendChild(riverPath);
  }

  const lakeD = radarProjectRingsToPath(waterGeo.lakes);
  if (lakeD) {
    const lakePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    lakePath.setAttribute("d", lakeD);
    lakePath.classList.add("radar-lake");
    layer.appendChild(lakePath);
  }
}

// Nagyvárosok feliratai a radaron, hogy az országhatár alakját nem ismerő is
// el tudjon igazodni (places-hu.json, ld. loadPlaces). A nagyítással egyre
// kisebb települések is kiíródnak; az egymást fedőket kihagyjuk.
function radarDrawPlaces() {
  const layer = document.getElementById("radar-places");
  layer.innerHTML = "";
  if (!bordersVisible || !placesList.length || !radarOrigin || !radarMaxRadiusKm) return;

  const maxRank = radarMaxRadiusKm >= 150 ? 1 : radarMaxRadiusKm >= 60 ? 2 : 3;
  const k = radarScaleK();
  const reachKm = radarMaxRadiusKm * RADAR_CORNER_FACTOR;
  const candidates = [];
  for (const p of placesList) {
    if (p.r > maxRank) continue;
    const dist = distanceKm(radarOrigin.lat, radarOrigin.lon, p.lat, p.lon);
    if (dist > reachKm || dist < radarMaxRadiusKm * 0.03) continue;
    const pos = radarProject(bearingBetween(radarOrigin.lat, radarOrigin.lon, p.lat, p.lon), dist, radarMaxRadiusKm);
    if (pos.x < 4 || pos.x > RADAR_W - 4 || pos.y < 8 || pos.y > RADAR_H - 4) continue;
    candidates.push({ p, pos });
  }
  candidates.sort((a, b) => a.p.r - b.p.r);

  // A felirat kb. 11 px-es betű: a szélessége viewBox-egységben a k-val osztva.
  const placed = [];
  const MAX_LABELS = 14;
  for (const c of candidates) {
    if (placed.length >= MAX_LABELS) break;
    const w = (c.p.n.length * 6.2 + 8) / k, h = 14 / k;
    const onRight = c.pos.x > RADAR_W - w - 10;
    const x0 = onRight ? c.pos.x - w : c.pos.x;
    const box = { x0, x1: x0 + w, y0: c.pos.y - h, y1: c.pos.y + 3 / k };
    if (placed.some(b => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
    placed.push(box);
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", c.pos.x.toFixed(1));
    dot.setAttribute("cy", c.pos.y.toFixed(1));
    dot.setAttribute("r", (1.6 / k).toFixed(2));
    dot.classList.add("radar-place-dot");
    layer.appendChild(dot);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", (c.pos.x + (onRight ? -3 : 3) / k).toFixed(1));
    text.setAttribute("y", (c.pos.y - 3 / k).toFixed(1));
    text.setAttribute("text-anchor", onRight ? "end" : "start");
    text.classList.add("radar-place");
    text.textContent = c.p.n;
    layer.appendChild(text);
  }
}

// A radar képpont-léptéke: hány képernyő-képpont jut egy viewBox-egységre.
// Nagyobb képernyőn az SVG szövege is nagyobbra nőne (a #radar-svg max-width
// 720 px, a viewBox 350 egység), ezért a feliratok méretét ennek reciprokával
// osztjuk (--k), így a betűméret mindenhol ugyanannyi képpont marad.
function radarScaleK() {
  const svg = document.getElementById("radar-svg");
  const width = parseFloat(getComputedStyle(svg).width);
  return width > 0 ? width / RADAR_W : 1;
}

function updateRadarScale() {
  document.getElementById("radar-svg").style.setProperty("--k", radarScaleK().toFixed(3));
}

if ("ResizeObserver" in window) {
  new ResizeObserver(() => {
    updateRadarScale();
    if (bordersVisible) radarDrawPlaces();
  }).observe(document.getElementById("radar-svg"));
}

// ---- Nagyítás a keresés VÉGE után ----
// Csak a megjelenített sugarat (radarMaxRadiusKm) változtatjuk: a határok,
// folyók, városfeliratok és a RainViewer-kép ugyanazzal a függvénnyel
// rajzolódnak újra, mint a keresés végén, a korábbi körök pontjait pedig a
// már meglévő tier.scale mechanizmus (CSS transform) igazítja. A keresést, a
// pásztázó vonalat és a RADAR_SWEEP_MS-t nem érintjük.
const RADAR_ZOOM_MIN_LEVEL = -1;
const RADAR_ZOOM_MAX_LEVEL = 3;
const RADAR_ZOOM_MIN_RADIUS_KM = 12;
let radarBaseRadiusKm = 0;
let radarZoomLevel = 0;

function radarZoomTo(level) {
  if (!radarBaseRadiusKm || !bordersVisible) return;
  const clamped = Math.max(RADAR_ZOOM_MIN_LEVEL, Math.min(RADAR_ZOOM_MAX_LEVEL, level));
  const radius = radarBaseRadiusKm / 2 ** clamped;
  if (radius < RADAR_ZOOM_MIN_RADIUS_KM) return;
  if (clamped === radarZoomLevel) return;
  radarZoomLevel = clamped;
  clearRadarPlace();
  radarMaxRadiusKm = radius;
  radarDrawBorders();
  radarDrawWaterGeo();
  radarDrawPlaces();
  drawRadarImage().catch(err => console.error(err));
  radarTierGroups.forEach(tier => {
    tier.scale = tier.maxRadiusKm / radius;
    tier.el.style.transform = `scale(${tier.scale})`;
  });
  updateRadarZoomButtons();
}

function updateRadarZoomButtons() {
  const minRadius = radarBaseRadiusKm / 2 ** (radarZoomLevel + 1);
  document.getElementById("radar-zoom-in").disabled =
    radarZoomLevel >= RADAR_ZOOM_MAX_LEVEL || minRadius < RADAR_ZOOM_MIN_RADIUS_KM;
  document.getElementById("radar-zoom-out").disabled = radarZoomLevel <= RADAR_ZOOM_MIN_LEVEL;
  document.getElementById("radar-zoom-reset").disabled = radarZoomLevel === 0;
}

function radarZoomResetState() {
  radarBaseRadiusKm = 0;
  radarZoomLevel = 0;
}

document.getElementById("radar-zoom-in").addEventListener("click", () => radarZoomTo(radarZoomLevel + 1));
document.getElementById("radar-zoom-out").addEventListener("click", () => radarZoomTo(radarZoomLevel - 1));
document.getElementById("radar-zoom-reset").addEventListener("click", () => radarZoomTo(0));

// Görgővel (Ctrl/Cmd, hogy az oldal görgetését ne vegye el) és két ujjas
// csippentéssel is nagyítható; egy ujjal az oldal görög tovább (CSS
// touch-action: pan-y).
{
  const svg = document.getElementById("radar-svg");
  svg.addEventListener("wheel", event => {
    if (!bordersVisible || !radarBaseRadiusKm || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    radarZoomTo(radarZoomLevel + (event.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  const pointers = new Map();
  let pinchStartDist = 0;
  let pinchStartLevel = 0;
  svg.addEventListener("pointerdown", event => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchStartLevel = radarZoomLevel;
    }
  });
  svg.addEventListener("pointermove", event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size !== 2 || !pinchStartDist) return;
    const [a, b] = [...pointers.values()];
    const ratio = Math.hypot(a.x - b.x, a.y - b.y) / pinchStartDist;
    radarZoomTo(pinchStartLevel + Math.round(Math.log2(ratio)));
  });
  const endPointer = event => { pointers.delete(event.pointerId); pinchStartDist = 0; };
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
}

function radarReset() {
  document.getElementById("radar-tiers").innerHTML = "";
  document.getElementById("radar-places").innerHTML = "";
  radarTierGroups = [];
  radarZoomResetState();
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
  radarDrawWaterGeo();
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

// Lásd RADAR_MIN_VISUAL_RADIUS_KM: minden keresés legvégén, mielőtt az
// országhatár/folyók/Balaton megjelenne, ezzel húzzuk ki a kört, ha a
// találat ennél közelebb volt. Üres ponttömbbel hívja a radarAddTier-t: nem
// keresünk újra és nem rajzolunk új esőpöttyöt, csak a léptéket (és vele a
// korábbi köröket) igazítjuk át.
function radarEnsureMinRadius() {
  if (radarMaxRadiusKm > 0 && radarMaxRadiusKm < RADAR_MIN_VISUAL_RADIUS_KM) {
    radarAddTier([], RADAR_MIN_VISUAL_RADIUS_KM, radarOrigin);
  }
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
    // A lookup-ot csak az isRainingNow ág hagyja figyelmen kívül (az korábban
    // tér vissza, mielőtt idáig érne) - az isRainingSoon ág UX-audit U01/U02
    // óta NEM tér vissza korán, tehát ennek a kezdő lookup-nak IS futnia kell,
    // különben a lenti "if (raining.length > 0) { const { refined } = await
    // lookup; }" null-on bukna el, ha már az 1. gyűrűben volt találat.
    let lookup = !isRainingNow(userForecast) && raining.length > 0 ? startLookup(userLoc, raining[0]) : null;

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
    // "Hamarosan" korábban ÖNÁLLÓ válaszként, saját időablak és a
    // legközelebbi eső keresése NÉLKÜL jelent meg (UX-audit U01/U02): a
    // jelen állapotot (most nem esik) és az előrejelzést (lehet, hogy
    // hamarosan fog) egybemosta, ráadásul teljesen elrejtette a #q2-block-ot.
    // Itt csak egy KIEGÉSZÍTŐ kontextus-sort készítünk elő - a tényleges
    // választ és a 2. fázisú keresést lent, a "Nem"-mel KÖZÖS ágban kapja
    // meg, így a legközelebbi eső innentől ebben az állapotban is látszik.
    // A 3 órás ablak nem kitalált szám: pontosan az, amit soonRainIndex
    // ténylegesen átvizsgál - nem mondunk többet, mint amit tudunk.
    let soonContext = null;
    if (isRainingSoon(userForecast)) {
      const idx = soonRainIndex(userForecast);
      const mm = userForecast.hourly.precipitation[idx];
      const prob = userForecast.hourly.precipitation_probability?.[idx];
      const band = intensityBand(mm);
      const hoursAhead = idx - currentHourIndex(userForecast);
      const probText = typeof prob === "number" ? `${Math.round(prob)}% eséllyel ` : "";
      const etaText = hoursAhead <= 0
        ? "akár ezen az órán belül"
        : hoursAhead === 1 ? "becslés szerint kb. 1 óra múlva" : `becslés szerint kb. ${hoursAhead} óra múlva`;
      soonContext = [
        `A következő 3 órában ${probText}${band.adj} eső várható`,
        etaText,
      ];
    }

    const answer = soonContext ? "Most nem esik" : (raining.length > 0 ? "Igen" : "Nem");

    // Csendes háttérfrissítésnél csak akkor megyünk tovább a távoli
    // keresésre, ha a környék helyzete meg is változott. A "hol esik
    // pontosan" válasz néhány perc alatt nem avul el annyira, hogy megérné
    // érte minden frissítéskor újra végigjárni az összes távoli gyűrűt is:
    // úgy egy nyitva hagyott lap napi több tízezer pontot kérne le.
    const unchanged = silent &&
      document.getElementById("q1-answer").textContent === answer;
    setHero(answer, soonContext);
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
  // koordinátáihoz kell számolni a távolságot/irányt - a névadó
  // pont a keresés során eltolódhatott az esős ponttól, így a kettő nem
  // feltétlenül ugyanaz.
  const isForeign = place.countryCode && userLoc.countryCode && place.countryCode !== userLoc.countryCode;
  const placeLabel = place.name
    ? (isForeign ? `${place.name}, ${place.countryName}` : place.name)
    : "egy közeli térségben";

  const displayDistance = place.name
    ? distanceKm(userLoc.lat, userLoc.lon, place.lat, place.lon)
    : nearest.distance;
  const displayBearing = place.name
    ? bearingBetween(userLoc.lat, userLoc.lon, place.lat, place.lon)
    : nearest.bearing;

  const direction = compassLabel(displayBearing);
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
     ${intensity}`
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
// A panel mindig látható; adatait a radar végleges betöltésekor (PHASE_DONE)
// kéri le, keresésenként egyszer - nem fut bele az 5 percenkénti automatikus
// frissítésbe, mert jóval nehezebb lekérdezés (31+ napos história, több évnyi
// archív összehasonlítás), mint amire a fő keresés épül. Nincs cache:
// egyetlen pontra vonatkozó hívásokról van szó, ez megengedhető egyszerűsítés.
let statsLoading = false;
let statsRunId = 0; // elavult válasz (új keresés közben) nem írhat felül újat

async function buildStatsPanel(point) {
  const runId = ++statsRunId;
  statsLoading = true;
  // Egyértelművé tesszük, hogy minden alábbi adat a KERESETT helyre szól,
  // nem arra a településre, ahol a radar esőt talált.
  document.getElementById("stats-place").textContent =
    `Az adatok helye: ${point.name || "a keresett helyszín"}`;
  const statusEl = document.getElementById("stats-status");
  statusEl.hidden = false;
  statusEl.textContent = "töltés…";
  try {
    const [stats, usual, flood] = await Promise.all([
      fetchUserStats(point),
      fetchUsualPrecipitation(point).catch(err => { console.error(err); return null; }),
      fetchRiverDischarge(point).catch(err => { console.error(err); return null; }),
    ]);
    if (runId !== statsRunId) return;
    const todayIdx = stats.daily.time.indexOf(stats.current.time.slice(0, 10));
    fillPrecipStats(stats, usual, todayIdx);
    fillForecastStats(stats, todayIdx);
    fillTempStats(stats, todayIdx);
    fillWaterStats(stats, flood, point);
    statusEl.hidden = true;
  } catch (err) {
    console.error(err);
    if (runId === statsRunId) statusEl.textContent = "Nem sikerült lekérni a statisztikát. Próbáld újra kicsit később.";
  } finally {
    if (runId === statsRunId) statsLoading = false;
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

// Egy nagy szám a "szokásoshoz képest" sávval: a kitöltés a tényleges érték,
// a függőleges jel a szokásos (3 éves átlag). Ha nincs szokásos érték, vagy
// az elhanyagolható (ld. formatUsualDiff), csak a szám marad.
function statsFigureHtml(label, mm, usualMm) {
  let html = `<span class="stats-figure-value">${formatMm(mm)}<small> mm</small></span>` +
    `<span class="stats-figure-label">${label}</span>`;
  if (typeof usualMm === "number" && usualMm > 0.5) {
    const top = Math.max(mm, usualMm, 0.1);
    const diff = formatUsualDiff(mm, usualMm);
    html += `<span class="stats-usual" role="img" aria-label="${diff}">` +
      `<span class="stats-usual-fill" style="width:${(mm / top * 100).toFixed(1)}%"></span>` +
      `<span class="stats-usual-mark" style="left:${(usualMm / top * 100).toFixed(1)}%"></span></span>` +
      `<span class="stats-usual-text">szokásos: ${formatMm(usualMm)} mm</span>`;
  }
  return html;
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
  const daily = stats.daily.precipitation_sum;
  const sum7d = daily.slice(Math.max(0, todayIdx - 6), todayIdx + 1).reduce((a, b) => a + b, 0);
  const sum30d = daily.slice(Math.max(0, todayIdx - 29), todayIdx + 1).reduce((a, b) => a + b, 0);

  document.getElementById("stats-precip-24h").innerHTML =
    sum24h === null ? "" : statsFigureHtml("24 óra", sum24h, null);
  document.getElementById("stats-precip-7d").innerHTML =
    statsFigureHtml("7 nap", sum7d, usual ? usual.usual7d : null);
  document.getElementById("stats-precip-30d").innerHTML =
    statsFigureHtml("30 nap", sum30d, usual ? usual.usual30d : null);
  document.getElementById("stats-precip-note").textContent = usual
    ? `A szokásos érték az elmúlt ${USUAL_PRECIP_YEARS_BACK} év ilyenkori átlaga.`
    : "";

  const from = Math.max(0, todayIdx - 29);
  const dates = stats.daily.time.slice(from, todayIdx + 1);
  renderSparkline(document.getElementById("stats-precip-chart"), dates, daily.slice(from, todayIdx + 1));
  // Dátumok a tengelyen: az első, a középső és az utolsó nap.
  const axis = document.getElementById("stats-precip-axis");
  axis.innerHTML = dates.length
    ? `<span>${formatStatsDate(dates[0])}</span><span>${formatStatsDate(dates[Math.floor(dates.length / 2)])}</span><span>${formatStatsDate(dates[dates.length - 1])}</span>`
    : "";
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
    rect.setAttribute("fill", "var(--accent)");
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
  hideSparklineTooltip();
  openTooltipBarIndex = index;
  const bars = document.getElementById("stats-precip-chart").querySelectorAll(".stats-bar");
  if (bars[index]) bars[index].classList.add("stats-bar-active");
  const tooltip = document.getElementById("stats-precip-tooltip");
  const leftPercent = ((index + 0.5) / barCount) * 100;
  tooltip.textContent = `${formatStatsDate(dateIso)}: ${formatMm(mm)} mm`;
  tooltip.style.left = `${leftPercent}%`;
  tooltip.hidden = false;
}

function hideSparklineTooltip() {
  openTooltipBarIndex = null;
  const chart = document.getElementById("stats-precip-chart");
  if (chart) chart.querySelectorAll(".stats-bar-active").forEach(el => el.classList.remove("stats-bar-active"));
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
    const hasProb = typeof prob === "number";
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="stats-day-name">${label}</span>` +
      `<span class="stats-day-bar" role="img" aria-label="${hasProb ? `${Math.round(prob)}% eséllyel` : "az esély nem ismert"}">` +
      (hasProb ? `<i style="height:${Math.max(0, Math.min(100, prob))}%"></i>` : "") + `</span>` +
      `<span class="stats-day-prob">${hasProb ? `${Math.round(prob)}%` : "?"}</span>` +
      `<span class="stats-day-mm">kb. ${formatMm(sum)} mm</span>`;
    list.appendChild(li);
  }
}

// Mai és holnapi min-max egy közös hőmérséklet-skálán, a fagypont
// (0 °C) jelölt vonalával. Az SVG szövegei 1 egység = ~1 képpont méretűek
// (a kártya kb. 300 px széles), ezért a betűméret nem torzul.
function renderTempBars(container, rows) {
  const valid = rows.filter(r => typeof r.min === "number" && typeof r.max === "number");
  if (!valid.length) {
    container.innerHTML = "";
    return;
  }
  const lo = Math.min(...valid.map(r => r.min)), hi = Math.max(...valid.map(r => r.max));
  const showZero = lo <= 1 && hi >= -1;
  const scaleLo = (showZero ? Math.min(lo, 0) : lo) - 1;
  const scaleMax = (showZero ? Math.max(hi, 0) : hi) + 1;
  const trackX0 = 62, trackX1 = 238, W = 300, rowH = 30, topPad = 14;
  const H = topPad + valid.length * rowH + 4;
  const xFor = t => trackX0 + ((t - scaleLo) / (scaleMax - scaleLo)) * (trackX1 - trackX0);
  let body = "";
  valid.forEach((r, i) => {
    const y = topPad + i * rowH + rowH / 2;
    const x0 = xFor(r.min), x1 = Math.max(xFor(r.max), x0 + 2);
    body += `<text class="stats-svg-text" x="0" y="${(y + 4).toFixed(1)}">${r.label}</text>` +
      `<line x1="${trackX0}" y1="${y}" x2="${trackX1}" y2="${y}" stroke="var(--border)" stroke-width="1"></line>` +
      `<rect x="${x0.toFixed(1)}" y="${y - 4}" width="${(x1 - x0).toFixed(1)}" height="8" fill="var(--accent)"></rect>` +
      `<text class="stats-svg-text stats-svg-text-strong" x="${(x0 - 5).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end">${formatC(r.min)}°</text>` +
      `<text class="stats-svg-text stats-svg-text-strong" x="${(x1 + 5).toFixed(1)}" y="${(y + 4).toFixed(1)}">${formatC(r.max)}°</text>`;
  });
  let zero = "";
  if (showZero) {
    const zx = xFor(0);
    zero = `<line x1="${zx.toFixed(1)}" y1="${topPad - 4}" x2="${zx.toFixed(1)}" y2="${H - 2}" stroke="var(--fg)" stroke-width="1" stroke-dasharray="2 2"></line>` +
      `<text class="stats-svg-text" x="${zx.toFixed(1)}" y="9" text-anchor="middle">0° fagypont</text>`;
  }
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${valid.map(r => `${r.label}: ${formatC(r.min)} és ${formatC(r.max)} °C között`).join(", ")}">${zero}${body}</svg>`;
}

function fillTempStats(stats, todayIdx) {
  document.getElementById("stats-temp-now").textContent =
    `${formatC(stats.current.temperature_2m)} °C`;

  const todayMin = stats.daily.temperature_2m_min[todayIdx];
  const todayMax = stats.daily.temperature_2m_max[todayIdx];
  const tomorrowIdx = todayIdx + 1;
  const tomorrowMin = stats.daily.temperature_2m_min[tomorrowIdx];
  const tomorrowMax = stats.daily.temperature_2m_max[tomorrowIdx];
  renderTempBars(document.getElementById("stats-temp-bars"), [
    { label: "Ma", min: todayMin, max: todayMax },
    { label: "Holnap", min: tomorrowMin, max: tomorrowMax },
  ]);

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

// A talaj felső rétegének állapota egy 3 fokozatú skálán (száraz, nedves,
// vizes - ugyanazok a határok, mint a SOIL_MOISTURE_BANDS), jelölővel. A
// szakaszok szélessége a határokkal arányos (0, 0,15, 0,35, 0,5 m³/m³).
function renderSoilScale(container, soil, trend) {
  const W = 300, scaleMax = 0.5;
  const segs = [
    { from: 0, to: 0.15, label: "száraz" },
    { from: 0.15, to: 0.35, label: "nedves" },
    { from: 0.35, to: scaleMax, label: "vizes" },
  ];
  const xFor = v => (Math.max(0, Math.min(scaleMax, v)) / scaleMax) * W;
  const current = soilMoistureLabel(soil);
  const rects = segs.map(seg => {
    const x = xFor(seg.from), w = xFor(seg.to) - x;
    const active = seg.label === current;
    return `<rect x="${x.toFixed(1)}" y="2" width="${w.toFixed(1)}" height="22" fill="${active ? "var(--accent)" : "none"}" stroke="var(--fg)" stroke-width="1"></rect>` +
      `<text class="stats-svg-text" x="${(x + w / 2).toFixed(1)}" y="17" text-anchor="middle" style="fill:${active ? "var(--bg)" : "var(--muted)"}">${seg.label}</text>`;
  }).join("");
  const mx = xFor(soil);
  const marker = `<path d="M${(mx - 5).toFixed(1)} 36 L${(mx + 5).toFixed(1)} 36 L${mx.toFixed(1)} 27 Z" fill="var(--accent)"></path>`;
  const arrow = trend === "nő" ? " ↑" : trend === "csökken" ? " ↓" : trend ? " →" : "";
  container.className = "stats-scale";
  container.innerHTML = `<svg viewBox="-1 0 ${W + 2} 40" role="img" aria-label="a talaj felső rétege most ${current}${trend ? `, ${trend}` : ""}">${rects}${marker}</svg>` +
    `<p class="stats-line">A talaj felső rétege most ${current}${trend ? `, ${trend}${arrow}` : ""}</p>`;
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
      trend = delta > 0.02 ? "nő" : delta < -0.02 ? "csökken" : "stabil";
    }
    soilEl.hidden = false;
    renderSoilScale(soilEl, soil, trend);
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
  statsRunId++; // a még úton lévő válasz elavult
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
  loadWaterGeo();    // ugyanúgy lusta, ugyanúgy nem várakoztat
  loadPlaces();      // a radar városfeliratai, ugyanígy
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
        radarEnsureMinRadius();
        bordersVisible = true;
        radarBaseRadiusKm = radarMaxRadiusKm;
        radarZoomLevel = 0;
        updateRadarScale();
        updateRadarZoomButtons();
        radarDrawBorders();
        radarDrawWaterGeo();
        loadPlaces().then(() => { if (bordersVisible) radarDrawPlaces(); });
        drawRadarImage().catch(err => console.error(err));
        // A statisztika-panel is csak most, hogy a radar véglegesen betöltött:
        // megjelenik (mindig látható, nincs nyitógomb), és ekkor tölt be.
        document.getElementById("stats-panel").hidden = false;
        if (currentLoc) buildStatsPanel(currentLoc);
        // A vízadat-panel viszont NEM gombra nyílik: a radar után rögtön
        // megjelenik, nyitva, mert a felhasználó szerint ez folytatja az
        // oldalt, nem egy elrejtendő mellékes részlet.
        // Csak magyarországi helyszínnél: minden adata (hydroinfo.hu mércék,
        // országos vízmérleg, Balaton) Magyarországra vonatkozik, külföldi
        // helynél félrevezető lenne. Ismeretlen országkódnál sem jelenik meg
        // (a run() addigra már megpróbálta pótolni reverse geocodinggal).
        if (currentLoc && currentLoc.countryCode === "HU") {
          document.getElementById("water-panel").hidden = false;
          buildWaterPanel(currentLoc);
        }
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
//
// UX-audit teljesítmény-validáció (PROGRESS.md, Later roadmap): élő
// Lighthouse-méréssel mérve a CLS (Cumulative Layout Shift) 0,297 - messze a
// 0,1-es célérték fölött -, a #loading-nak tulajdonítva. Kipróbáltuk: a FLIP
// célpontját a svg helyett a teljes #loading dobozra váltva a Layout
// Instability API MÉGIS ugyanúgy jelezte a shiftet (PerformanceObserver-rel
// közvetlenül megmérve) - kiderült, hogy ez a böngésző metrikájának valódi
// korlátja, nem egy itteni hiba: a Layout Instability API a LAYOUT-dobozt
// (padding-top: 8rem -> var(--sp-3) a .settled osztálynál) nézi, a
// transformot (ami csak a FESTÉST mozgatja) figyelmen kívül hagyja - FLIP
// a VIZUÁLIS ugrást szünteti meg emberi szemnek, a CLS-metrikát nem téveszti
// meg. Egy valódi javítás a padding-alapú elrendezést teljesen transform-
// alapúra cserélné (fix magasságú doboz, a tartalom csak transform:
// translateY-nal mozogna benne) - ez a keresés-koreográfia (CLAUDE.md 6.
// szabály) CSS-mechanizmusát érintő, nagyobb átalakítás lenne, amit
// szándékosan NEM végeztünk el itt, nehogy a védett, adatvezérelt
// viselkedésbe hibát vigyen be egy becsült, de nem tesztelt CSS-refaktor.
// Ezért a célpont visszakerült a svg-re (az eredeti, bevált viselkedés).
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
// különben ott lógna a helyszín-kereső form alatt. FONTOS: NEM hívja a
// cancelReveal()-t és NEM nulláz a statisztika-/vízadat-panelt (ahogy
// korábban tette) - azt a TÉNYLEGES új keresés kezdete (beginSearchUI) már
// amúgy is elvégzi. Ha itt megszakítanánk egy még folyamatban lévő
// revealPhase(PHASE_DONE)-t, a hozzá tartozó buildWaterPanel hívás NÉMÁN
// elveszne - ez csak akkor derült ki, amikor a "Mégse" (UX-audit U04) a
// korábbi eredményhez térhet vissza anélkül, hogy új keresés indulna, és
// ami emiatt soha nem épülne újra. A #loading elrejtése önmagában elég a
// "ne lógjon a form alatt" célhoz - a radar ÉPPEN emiatt (hidden) nem
// villan fel újra, a benne futó setTimeout-nak viszont hagyni kell lefutni.
function hideLoadingImmediately() {
  const loading = document.getElementById("loading");
  loading.hidden = true;
  loading.classList.remove("settled", "locating");
}

function showError(msg) {
  const el = document.getElementById("location-error");
  // Előbb látszódjon, utána kapjon szöveget: a role="alert" régiót csak a
  // MÁR látható elemen történő szövegváltozásra jelzik megbízhatóan a
  // képernyőolvasók, nem a hidden->látható váltásra magára.
  el.hidden = false;
  el.textContent = msg;
  document.getElementById("location-input").setAttribute("aria-invalid", "true");
}

function clearLocationError() {
  const el = document.getElementById("location-error");
  el.hidden = true;
  el.textContent = "";
  document.getElementById("location-input").setAttribute("aria-invalid", "false");
}

function showResult() {
  document.getElementById("location-picker").hidden = true;
  document.getElementById("result").hidden = false;
}

function renderRecentLocations() {
  const wrap = document.getElementById("recent-locations");
  const list = document.getElementById("recent-locations-list");
  list.innerHTML = "";
  // A JELENLEGI helyszínt nem ajánljuk fel újra - úgyis az van elöl.
  const items = loadRecentLocations().filter(loc => !currentLoc || loc.name !== currentLoc.name);
  if (!items.length) {
    wrap.hidden = true;
    return;
  }
  for (const loc of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = loc.name;
    btn.addEventListener("click", () => {
      clearLocationError();
      saveLocation(loc);
      showResult();
      runAndTrack(loc);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
  wrap.hidden = false;
}

function showPicker() {
  document.getElementById("result").hidden = true;
  document.getElementById("location-picker").hidden = false;
  hideLoadingImmediately();
  renderRecentLocations();
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
    // Ha a böngésző helymeghatározása nem elérhető/engedélyezett, ne
    // kényszerítsük a felhasználót azonnal kézi keresésre - Budapest
    // ésszerű alapértelmezett, azonnali választ ad, a "másik hely"
    // (#change-location) linkkel bármikor átválthat a kézi keresőre.
    // Szándékosan NEM mentjük el mentett helyként (saveLocation) - legközelebb
    // újra megpróbálja az automatikus helymeghatározást, nem ragad be
    // Budapestnél, ha az csak egyszeri hiba volt.
    showLoading(false);
    const loc = { name: "Budapest", lat: 47.4979, lon: 19.0402, countryCode: "HU" };
    showResult();
    runAndTrack(loc);
  }
}

document.getElementById("location-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("location-input");
  clearLocationError();

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
  const label = enabled ? "értesítés kikapcsolása" : "értesíts, ha esni kezd";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  btn.classList.toggle("icon-btn-on", enabled);
}

async function enableNotifications(userLoc) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    alert("A böngésződ nem támogatja az értesítéseket.");
    return;
  }
  // UX-audit U05: korábban egy nem "granted" engedély-válasz (megtagadva
  // vagy csak bezárva, választás nélkül) teljesen csendben tért vissza - a
  // gomb szövege nem változott, semmi nem jelezte, mi történt (vagy nem
  // történt). Minden kimenetnek legyen látható visszajelzése.
  const btn = document.getElementById("notify-toggle");
  const prevText = btn.textContent;
  btn.textContent = "engedély kérése…";
  let permission;
  try {
    permission = await Notification.requestPermission();
  } finally {
    btn.textContent = prevText;
  }
  if (permission === "denied") {
    alert("Az értesítések ebben a böngészőben nem engedélyezhetők.");
    return;
  }
  if (permission !== "granted") {
    alert("Az értesítések bekapcsolásához engedélyezned kell a böngésző kérését.");
    return;
  }

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
  if (!loc) {
    alert("Előbb válassz egy helyszínt.");
    return;
  }
  await enableNotifications(loc);
});

document.getElementById("change-location").addEventListener("click", () => {
  showPicker();
});

document.getElementById("share-location").addEventListener("click", async () => {
  if (!currentLoc) return;
  const params = new URLSearchParams({
    lat: currentLoc.lat.toFixed(5),
    lon: currentLoc.lon.toFixed(5),
    name: currentLoc.name,
  });
  if (currentLoc.countryCode) params.set("cc", currentLoc.countryCode);
  const url = `${location.origin}${location.pathname}?${params.toString()}`;
  const confirmEl = document.getElementById("share-confirm");
  try {
    await navigator.clipboard.writeText(url);
    confirmEl.textContent = "link másolva";
  } catch (err) {
    console.error(err);
    alert(`Nem sikerült a vágólapra másolni, másold ki kézzel: ${url}`);
  }
  setTimeout(() => { confirmEl.textContent = ""; }, 3000);
});

// A water-panel már nem <details>, nincs toggle esemény: megjelenését és
// feltöltését a revealPhase(PHASE_DONE) ág intézi.

document.getElementById("retry-geo").addEventListener("click", () => {
  clearLocationError();
  tryAutoLocate();
});

// Mégse/Escape: a #location-picker EGYETLEN megnyitási útja a #change-location
// gomb (ld. showPicker hívásai), tehát mindig van érvényes korábbi eredmény,
// amihez vissza lehet térni - nem kell külön esetet kezelni "nincs korábbi
// eredmény" helyzetre.
function cancelLocationPicker() {
  clearLocationError();
  showResult();
  document.getElementById("change-location").focus();
}
document.getElementById("cancel-location").addEventListener("click", cancelLocationPicker);
document.getElementById("location-picker").addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancelLocationPicker();
});

// ============================================================================
// Vízadatok: talaj, folyók, tavak, vízmérleg
//
// Három, otthoni gépen (soil-moisture-mapper, külön repó) óránként frissített
// pillanatkép a push-worker KV-jéből: GET /soil-snapshot, /rivers-snapshot,
// /lakes-snapshot (ugyanaz a PUSH_WORKER_URL, ami a push-értesítésekhez is
// kell, ld. fentebb). A panel nem lenyíló: a végleges válasz után, csak
// magyarországi helyszínnél nyílik meg és tölt be (lásd revealPhase), minden
// új keresésnél újra.
// ============================================================================

const BALATON_LITERS = 1.9e12; // ~1,9 km³, több forrásból is megerősített érték
const WATER_DEPTH_BANDS = [[0, 1, 0.01], [1, 3, 0.02], [3, 9, 0.06], [9, 27, 0.18], [27, 81, 0.54]];

// Az EGYETLEN Balaton-ikon path (a design-canvasból), amit minden
// Balaton-ábra használ: a waterBalatonTilesSvg (vízmérleg "hány Balaton"),
// a renderBalatonStack (talajvíz-rétegek) apró csempeként, és a
// renderLakeCards (tavak) a Balaton-kártya körvonalaként.
const BALATON_TILE_ICON_PATH = "M47.3 21.7 L45.5 23.5 L24 32.7 L22.7 33.7 L21.6 35.1 L18.5 37.4 L17.2 38 L14 38.3 L8 37.2 L4.7 37.1 L2.1 38 L0.8 37.9 L0 36.4 L1.1 32.4 L4.2 32.3 L7.4 33.4 L8.9 33 L9.4 31.5 L10.5 30.2 L12 29.1 L13.3 28.7 L16.2 29 L17.6 29.4 L18.9 30.3 L22.8 27.4 L24.9 26.2 L28.9 25.6 L29.8 25.1 L31.3 22.8 L32.3 21.5 L33.1 21.1 L34.1 20.9 L43.6 17.1 L44.9 15.5 L45.4 15.8 L48 18.1 L49.1 18.2 L49.8 17 L49.3 15.5 L48.2 14.3 L47 13.6 L47 12.9 L54.5 8.6 L56.9 6.8 L57.9 5.6 L59 4 L59.8 2.2 L60.1 0.4 L60.8 0 L62.4 0.3 L65.8 1.5 L67.1 2.3 L68.8 3.6 L70.1 5.2 L70.1 6.4 L69 8.3 L67.6 11.6 L66.3 12.9 L63.2 14.7 L52.6 18.4 L52.1 18.5 L51.1 18.2 L50.7 18.7 L49.6 20.4 L47.3 21.7Z";

// A Balaton hossztengelye átlósan dől (DNy-ÉK), nem vízszintes - egy sima
// vízszintes vágás ezért a tó ÉK-i végét MINDIG üresen hagyná, bármekkora
// a vízszint (élő screenshoton ellenőrizve: "Balaton vízszintje furcsán
// néz ki"). A tó-kártya (renderLakeCards) feltöltő téglalapját ezért a tó
// dőlésszögével forgatjuk el, hogy a vízszint-vonal a hossztengelyre
// MERŐLEGESEN haladjon végig a tavon. Az értékek a BALATON_TILE_ICON_PATH
// saját koordinátáiban vannak (az ikon kb. 70 x 38 egység).
const BALATON_TILT_DEG = 66;
const BALATON_TILT_PIVOT = { x: 35.06, y: 20.8 };
const BALATON_TILT_HALF_SPAN = 38.4;

// Kis, azonos-léptékű körvonalak (ugyanabból a design-canvasból) a "többi
// nagy tó" összevető ábrájához: Balaton, Fertő, Tisza-tó, egy 400x140-es
// rajzterületen.
const LAKE_COMPARE_PATHS = {
  balaton: { d: "M142 65.2 L136.5 70.4 L72 98.1 L68.2 101.2 L64.8 105.2 L55.4 112.1 L51.7 113.9 L41.9 114.9 L24.1 111.5 L14.2 111.3 L6.2 114 L2.4 113.6 L0 109.1 L3.4 97.1 L12.6 96.9 L22.2 100.3 L26.7 98.9 L28.1 94.5 L31.6 90.5 L35.9 87.4 L40 86.2 L48.6 86.9 L52.8 88.3 L56.6 90.9 L68.3 82.1 L74.8 78.7 L86.8 76.9 L89.4 75.4 L93.9 68.4 L96.8 64.6 L99.3 63.2 L102.2 62.7 L130.9 51.2 L134.7 46.6 L136.2 47.5 L143.9 54.2 L147.2 54.7 L149.3 50.9 L147.8 46.5 L144.5 42.8 L140.9 40.9 L140.9 38.7 L163.6 25.9 L170.7 20.3 L173.8 16.7 L176.9 11.9 L179.4 6.5 L180.2 1.2 L182.4 0 L187.3 0.9 L197.3 4.5 L201.4 6.9 L206.4 10.9 L210.2 15.5 L210.4 19.3 L207.1 24.9 L202.8 34.7 L198.9 38.7 L189.6 44.1 L157.8 55.2 L156.2 55.4 L153.4 54.7 L152.1 56.1 L148.8 61.3 L142 65.2Z", transform: "" },
  ferto: { d: "M24.6 31.9 L17.6 43.9 L13.9 51.7 L12.5 55.4 L10.5 65.6 L11.4 74.7 L16 74.5 L20.5 72.5 L24.8 77.1 L26 82.4 L24.7 85.7 L23.2 87.2 L20.2 84.5 L17.3 83.8 L12.1 81.7 L8.8 73.4 L6.1 65.8 L3.3 64.6 L3.7 70.3 L2.4 74.2 L0 70.2 L1 64.1 L3.8 61.9 L4.6 59.6 L2.8 57.2 L2.6 49.1 L5.2 39.5 L7.6 33.2 L8.6 23.3 L9.7 17.5 L12.7 11.4 L18.4 4.8 L26.2 1.6 L32.9 0 L36 2.4 L35.7 9.6 L33.4 18.6 L29.9 25.1 L27.9 27.9 L24.6 31.9Z", transform: "translate(250,10)" },
  tiszato: { d: "M0 25.5 L3.9 13.1 L7.6 5.2 L10.2 2.9 L14.7 0.1 L19.6 0 L20.6 4.1 L20.7 7.1 L18 11.4 L14.7 15.7 L11.9 20.8 L8.6 25 L2.1 27.4 L0 25.5Z", transform: "translate(330,70)" },
};

// A Velencei-tó körvonala EGYSZERŰSÍTETT, kézzel megrajzolt séma (a
// water-geo.json-ban csak a Balaton van meg): a tó nyugat-keleti, kb. 10 x 2
// km-es, ez a tó-kártya "alakja". Nem pontos partvonal, csak a kártyák
// egységes megjelenéséhez kell; az arányokat a valódi hossz/szélesség adja.
function velenceiOutlinePath() {
  const pts = [
    [18.535, 47.214], [18.55, 47.206], [18.57, 47.200], [18.59, 47.197], [18.61, 47.199],
    [18.63, 47.206], [18.652, 47.218], [18.664, 47.230], [18.652, 47.234], [18.63, 47.230],
    [18.61, 47.230], [18.585, 47.226], [18.565, 47.222], [18.545, 47.222], [18.532, 47.219],
  ];
  const lonKm = Math.cos(47.21 * Math.PI / 180) * 111;
  const kmToUnits = 6;
  return pts.map(([lon, lat], i) => {
    const x = (lon - 18.53) * lonKm * kmToUnits;
    const y = (47.24 - lat) * 111 * kmToUnits * 0.55; // keskenyebb, mint a térképi arány: séma
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ") + "Z";
}

const LAKE_CARD_PATHS = {
  balaton: BALATON_TILE_ICON_PATH,
  ferto: LAKE_COMPARE_PATHS.ferto.d,
  velencei: velenceiOutlinePath(),
};

function waterNum(n, maxDecimals = 1) {
  return n.toLocaleString("hu-HU", { maximumFractionDigits: maxDecimals });
}

// UX-audit D01: a talaj-/folyó-/tó-adatok "generated_at" mezője (a
// push-worker snapshot-jaiban) már megvan, csak eddig sosem jelent meg - a
// felhasználó nem tudta megkülönböztetni a friss mérést egy elavult
// válasz tól. Mindig dátum+idő, "ma"-trükk nélkül (az elkerüli a
// böngésző-időzóna vs. Budapest időzóna félreértést éjfél körül).
function formatUpdatedAt(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleString("hu-HU", {
    timeZone: "Europe/Budapest",
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
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
      <line x1="${tile / 2}" y1="0" x2="${tile / 2}" y2="${tile}" stroke="var(--accent)" stroke-width="1.2"></line>
    </pattern>`).join("");
}

// ---- 1. Talajvíz: Balaton-alakú rétegek ----
//
// Minden mélységi sáv egy VÍZSZINTES CSÍKJA a Balaton körvonalának, a sáv
// liter-arányos magasságú (clipPath-tel vágva, nem a path újrarajzolásával -
// ez garantálja, hogy minden csík pontosan a megfelelő, torzítatlan darabja
// a tó alakjának). A legmélyebb sáv alul, a legfelső (0-1cm) felül, mint egy
// talajszelvény.
// A korábbi "egy közös Balaton-körvonal, vízszintesen clipPath-elt sávokra
// osztva" próbálkozás élőben (Playwright-tesztelve, mobil és asztali nézetben
// is) vagy levágta a feliratot a jobb szélen, vagy a két legkisebb sáv
// felirata egymásra csúszott - a pontos koordináta-matek bármekkora
// minimum-magasság mellett törékeny maradt. Az azóta frissített terv-canvas
// megoldása ezt elkerüli: NINCS pozicionált SVG-szöveg. Minden sáv egy
// SIMA HTML sor (böngésző intézi a sorközt, nem mi), alatta egy kis,
// apró Balaton-ikonokkal mintázott sáv, aminek a SZÉLESSÉGE arányos a
// liter-mennyiséggel - ugyanaz a minta-csempe trükk, mint a vízmérleg
// "hány Balaton" ábráján (ld. waterBalatonTilesSvg).
function renderBalatonStack(containerEl, depthBandsCm, litersByDepth, moistureByDepth) {
  const counts = litersByDepth.map(l => l / BALATON_LITERS);
  const maxCount = Math.max(...counts, 0.01);
  const BAR_UNITS_PER_BALATON = 46; // ~ a design mintájából (327.5 egység / 7.1 Balaton)

  containerEl.innerHTML = "";
  const list = document.createElement("div");
  list.className = "water-balaton-stack-list";

  for (let i = 0; i < depthBandsCm.length; i++) {
    const [lo, hi] = depthBandsCm[i];
    const pct = Math.round(moistureByDepth[i] * 100);
    const widthUnits = Math.max(2, counts[i] * BAR_UNITS_PER_BALATON);
    const row = document.createElement("div");
    row.innerHTML = `
      <div class="water-balaton-stack-row-head">
        <span style="font-weight: 600;">${lo}–${hi} cm</span>
        <span style="color: var(--muted);">${waterBalatonCount(litersByDepth[i], 2)} Balaton · ${pct}% víz</span>
      </div>
      <svg viewBox="0 0 400 26" class="water-balaton-stack-bar" aria-hidden="true">
        <defs><pattern id="mbal-${i}" width="46" height="26" patternUnits="userSpaceOnUse">
          <path transform="translate(1.5,1.5) scale(0.6)" fill="var(--accent)" d="${BALATON_TILE_ICON_PATH}"></path>
        </pattern></defs>
        <rect x="0" y="0" width="${widthUnits.toFixed(1)}" height="26" fill="url(#mbal-${i})"></rect>
      </svg>`;
    list.appendChild(row);
  }
  containerEl.appendChild(list);
}

// ---- 2. Országtérkép: talajnedvesség-dombormű + folyók + tavak ----
//
// Lapos rács, EGYENES felülnézetben (nem axonometrikus/ferde - korábban
// kipróbáltuk izometrikus kockákkal is, majd ferde-vetítésű lapos cellákkal,
// de a felhasználó szerint ez még mindig túl "térképészeti makett"-szerű
// volt; sima, torzítatlan felülnézet kell, mint egy valódi térkép).
//
// A torzítás korábban onnan jött, hogy a cella szélessége és magassága KÖZÖS,
// tetszőlegesen választott képpont-méretet kapott, holott Magyarország
// szélességén egy hosszúsági fok valódi távolsága kb. cos(47 fok) ~ 0,68-
// szorosa egy szélességi foknak - a rács emiatt vízszintesen széthúzva,
// függőlegesen összenyomva jelent meg. A cella szélessége ezért lent mindig
// a magasság cos(középső szélesség)-szerese (ld. lonFactor), nem önálló
// konstans.
//
// A talajnedvesség maga nem különálló téglalapokként jelenik meg, hanem egy
// folytonos szürke-fokozatú raszterként - ugyanaz a csempe-kompozitálási
// technika, mint a radar saját raszterénél (ld. drawRadarImage): a ritka
// mintarácsot kétlineárisan (bilineárisan) interpolálva kapunk sima
// átmenetet, nem éles téglalap-határokat. A raszter a VALÓDI országhatárra
// van vágva (ld. borderRings), nem a mintarács durva, lépcsős szélére.
function cssVarRgb(name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (!hex) return [128, 128, 128];
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function tierGradientRgb(frac, stops) {
  const t = Math.min(Math.max(frac, 0), 1) * (stops.length - 1);
  const i0 = Math.floor(t), i1 = Math.min(i0 + 1, stops.length - 1), f = t - i0;
  const a = stops[i0], b = stops[i1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Szabványos pont-a-sokszögben teszt (ray casting) - ld. selectCountryBorderRing.
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [loni, lati] = ring[i];
    const [lonj, latj] = ring[j];
    if ((lati > lat) !== (latj > lat) &&
        lon < (lonj - loni) * (lat - lati) / (latj - lati) + loni) {
      inside = !inside;
    }
  }
  return inside;
}

// Gyűrű területe (shoelace-formula, fok²-ben - csak összehasonlításra kell,
// nem valódi km²-re).
function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(area) / 2;
}

// Egyetlen, pontos országhatár-gyűrű kiválasztása a borderRings tömbből (ami
// a VILÁG összes országát tartalmazza egy lapos tömbben, gyűrűnként - ld.
// loadBorders). NEM a "bounds-on kívül megszakítjuk" trükköt használjuk (az
// csak látható VONAL-rajzolásra biztonságos - egy megszakított, több
// darabból álló path kitöltéskor/záráskor minden darabot KÜLÖN automatikusan
// visszazár egy egyenes szakasszal, ami hamis, átlós vágásvonalakat okoz),
// és NEM a bounds befoglaló téglalapjának átfedését nézzük (ez kis, bezoomolt
// bounds-nál - ld. buildChannelsMap - téves eredményt ad: egy nagy szomszédos
// ország befoglalója is könnyen lefedi egy apró kivágás egész területét,
// miközben a valódi alakja egyáltalán nem ott van). Helyette azt a gyűrűt
// választjuk, amelyik TÉNYLEGESEN TARTALMAZZA a bounds középpontját (pont-a-
// sokszögben teszt); ha több egymásba ágyazott gyűrű is tartalmazza (sziget/
// enklávé), a legkisebb területűt - az illik legszorosabban a ponthoz. Minden
// flat (nem azimutális) országtérkép ezt a függvényt használja, hogy a határ
// mindenhol, minden nagyításban ugyanolyan pontos legyen (ld. buildReliefMap,
// buildChannelsMap).
function selectCountryBorderRing(minLon, maxLon, minLat, maxLat) {
  if (!borderRings || !borderRings.length) return null;
  const midLon = (minLon + maxLon) / 2, midLat = (minLat + maxLat) / 2;
  const containing = borderRings.filter(ring => pointInRing(midLon, midLat, ring));
  if (containing.length) {
    return containing.reduce((a, b) => (ringArea(a) < ringArea(b) ? a : b));
  }
  // Fallback, ha a középpont épp nem esik bele semelyik gyűrűbe sem (pl. a
  // bounds középpontja egy folyó/tó miatt kiesik): a legjobban fedő
  // befoglaló téglalap, ahogy korábban.
  let best = null, bestOverlap = -1;
  for (const ring of borderRings) {
    let rMinLon = Infinity, rMaxLon = -Infinity, rMinLat = Infinity, rMaxLat = -Infinity;
    for (const [lon, lat] of ring) {
      if (lon < rMinLon) rMinLon = lon;
      if (lon > rMaxLon) rMaxLon = lon;
      if (lat < rMinLat) rMinLat = lat;
      if (lat > rMaxLat) rMaxLat = lat;
    }
    const ox = Math.max(0, Math.min(rMaxLon, maxLon) - Math.max(rMinLon, minLon));
    const oy = Math.max(0, Math.min(rMaxLat, maxLat) - Math.max(rMinLat, minLat));
    const overlap = ox * oy;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = ring;
    }
  }
  return best;
}

// Lat/lon -> képernyő-vetítés, a hosszúsági fok cos(szélesség)-torzítás-
// korrekciójával (egy fok hosszúság a mi szélességünkön kevesebb valódi
// távolság, mint egy fok szélesség - ld. buildReliefMap fejkomment). A
// bounds-ot a kisebbik irány-skála szerint, torzítás nélkül, középre
// illesztve helyezzük a width x height dobozba. MINDEN flat országtérkép
// ezt használja (dombormű, csatornák), hogy az ország alakja mindenhol
// ugyanolyan arányos legyen.
function fitFlatProjection(minLon, maxLon, minLat, maxLat, width, height) {
  const lonFactor = Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
  const lonSpan = (maxLon - minLon) * lonFactor;
  const latSpan = maxLat - minLat;
  const scale = Math.min(width / lonSpan, height / latSpan);
  const originX = (width - lonSpan * scale) / 2;
  const originY = (height - latSpan * scale) / 2;
  const project = (lat, lon) => ({
    x: originX + (lon - minLon) * lonFactor * scale,
    y: originY + (maxLat - lat) * scale,
  });
  // A pöccre nagyítható/mozgatható csatorna-térkép (buildChannelsMap) a
  // fordított irányhoz (képernyő -> lat/lon, kurzor-középpontú nagyításhoz/
  // húzáshoz) ugyanezt a skálát/origót használja - itt tesszük elérhetővé
  // project tulajdonságaiként, hogy ne kelljen a vetítő-matekot máshol
  // megismételni.
  project.lonFactor = lonFactor;
  project.scale = scale;
  project.originX = originX;
  project.originY = originY;
  return project;
}

// Csak jelölők, FELIRAT NÉLKÜL: egy sűrű rácson (akár 12 folyó-állomás +
// 5 tó-mérce) a mindegyikhez kiírt név+érték élőben kipróbálva olvashatatlan
// tömeggé állt össze (egymást fedő feliratok). A név/érték a külön "és a
// folyók?" listában és a tavak szekcióban már úgyis megvan - a térképen csak
// a HELY számít. Folyó = üres gyűrű, tó = teli gyémánt alak - a kettő forma
// szerint megkülönböztethető szín/felirat nélkül is.
function waterRiverMarker(x, y) {
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.3"></circle>`;
}

function waterLakeMarker(x, y) {
  const r = 3.2;
  return `<path d="M${x.toFixed(1)} ${(y - r).toFixed(1)} L${(x + r).toFixed(1)} ${y.toFixed(1)} L${x.toFixed(1)} ${(y + r).toFixed(1)} L${(x - r).toFixed(1)} ${y.toFixed(1)} Z" fill="var(--accent)"></path>`;
}

// ---- Közös térkép-buborék ----
//
// Egyetlen buborék-komponens a talajtérképhez, a folyóhálózathoz és a
// csatorna-térképhez (UX-terv "Tooltips"): ugyanaz a fordított (fg/bg),
// monokróm doboz, törzsszöveg-méretű betűvel. A buborék a .water-figure
// ELSŐ szintű gyermeke, a figure pedig pontosan akkora, mint az svg (a
// szélesség-korlátot a figure kapja, ld. style.css), ezért a pozíció
// egyszerűen a figure bal-felső sarkához mért pixel.
function mapPopupShow(popupEl, clientX, clientY, html) {
  const figure = popupEl.parentElement;
  const rect = figure.getBoundingClientRect();
  popupEl.innerHTML = html;
  popupEl.hidden = false;
  const w = popupEl.offsetWidth, h = popupEl.offsetHeight;
  const x = Math.min(Math.max(clientX - rect.left, w / 2), Math.max(rect.width - w / 2, w / 2));
  const y = clientY - rect.top;
  // Felül nincs hely: a kurzor ALÁ kerül, nem kilóg a térkép tetején.
  const below = y - h - 12 < 0;
  popupEl.style.left = `${x}px`;
  popupEl.style.top = `${y}px`;
  popupEl.style.transform = below ? "translate(-50%, 12px)" : "translate(-50%, calc(-100% - 12px))";
}

function mapPopupHide(popupEl) {
  if (popupEl) popupEl.hidden = true;
}

// Mini vonaldiagram a buborékba: values egy számsor, a forecastFrom-tól
// kezdve szaggatott (előrejelzés). Szín helyett currentColor, hogy a
// fordított buborékban is olvasható maradjon.
function popupSparklineSvg(values, forecastFrom = null) {
  if (!Array.isArray(values) || values.length < 2) return "";
  const W = 160, H = 36, pad = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const span = Math.max(max - min, 1e-9);
  const xFor = i => pad + (i / (values.length - 1)) * (W - 2 * pad);
  const yFor = v => pad + (H - 2 * pad) - ((v - min) / span) * (H - 2 * pad);
  const pts = values.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`);
  const split = forecastFrom === null ? values.length : Math.max(1, Math.min(values.length, forecastFrom + 1));
  let svg = `<svg class="water-popup-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
  svg += `<polyline points="${pts.slice(0, split).join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></polyline>`;
  if (forecastFrom !== null && split < values.length) {
    svg += `<polyline points="${pts.slice(split - 1).join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3" stroke-linejoin="round"></polyline>`;
  }
  const nowIdx = forecastFrom === null ? values.length - 1 : forecastFrom;
  svg += `<circle cx="${xFor(nowIdx).toFixed(1)}" cy="${yFor(values[nowIdx]).toFixed(1)}" r="2.5" fill="currentColor"></circle></svg>`;
  return svg;
}

// ---- Közös helynévlista (places-hu.json) és megyehatárok ----
//
// Statikus fájlok, egyszer töltődnek be, a böngésző gyorsítótárazza őket
// (mint a borders.json). A hibájuk sosem buktat el semmit: üres lista marad,
// és a térképek egyszerűen felirat nélkül rajzolódnak.
const PLACES_URL = "places-hu.json?v=1";
const COUNTIES_URL = "counties-hu.json?v=1";
let placesList = [];
let placesLoading = null;
let countyRings = [];
let countiesLoading = null;

function loadPlaces() {
  if (placesLoading) return placesLoading;
  placesLoading = fetch(PLACES_URL)
    .then(res => res.json())
    .then(list => { placesList = list; })
    .catch(err => { console.error(err); placesList = []; });
  return placesLoading;
}

function loadCounties() {
  if (countiesLoading) return countiesLoading;
  countiesLoading = fetch(COUNTIES_URL)
    .then(res => res.json())
    .then(data => { countyRings = data.rings || []; })
    .catch(err => { console.error(err); countyRings = []; });
  return countiesLoading;
}

// A cella nevét a területére eső legnagyobb település adja (rang szerint,
// aztán a középponthoz közelebbi), ha egyik sem esik bele, a legközelebbi.
function nearestPlaceName(lat, lon, halfLat, halfLon) {
  if (!placesList.length) return null;
  const lonScale = Math.cos(lat * Math.PI / 180);
  let best = null, bestScore = Infinity;
  for (const p of placesList) {
    const dLat = p.lat - lat, dLon = (p.lon - lon) * lonScale;
    const dist = Math.hypot(dLat, dLon);
    const inside = Math.abs(p.lat - lat) <= halfLat && Math.abs(p.lon - lon) <= halfLon;
    const score = (inside ? 0 : 100) + (inside ? p.r * 10 + dist : dist);
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best ? best.n : null;
}

function buildReliefMap(svgEl, legendEl, soilSnapshot, riverStations, lakeStations, highlightLoc, waterGeo) {
  // A Balaton fölötti cellára az Open-Meteo nem ad talajt, a gyűjtő 0 literrel
  // tárolja. Az ilyen cella nincs-adat: nem számít bele a min/max-ba, a
  // színskálába, és nem festődik a "legszárazabbnak" - a raszterben a
  // legközelebbi VALÓDI cella értékét kapja (ld. valueAt).
  const allCells = soilSnapshot.points.filter(p => p.in_hungary);
  const cells = allCells.filter(p => p.liters_total > 0);
  if (!cells.length) {
    svgEl.innerHTML = "";
    legendEl.textContent = "a dombormű-adat jelenleg nem érhető el";
    return;
  }

  const step = soilSnapshot.grid_step_deg;
  const lats = allCells.map(p => p.lat), lons = allCells.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons);
  const toRowCol = (lat, lon) => ({ row: (maxLat - lat) / step, col: (lon - minLon) / step });

  const litersValues = cells.map(p => p.liters_total);
  const minL = Math.min(...litersValues), maxL = Math.max(...litersValues);
  const fracFor = liters => (maxL <= minL ? 0.5 : (liters - minL) / (maxL - minL));

  const rowsAll = allCells.map(p => toRowCol(p.lat, p.lon).row);
  const colsAll = allCells.map(p => toRowCol(p.lat, p.lon).col);
  const maxRow = Math.max(...rowsAll), maxCol = Math.max(...colsAll);

  // A raszter minden oldalon egy cellával túlnyúlik a mintapontok
  // befoglalóján: az igazi országhatár (északkeleti csúcs, déli perem) akár
  // fél cellányira is kilép a befoglaló téglalapból, és az ott lévő vágó-
  // alakzat mögött nem lenne semmi. A kinti értékeket a valueAt a legközelebbi
  // valódi cellából extrapolálja, tehát csak a vászon és a kép origója változik.
  const PAD = 1;
  const gridRows = maxRow + 1 + 2 * PAD;
  const gridCols = maxCol + 1 + 2 * PAD;

  // lonFactor: egy hosszúsági fok valódi távolsága a szélességi fokhoz
  // képest, a rács középső szélességi fokán (cos) - ld. a szakasz-fejkomment.
  // A kisebbik irány-skála nyer, hogy a teljes rács beleférjen a viewBox-ba
  // torzítás nélkül; a másik irányban üres margó marad, nem nyúlik szét.
  const midLatRad = (minLat + maxLat) / 2 * Math.PI / 180;
  const lonFactor = Math.cos(midLatRad);
  // A viewBox magassága a rács alakjához igazodik (nincs üres sáv a térkép
  // alatt/fölött); az ábra képarányát (--ar) a figure is megkapja, hogy a
  // magasság-korlát (70vh) a valódi arányból számolódjon.
  const VB_W = 640;
  const MARGIN = 10;
  const cellW = (VB_W - 2 * MARGIN) / gridCols;
  const cellH = cellW / lonFactor;
  const gridPixelWidth = gridCols * cellW;
  const gridPixelHeight = gridRows * cellH;
  const VB_H = Math.round(gridPixelHeight + 2 * MARGIN);
  const originX = MARGIN;
  const originY = MARGIN;
  svgEl.setAttribute("viewBox", `0 0 ${VB_W} ${VB_H}`);
  if (svgEl.parentElement) svgEl.parentElement.style.setProperty("--ar", (VB_W / VB_H).toFixed(3));

  // (row, col) = a minta-rács koordinátája; a PAD-nyi ráhagyás beleszámítva.
  const projectRowCol = (row, col) => ({ x: originX + (col + PAD) * cellW, y: originY + (row + PAD) * cellH });
  const projectLatLon = (lat, lon) => {
    const { row, col } = toRowCol(lat, lon);
    const p = projectRowCol(row, col);
    return { x: p.x + cellW / 2, y: p.y + cellH / 2 }; // cella közepére, nem a sarkára
  };

  // A water-geo.json (folyók/Balaton) és a borders.json (országhatár) is
  // SZÁNDÉKOSAN túlnyúlik Magyarországon (a radar azimutális vetítéséhez, ill.
  // a világ összes országához kell). Itt viszont a rács egyenes, lineáris
  // vetület - egy messze kívül eső pont egyenes szakasszal kötné össze a
  // magyarországi résszel, ami a teljes vásznon átszelő, hamis vonalként
  // jelenne meg. Ezért a rács-tartományon kívül eső pontoknál megszakítjuk a
  // vonalat, nem a peremre lapítjuk.
  const BOUNDS_MARGIN = 3;
  const inGridBounds = (row, col) =>
    row >= -BOUNDS_MARGIN && row <= maxRow + BOUNDS_MARGIN &&
    col >= -BOUNDS_MARGIN && col <= maxCol + BOUNDS_MARGIN;
  const ringsToPath = rings => {
    let d = "";
    for (const ring of rings) {
      let connected = false;
      for (const [lon, lat] of ring) {
        const { row, col } = toRowCol(lat, lon);
        if (!inGridBounds(row, col)) {
          connected = false;
          continue;
        }
        const { x, y } = projectLatLon(lat, lon);
        d += `${connected ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
        connected = true;
      }
    }
    return d;
  };

  // --- Talajnedvesség-raszter: ld. a szakasz-fejkomment. Minden kimeneti
  // képpontot a 4 legközelebbi mintapont súlyozott átlagából (bilineáris
  // interpoláció) számolunk. A mintarács az ország szélén lépcsős (nem minden
  // rács-cella esik Magyarországra), de a kimenetnek SZÍN NÉLKÜLI lyukak
  // helyett teljesen ki kell töltenie a befoglaló téglalapot - a valódi
  // alak kialakítását lent, a vágás (clip-path) végzi az országhatárral,
  // nem a mintarács hiányos szélei. Ezért egy hiányzó rács-pontot a hozzá
  // legközelebbi VALÓDI mintapont értékével helyettesítünk (legközelebbi
  // szomszéd extrapoláció), nem hagyjuk üresen.
  const cellRowCols = cells.map(cell => ({ ...toRowCol(cell.lat, cell.lon), cell }));
  const cellGrid = new Map();
  for (const c of cellRowCols) cellGrid.set(`${Math.round(c.row)},${Math.round(c.col)}`, c);
  const nearestCache = new Map();
  const nearestRealAt = (r, c) => {
    const key = `${r},${c}`;
    const exact = cellGrid.get(key);
    if (exact) return exact;
    if (nearestCache.has(key)) return nearestCache.get(key);
    let best = cellRowCols[0], bestDist = Infinity;
    for (const cand of cellRowCols) {
      const d = (cand.row - r) ** 2 + (cand.col - c) ** 2;
      if (d < bestDist) { bestDist = d; best = cand; }
    }
    nearestCache.set(key, best);
    return best;
  };
  const valueAt = (r, c) => nearestRealAt(r, c).cell.liters_total;

  const canvasW = Math.max(1, Math.round(gridPixelWidth));
  const canvasH = Math.max(1, Math.round(gridPixelHeight));
  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(canvasW, canvasH);
  const tierStops = [0, 1, 2, 3, 4].map(i => cssVarRgb(`--t${i}`));

  for (let y = 0; y < canvasH; y++) {
    const rowF = y / cellH - PAD - 0.5;
    const r0 = Math.floor(rowF), r1 = r0 + 1, ty = rowF - r0;
    for (let x = 0; x < canvasW; x++) {
      const colF = x / cellW - PAD - 0.5;
      const c0 = Math.floor(colF), c1 = c0 + 1, tx = colF - c0;
      const value =
        valueAt(r0, c0) * (1 - ty) * (1 - tx) +
        valueAt(r0, c1) * (1 - ty) * tx +
        valueAt(r1, c0) * ty * (1 - tx) +
        valueAt(r1, c1) * ty * tx;
      const [r, g, b] = tierGradientRgb(fracFor(value), tierStops);
      const di = (y * canvasW + x) * 4;
      img.data[di] = r;
      img.data[di + 1] = g;
      img.data[di + 2] = b;
      img.data[di + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Az ország VALÓDI körvonalára vágjuk a rasztert (nem a mintarács durva,
  // lépcsős szélére) - ld. selectCountryBorderRing fejkomment.
  const maxLon = Math.max(...lons);
  const borderRing = selectCountryBorderRing(minLon, maxLon, minLat, maxLat);
  let clipMarkup = "";
  let borderMarkup = "";
  if (borderRing) {
    let borderD = "";
    borderRing.forEach(([lon, lat], i) => {
      const { x, y } = projectLatLon(lat, lon);
      borderD += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    borderD += "Z";
    clipMarkup = `<clipPath id="water-relief-clip"><path d="${borderD}"></path></clipPath>`;
    borderMarkup = `<path class="water-relief-border" d="${borderD}"></path>`;
  }
  const clipAttr = clipMarkup ? ` clip-path="url(#water-relief-clip)"` : "";
  const cellsMarkup =
    `<image href="${canvas.toDataURL()}" x="${originX.toFixed(1)}" y="${originY.toFixed(1)}" width="${gridPixelWidth.toFixed(1)}" height="${gridPixelHeight.toFixed(1)}"${clipAttr}></image>`;

  // A legnagyobb folyók és a Balaton VALÓDI vonala/körvonala, ugyanazzal a
  // projectLatLon-nal, mint a mérőállomások - ugyanaz a water-geo.json,
  // amit a radar is használ (ld. loadWaterGeo), csak most a rács fölé
  // vetítve, nem azimutálisan. A raszter UTÁN kell rajzolni, különben az
  // eltakarná.
  let geoMarkup = "";
  if (waterGeo) {
    const riverD = ringsToPath(waterGeo.rivers);
    if (riverD) geoMarkup += `<path class="water-map-river" d="${riverD}"></path>`;
    const lakeD = ringsToPath(waterGeo.lakes);
    if (lakeD) geoMarkup += `<path class="water-map-lake" d="${lakeD}"></path>`;
  }

  // Mérő-jelölők: billentyűzettel is elérhetők (tabindex + aria-label), a
  // buborék (ld. lent) rámutatásra, koppintásra ÉS fókuszra is megnyílik.
  const markerIcons = [];
  let markersMarkup = "";
  const addMarker = (station, kind) => {
    const { x, y } = projectLatLon(station.lat, station.lon);
    const label = kind === "river"
      ? `${station.river}, ${station.name}: ${waterNum(station.level_cm, 0)} cm`
      : `${station.lake}, ${station.station}: ${waterNum(station.level_cm, 0)} cm`;
    markerIcons.push({ title: kind === "river" ? `${station.river} · ${station.name}` : `${station.lake} · ${station.station}`, level: station.level_cm });
    markersMarkup += `<g class="water-marker" tabindex="0" role="img" data-marker="${markerIcons.length - 1}" aria-label="${label}">` +
      `<circle class="water-marker-touch" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9"></circle>` +
      (kind === "river" ? waterRiverMarker(x, y) : waterLakeMarker(x, y)) + `</g>`;
  };
  for (const station of riverStations) addMarker(station, "river");
  for (const station of lakeStations) {
    if (station.station === "Balaton average") continue; // a 3 mérce elég, az átlag külön szekcióban van
    addMarker(station, "lake");
  }

  // A keresett hely kettős gyűrűvel; a neve a felirat-rétegben.
  let hereXY = null;
  if (highlightLoc) {
    hereXY = projectLatLon(highlightLoc.lat, highlightLoc.lon);
    markersMarkup += `<g class="water-here" role="img" aria-label="${highlightLoc.name || "a keresett helyszín"}">` +
      `<circle cx="${hereXY.x.toFixed(1)}" cy="${hereXY.y.toFixed(1)}" r="3" fill="var(--fg)"></circle>` +
      `<circle cx="${hereXY.x.toFixed(1)}" cy="${hereXY.y.toFixed(1)}" r="6.5" fill="none" stroke="var(--fg)" stroke-width="1.5"></circle></g>`;
  }

  // Feliratok: a három víz és néhány nagyváros, hogy a térkép a határ alakját
  // ismerők nélkül is olvasható legyen. A keresett hely neve ugyanilyen stílusú.
  let labelsMarkup = "";
  const addWaterLabel = (text, lat, lon, anchor = "start") => {
    const { x, y } = projectLatLon(lat, lon);
    labelsMarkup += `<text class="water-map-label water-map-label-water" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}">${text}</text>`;
  };
  addWaterLabel("Duna", 46.45, 18.98);
  addWaterLabel("Tisza", 46.62, 20.25);
  addWaterLabel("Balaton", 46.76, 17.65, "middle");
  const hereName = highlightLoc && highlightLoc.name;
  const labelledPlaces = [];
  for (const name of ["Budapest", "Debrecen", "Szeged", "Miskolc", "Pécs", "Győr", "Nyíregyháza", "Szombathely"]) {
    const place = placesList.find(p => p.n === name);
    if (!place || name === hereName) continue;
    const { x, y } = projectLatLon(place.lat, place.lon);
    if (hereXY && Math.hypot(x - hereXY.x, y - hereXY.y) < 40) continue;
    const anchor = x > VB_W - 170 ? "end" : "start";
    const dx = anchor === "end" ? -6 : 6;
    const minor = ["Miskolc", "Nyíregyháza", "Szombathely", "Győr"].includes(name) ? ` class="water-map-label-minor"` : "";
    labelledPlaces.push(`<g${minor}><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="var(--fg)"></circle>` +
      `<text class="water-map-label" x="${(x + dx).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}">${name}</text></g>`);
  }
  labelsMarkup += labelledPlaces.join("");
  if (hereXY && hereName) {
    const anchor = hereXY.x > VB_W - 170 ? "end" : "start";
    labelsMarkup += `<text class="water-map-label water-map-label-here" x="${(hereXY.x + (anchor === "end" ? -11 : 11)).toFixed(1)}" y="${(hereXY.y + 4).toFixed(1)}" text-anchor="${anchor}">${hereName}</text>`;
  }

  svgEl.innerHTML = `<defs>${clipMarkup}</defs>${cellsMarkup}<g id="water-relief-cellbox"></g>${borderMarkup}${geoMarkup}${labelsMarkup}${markersMarkup}`;
  svgEl.setAttribute("role", "group");
  svgEl.setAttribute("aria-label", "Magyarország talajnedvesség-térképe, a mérőállomások egyenként elérhetők");

  // --- Rámutatás / koppintás: a cella körvonala + buborék. A talajcellákra a
  // raszter <image>-én át lehet rámutatni (a clip-path a találat-tesztelést
  // is levágja az ország körvonalára, tehát a buborék magától eltűnik a
  // határon kívül). Egér: rámutatás; érintés: koppintás rögzíti, máshová
  // koppintva (vagy Escape) bezáródik. A cella adata a saját, MINTAVÉTELI
  // négyzetére vonatkozik (a sima raszter csak a megjelenítés), ezért a
  // négyzet körvonala is látszik.
  const imageEl = svgEl.querySelector("image");
  const popupEl = document.getElementById("water-map-tooltip");
  const boxEl = svgEl.querySelector("#water-relief-cellbox");
  const halfLat = step / 2, halfLon = step / 2;
  const nameCache = new Map();
  const cellName = cell => {
    if (!nameCache.has(cell)) nameCache.set(cell, nearestPlaceName(cell.lat, cell.lon, halfLat, halfLon));
    return nameCache.get(cell);
  };

  // A buborék-szöveg külön függvényben, hogy a későbbi idősor (cell.history:
  // napi átlag-nedvességek, 0-1) egyetlen helyen kapcsolódhasson be - a
  // gyűjtő most még nem tárol cellánkénti történetet, ezért ma nincs vonal.
  const cellPopupHtml = cell => {
    const name = cellName(cell);
    const title = name ? `${name} környéke` : "mintaterület";
    const avg = Math.round(waterWeightedAvg(cell.moisture_by_depth) * 100);
    const history = Array.isArray(cell.history) ? cell.history : null;
    return `<strong>${title}</strong><span>${waterNum(cell.liters_total / 1e9, 0)} milliárd liter</span><span>átlagosan ${avg}% víztartalom</span>${history ? popupSparklineSvg(history) : ""}`;
  };

  let pinnedCell = false;
  const showCellAt = (event, pin) => {
    const rect = svgEl.getBoundingClientRect();
    const svgX = (event.clientX - rect.left) * (VB_W / rect.width);
    const svgY = (event.clientY - rect.top) * (VB_H / rect.height);
    const r = Math.floor((svgY - originY) / cellH - PAD);
    const c = Math.floor((svgX - originX) / cellW - PAD);
    const hit = nearestRealAt(r, c);
    const cell = hit.cell;
    const exactAll = allCells.find(p => Math.round(toRowCol(p.lat, p.lon).row) === r && Math.round(toRowCol(p.lat, p.lon).col) === c);
    const noData = exactAll && !(exactAll.liters_total > 0);
    const box = projectRowCol(Math.round(hit.row), Math.round(hit.col));
    const shownBox = noData ? projectRowCol(r, c) : box;
    boxEl.innerHTML = `<rect class="water-cell-box" x="${shownBox.x.toFixed(1)}" y="${shownBox.y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${cellH.toFixed(1)}"${clipAttr}></rect>`;
    const html = noData
      ? `<strong>${nearestPlaceName(exactAll.lat, exactAll.lon, halfLat, halfLon) || "tó"} környéke</strong><span>itt nincs talajadat (nagy víztükör)</span>`
      : cellPopupHtml(cell);
    mapPopupShow(popupEl, event.clientX, event.clientY, html);
    pinnedCell = pin;
  };
  const clearCell = () => {
    boxEl.innerHTML = "";
    mapPopupHide(popupEl);
    pinnedCell = false;
  };
  if (imageEl && popupEl) {
    imageEl.addEventListener("pointermove", event => {
      if (event.pointerType !== "mouse" || pinnedCell) return;
      showCellAt(event, false);
    });
    imageEl.addEventListener("pointerleave", event => {
      if (event.pointerType === "mouse" && !pinnedCell) clearCell();
    });
    imageEl.addEventListener("click", event => {
      event.stopPropagation();
      showCellAt(event, true);
    });
  }

  // Mérő-jelölők: ugyanaz a buborék (név + szint), idősor nélkül - a tavaknak
  // nincs története, a folyóké a folyó-térképen (és a listában) látszik.
  const markerHtml = el => {
    const m = markerIcons[Number(el.dataset.marker)];
    return `<strong>${m.title}</strong><span>${waterNum(m.level, 0)} cm</span>`;
  };
  const showMarker = (el, clientX, clientY) => {
    boxEl.innerHTML = "";
    mapPopupShow(popupEl, clientX, clientY, markerHtml(el));
  };
  svgEl.querySelectorAll(".water-marker").forEach(el => {
    el.addEventListener("pointerenter", event => { if (event.pointerType === "mouse") showMarker(el, event.clientX, event.clientY); });
    el.addEventListener("pointerleave", event => { if (event.pointerType === "mouse") clearCell(); });
    el.addEventListener("click", event => { event.stopPropagation(); showMarker(el, event.clientX, event.clientY); pinnedCell = true; });
    el.addEventListener("focus", () => {
      const r = el.getBoundingClientRect();
      showMarker(el, r.left + r.width / 2, r.top);
    });
    el.addEventListener("blur", clearCell);
  });
  // Egy korábbi build dokumentum-figyelője ne halmozódjon: a legutóbbit
  // tartjuk meg (a buildWaterPanel minden új keresésnél újrafut).
  if (buildReliefMap.closer) document.removeEventListener("click", buildReliefMap.closer);
  buildReliefMap.closer = () => clearCell();
  document.addEventListener("click", buildReliefMap.closer);
  svgEl.addEventListener("keydown", event => { if (event.key === "Escape") clearCell(); });

  // A legenda egy középre igazított sor: valódi számok a skála két végén
  // (a nincs-adat cella nélkül), alatta a jelölők jelmagyarázata - korábban
  // ez egy hosszú mondatban volt elásva. A színek ugyanabból a --t0..--t4
  // tokenből jönnek, mint a raszteré, tehát a kettő garantáltan összhangban marad.
  const legendStops = tierStops
    .map((rgb, i) => `<stop offset="${(i / (tierStops.length - 1) * 100).toFixed(0)}%" stop-color="rgb(${rgb.map(Math.round).join(",")})"></stop>`)
    .join("");
  const ringIcon = `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="3.5" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.3"></circle></svg>`;
  const diamondIcon = `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M7 3 L11 7 L7 11 L3 7 Z" fill="var(--accent)"></path></svg>`;
  const hereIcon = `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="2" fill="var(--fg)"></circle><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--fg)" stroke-width="1.3"></circle></svg>`;

  legendEl.innerHTML = `
    <div class="water-legend-scale">
      <span>${waterNum(minL / 1e9, 0)} mrd l</span>
      <svg width="160" height="12" aria-hidden="true">
        <defs><linearGradient id="water-relief-legend-gradient" x1="0" x2="1" y1="0" y2="0">${legendStops}</linearGradient></defs>
        <rect width="160" height="12" fill="url(#water-relief-legend-gradient)" stroke="var(--border)" stroke-width="0.75"></rect>
      </svg>
      <span>${waterNum(maxL / 1e9, 0)} mrd l</span>
    </div>
    <div class="water-legend-markers">
      <span>${ringIcon}folyó-mérce</span>
      <span>${diamondIcon}tó-mérce</span>
      <span>${hereIcon}a keresett hely</span>
    </div>
    <p class="water-legend-note">Egy négyzet kb. ${Math.round(step * 111)} × ${Math.round(step * 111)} km-es mintaterület.</p>`;

  const howtoEl = document.getElementById("water-map-howto");
  if (howtoEl) {
    howtoEl.innerHTML = `<p class="about">Minden mintapont kb. ${Math.round(step * 111)} × ${Math.round(step * 111)} km-es területet képvisel, a színe a területen lévő víz mennyisége (${waterNum(minL / 1e9, 0)}-${waterNum(maxL / 1e9, 0)} milliárd liter a legszárazabb és a legvizesebb pont között). A talajnedvesség itt Open-Meteo modell-becslés, nem mérés, a köztük lévő sima átmenetet a szín erőssége mutatja. Egérrel rámutatva, érintőképernyőn rákoppintva megjelenik a mintaterület kerete és a leolvasott érték. A vonal a legnagyobb folyók, a szaggatott körvonal a Balaton valódi futása. Az üres gyűrű folyó-, a teli gyémánt tó-mérőállomás: ezek élő mérce-adatok, a pontos vízállásuk lent, a listákban.</p>`;
  }
}

// ---- 2c. Folyóhálózat: teljes vonalhálózat, vastagság = vízhozam ----
//
// Ez MÁS, mint a fenti dombormű: ott a talajnedvesség-rács kap folyó-/tó-
// JELÖLŐKET (pontok, cm-es élő adattal), itt viszont maga a folyók VALÓDI
// FUTÁSA van megrajzolva, a vonalvastagság a sokéves átlagos vízhozammal
// (m³/s) arányos - ez egy külön, statikus "melyik folyóban folyik a
// legtöbb víz" áttekintő, nem napi adat, és szándékosan nem ugyanaz a
// vizualizáció, mint a talaj-dombormű.
const WATER_RIVER_NET_SVG = `
  <path fill="none" stroke="var(--border)" stroke-width="1.5" stroke-linejoin="round" d="M393.1 58.5 L390.7 62.2 L386.6 64.5 L386 68.4 L383.2 69.3 L379.5 73.1 L375.2 74.3 L369.1 71.8 L367.3 72.2 L365.8 76.1 L358.8 77.1 L355.1 81.2 L352.5 88.5 L348.9 89.8 L343.7 94.2 L342.7 96.3 L343.4 104.5 L342.2 106.8 L338.7 108.2 L335.5 112.5 L333.3 119.4 L333.1 122.9 L330.8 125.6 L329.9 128.5 L322.5 135.4 L324.6 137.8 L323.3 142 L320 144.9 L319.7 149.9 L317 151 L315.1 153.5 L313.2 158.7 L315.2 160.3 L315 161.9 L311.3 164.4 L309 168.4 L303.6 170.2 L303.1 175 L300.5 180.8 L302.5 185.8 L297.6 187.4 L296.1 190.3 L294.7 196.9 L292.2 197.5 L289.5 200.8 L276.3 197.9 L271.8 200.7 L272.1 204.5 L270.1 204.8 L269.5 207.5 L267.5 209 L263.9 209.7 L256.4 206 L255 208.3 L245.9 208.5 L243.6 211.5 L240.5 208.8 L237.6 209.1 L235.4 207.6 L231.8 208.6 L225.8 206.9 L217.9 209.7 L211 206.1 L204.3 206.8 L200.7 209.3 L201.4 211.4 L198.8 214 L194.6 217.7 L190.5 218.3 L188 222 L181.5 221.8 L178.1 218.9 L175.9 221.1 L175.8 223.5 L172 224.6 L172 227 L166.6 226.3 L163.3 228.3 L162 227.7 L160.3 230.2 L153.5 228.2 L148.9 235.7 L146.4 237.9 L143.7 237.8 L139.3 242 L137.2 240.6 L134.3 241.5 L128.3 238.3 L120.9 239.5 L110.1 237.8 L108.3 239.5 L105.5 235.9 L96.8 233.3 L96.2 229.5 L93.1 225.8 L88.6 224.3 L83.8 224.1 L82.6 225.2 L81.7 223.6 L79.2 224.2 L78.8 221.8 L78.1 222.8 L76 221.8 L77.6 220.7 L75.2 219.5 L73.7 213.8 L71.4 210.8 L65.3 209.8 L58.2 203 L53.3 196.2 L52.5 192 L50.4 188.7 L46.5 187.5 L45.7 188.7 L40.2 181.9 L36.6 180.3 L35.6 181.3 L32.1 178.7 L31.3 175.2 L23.7 167 L26.1 164.9 L25.8 163.3 L23.1 162.3 L23.1 160.9 L20.7 158.6 L19.8 155.9 L21.3 150.6 L18.3 148.6 L8.2 148.7 L15.5 142.2 L18.4 136.9 L26.4 138.2 L30.4 137.4 L29.4 135.7 L26.9 135.3 L30.8 133.2 L28.6 130.5 L31.7 125.8 L31.1 124.8 L27.4 125.2 L27.9 122.5 L26.3 121.7 L26.7 117.1 L29.7 114.2 L26.9 108.6 L27.5 104.3 L28.7 103 L30.2 104.6 L39.2 99.6 L39 96.2 L41.3 94.9 L41.9 92.5 L39.8 90.1 L40.1 88.5 L38.6 85.5 L26 82.3 L27.8 79.8 L28.6 80.6 L31.9 78.5 L33 75.5 L35.1 74.5 L42 76.6 L44.3 80.2 L48.1 81.1 L51.1 78 L51.9 80.1 L54.1 80.5 L63.9 78.3 L62.4 76.5 L61.9 70.6 L62.7 69.7 L59.8 65.5 L63.4 63.9 L64.5 60.5 L63.8 59.7 L65 57.8 L64.4 56.6 L70.1 52.4 L78.8 54.2 L86.4 63.3 L89.5 64.7 L92.1 68.3 L93.9 67.9 L98 71.6 L106.4 74.9 L129.7 74.6 L147.7 71.3 L155.6 72.6 L159.9 68.9 L162.6 68 L158.8 64.8 L159.1 58.1 L158.5 56.5 L161.4 54.7 L163.9 50.8 L172.9 48.6 L185.7 49 L189.7 46.8 L197.4 46.9 L200.4 44.8 L202.2 37.1 L208.4 35.2 L212 37.7 L216 37.4 L217 38.6 L217.1 41.6 L219.7 40.9 L223.2 43.3 L225.8 43.3 L235.8 37.2 L237.4 33.6 L239.5 33.8 L242.8 31.5 L245.3 33.1 L248.2 30.8 L253.7 18.4 L257.1 14.2 L257.1 10.3 L275.2 6.7 L283.5 10.9 L288.6 11.3 L292.8 13.4 L299 10.9 L301.4 12.2 L304.8 8.5 L310.6 7.4 L314.9 9.6 L316.2 12.5 L320.1 13.1 L321.4 17.4 L325 23.1 L329.6 26.3 L339.3 23.1 L347.7 22.8 L354.8 19.3 L358.7 20.5 L357.9 24.4 L360.2 25 L360.8 29.6 L363.6 33.9 L370.6 33.9 L374.8 39.3 L377.6 46 L385.6 44.4 L388.8 46.5 L391.8 50.1 L392.2 51.7 L390.5 55.8 L393.1 58.5Z"></path>

  <!-- határon túli szakaszok -->
  <g fill="none" stroke="var(--muted)" stroke-width="0.75" stroke-linecap="round" stroke-linejoin="round">
  <path d="M165.1 232.7 L165.3 234.4 L164.8 235.7 L164.7 237.5 L166.2 238.7 L167.5 241.3 L167.6 244.3 L168 245.4 L171 247.6 L171.2 248.2 L170.6 250M163.6 229.9 L164 231.4 L165.1 231.8 L165.1 232.7M67.4 42.7 L68.1 43.5 L67.9 45.5 L69.3 48.2 L73.4 51.5M84.7 58.9 L85.3 59.1 L85.5 60M85.8 60.4 L86 60.6M25.9 34.4 L31.5 40.1 L35 42.4 L38 43.2 L42 43.6 L45.5 43 L48.9 44.3 L53.4 43 L55.2 41.9 L56.2 42 L58.4 40 L62.3 42.5 L67.4 42.7M0 25.9 L3.9 25.4 L5.3 26 L8.6 25.9 L14.8 24.7 L20.3 24.9 L21.8 25.9 L22.7 27.9 L22.5 28.7 L25.9 34.4"></path>
  <path d="M270.6 207.8 L273.2 207.8 L276.2 212.2 L277.5 213.2 L278.4 212.8 L281.4 214.3 L282 213.9 L282 213.1 L282.9 212.3 L284.1 210 L285.1 209.7 L284.8 209.3 L286.1 209.9 L286.6 209.5 L285.5 208.7 L285.9 208.4 L286.9 208.9 L287.2 208.3 L286.9 207.9 L291.6 207.6 L292.3 207.9 L293 209.1 L296.3 209.2 L299.2 207.7 L301.4 208.1 L303.2 207.2 L304.8 206.9 L304.9 206 L305.6 205.7 L306.7 207.1 L306.7 208.1 L308.1 208.6 L308.8 209.7 L310.2 210.2 L311.3 209.7 L311.3 209 L314.9 209 L316.9 211 L321.8 211.7 L322.2 212.5 L323.3 212.6 L322.8 213.5 L324.1 212.8 L324.4 214.1 L326 212.5 L327.7 212 L329.6 212 L330.9 212.6 L330.9 213.2 L333.2 213.7 L334.2 213.5 L335.8 212 L337.2 212.4 L337.3 213.3 L338.6 212.5 L339.6 212.6 L339.7 213.3 L340.6 212.7 L342.6 213.6 L343.9 213 L344.6 213.2 L344.5 213.7 L345.6 214.9 L345.5 216 L346.2 216.3 L346.9 217.9 L347.5 217.8 L347.9 219 L349.1 219.2 L349.3 219.7 L350.2 219.3 L350.8 219.8 L350.3 221.4 L351.6 220.3 L353.9 220.8 L355.3 220.1 L358.8 220.4 L360.9 221.5 L361.3 220.8 L365 220.9 L365.9 219.7 L366.7 219.9 L367.2 219.3 L367.9 219.5 L367.6 222.3 L369.5 223 L371.7 225.4 L373.1 225.7 L373.9 227.3 L374.3 226.3 L375.6 226.5 L375.9 225.7 L376.5 225.6 L376.2 227 L376.8 227 L377.4 225.7 L378.2 225.7 L379.2 227.2 L380 226 L380.9 227 L381.6 226.2 L383.8 227.1 L386 226.7 L387.3 228.3 L392 226.6 L393.5 228.2 L394.8 228.3 L396.2 230 L398 230 L400 231.7"></path>
  <path d="M400 46.7 L399 46.6 L397.4 48.1 L396.4 48.1 L395.4 47.3 L393.1 46.9 L392.9 46 L390.9 46.1 L390.9 45.6M390.9 45.6 L390.4 44.4 L389.9 44.4 L389.6 45.3M389.2 45 L389.3 44.1 L387.7 44.1M234.2 209.7 L234.4 210.5M234.4 210.5 L232.2 212.8 L233.9 214.1M233.9 214.1 L234.9 215.4 L234.7 216.9 L233.5 218.7 L232 219 L234 220.9 L235.7 221.1 L235.8 221.5 L235.3 223.5 L235.3 224.8 L235.9 225.7M235.9 225.7 L236.3 227.3 L237.6 228.8 L237.4 229.4 L235 232 L235.4 232.7 L238.1 234.4 L238.6 236 L238.6 239.9M238.6 239.9 L239.6 241.7 L239.2 242.8 L237.3 244.3 L235.6 244.3 L235.9 245.6 L235.4 246.5 L236.5 248.3 L236 250"></path>
  <path d="M0 189.9 L0.3 190.3 L1.2 190.2 L5.4 187.6 L5.9 187.6 L7.5 189.1 L9.2 188.6 L11 186.9 L12.6 188M12.6 188 L13.7 189.1 L17.2 188.7 L19.9 189.8 L20.2 189.1 L21.7 191 L22 192.7 L25.2 194.5 L29.6 194.7 L31.8 195.6 L32.4 194.6 L34.5 194.6 L35.8 193.8 L37.6 194.5 L39.5 194.1 L40.2 195.1 L41.5 195 L41.7 194.3 L43.5 193.8 L44.5 193.9 L46.3 195.7 L51.7 195.2M135 243 L135.9 243.4 L136.2 244.2 L137.6 243.9 L138.3 245 L139.4 245.2 L140.9 246.8 L142.1 246 L142.6 246.7 L144.7 246.8 L144.9 247.3 L144.4 248.3 L145.8 250"></path>
  <path d="M0 162.4 L0.9 162.6 L2.3 164M21.7 176.9 L22.1 176.8 L22.5 175.7 L24.5 176.6 L25 175.7 L25.9 176.7 L27.3 177.1 L27.9 178 L29.1 177.6 L30.9 178.7M2.3 164 L6.1 167 L8.3 169.5 L10 170.3 L10.7 170.1 L10.9 169.6 L11.8 169.9 L13.3 172 L14.5 172.5 L14.9 173.5 L18.3 176.2 L21.7 176.9"></path>
  <path d="M0 141.4 L5.2 141.8 L9.8 143.2 L11.5 143.1"></path>
  <path d="M249.4 13.5 L249.3 15.4 L247.7 17.6 L247.6 19.8 L246.9 20.9 L246.5 22.8 L248.4 26.3 L247.7 29.1M259.3 0 L257.2 3.8 L257 5.2 L256 7.1 L252.3 8.5 L251.3 11 L251.7 12.2 L249.4 13.5"></path>
  <path d="M386.5 69.9 L387.5 69.8 L388.8 70.7 L391.4 70.9 L393.2 71.8 L396.8 72.6 L400 72.5"></path>
  </g>

  <!-- tavak -->
  <g fill="var(--accent)">
  <path d="M108.9 148.6 L107.6 149.9 L91.5 156.9 L90.6 157.6 L89.7 158.6 L87.4 160.4 L86.5 160.8 L84 161.1 L79.6 160.2 L77.2 160.2 L75.2 160.9 L74.2 160.7 L73.6 159.6 L74.5 156.6 L76.8 156.5 L79.2 157.4 L80.3 157.1 L80.6 156 L81.5 155 L82.6 154.2 L83.6 153.9 L85.7 154.1 L86.8 154.4 L87.7 155.1 L90.6 152.9 L92.2 152 L95.2 151.6 L95.9 151.2 L97 149.4 L97.7 148.5 L98.3 148.1 L99 148 L106.2 145.1 L107.1 143.9 L107.5 144.2 L109.4 145.8 L110.2 146 L110.8 145 L110.4 143.9 L109.6 143 L108.7 142.5 L108.7 142 L114.3 138.7 L116.1 137.3 L116.8 136.4 L117.6 135.2 L118.2 133.9 L118.4 132.5 L119 132.3 L120.2 132.5 L122.7 133.4 L123.7 134 L125 135 L125.9 136.1 L125.9 137.1 L125.1 138.5 L124 140.9 L123.1 142 L120.8 143.3 L112.9 146.1 L112.5 146.1 L111.8 146 L111.5 146.3 L110.6 147.6 L108.9 148.6Z"></path>
  <path d="M48.2 67.4 L46.5 70.3 L45.5 72.3 L45.2 73.2 L44.7 75.8 L44.9 78.1 L46.1 78 L47.2 77.5 L48.3 78.7 L48.6 80 L48.3 80.8 L47.9 81.2 L47.1 80.5 L46.4 80.4 L45.1 79.8 L44.2 77.8 L43.6 75.9 L42.8 75.6 L42.9 77 L42.6 78 L42 77 L42.3 75.4 L43 74.9 L43.2 74.3 L42.7 73.7 L42.7 71.7 L43.3 69.3 L43.9 67.7 L44.2 65.2 L44.5 63.7 L45.2 62.2 L46.7 60.6 L48.6 59.8 L50.3 59.4 L51.1 60 L51 61.8 L50.5 64 L49.6 65.6 L49.1 66.4 L48.2 67.4Z"></path>
  <path d="M263.7 90 L264.6 86.8 L265.6 84.9 L266.2 84.3 L267.4 83.6 L268.6 83.6 L268.8 84.6 L268.9 85.3 L268.2 86.4 L267.4 87.5 L266.7 88.8 L265.8 89.8 L264.2 90.4 L263.7 90Z"></path>
  </g>

  <!-- folyók az országban, vastagság = vízhozam -->
  <g fill="none" stroke="var(--accent)" stroke-linecap="round" stroke-linejoin="round">
  <path stroke-width="1" d="M222.6 42.7 L221.7 42.7 L221.7 43.3 L223.7 49.5 L224.3 50.3 L226.9 50.8 L227 53.4 L221.8 54.5 L220 53.8 L219.2 55.9 L216.8 56.5 L212.2 60.1 L212 61.3 L212.9 63.4 L211.9 64.8 L211.7 69.4 L212 77 L211.6 81.8 L212.4 83.6 L213.1 90 L213.6 91.3 L216.4 93.5 L216.7 94.8 L218.5 94.8 L221.4 96.5 L223.2 96.6 L223.1 95.7 L224.6 94.3 L226.1 94.5 L227.9 94 L228.3 94.8 L228.1 96.1 L229.9 97.7 L229.3 99.6 L229.3 101.3 L231.8 102.2 L232.9 104.2 L233.1 105.6 L234.8 106.1 L234.9 107.9 L234.4 108.1 L234.1 109.3 L234.3 110.8 L234.9 111.1 L234.5 112.3 L235.1 113.6 L236.2 113.8 L236.2 114.5 L237 114.2 L237.4 115.3 L237 116.1 L237.2 116.3 L236.5 117 L237.2 117.6 L236.8 118.1 L237.5 118.2 L237.7 119.2 L240.2 120.2 L241.6 119.5 L242.3 120.4 L241.1 120.7 L241.3 122.7 L240.9 123.2"></path>
  <path stroke-width="1" d="M305 7.4 L304.6 7.4 L304.5 7.8 L305 8 L304.4 8.3 L304.7 8.5 L304.2 9.2 L304.4 9.6 L303.2 11.4 L302.4 11.6 L302.4 12 L302 11.6 L301.8 12.3 L299.1 12.8 L298.4 14.3 L298.6 15.2 L298.1 15.5 L297.7 16.6 L298.1 17.1 L297.7 18.3 L298.2 18.3 L298 18.9 L298.5 19 L298.3 21.9 L297.3 22.8 L296.9 24.5 L295.8 25.4 L296.2 26.5 L295.9 26.6 L296.1 26.8 L295.8 27.8 L290.5 32.9 L287.9 34.4 L288.4 35.1 L287.7 35.3 L287.8 35.8 L286.6 37.6 L286 37.5 L285.8 39.4 L284.8 39.9 L285 40.3 L284.3 42.8 L284.5 44.6 L283.6 47.2 L284.6 48 L284.1 48.5 L284.7 48.8 L285.1 50 L284.8 50.7 L283.9 50.7 L283.5 51.4 L283.9 51.8 L283.4 51.6 L283.2 52 L283.4 52.4 L282.9 52.3 L283.3 52.7 L283.3 54.3 L282.6 55"></path>
  <path stroke-width="1" d="M335.3 116.5 L333.5 116 L332.8 114.6 L331.8 114.1 L330.3 114.4 L330 115.3 L327.1 115.9 L324.9 118.5 L324.3 118 L323.6 118.6 L320.7 118.7 L319.8 119.7 L318.1 120.3 L317.1 120.1 L314.7 121.3 L311.9 121.6 L305.2 127.6 L302.6 130.6 L298.9 133 L297.3 134.5 L296.6 136.2 L292.4 139.1 L290.6 141.5 L289 142.5 L285.2 143.7 L281.8 142.8 L279.8 143 L276.9 141.3 L272.2 143.2 L266.3 142.1 L265 142.3 L262.9 144.5 L261 144.3 L260.5 145.4 L257.7 146.3 L254.3 144.4 L249.6 143.8 L247.9 147.2 L246.9 147.3 L245.5 149.5 L245.9 150.9 L245.6 151.3 L244.9 152.2 L243.2 152.4 L242.1 153.5 L241.7 155.8 L241.8 157 L240.7 158 L240.5 160.9"></path>
  <path stroke-width="1" d="M324 135.4 L319.8 136.5 L316.7 139.2 L306.6 139 L300.9 139.2 L300.3 139.8 L299.3 138.8 L298.3 139.1 L297.3 138.2 L293.5 138.6"></path>
  <path stroke-width="1" d="M312.2 165 L311.6 165 L310.9 162.7 L308.6 161 L304.3 162.2 L303.5 161.7 L302 162.3 L299 160 L294.9 156.5 L294.2 153.8 L293.1 152.6 L292.2 150.1 L290.8 149.4 L288.4 146.8 L288.1 145.9 L285.2 143.7"></path>
  <path stroke-width="1" d="M20.2 146.8 L23.3 148.4 L24.3 150.2 L26.3 150.2 L29.8 151.6 L33.1 150.5 L36.9 150.4 L45.1 147.7 L47.8 149.1 L51 149.8 L52.8 149.1 L53.2 147.6 L54 146.9 L56 147.1 L58.2 143.4 L59.6 142.3 L59.5 141.6 L60.7 140.4 L60.9 139.3 L62.8 139.2 L63.3 139.7 L64.1 143.4 L64.1 145.1 L65.8 150.7 L66.5 156.6 L66.6 161.6 L67.2 165.7 L69.4 167.6 L70.8 166.9 L70.9 166.1 L71.9 165.6 L73 163.8 L73.9 163.3 L74.4 161.7"></path>
  <path stroke-width="1" d="M71.8 52.5 L73.5 55.5 L73.4 57.8 L74.5 56.7 L75 56.8 L75.1 57.6 L75.6 58.4 L75.4 58.8 L74.2 58.8 L74.3 60.5 L74.7 61 L76.2 60.2 L76.4 61 L76 61.5 L76.1 62.1 L77.3 62.5 L77 63 L77.9 63.8 L77.3 64.5 L76.1 64.5 L75.7 65.3 L75.9 67.2 L77.3 66.1 L77.7 66.5 L77.7 67 L76.5 67.7 L76.6 68.1 L78.1 67.7 L78.3 66.8 L78.7 66.6 L79.5 67.6 L80.9 67.3 L80.9 68 L79.3 68.4 L78.8 69.1 L79.2 69.5 L80.1 69.3 L80.4 68.7 L82.4 68.6 L82.7 69.2 L82.8 70.9 L83.2 71.1 L83.8 70.9 L84.9 68.9 L85.5 69 L86 69.6 L86.1 70.5 L88.8 71.4 L88.7 72.1 L86.3 72.2 L86.1 73 L87.7 74.2 L89.9 73.7 L91.1 75 L90.1 75.5 L90.2 76.2 L92.3 76.1 L92.4 77 L91.8 78.1 L94.2 78.5 L95.1 78.1 L95.4 78.6 L95 79.8 L97.2 78.9 L98.1 76.9 L104.6 76"></path>
  <path stroke-width="1" d="M164.2 69.3 L164.7 68.4 L163.3 67.9 L163 66.5 L159.7 64.8 L159.3 60.5 L160.3 59.3 L160.1 58.1 L160.4 57.8 L159.2 56.1 L159.7 55.2 L161.9 55.1 L162.6 54.5 L162.7 52.1 L163.1 51.7 L162.8 50.9 L163.5 50 L165.9 50 L166.5 49.8 L166.7 49.1"></path>
  <path stroke-width="1.2" d="M18 141.7 L18.1 141.6M18.1 141.6 L20.8 141.1 L24.1 141.5 L25.5 141.2 L27.7 141.3 L27.8 141.8 L29.5 142.1 L31.6 141 L32 139.4 L33.3 138.3 L40.2 136 L42.4 133.1 L44 132.7 L44.6 131.8 L45.8 132 L46.8 130.9 L48.8 130.4 L49.3 129.6 L50.6 129.1 L51.5 126.6 L53 124.7 L53.5 123.2 L53.6 121.5 L54.4 119.7 L56 117.8 L57 117.5 L57.3 116.2 L58 115.4 L58.2 112.3 L61.3 107.3 L62.2 104.9 L63.5 103.7 L65.4 103.5 L67.2 102.5 L67.5 101.7 L68.5 101.1 L71.9 100.7 L73.3 101.4 L76.8 101.7 L78.2 101 L79.7 101.2 L81.7 98.9 L81.8 97.2 L82.7 94.8 L82.7 92M11.5 143.1 L18.1 141.6M82.7 92 L85 87.9 L86.9 86.3 L94 83.2 L95.8 80.2 L97.8 78.8 L98.4 77.1 L104.4 75.9"></path>
  <path stroke-width="1.2" d="M119.2 144.9 L120.3 146 L121.9 146.2 L124 147 L125.7 147.6 L127.5 147.7 L131.6 150.2 L131.8 151.4 L134.2 152.8 L134.6 154.6 L138.1 156.5 L139.4 157.8 L141.9 158.7 L143.2 159.1 L143.4 159.4 L147.5 158.1 L149.8 158.4 L150.9 160 L152 162.1 L151.8 164.6 L151 169.6 L150.5 171.9 L150 173.2 L150.5 178.2 L152.9 180.7 L153.5 181.4 L153.8 183.3 L153 185.1 L152 187.5 L153.1 188.4 L157.2 188.9 L159.4 190.5 L160.8 192 L162.7 192.5 L163.4 191.2 L163.9 191 L164.3 191.7 L164.4 193 L165.4 194 L165 194.9 L166.4 195.3 L167 196.3 L166.4 197.2 L166.6 197.6 L168.5 198.2"></path>
  <path stroke-width="1.4" d="M289.1 56.7 L289.3 55.6 L291 56.8 L290.7 57.6 L291.1 58.6 L292.6 58.6M282.7 54 L282.5 54.3 L283.4 56.6 L284.3 56.8 L284.5 57.5 L285.6 58 L286.9 57.5 L288.5 57.9 L287.9 57.2 L289 57.3 L289.1 56.7M278.3 46 L278.8 46.5 L278.6 47.2 L279.3 47.7 L279.1 48.1 L279.8 48.4 L280.8 51.1 L282.7 54M276.4 44.8 L278.3 46M266.1 31.8 L268.8 33.5 L269.5 35 L271.6 35.6 L273.8 37M247.7 29.1 L248 30.1M273.8 37 L275 39.2 L274.8 40.6 L276.2 41.9 L276 42.8 L276.4 44.8M248 30.1 L249.6 30.7 L250.4 30.3 L252.3 31.2 L254.4 31.2 L255.7 30.6 L258.7 30.9 L259 31.4 L263.1 30.8 L266.1 31.8"></path>
  <path stroke-width="1.6" d="M363.2 44.6 L363.3 45.4 L364.1 46.1 L363.4 46.8M363.4 46.8 L364.8 49.2 L365.6 49.6 L366.7 51.8 L373.8 59.9 L374.8 59.9 L380 63.2 L381.9 66 L382.9 66.1 L382.9 67.3 L383.8 68.5M383.8 68.5 L384.4 69.5 L386.5 69.9"></path>
  <path stroke-width="1.7" d="M30.9 178.7 L31 179.2M31 179.4 L32 179.7 L32.1 180.6M32.6 180.9 L35.3 181.9 L37.9 181.7M37.9 181.7 L41.2 182.7 L40.6 183.4 L41.6 183.7 L44.1 188.1 L45.1 187.2 L45.4 188.4 L46 188.4 L46.5 189.2 L46.8 188.6 L47.4 189.1 L48.4 188.5 L52.2 191.2 L52.1 191.9 L53.4 192.8 L52.9 193 L52.8 193.8 L53.3 196"></path>
  <path stroke-width="1.8" d="M241.1 199.2 L241.9 200.1 L243.4 200.4 L248.7 200.1 L249.8 201.4 L251 201.2 L251.6 202 L255.7 203.3M255.7 203.3 L261.7 205.9 L264.7 208.4M264.7 208.4 L265.7 209.2 L266.5 209.2 L267.4 207.9 L268.9 208 L270.1 206.7 L270.6 207.8"></path>
  <path stroke-width="2.5" d="M51.7 195.2 L53.3 196M53.3 196 L53.5 196.9 L55.3 199.1 L56.1 199.3 L56.3 200.7 L57.4 201.7 L57.8 203.6 L59.6 203.4 L60.3 205.4 L61.2 205.8 L62.2 207.9 L63.3 208.2 L64 209.5 L67.4 211.4 L68.2 211 L69.3 211.4 L71.3 210.5 L72.1 210.7 L72.6 212.9 L74.1 214.8 L75.7 220.2 L77.9 220 L77.7 220.9 L76.3 221.4 L76.2 221.9 L77.4 222.8 L77.6 223.7 L79.7 222.8 L79.1 224.9 L79.6 225.6 L82.1 224.5 L83 225.8 L84.8 224.4 L91.7 225.5 L94.7 227.7 L96.1 229.7 L96.9 232.9 L97.4 233.5 L102.1 234.7 L102.7 235.4 L104.8 235.8 L105.5 236.5 L106.5 236.1 L108.7 239.5 L110.6 237.6 L116.4 237.6 L117.4 238.9 L120.7 240.1 L122.3 239.9 L123.6 238.4 L125.1 238.3 L125.9 239.2 L127.5 238.5 L131.9 241.1 L134 243.1 L134.7 243.1 L135 243"></path>
  <path stroke-width="2.9" d="M241.1 199.2 L239.3 198.9 L238.5 199.4M241.1 199.2 L243.5 196.6 L243.9 195.3 L243.6 194.4 L242.6 193.7 L242.4 192.7M389.6 45.3 L389.2 45M387.7 44.1 L387.2 44.8 L386.1 44.2 L384.8 44.3 L381.8 46.4 L379.1 45.4 L378.1 46.4 L376.9 45.6 L376.5 46.3 L375.9 46.3 L375.8 47.6 L375.3 48.1 L372.7 49 L370.9 48.3 L370.4 49.1 L369.2 48 L367.1 48.2 L364.4 44.9 L364 44.4 L363.2 44.6 L362.7 43.4 L361.7 42.3 L362 39.3 L361.1 39.3 L359.4 37.9 L359.6 36.7 L359.2 36 L359.9 33.9 L359 33.2 L358.6 31.7 L357.4 32.3 L356.9 31.8 L358.1 30.2 L358.1 29 L357.4 27.8 L358.7 25.5 L357.4 24.4 L358.8 23.6 L357.4 21.6 L359.1 20 L356.2 18.9 L355.2 18.9 L353.1 20.2 L350.8 22.1 L349.7 23.7 L349.6 25 L348.2 26.8 L348.4 28.2 L347.5 27.5 L347.2 29 L346.3 28.1 L343.9 28.7 L340.5 32.8 L339.1 34.3 L338.1 33.9 L336.6 34.6 L335.3 34.3 L334.1 35.4 L332.8 35.5 L331.6 37.2 L330.7 36.9 L329.3 37.4 L328.1 38.8 L324.2 40.4 L321.1 38.4 L316.4 39.5 L314.2 39.4 L312.6 40.8 L311.8 41.4 L310.4 44.1 L310.6 44.9 L312.3 46.7 L311.3 47.2 L311.7 49.2 L311.5 50.5 L310.2 50.1 L310.2 51.4 L307.6 51.5 L305.7 52.2 L302.9 51.4 L301.6 50.3 L301.6 49.4 L299.7 50.7 L299.7 51.4 L299.3 52.1 L296.3 52.2 L294.5 53.8 L292.6 58.6 L292.5 59.3 L291.2 60.6 L289.7 61.9 L289.7 63.9 L289.8 64.7 L289.1 66.3 L289.6 67.7 L287.5 68.6 L287.3 69.2 L288.3 70.4 L288.5 71.9 L286.3 71.8 L285.7 72.7 L284.5 73.2 L285 75.3 L283.8 76.8 L282.4 79.2 L279 81 L275.9 81.1 L275.4 81 L273.2 83.9 L271.8 85 L270.4 86.3 L270.6 87.3 L270.1 89.7 L268.4 90.7 L267.4 92 L264.4 93.2 L263.8 94.4 L264.3 96 L263 97.4 L259.4 97 L257.7 98.7 L256 98.9 L255.4 99.8 L255.1 100.6 L253.8 101.8 L251.4 102.5 L251.2 104.1 L253.6 104 L254.2 104.5 L254.7 105.1 L254.5 106.3 L255.1 109.3 L256.8 111.1 L256.8 111.5 L256.2 114 L254.8 115.3 L252.2 115.9 L250.9 114.8 L250 114.9 L249.1 116.1 L246.9 117.6 L246.3 119 L246.4 121.3 L244.2 122.1 L243.8 122.7 L241.1 122.8 L240.3 123.5 L239.1 127.1 L240.2 126.9 L240.7 127.4 L240.8 128.9 L240.2 130.8 L241 132.1 L241.1 133.8 L242.1 134 L243 133.2 L244.1 133 L245.8 133.7 L246.1 134.8 L245.3 134.9 L243.2 135 L242.1 136.3 L237.3 138.3 L237.1 140.3 L236.4 140.5 L235.7 141.5 L235.9 141.9 L236.7 141.8 L238.2 141.9 L238.6 142.6 L238.6 143.8 L234.3 147.5 L233.8 146.7 L233 147 L232.1 149 L231.9 150.4 L233.1 152.5 L233.6 154.4 L234.5 155 L235.1 156.8 L236.1 158.4 L237.5 159.2 L237.8 160.2 L238.7 160.9 L240.5 160.6 L241.1 163 L242.4 164.4 L240.7 165.9 L239.1 171.3 L237.8 171.8 L237.9 173.4 L239.3 174.9 L239.2 176.3 L239.8 177.3 L241.5 181.7 L240.5 186.5 L241.4 187.3 L241.5 189.2 L240.9 190.8 L242.4 191.4 L242.4 192.7M238.5 199.4 L233.6 208 L233.5 209.2 L234.2 209.7"></path>
  <path stroke-width="4.2" d="M155.9 220.4 L160.2 224.2 L160.6 225.8 L163.4 228.5 L163.6 229.9M171.3 72.1 L171.8 70.6 L172.6 69.6 L174.6 68.7 L176 68.9 L178 69.6 L178.8 71.2 L179.7 71.9 L180.5 74.7 L180.5 78.2 L179.6 83.8 L177.2 88.9 L176.9 90.8 L175.5 94.6 L175.7 95.8 L177.1 98.6 L176.2 100.5 L175.2 104.5 L174.7 105 L171.5 105.7 L170.3 107.7 L170.6 109.2 L168.6 113.1 L168.8 114.6 L168.1 118.2 L166.6 120.9 L166.1 123.9 L166.4 126.7 L167.4 130.8 L171.1 134 L171.7 135.4 L171.9 136.7 L170.8 138.2 L171.7 141.7 L171.7 144.2 L169.3 149.6 L170.8 152.7 L171.5 155.4 L172.6 157 L172.7 159 L173.4 160 L173.8 162.4 L173.4 164.4 L171.3 167.1 L168.8 168 L166.9 168 L165.8 170.5 L165.9 171.4 L167.1 172.6 L167.4 173.7 L167.9 178.4 L168.9 180.4 L169.1 181.6 L168.5 184.6 L167.7 185.5 L167 187.6 L167.7 192.6 L169.2 195.3 L168.5 197.4 L168.3 202.5 L169.2 204.7 L169.1 205.5 L168.1 206.7 L165.4 206.7 L164.5 207.6 L164.8 207.9 L162.7 211 L160 213.3 L159.5 215.8 L156 218.3 L155.5 219.5 L155.9 220.4M73.4 51.5 L74.8 54.4 L77.5 54.9 L79.2 56.3 L79.7 55.9 L78.8 54.8 L79.2 54.9 L81.7 56.2 L83.3 58.3 L84.7 58.9M86 60.6 L86.9 62.5 L87.6 62.6 L87.6 63.3 L89.4 63.2 L89.4 64.7 L91.2 66.6 L91.5 68.1 L92.6 69.1 L94.6 69.1 L97.2 71.2 L99.2 72 L100.8 74.8 L104.4 75.9 L108.5 75.5 L110.9 75.9 L112 74.8 L114.4 74.3 L117 75.2 L118.1 74.5 L121.9 74.1 L126.4 75.7 L133.7 76.5 L140.2 74.8 L142.2 73.8 L143.5 73.9 L144.3 74.8 L146.1 74.6 L148.4 73.3 L150.2 73.5 L151.2 74.3 L154.1 74.2 L157.8 71.8 L158.1 70 L158.8 69.5 L158.5 69.3 L161.9 68.9 L167.9 70.5 L168.2 72.1 L169 73.5 L170 73.6 L171.3 72.1"></path>
  </g>

  <!-- nevek -->
  <g font-size="12" stroke="var(--bg)" stroke-width="3.5" stroke-linejoin="round" style="paint-order: stroke fill;">
  <text x="160" y="128" text-anchor="end" fill="var(--fg)" font-weight="700" font-size="14">Duna</text>
  <text x="233" y="188" text-anchor="end" fill="var(--fg)" font-weight="700" font-size="14">Tisza</text>
  <text x="100" y="250" text-anchor="middle" fill="var(--fg)" font-weight="600">Dráva</text>
  <text x="44" y="178" text-anchor="end" fill="var(--fg)">Mura</text>
  <text x="63" y="114" fill="var(--fg)">Rába</text>
  <text x="100" y="90" fill="var(--fg)">Mosoni-Duna</text>
  <text x="156" y="52" text-anchor="end" fill="var(--fg)">Ipoly</text>
  <text x="216" y="72" fill="var(--fg)">Zagyva</text>
  <text x="263" y="46" text-anchor="end" fill="var(--fg)">Sajó</text>
  <text x="300" y="24" fill="var(--fg)">Hernád</text>
  <text x="368" y="68" text-anchor="end" fill="var(--fg)">Szamos</text>
  <text x="262" y="136" fill="var(--fg)">Körösök</text>
  <text x="252" y="196" fill="var(--fg)">Maros</text>
  <text x="146" y="178" text-anchor="end" fill="var(--fg)">Sió</text>
  <text x="62" y="168" text-anchor="end" fill="var(--fg)">Zala</text>
  <text x="88" y="128" text-anchor="middle" fill="var(--muted)">Balaton</text>
  </g>
`;

// ---- 2b. Folyók: önálló lista, kattintható állomások ----
//
// Minden sor koppintásra nyit/csuk, és csak ELSŐ nyitáskor rajzolja fel a
// grafikonját (nem mindegyiket előre, ha a felhasználó sosem nyitja ki).
// A grafikon a hydroinfo.hu 6 napos előrejelzését (ingyen jön a már
// amúgy is lekért táblából) és a soil-moisture-mapper saját historikus
// naplójából visszaolvasott korábbi vízállást (history.jsonl, ld. a
// rivers-snapshot station.history mezőjét) köti össze egy közös
// grafikonon, "most" elválasztóval.
// A térkép egy folyójára kattintva a hozzá tartozó sorok nyílnak ebben a
// listában (ld. buildRiverNet): a sorokat itt jegyezzük meg folyónév szerint.
let riverListRows = [];

function buildRiverList(container, stations) {
  container.innerHTML = "";
  riverListRows = [];
  stations.forEach((station, i) => {
    const row = document.createElement("div");
    row.className = "water-river-row";
    // UX-audit A01: korábban ez egy sima <div onclick> volt - Tab-bal
    // átugorható, képernyőolvasóval észrevehetetlen. Valódi <button>, hogy a
    // nyitás/csukás billentyűzettel (Enter/Space) is elérhető legyen, az
    // aria-expanded/aria-controls pedig jelezze az állapotát és a célját.
    const chartId = `water-river-chart-${i}`;
    const head = document.createElement("button");
    head.type = "button";
    head.className = "water-river-row-head";
    head.setAttribute("aria-expanded", "false");
    head.setAttribute("aria-controls", chartId);
    head.innerHTML =
      `<span class="water-river-name">${station.river} · ${station.name}</span>` +
      `<span class="water-river-level">${waterNum(station.level_cm, 0)} cm</span>`;
    const chartWrap = document.createElement("div");
    chartWrap.className = "water-river-chart-wrap";
    chartWrap.id = chartId;
    const chartSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chartSvg.setAttribute("viewBox", "0 0 400 150");
    chartWrap.appendChild(chartSvg);

    let built = false;
    head.addEventListener("click", () => {
      const open = row.classList.toggle("open");
      head.setAttribute("aria-expanded", open ? "true" : "false");
      if (open && !built) {
        renderRiverChart(chartWrap, station, chartId);
        built = true;
      }
    });

    row.appendChild(head);
    row.appendChild(chartWrap);
    container.appendChild(row);
    riverListRows.push({ river: station.river, row, head });
  });
}

// ---- Folyóhálózat: rámutatás / koppintás ----
//
// A WATER_RIVER_NET_SVG statikus: az ország-beli folyók egymás utáni <path>-ok
// a "folyók az országban" csoportban. Ez a sorrend (a vonalvastagság szerint
// rendezett fájl, a feliratok koordinátáival egyeztetve) rendeli őket
// folyókhoz. A második tag az átlagos vízhozam (m³/s, ld. a táblázatot), a
// harmadik: hiányzik-e a pontos vízhozam-adat (halvány, szaggatott vonal).
const RIVER_NET_PATHS = [
  ["Zagyva", null, true], ["Hernád", null, true], ["Körösök", null, true],
  ["Körösök", null, true], ["Körösök", null, true], ["Zala", null, true],
  ["Mosoni-Duna", null, true], ["Ipoly", null, true], ["Rába", 27, false],
  ["Sió", 40, false], ["Sajó", 80, false], ["Szamos", 140, false],
  ["Mura", 170, false], ["Maros", 190, false], ["Dráva", 600, false],
  ["Tisza", 890, false], ["Duna", 2300, false],
];

// A térképi folyónév -> a mérőállomások folyóneve a rivers-snapshotban.
const RIVER_NET_GAUGE_NAME = { "Körösök": "Hármas-Körös" };
// Hová nézzen a buborék idősora: a tározó alatti Kisköre alsó mérce helyett
// a szolnoki (ld. a WATER_LAKE_BANDS megjegyzését a Tisza-tóról).
const RIVER_NET_PRIMARY_STATION = { "Tisza": "Szolnok" };

// A WATER_RIVER_NET_SVG-t a folyó-útvonalak data-river indexével adja vissza.
function riverNetMarkup() {
  const start = WATER_RIVER_NET_SVG.indexOf("<!-- folyók az országban");
  const namesAt = WATER_RIVER_NET_SVG.indexOf("<!-- nevek");
  let index = 0;
  const middle = WATER_RIVER_NET_SVG.slice(start, namesAt)
    .replace(/<path stroke-width=/g, () => `<path data-river="${index++}" stroke-width=`);
  return WATER_RIVER_NET_SVG.slice(0, start) + middle + WATER_RIVER_NET_SVG.slice(namesAt);
}

// Naponta egy érték (az adott nap utolsó mérése) a rivers-snapshot óránkénti
// naplójából, az utolsó 8 napra, aztán a "most" és az előrejelzés: ebből
// lesz a buborék kis vonaldiagramja.
function riverSparkSeries(station) {
  const byDay = new Map();
  for (const h of station.history || []) {
    const day = new Date(h.at).toLocaleDateString("sv-SE", { timeZone: "Europe/Budapest" });
    byDay.set(day, h.level_cm);
  }
  const todayKey = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Budapest" });
  byDay.delete(todayKey);
  const past = [...byDay.values()].slice(-8);
  return { values: [...past, station.level_cm, ...(station.forecast_cm || [])], nowIndex: past.length };
}

function riverNetPopupHtml(riverName, discharge, stations) {
  let html = `<strong>${riverName}</strong>`;
  if (discharge) html += `<span>átlagos vízhozam: kb. ${waterNum(discharge, 0)} m³/s</span>`;
  if (!stations.length) return html + `<span>nincs mérőállomás az oldalon</span>`;
  for (const st of stations) html += `<span>${st.name}: ${waterNum(st.level_cm, 0)} cm</span>`;
  const primaryName = RIVER_NET_PRIMARY_STATION[riverName];
  const primary = stations.find(st => st.name === primaryName) ||
    stations.find(st => st.role === "interior") || stations[0];
  const { values, nowIndex } = riverSparkSeries(primary);
  return html + popupSparklineSvg(values, nowIndex) +
    `<span>${primary.name}: 8 nap és 6 napos előrejelzés</span>`;
}

function buildRiverNet(svgEl, popupEl, stations) {
  svgEl.innerHTML = riverNetMarkup();
  const paths = [...svgEl.querySelectorAll("path[data-river]")];
  const mutedNames = new Set();
  RIVER_NET_PATHS.forEach(([name, , muted], i) => {
    const el = paths[i];
    if (!el) return;
    el.dataset.riverName = name;
    if (muted) { el.classList.add("is-muted"); mutedNames.add(name); }
  });
  svgEl.querySelectorAll("text").forEach(t => {
    if (mutedNames.has(t.textContent.trim())) t.classList.add("is-muted");
  });

  // Az érzékelő-réteg: a vékony vonalakra is könnyű legyen rámutatni, és
  // Tab-bal elérhető, olvasható aria-label-lel.
  let hits = "";
  paths.forEach((el, i) => {
    const [name, discharge] = RIVER_NET_PATHS[i] || [];
    if (!name) return;
    const gauges = stations.filter(st => st.river === (RIVER_NET_GAUGE_NAME[name] || name));
    const label = gauges.length
      ? `${name}: ${gauges.map(g => `${g.name} ${waterNum(g.level_cm, 0)} cm`).join(", ")}`
      : `${name}${discharge ? `, átlagosan kb. ${waterNum(discharge, 0)} köbméter másodpercenként` : ""}`;
    hits += `<path class="water-river-hit" data-hit="${i}" d="${el.getAttribute("d")}" tabindex="0" role="button" aria-label="${label}"></path>`;
  });
  svgEl.insertAdjacentHTML("beforeend", `<g>${hits}</g>`);

  const highlight = name => {
    svgEl.classList.toggle("has-hl", !!name);
    paths.forEach(el => el.classList.toggle("is-hl", !!name && el.dataset.riverName === name));
  };
  const show = (i, clientX, clientY) => {
    const [name, discharge] = RIVER_NET_PATHS[i];
    const gauges = stations.filter(st => st.river === (RIVER_NET_GAUGE_NAME[name] || name));
    highlight(name);
    mapPopupShow(popupEl, clientX, clientY, riverNetPopupHtml(name, discharge, gauges));
  };
  const clear = () => { highlight(null); mapPopupHide(popupEl); };
  const openInList = i => {
    const [name] = RIVER_NET_PATHS[i];
    const gaugeName = RIVER_NET_GAUGE_NAME[name] || name;
    const rows = riverListRows.filter(r => r.river === gaugeName);
    if (!rows.length) return;
    rows.forEach(r => { if (!r.row.classList.contains("open")) r.head.click(); });
    rows[0].row.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  svgEl.querySelectorAll(".water-river-hit").forEach(hit => {
    const i = Number(hit.dataset.hit);
    hit.addEventListener("pointermove", event => { if (event.pointerType === "mouse") show(i, event.clientX, event.clientY); });
    hit.addEventListener("pointerleave", event => { if (event.pointerType === "mouse") clear(); });
    hit.addEventListener("click", event => {
      event.stopPropagation();
      show(i, event.clientX, event.clientY);
      openInList(i);
    });
    hit.addEventListener("focus", () => {
      const r = hit.getBoundingClientRect();
      show(i, r.left + r.width / 2, r.top + r.height / 2);
    });
    hit.addEventListener("blur", clear);
    hit.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openInList(i); }
      if (event.key === "Escape") clear();
    });
  });
  if (buildRiverNet.closer) document.removeEventListener("click", buildRiverNet.closer);
  buildRiverNet.closer = clear;
  document.addEventListener("click", buildRiverNet.closer);
}

// Egy svg-figure képpont/viewBox-egység arányának (--k) követése, hogy a
// feliratok betűmérete képpontban állandó maradjon (ld. .water-map-label).
const figureScaleObservers = new Map();
function watchFigureScale(svgEl, viewBoxWidth) {
  const apply = () => {
    const w = svgEl.getBoundingClientRect().width;
    if (w > 0) svgEl.style.setProperty("--k", (w / viewBoxWidth).toFixed(3));
  };
  apply();
  if (!("ResizeObserver" in window)) return;
  if (figureScaleObservers.has(svgEl)) figureScaleObservers.get(svgEl).disconnect();
  const observer = new ResizeObserver(apply);
  observer.observe(svgEl);
  figureScaleObservers.set(svgEl, observer);
}

// Rövid "nov. 13." formátum, ugyanúgy mint formatStatsDate - itt viszont
// Date objektumból, nem ISO dátum-stringből indulunk.
function formatShortDate(d) {
  return d.toLocaleDateString("hu-HU", { timeZone: "Europe/Budapest", month: "short", day: "numeric" });
}

function renderRiverChart(wrapEl, station, chartId) {
  const svgEl = wrapEl.querySelector("svg");
  const history = station.history || [];
  const historyVals = history.map(h => h.level_cm);
  const forecastVals = station.forecast_cm || [];
  const series = [...historyVals, station.level_cm, ...forecastVals];
  const todayIdx = historyVals.length;

  // A grafikon a MEGJELENÍTETT képpont-szélességre készül (1 egység = 1
  // képpont), nem nyújtott viewBox-ra: korábban a szöveg is torzult, és
  // nagy képernyőn óriásira nőtt. A max-width (CSS) 720 px.
  const W = Math.max(280, Math.min(720, Math.round(wrapEl.clientWidth || 400)));
  const H = 170;
  svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svgEl.removeAttribute("preserveAspectRatio");

  if (series.length < 2) {
    svgEl.innerHTML = `<text x="8" y="40" font-size="13" fill="var(--muted)">még nincs elég adat a grafikonhoz</text>`;
    return;
  }

  // UX-audit D03: a grafikonnak eddig nem volt sem cm-tengelye, sem
  // dátumai - csak "múlt"/"most"/"6 napos előrejelzés" szavak. A tényleges
  // dátumokat a history[].at mezőkből (múlt) és a mai naptól számolva
  // (előrejelzés, napi bontású) kapjuk - nem kitalált, a snapshot saját
  // adata.
  const today = new Date();
  const dateFor = i => {
    if (i < history.length) return new Date(history[i].at);
    const daysAhead = i - todayIdx; // 0 a "most" pontnál, 1.. az előrejelzésnél
    const d = new Date(today);
    d.setDate(d.getDate() + daysAhead);
    return d;
  };

  // A hydroinfo.hu értékei naponta változnak, a gyűjtő viszont óránként
  // naplóz: a múltat ezért idő-arányos x-tengelyen, egyetlen vonalként
  // rajzoljuk (nem egy pont minden órás mintán - ez ~200 egymásra rajzolt
  // pötty volt). Az előrejelzés napi, ott kis pont jelöli a napokat.
  const tOf = i => dateFor(i).getTime();
  const tNow = today.getTime();
  const dayMs = 86400000;
  const tFor = i => (i < todayIdx ? tOf(i) : tNow + (i - todayIdx) * dayMs);
  const tMin = tFor(0), tMax = tFor(series.length - 1);

  const minV = Math.min(...series), maxV = Math.max(...series);
  const span = Math.max(maxV - minV, 1);
  const padL = 40, padR = 14, padTop = 22, padBottom = 28;
  const w = W - padL - padR, h = H - padTop - padBottom;
  const xFor = t => padL + ((t - tMin) / Math.max(tMax - tMin, 1)) * w;
  const yFor = v => padTop + h - ((v - minV) / span) * h;

  const pastPoints = series.slice(0, todayIdx + 1).map((v, i) => `${xFor(tFor(i)).toFixed(1)},${yFor(v).toFixed(1)}`);
  const futurePoints = series.slice(todayIdx).map((v, i) => `${xFor(tFor(todayIdx + i)).toFixed(1)},${yFor(v).toFixed(1)}`);
  const todayX = xFor(tNow).toFixed(1);

  let forecastDots = "";
  for (let i = todayIdx + 1; i < series.length; i++) {
    forecastDots += `<circle cx="${xFor(tFor(i)).toFixed(1)}" cy="${yFor(series[i]).toFixed(1)}" r="2.5" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.2"></circle>`;
  }

  svgEl.setAttribute("role", "img");
  svgEl.setAttribute("aria-label",
    `${station.river} ${station.name}, vízállás centiméterben, ${formatShortDate(dateFor(0))}-tól ${formatShortDate(dateFor(series.length - 1))}-ig - a pontos értékek a lenti táblázatban`);
  const axisY = padTop + h;
  svgEl.innerHTML = `
    <text x="${padL - 6}" y="${(yFor(maxV) + 4).toFixed(1)}" font-size="12" fill="var(--muted)" text-anchor="end">${waterNum(maxV, 0)}</text>
    <text x="${padL - 6}" y="${(yFor(minV) + 4).toFixed(1)}" font-size="12" fill="var(--muted)" text-anchor="end">${waterNum(minV, 0)}</text>
    <line x1="${padL}" y1="${axisY}" x2="${padL + w}" y2="${axisY}" stroke="var(--border)" stroke-width="1"></line>
    <line x1="${todayX}" y1="${padTop - 4}" x2="${todayX}" y2="${axisY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 3"></line>
    <polyline points="${pastPoints.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"></polyline>
    <polyline points="${futurePoints.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-dasharray="4 4" stroke-linejoin="round"></polyline>
    ${forecastDots}
    <circle cx="${todayX}" cy="${yFor(station.level_cm).toFixed(1)}" r="3.5" fill="var(--accent)"></circle>
    <text x="${todayX}" y="${(padTop - 8).toFixed(1)}" font-size="12" font-weight="600" fill="var(--fg)" text-anchor="middle">most: ${waterNum(station.level_cm, 0)} cm</text>
    <text x="${padL}" y="${axisY + 18}" font-size="12" fill="var(--muted)">${history.length > 0 ? formatShortDate(dateFor(0)) : ""}</text>
    <text x="${padL + w}" y="${axisY + 18}" font-size="12" fill="var(--muted)" text-anchor="end">${forecastVals.length ? `${formatShortDate(dateFor(series.length - 1))} (előrejelzés vége)` : formatShortDate(dateFor(series.length - 1))}</text>`;

  // Ugyanaz az adat táblázatként is - billentyűzettel/képernyőolvasóval
  // elérhető, és pontos érték olvasható ki belőle, nem csak a vonal alakja.
  // A múltbeli (gyakran óránkénti) mérésekből naponta csak az utolsót
  // mutatjuk, a diagram vizuális sűrűségét nem kell táblában is visszaadni.
  const dayRows = new Map();
  history.forEach(h => {
    const day = formatShortDate(new Date(h.at));
    dayRows.set(day, h.level_cm); // az utolsó felülírja a napon belüli korábbiakat
  });
  let tableRows = [...dayRows.entries()]
    .map(([day, cm]) => `<tr><td>${day}</td><td>${waterNum(cm, 0)} cm</td><td>mért</td></tr>`)
    .join("");
  tableRows += `<tr><td>${formatShortDate(today)}</td><td>${waterNum(station.level_cm, 0)} cm</td><td>most</td></tr>`;
  tableRows += forecastVals
    .map((cm, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i + 1);
      return `<tr><td>${formatShortDate(d)}</td><td>${waterNum(cm, 0)} cm</td><td>előrejelzés</td></tr>`;
    })
    .join("");

  let detailsEl = wrapEl.querySelector("details");
  if (!detailsEl) {
    detailsEl = document.createElement("details");
    detailsEl.className = "water-river-chart-table-details";
    detailsEl.innerHTML = `<summary>értékek táblázatban</summary><table class="water-river-chart-table"></table>`;
    wrapEl.appendChild(detailsEl);
  }
  detailsEl.querySelector("table").innerHTML = `<caption>${station.river} ${station.name}, napi vízállás</caption>
    <thead><tr><th>dátum</th><th>vízállás</th><th>típus</th></tr></thead>
    <tbody>${tableRows}</tbody>`;
}

// ---- 2d. Csatornák: önálló térkép (a felhasználó kérése szerint "külön" a
// dombormű-/folyóhálózat-térképektől), a nevesített csatornák, belvíz-
// elvezetők és árkok valódi futásával. A geometria a soil-moisture-mapper
// otthoni gépen futó app/channels.py-ból jön (ld. onnan a docstringet):
// Geofabrik OSM-kivonat, csak NEVESÍTETT vízfolyások (minden vízfolyás
// ~190KB gzipelve lenne egy háttér-rajzolathoz, a nevesítettek ~32KB) -
// a fejsoron és a hossz-táblán viszont a VALÓDI, minddel számolt
// darabszám/hossz szerepel, nem csak a berajzolt rész. Nem élő adat: a
// hálózat geometriája ritkán változik, a home-job alkalmanként, kézzel
// frissíti, nem az óránkénti ciklus része (ellentétben a talaj-/folyó-/
// tó-pillanatképekkel) - ezért ennek a lekérése is a többitől FÜGGETLEN
// try/catch-ben történik lent, hogy egy még hiányzó csatorna-pillanatkép
// ne dönthesse el a már működő szakaszokat.
// geo.names egy dedup-olt névtábla, geo.features egy lapos lista (ld.
// app/channels.py docstring) - minden feature saját gyűrűt, típust és
// hosszt visel, hogy a térképen EGYENKÉNT rámutatható/rákoppintható legyen.
function decodeChannelFeatures(geo) {
  const names = geo.names || [];
  // geo.scale: a channels-snapshot SAJÁT, a borders.json/water-geo.json-tól
  // eltérő, finomabb koordináta-skálája (ld. app/channels.py docstring -
  // a *100-ás közös skála a nevesített vízfolyások felénél egyetlen pontra
  // zsugorította a geometriát). A JSON-ban utazik, nem kell kézzel szinkronban
  // tartott duplikált konstans a frontenden.
  const scale = geo.scale || 100;
  return (geo.features || []).map(f => ({
    name: names[f.n] ?? null,
    type: f.t,
    km: f.km,
    ring: decodeDeltaRings([f.g], scale)[0],
  }));
}

const CHANNEL_TYPE_LABEL = {
  canal: "csatorna", drain: "belvízelvezető", ditch: "árok", river: "folyó", lake: "tó",
};

// UX-audit D04: ugyanaz a kézzel jóváhagyott szinonima-tábla, mint a
// soil-moisture-mapper app/channels.py RIVER_NAME_SYNONYMS-je - határ menti
// szakaszok kétnyelvű OSM-neve ("Dunaj / Duna") itt a kereső-listában (ld.
// lent, searchableByName) is a magyar kanonikus név alá csoportosul, nem
// külön, zavaró sorként jelenik meg. Csak ez a véges lista, nem algoritmus -
// ld. a python oldali fejkommentet, miért nem lett belőle általános heurisztika.
const RIVER_NAME_SYNONYMS = {
  "Dunaj / Duna": "Duna", "Dunaj": "Duna", "Dunav / Дунав": "Duna",
  "Тиса - Tisza": "Tisza", "Tisa - Tisza": "Tisza", "Тиса": "Tisza",
  "Dráva / Drava": "Dráva", "Drava / Dráva": "Dráva",
  "Raab / Rába": "Rába",
  "Ipoly / Ipeľ": "Ipoly", "Ipeľ / Ipoly": "Ipoly",
  "Slaná / Sajó": "Sajó",
  "Hernád/Hornád": "Hernád",
  "Lafnitz / Lapincs": "Lapincs",
  "Crișul Alb / Fehér-Körös": "Fehér-Körös",
  "Ledava / Lendva": "Lendva", "Lendva / Ledava": "Lendva",
  "Tőzegcsatorna / Torfkanal": "Tőzegcsatorna",
};

// Pöccre nagyítható/mozgatható csatorna-térkép: a teljes hálózat helyett
// mindig csak a jelenlegi nézet (view) + a rajta belüli zoom-szinthez
// (zoomRatio) tartozó típus(ok) rajzolódnak ki - ettől marad gyors a DOM
// akár 6335 nevesített vízfolyásnál is. A view SOHA nem léphet ki a
// hálózat teljes kiterjedéséből (fullBounds) - se nagyítással kisebbre,
// se kicsinyítéssel nagyobbra, se húzással arrébb -, hogy sose lehessen
// kiüres területre pannelni.
function buildChannelsMap(svgEl, legendEl, channelsSnapshot) {
  const WIDTH = 400;
  const HEIGHT = 250;
  const PAD_DEG = 0.15;
  const ZOOM_STEP = 1.4;
  const MIN_VIEW_DEG = 0.015; // kb. 1,5 km-es sávnál ne engedjünk tovább nagyítani
  const LOD_DRAIN_RATIO = 2.2; // zoomRatio (teljes/jelenlegi szélesség), amitől a belvízelvezető is látszik
  const LOD_DITCH_RATIO = 5.5; // ...és amitől az árok is

  const features = decodeChannelFeatures(channelsSnapshot.geo);
  if (!features.length) {
    svgEl.innerHTML = "";
    legendEl.textContent = "";
    return;
  }

  // A Balaton (és a Fertő-/Velencei-tó) OSM-ben multipolygon-RELÁCIÓ, a
  // channels.py feldolgozás szándékosan nem kapja el őket (ld. a python-
  // oldali modul-docstring) - DE a Balaton valódi körvonala már úgyis itt
  // van a honlapon, a water-geo.json-ban (a dombormű-térkép/radar
  // használja). Kár lenne nem felhasználni ugyanerre a térképre is: a
  // felhasználó Magyarország legismertebb taváról kérdez rá, nem kapna
  // kielégítő választ, ha a pöccre nagyítható térkép egyszerűen hallgat
  // róla, miközben a geometria már rendelkezésre áll.
  if (waterGeo && waterGeo.lakes && waterGeo.lakes.length && waterGeo.lakes[0].length > 2) {
    const ring = waterGeo.lakes[0];
    let perimeterKm = 0;
    for (let i = 0; i < ring.length; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[(i + 1) % ring.length];
      perimeterKm += distanceKm(lat1, lon1, lat2, lon2);
    }
    features.push({ name: "Balaton", type: "lake", km: perimeterKm, ring });
  }

  // A méretarány-doboz MINDIG a csatornák saját kiterjedéséből jön (azok
  // garantáltan Magyarországon belül vannak) - a világ-körvonalakból
  // (borderRings) sosem, mert azok kiterjedése az egész Föld. Minden
  // feature-höz egyszer kiszámoljuk a saját bbox-át is, hogy nagyításkor
  // gyorsan ki lehessen szűrni, mi esik a látható ablakba.
  const featuresWithBounds = features.map(f => {
    const flons = f.ring.map(p => p[0]), flats = f.ring.map(p => p[1]);
    return {
      ...f,
      minLon: Math.min(...flons), maxLon: Math.max(...flons),
      minLat: Math.min(...flats), maxLat: Math.max(...flats),
    };
  });
  // A tavak (ellentétben a csatornával/folyóval) DOT-ként is kirajzolódnak
  // (ld. render() LAKE_DOT_PX_THRESHOLD), ami egy vonalnál sokkal nagyobb
  // vizuális súlyú elem - mind az 1056-ot egyszerre, teljes kiterjedésben
  // kirajzolva a térkép pettyekkel teliszórt, olvashatatlan lett volna.
  // Ezért a tavak (ellentétben canal/river-rel) ZOOM-fokozatosan tárulnak
  // fel, a SAJÁT méretük (bbox-átló) szerinti sorrendben - ld. render()
  // lakeRank/LAKE_REVEAL_BASE.
  const lakesBySize = featuresWithBounds
    .filter(f => f.type === "lake")
    .sort((a, b) => (b.maxLon - b.minLon + (b.maxLat - b.minLat)) - (a.maxLon - a.minLon + (a.maxLat - a.minLat)));
  const lakeRank = new Map(lakesBySize.map((f, i) => [f, i]));

  // Vonalvastagság a vízfolyás saját hossza szerint (nagyobb csatorna/folyó
  // = vastagabb vonal) - a tipus SAJÁT (nem a teljes hálózat) legrövidebb/
  // leghosszabb nevesített tagjához képest, log-skálán (egy-két kiugróan
  // hosszú folyó/főcsatorna ne nyomja az egész típus többi tagját a
  // minimumra). A teljes (nem csak látható) feature-halmazon SZÁMOLVA EGYSZER,
  // hogy egy adott vonal vastagsága zoomra/pannelésre ne ugráljon.
  const BASE_STROKE_WIDTH = { canal: 0.9, drain: 0.6, ditch: 0.4, river: 1.7 };
  const kmLogRangeByType = {};
  for (const f of featuresWithBounds) {
    if (f.type === "lake") continue; // a tó mérete a kiterjedésén látszik, nem a vonalvastagságán
    const logKm = Math.log(1 + f.km);
    const r = kmLogRangeByType[f.type] || (kmLogRangeByType[f.type] = { min: logKm, max: logKm });
    if (logKm < r.min) r.min = logKm;
    if (logKm > r.max) r.max = logKm;
  }
  function strokeWidthFor(type, km) {
    const base = BASE_STROKE_WIDTH[type];
    if (base === undefined) return null; // lake: a CSS-saját szélesség marad
    const range = kmLogRangeByType[type];
    const norm = range.max > range.min ? (Math.log(1 + km) - range.min) / (range.max - range.min) : 0.5;
    return base * (0.6 + 0.8 * norm);
  }

  const allLons = featuresWithBounds.map(f => f.minLon).concat(featuresWithBounds.map(f => f.maxLon));
  const allLats = featuresWithBounds.map(f => f.minLat).concat(featuresWithBounds.map(f => f.maxLat));
  const fullBounds = {
    minLon: Math.min(...allLons) - PAD_DEG, maxLon: Math.max(...allLons) + PAD_DEG,
    minLat: Math.min(...allLats) - PAD_DEG, maxLat: Math.max(...allLats) + PAD_DEG,
  };
  // Ugyanaz a pontos, egybefüggő gyűrű-kiválasztás, mint a dombormű-
  // térképen (ld. selectCountryBorderRing fejkomment) - a határvonal
  // mindenhol a site-on egyformán pontos legyen, bármilyen nagyításnál.
  const borderRing = selectCountryBorderRing(fullBounds.minLon, fullBounds.maxLon, fullBounds.minLat, fullBounds.maxLat);

  // Domborzat-háttér: a nyers 90x40-es rácsot EGYETLEN <canvas>-ból kapott
  // data URL-ként tároljuk, EGYSZER (nem minden render()-nél újra) - a
  // böngésző saját, natív képnagyítása (bilineáris) simítja fel, amikor az
  // SVG <image> a tényleges képernyőméretre nyújtja lent, nincs szükség
  // kézi upscale-re/interpolációra a frontenden.
  let elevationDataUrl = null;
  if (elevationGrid && elevationGrid.rows && elevationGrid.cols) {
    const canvas = document.createElement("canvas");
    canvas.width = elevationGrid.cols;
    canvas.height = elevationGrid.rows;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(elevationGrid.cols, elevationGrid.rows);
    for (let r = 0; r < elevationGrid.rows; r++) {
      const row = elevationGrid.shade[r];
      for (let c = 0; c < elevationGrid.cols; c++) {
        const v = row[c];
        const di = (r * elevationGrid.cols + c) * 4;
        img.data[di] = v;
        img.data[di + 1] = v;
        img.data[di + 2] = v;
        img.data[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    elevationDataUrl = canvas.toDataURL();
  }

  let view = { ...fullBounds };
  let visible = []; // az aktuálisan kirajzolt feature-ök - a data-fid ebbe indexel
  const activePointers = new Map(); // pointerId -> {x, y}, húzáshoz/csippentéshez
  let renderScheduled = false;
  // A legenda kattintható (ld. lent) - egy típus ide kerül, ha a felhasználó
  // kikapcsolta, függetlenül attól, hogy a LOD szerint egyébként látszana.
  const disabledTypes = new Set();

  const tooltipEl = document.getElementById("water-channels-tooltip");

  const clampSpan = (span, fullSpan) => Math.min(Math.max(span, MIN_VIEW_DEG), fullSpan);

  function setView(minLon, maxLon, minLat, maxLat) {
    const lonSpan = maxLon - minLon, latSpan = maxLat - minLat;
    const fullLonSpan = fullBounds.maxLon - fullBounds.minLon;
    const fullLatSpan = fullBounds.maxLat - fullBounds.minLat;
    const clampedMinLon = fullLonSpan <= lonSpan
      ? fullBounds.minLon
      : Math.min(Math.max(minLon, fullBounds.minLon), fullBounds.maxLon - lonSpan);
    const clampedMinLat = fullLatSpan <= latSpan
      ? fullBounds.minLat
      : Math.min(Math.max(minLat, fullBounds.minLat), fullBounds.maxLat - latSpan);
    view = { minLon: clampedMinLon, maxLon: clampedMinLon + lonSpan, minLat: clampedMinLat, maxLat: clampedMinLat + latSpan };
    scheduleRender();
  }

  function zoomBy(factor, centerLon, centerLat) {
    const lonSpan = clampSpan((view.maxLon - view.minLon) / factor, fullBounds.maxLon - fullBounds.minLon);
    const latSpan = clampSpan((view.maxLat - view.minLat) / factor, fullBounds.maxLat - fullBounds.minLat);
    const relX = (centerLon - view.minLon) / (view.maxLon - view.minLon);
    const relY = (centerLat - view.minLat) / (view.maxLat - view.minLat);
    const minLon = centerLon - relX * lonSpan;
    const minLat = centerLat - relY * latSpan;
    setView(minLon, minLon + lonSpan, minLat, minLat + latSpan);
  }

  function screenToGeo(px, py) {
    const project = fitFlatProjection(view.minLon, view.maxLon, view.minLat, view.maxLat, WIDTH, HEIGHT);
    return {
      lon: view.minLon + (px - project.originX) / (project.lonFactor * project.scale),
      lat: view.maxLat - (py - project.originY) / project.scale,
    };
  }

  function panByPixels(dxPx, dyPx) {
    const project = fitFlatProjection(view.minLon, view.maxLon, view.minLat, view.maxLat, WIDTH, HEIGHT);
    const dLon = -dxPx / (project.lonFactor * project.scale);
    const dLat = dyPx / project.scale;
    setView(view.minLon + dLon, view.maxLon + dLon, view.minLat + dLat, view.maxLat + dLat);
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => { renderScheduled = false; render(); });
  }

  function showTooltip(fid, clientX, clientY) {
    const f = visible[fid];
    if (!f) return;
    const title = f.name || CHANNEL_TYPE_LABEL[f.type];
    mapPopupShow(tooltipEl, clientX, clientY,
      `<strong>${title}</strong><span>${CHANNEL_TYPE_LABEL[f.type]}, ${waterNum(f.km, 1)} km</span>`);
  }
  function hideTooltip() {
    mapPopupHide(tooltipEl);
  }

  // Aktiválás: egy kattintás/koppintás után a sima görgő nagyít, a húzás
  // mozgat (ld. style.css #water-channels-map.is-active) - addig az oldal
  // görög tovább a térkép fölött is. Escape vagy a térképen kívüli kattintás
  // elengedi. Az első aktiválásig egy rövid felirat jelzi a lehetőséget.
  let active = false;
  const hintEl = document.getElementById("water-channels-hint");
  function setActive(on) {
    active = on;
    svgEl.classList.toggle("is-active", on);
    if (on && hintEl) hintEl.hidden = true;
  }
  if (hintEl) hintEl.hidden = false;

  // A keresésre ugrott vízfolyás neve: kiemelve rajzoljuk (ld. render()).
  let highlightName = null;

  // A viewBox-egység -> képpont arány (--k): a feliratok méretét ezzel
  // osztva képpontban állandó marad a betű.
  const pxPerUnit = () => (svgEl.getBoundingClientRect().width / WIDTH) || 1;

  function labelsMarkup(project, zoomRatio, activeTypes) {
    const k = pxPerUnit();
    const boxes = [];
    const fits = box => !boxes.some(b => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
    let out = "";

    // Folyók és főcsatornák neve: a nézetben lévő, névvel ellátott legnagyobb
    // vonalak, a vonal közepén, a vonal irányába forgatva (de sosem fejjel lefelé).
    if (zoomRatio >= 2) {
      const best = new Map();
      for (const f of visible) {
        if (!f.name || (f.type !== "river" && f.type !== "canal")) continue;
        const name = RIVER_NAME_SYNONYMS[f.name] || f.name;
        if (!best.has(name) || best.get(name).km < f.km) best.set(name, f);
      }
      const named = [...best.entries()].sort((a, b) => b[1].km - a[1].km).slice(0, 14);
      for (const [name, f] of named) {
        // A nézetben lévő csúcsok közül a nézet középpontjához legközelebbi.
        let pick = -1, pickDist = Infinity;
        const cx = WIDTH / 2, cy = HEIGHT / 2;
        for (let i = 1; i < f.ring.length - 1; i++) {
          const { x, y } = project(f.ring[i][1], f.ring[i][0]);
          if (x < 8 || x > WIDTH - 8 || y < 8 || y > HEIGHT - 8) continue;
          const d = Math.hypot(x - cx, y - cy);
          if (d < pickDist) { pickDist = d; pick = i; }
        }
        if (pick < 0) continue;
        const p = project(f.ring[pick][1], f.ring[pick][0]);
        const a = project(f.ring[pick - 1][1], f.ring[pick - 1][0]);
        const b = project(f.ring[pick + 1][1], f.ring[pick + 1][0]);
        let angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        const w = (name.length * 6 + 6) / k, h = 12 / k;
        const box = { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - h, y1: p.y + h / 2 };
        if (!fits(box)) continue;
        boxes.push(box);
        out += `<text class="water-map-label water-map-label-water" x="${p.x.toFixed(1)}" y="${(p.y - 2 / k).toFixed(1)}" text-anchor="middle" transform="rotate(${angle.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)})">${name}</text>`;
      }
    }

    // Városok: rang szerint fokozatosan (1: megyeszékhelyek, 2: nagyobb
    // városok, 3: kisebb városok).
    if (placesList.length) {
      const maxRank = zoomRatio >= 4 ? 3 : zoomRatio >= 2 ? 2 : 1;
      const towns = placesList
        .filter(p => p.r <= maxRank)
        .map(p => ({ p, pos: project(p.lat, p.lon) }))
        .filter(t => t.pos.x > 4 && t.pos.x < WIDTH - 4 && t.pos.y > 8 && t.pos.y < HEIGHT - 4)
        .sort((a, b) => a.p.r - b.p.r);
      let shown = 0;
      for (const t of towns) {
        if (shown >= 40) break;
        const w = (t.p.n.length * 6.2 + 8) / k, h = 14 / k;
        const onRight = t.pos.x > WIDTH - w - 8;
        const x0 = onRight ? t.pos.x - w : t.pos.x;
        const box = { x0, x1: x0 + w, y0: t.pos.y - h, y1: t.pos.y + 3 / k };
        if (!fits(box)) continue;
        boxes.push(box);
        shown += 1;
        out += `<circle class="water-map-town" cx="${t.pos.x.toFixed(1)}" cy="${t.pos.y.toFixed(1)}" r="${(2 / k).toFixed(2)}"></circle>` +
          `<text class="water-map-label" x="${(t.pos.x + (onRight ? -3 : 3) / k).toFixed(1)}" y="${(t.pos.y - 3 / k).toFixed(1)}" text-anchor="${onRight ? "end" : "start"}">${t.p.n}</text>`;
      }
    }
    return out;
  }

  // Méretarány-vonal a bal alsó sarokban: egy "szép" kerek hossz (km), ami kb.
  // 80-120 képpont széles.
  function scaleBarMarkup(project) {
    const k = pxPerUnit();
    const kmPerUnit = 111 / project.scale;
    const targetKm = (90 / k) * kmPerUnit;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200].reduce((best, v) => Math.abs(v - targetKm) < Math.abs(best - targetKm) ? v : best);
    const w = nice / kmPerUnit;
    const x0 = 10 / k, y = HEIGHT - 12 / k;
    return `<g class="water-map-scale" pointer-events="none"><line x1="${x0.toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x0 + w).toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--fg)" stroke-width="${(2 / k).toFixed(2)}"></line>` +
      `<text class="water-map-label" x="${x0.toFixed(1)}" y="${(y - 5 / k).toFixed(1)}">${nice} km</text></g>`;
  }

  // Kis országtérkép a jobb alsó sarokban, a jelenlegi nézet téglalapjával.
  function insetMarkup(project, zoomRatio) {
    if (zoomRatio < 1.3 || !borderRing) return "";
    const k = pxPerUnit();
    const boxW = 72 / k, boxH = (72 * (fullBounds.maxLat - fullBounds.minLat) / ((fullBounds.maxLon - fullBounds.minLon) * Math.cos(47 * Math.PI / 180))) / k;
    const small = fitFlatProjection(fullBounds.minLon, fullBounds.maxLon, fullBounds.minLat, fullBounds.maxLat, boxW, boxH);
    const ox = WIDTH - boxW - 8 / k, oy = HEIGHT - boxH - 8 / k;
    let d = "";
    borderRing.forEach(([lon, lat], i) => {
      const p = small(lat, lon);
      d += `${i === 0 ? "M" : "L"}${(ox + p.x).toFixed(1)} ${(oy + p.y).toFixed(1)}`;
    });
    const tl = small(view.maxLat, view.minLon), br = small(view.minLat, view.maxLon);
    return `<g pointer-events="none"><rect x="${(ox - 3 / k).toFixed(1)}" y="${(oy - 3 / k).toFixed(1)}" width="${(boxW + 6 / k).toFixed(1)}" height="${(boxH + 6 / k).toFixed(1)}" fill="var(--bg)" opacity="0.8"></rect>` +
      `<path d="${d}Z" fill="none" stroke="var(--fg)" stroke-width="${(1 / k).toFixed(2)}"></path>` +
      `<rect x="${(ox + tl.x).toFixed(1)}" y="${(oy + tl.y).toFixed(1)}" width="${Math.max(br.x - tl.x, 1).toFixed(1)}" height="${Math.max(br.y - tl.y, 1).toFixed(1)}" fill="var(--accent)" fill-opacity="0.25" stroke="var(--accent)" stroke-width="${(1.2 / k).toFixed(2)}"></rect></g>`;
  }

  function render() {
    const project = fitFlatProjection(view.minLon, view.maxLon, view.minLat, view.maxLat, WIDTH, HEIGHT);
    const zoomRatio = (fullBounds.maxLon - fullBounds.minLon) / (view.maxLon - view.minLon);
    // A folyó (438 nevesített) a csatornával együtt MINDIG látszik -
    // nagyságrendileg ugyanott van, mint a ma is alapból látható csatorna
    // (2161) -, csak a belvízelvezető/árok vár nagyításra. A tó (1056,
    // típusban MINDIG "aktív", de lent, MÉRET szerint tovább szűrve - ld.
    // MIN_LAKE_PX) eleve csak a ténylegesen észrevehető méretűekkel.
    const activeTypes = new Set(["canal", "river", "lake"]);
    if (zoomRatio >= LOD_DRAIN_RATIO) activeTypes.add("drain");
    if (zoomRatio >= LOD_DITCH_RATIO) activeTypes.add("ditch");
    for (const t of disabledTypes) activeTypes.delete(t);

    // Kis ráhagyással szűrünk, hogy a view szélén belépő vonalak se
    // vágódjanak le csonkán, mire a pointer odaér.
    const marginLon = (view.maxLon - view.minLon) * 0.1;
    const marginLat = (view.maxLat - view.minLat) * 0.1;
    // A tavak mérete NAGYON szór (néhány méteres halastótól a több km²-es
    // tóig). Élesben lemérve: a LEGNAGYOBB nevesített tó (Alcsi Holt-Tisza)
    // is csak ~4 képpont teljes kiterjedésben, keskeny mobilon - egy, a
    // VALÓDI körvonalat rajzoló megoldásnak NINCS olyan mérete, ami ezt
    // látszódóvá tenné, ÉS minden más (apróbb) tavat is láthatóan megjelenít
    // (ld. non-scaling-stroke próbálkozás: technikailag "látszik", a
    // képernyőn gyakorlatilag észrevehetetlen maszat). A valódi térképeken
    // bevett trükk: a TÚL apró alakzatokat nem körvonalként, hanem egy fix
    // méretű PONTKÉNT rajzoljuk (a tó középpontjában) - ez bármilyen
    // méretnél ugyanolyan jól látszik, és nagyításkor, amint a valódi alak
    // már elég nagy lenne, visszavált a tényleges körvonalra.
    const LAKE_DOT_PX_THRESHOLD = 12;
    // A tavak száma a nagyítással EGYÜTT nő (mint a drain/ditch rétegnél),
    // csak itt nem egy be/ki típus-kapcsoló, hanem egy fokozatosan táguló
    // darabszám, a tavak SAJÁT mérete szerinti sorrendben (lakesBySize) -
    // teljes kiterjedésben csak a legnagyobbak, minél jobban nagyítasz,
    // annál több (egészen az összesig).
    const LAKE_REVEAL_BASE = 30;
    const lakeKeepCount = Math.min(lakesBySize.length, Math.round(LAKE_REVEAL_BASE * zoomRatio));
    visible = featuresWithBounds.filter(f =>
      activeTypes.has(f.type) &&
      (f.type !== "lake" || lakeRank.get(f) < lakeKeepCount) &&
      f.maxLon >= view.minLon - marginLon && f.minLon <= view.maxLon + marginLon &&
      f.maxLat >= view.minLat - marginLat && f.minLat <= view.maxLat + marginLat
    );

    const pathByIdx = visible.map(f => {
      if (f.type === "lake") {
        const pxLon = (f.maxLon - f.minLon) * project.lonFactor * project.scale;
        const pxLat = (f.maxLat - f.minLat) * project.scale;
        if (Math.max(pxLon, pxLat) < LAKE_DOT_PX_THRESHOLD) {
          let sumLon = 0, sumLat = 0;
          for (const [lon, lat] of f.ring) { sumLon += lon; sumLat += lat; }
          const { x, y } = project(sumLat / f.ring.length, sumLon / f.ring.length);
          return { mode: "dot", x, y };
        }
      }
      let d = "";
      f.ring.forEach(([lon, lat], i) => {
        const { x, y } = project(lat, lon);
        d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      });
      return { mode: "path", d };
    });

    let markup = "";
    let borderD = "";
    if (borderRing) {
      borderRing.forEach(([lon, lat], i) => {
        const { x, y } = project(lat, lon);
        borderD += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      });
    }
    // A domborzat-kép az ORSZÁG VALÓDI körvonalára van vágva (ugyanaz a
    // borderD, amit a látható határvonal is használ lent) - a kép maga a
    // teljes rács téglalapját fedi, a project() minden render()-nél (zoom/
    // pan) újraszámolja, hova vetül a rács négy sarka a jelenlegi nézetben.
    if (borderD && elevationDataUrl) {
      const gridMaxLat = elevationGrid.min_lat + (elevationGrid.rows - 1) * elevationGrid.step_deg;
      const gridMaxLon = elevationGrid.min_lon + (elevationGrid.cols - 1) * elevationGrid.step_deg;
      const topLeft = project(gridMaxLat, elevationGrid.min_lon);
      const bottomRight = project(elevationGrid.min_lat, gridMaxLon);
      markup += `<defs><clipPath id="water-channels-elevation-clip"><path d="${borderD}Z"></path></clipPath></defs>`;
      markup += `<image class="water-channel-elevation" href="${elevationDataUrl}" x="${topLeft.x.toFixed(1)}" y="${topLeft.y.toFixed(1)}" width="${(bottomRight.x - topLeft.x).toFixed(1)}" height="${(bottomRight.y - topLeft.y).toFixed(1)}" preserveAspectRatio="none" clip-path="url(#water-channels-elevation-clip)"></image>`;
    }
    // Megyehatárok: vékony pontvonal, kicsit nagyítva már (az áttekintő nézet
    // maradjon tiszta). A saját megyehatár-fájl (counties-hu.json) a
    // megyéket zárt gyűrűként adja, az országhatárral egybeeső szakaszok
    // egymásra rajzolódnak.
    if (zoomRatio >= 1.5 && countyRings.length) {
      let countyD = "";
      for (const ring of countyRings) {
        ring.forEach(([lon, lat], i) => {
          const { x, y } = project(lat, lon);
          countyD += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
        });
        countyD += "Z";
      }
      markup += `<path class="water-channel-county" d="${countyD}"></path>`;
    }
    if (borderD) {
      markup += `<path class="water-channel-border" d="${borderD}Z"></path>`;
    }
    // Legalul a legapróbb/legsűrűbb (árok), legfelül a csatorna/tó, hogy a
    // ritkább, de "fontosabb" vízfolyások ne tűnjenek el a sűrű árokrajzban.
    for (const type of ["ditch", "drain", "river", "canal", "lake"]) {
      if (!activeTypes.has(type)) continue;
      visible.forEach((f, idx) => {
        if (f.type !== type) return;
        const item = pathByIdx[idx];
        if (item.mode === "dot") {
          markup += `<circle class="water-channel-lake-dot" data-fid="${idx}" cx="${item.x.toFixed(1)}" cy="${item.y.toFixed(1)}" r="2.2"></circle>`;
        } else {
          const width = strokeWidthFor(f.type, f.km);
          const widthAttr = width !== null ? ` style="stroke-width:${width.toFixed(2)}"` : "";
          const hl = highlightName && f.name && (RIVER_NAME_SYNONYMS[f.name] || f.name) === highlightName ? " is-hl" : "";
          markup += `<path class="water-channel-${type}${hl}" data-fid="${idx}"${widthAttr} d="${item.d}"></path>`;
        }
      });
    }
    // Feliratok: városok (a nagyítással egyre kisebbek is), a nagyobb folyók és
    // főcsatornák neve a vonaluk mentén; az egymást fedőket kihagyjuk.
    markup += labelsMarkup(project, zoomRatio, activeTypes);
    markup += scaleBarMarkup(project) + insetMarkup(project, zoomRatio);

    // A találat-céllapok (átlátszó, szélesebb vonal/kör) legfelül, MINDEN
    // látható vonalra - ugyanaz a trükk, mint a .water-cell-touch/
    // .water-marker-touch-nál, hogy a vékony árok-vonalakra (és az apró
    // tó-pontokra) is könnyű legyen rámutatni/rákoppintani.
    visible.forEach((f, idx) => {
      const item = pathByIdx[idx];
      if (item.mode === "dot") {
        markup += `<circle class="water-channel-hit" data-fid="${idx}" cx="${item.x.toFixed(1)}" cy="${item.y.toFixed(1)}" r="7"></circle>`;
      } else {
        markup += `<path class="water-channel-hit" data-fid="${idx}" d="${item.d}"></path>`;
      }
    });

    svgEl.innerHTML = markup;
  }

  // Amíg a térkép nincs aktiválva (kattintás/koppintás), a sima görgő az
  // OLDALT görgeti (UX-audit U03: korábban a térkép elnyelte a görgetést);
  // aktiválás után a görgő nagyít. A Ctrl/Cmd+görgő (a trackpad-csippentés is
  // így jön) mindig nagyít.
  svgEl.addEventListener("wheel", event => {
    const wants = active || event.ctrlKey || event.metaKey;
    if (!wants) return;
    event.preventDefault();
    if (hintEl) hintEl.hidden = true;
    const rect = svgEl.getBoundingClientRect();
    const px = (event.clientX - rect.left) * (WIDTH / rect.width);
    const py = (event.clientY - rect.top) * (HEIGHT / rect.height);
    const { lon, lat } = screenToGeo(px, py);
    zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, lon, lat);
  }, { passive: false });

  // Az aktív állapot elengedése: Escape, vagy a térképen (figure-en) kívüli
  // kattintás/koppintás. Egy korábbi build figyelői ne halmozódjanak.
  if (buildChannelsMap.releasers) {
    document.removeEventListener("pointerdown", buildChannelsMap.releasers.down);
    document.removeEventListener("keydown", buildChannelsMap.releasers.key);
  }
  buildChannelsMap.releasers = {
    down: event => {
      if (!svgEl.parentElement.contains(event.target)) { setActive(false); hideTooltip(); }
    },
    key: event => { if (event.key === "Escape") { setActive(false); hideTooltip(); } },
  };
  document.addEventListener("pointerdown", buildChannelsMap.releasers.down);
  document.addEventListener("keydown", buildChannelsMap.releasers.key);

  let tapStart = null; // {x, y, target}: a koppintás/kattintás felismeréséhez
  svgEl.addEventListener("pointerdown", event => {
    // Mindenkit nyilvántartunk (kell a második ujj érkezésekor a
    // csippentés-számításhoz). Egérrel a húzás azonnal mozgat; EGY érintő ujj
    // csak aktivált térképnél (különben az oldal görög, touch-action: pan-y).
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    tapStart = activePointers.size === 1 ? { x: event.clientX, y: event.clientY, target: event.target } : null;
    if (event.pointerType === "mouse") {
      svgEl.setPointerCapture(event.pointerId);
      svgEl.style.cursor = "grabbing";
      hideTooltip();
    } else if (activePointers.size === 2 || active) {
      for (const id of activePointers.keys()) svgEl.setPointerCapture(id);
      hideTooltip();
    }
  });

  svgEl.addEventListener("pointermove", event => {
    if (!activePointers.has(event.pointerId)) {
      if (event.pointerType === "mouse" && event.target.tagName === "path" && event.target.dataset.fid !== undefined) {
        showTooltip(Number(event.target.dataset.fid), event.clientX, event.clientY);
      } else if (event.pointerType === "mouse") {
        hideTooltip();
      }
      return;
    }
    const prev = activePointers.get(event.pointerId);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (tapStart && Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y) > 5) tapStart = null;
    const rect = svgEl.getBoundingClientRect();

    if (activePointers.size === 1) {
      if (event.pointerType !== "mouse" && !active) return; // aktiválatlanul egy ujjal az oldal görög
      const dxPx = (event.clientX - prev.x) * (WIDTH / rect.width);
      const dyPx = (event.clientY - prev.y) * (HEIGHT / rect.height);
      panByPixels(dxPx, dyPx);
    } else if (activePointers.size === 2) {
      // Két ujjas csippentés: a másik (nem mozgó) pointer utolsó ismert
      // helyéhez mérve a távolság-változás adja a nagyítás mértékét, a két
      // pont középpontja a nagyítás középpontja.
      event.preventDefault();
      const otherId = [...activePointers.keys()].find(id => id !== event.pointerId);
      const other = activePointers.get(otherId);
      const prevDist = Math.hypot(prev.x - other.x, prev.y - other.y);
      const newDist = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      if (prevDist > 0 && newDist > 0) {
        const midX = (event.clientX + other.x) / 2, midY = (event.clientY + other.y) / 2;
        const px = (midX - rect.left) * (WIDTH / rect.width);
        const py = (midY - rect.top) * (HEIGHT / rect.height);
        const { lon, lat } = screenToGeo(px, py);
        zoomBy(newDist / prevDist, lon, lat);
      }
    }
  });

  // Koppintás/kattintás (nem húzás): aktiválja a térképet, és ha vízfolyásra
  // esett, megmutatja a buborékját (érintőképernyőn nincs rámutatás).
  function endPointer(event) {
    const wasTap = tapStart && activePointers.size === 1;
    activePointers.delete(event.pointerId);
    if (activePointers.size === 0) svgEl.style.cursor = "";
    if (wasTap && event.type === "pointerup") {
      setActive(true);
      const target = tapStart.target;
      if (target && target.tagName === "path" && target.dataset.fid !== undefined) {
        showTooltip(Number(target.dataset.fid), event.clientX, event.clientY);
      } else {
        hideTooltip();
      }
    }
    tapStart = null;
  }
  svgEl.addEventListener("pointerup", endPointer);
  svgEl.addEventListener("pointercancel", endPointer);
  svgEl.addEventListener("pointerleave", event => {
    if (event.pointerType === "mouse" && activePointers.size === 0) hideTooltip();
  });

  // Billentyűzet: Enter/Szóköz aktivál, utána +/- nagyít, a nyilak mozgatnak.
  svgEl.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActive(true);
      return;
    }
    const c = { lon: (view.minLon + view.maxLon) / 2, lat: (view.minLat + view.maxLat) / 2 };
    if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP, c.lon, c.lat);
    else if (event.key === "-") zoomBy(1 / ZOOM_STEP, c.lon, c.lat);
    else if (event.key === "ArrowLeft") panByPixels(24, 0);
    else if (event.key === "ArrowRight") panByPixels(-24, 0);
    else if (event.key === "ArrowUp") panByPixels(0, 24);
    else if (event.key === "ArrowDown") panByPixels(0, -24);
    else return;
    event.preventDefault();
  });

  const zoomInBtn = document.getElementById("water-channels-zoom-in");
  const zoomOutBtn = document.getElementById("water-channels-zoom-out");
  const zoomResetBtn = document.getElementById("water-channels-zoom-reset");
  const viewCenter = () => ({ lon: (view.minLon + view.maxLon) / 2, lat: (view.minLat + view.maxLat) / 2 });
  if (zoomInBtn) zoomInBtn.addEventListener("click", () => { const c = viewCenter(); zoomBy(ZOOM_STEP, c.lon, c.lat); });
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => { const c = viewCenter(); zoomBy(1 / ZOOM_STEP, c.lon, c.lat); });
  if (zoomResetBtn) zoomResetBtn.addEventListener("click", () => { view = { ...fullBounds }; highlightName = null; render(); });
  // A gombok használata is "használatba vétel": a felirat már nem kell.
  for (const btn of [zoomInBtn, zoomOutBtn]) if (btn) btn.addEventListener("click", () => { if (hintEl) hintEl.hidden = true; });

  // UX-audit A01 (teljes kör): a térkép maga (5000+ feature) eddig csak
  // egérrel/érintéssel volt böngészhető. Itt NÉV szerint csoportosítjuk a
  // feature-öket (egy "Duna" simán 55+ külön OSM-szakaszból áll, ld.
  // decodeChannelFeatures fejkomment - külön sorként mutatva olvashatatlan
  // lenne), a hosszukat összeadva és a befoglaló téglalapjukat egyesítve,
  // EGYSZER, nem minden billentyűleütésnél. A csoportosító kulcs NÉV+TÍPUS
  // (nem csak név): a valódi adaton kiderült, hogy van külön, a folyótól
  // FÜGGETLEN "Duna" nevű árok (4 way, 0,09 km) ÉS "Dunaj" nevű csatorna is
  // (1 way, 15,7 km) - ugyanaz a hiba lenne, mint a D04-ben kijavított
  // kétnyelvű névösszevonás, ha típustól függetlenül összeadnánk őket (ld.
  // app/channels.py RIVER_NAME_SYNONYMS fejkommentjét).
  const searchableByName = new Map();
  for (const f of featuresWithBounds) {
    if (!f.name) continue;
    const canonicalName = RIVER_NAME_SYNONYMS[f.name] || f.name;
    const key = `${canonicalName}|${f.type}`;
    const existing = searchableByName.get(key);
    if (existing) {
      existing.km += f.km;
      existing.minLon = Math.min(existing.minLon, f.minLon);
      existing.maxLon = Math.max(existing.maxLon, f.maxLon);
      existing.minLat = Math.min(existing.minLat, f.minLat);
      existing.maxLat = Math.max(existing.maxLat, f.maxLat);
    } else {
      searchableByName.set(key, {
        name: canonicalName, km: f.km,
        minLon: f.minLon, maxLon: f.maxLon, minLat: f.minLat, maxLat: f.maxLat,
        types: new Set([f.type]),
      });
    }
  }
  const searchableFeatures = [...searchableByName.values()];

  const searchInput = document.getElementById("water-channels-search-input");
  const searchStatus = document.getElementById("water-channels-search-status");
  const searchResultsEl = document.getElementById("water-channels-search-results");
  const SEARCH_MAX_RESULTS = 25;
  const SEARCH_MIN_CHARS = 2;

  function jumpToSearchResult(item) {
    // Aktiváláskor a típusa ne maradjon a legendából kikapcsolva (ld.
    // disabledTypes) - a keresés célja pont az, hogy MEGMUTASSA, nem hogy
    // elrejtett maradjon egy korábbi szűrés miatt.
    for (const t of item.types) disabledTypes.delete(t);
    highlightName = item.name;
    const lonPad = Math.max((item.maxLon - item.minLon) * 0.3, MIN_VIEW_DEG / 2);
    const latPad = Math.max((item.maxLat - item.minLat) * 0.3, MIN_VIEW_DEG / 2);
    setView(item.minLon - lonPad, item.maxLon + lonPad, item.minLat - latPad, item.maxLat + latPad);
    const centerLat = (item.minLat + item.maxLat) / 2, centerLon = (item.minLon + item.maxLon) / 2;
    const typeLabel = [...item.types].map(t => CHANNEL_TYPE_LABEL[t]).join(", ");
    searchStatus.textContent =
      `${item.name} (${typeLabel}, ${waterNum(item.km, 1)} km) - a térkép odaugrott, kb. ${Math.abs(centerLat).toFixed(1)}°É ${Math.abs(centerLon).toFixed(1)}°K`;
  }

  function renderSearchResults(query) {
    searchResultsEl.innerHTML = "";
    const q = query.trim().toLocaleLowerCase("hu-HU");
    if (q.length < SEARCH_MIN_CHARS) {
      searchStatus.textContent = query.trim().length > 0 ? `írj be legalább ${SEARCH_MIN_CHARS} betűt` : "";
      return;
    }
    const matches = searchableFeatures
      .filter(f => f.name.toLocaleLowerCase("hu-HU").includes(q))
      .sort((a, b) => b.km - a.km)
      .slice(0, SEARCH_MAX_RESULTS);
    if (!matches.length) {
      searchStatus.textContent = "nincs ilyen nevű vízfolyás";
      return;
    }
    searchStatus.textContent = `${matches.length} találat${matches.length === SEARCH_MAX_RESULTS ? " (csak az első " + SEARCH_MAX_RESULTS + ")" : ""}`;
    for (const item of matches) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      const typeLabel = [...item.types].map(t => CHANNEL_TYPE_LABEL[t]).join(", ");
      btn.innerHTML = `<span>${item.name}</span><span>${typeLabel}, ${waterNum(item.km, 1)} km</span>`;
      btn.addEventListener("click", () => jumpToSearchResult(item));
      li.appendChild(btn);
      searchResultsEl.appendChild(li);
    }
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => renderSearchResults(searchInput.value));
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const firstBtn = searchResultsEl.querySelector("button");
        if (firstBtn) firstBtn.click();
      }
    });
  }

  render();

  // Induló "kígyózó" betöltés: a kezdő (teljes kiterjedésű) nézet vonalai
  // nem egyszerre jelennek meg, hanem sorban, kirajzolódva - MINDIG csak
  // egyszer, zoomra/pannelésre SOHA nem ismétlődik (a render() ezt nem
  // hívja újra). Két fázisra bontva: az ELREJTÉS azonnal, szinkron megtörténik
  // (a vonalak a build pillanatától kezdve láthatatlanok - különben, ha a
  // térkép még a görgetési oldal alján van, mire a felhasználó odaér, a
  // vonalak már RÉGEN látszanának, nem lenne mit "kígyózva" megmutatni), a
  // KIRAJZOLÁS (a tényleges animáció) viszont csak akkor indul, amikor a
  // térkép TÉNYLEG a látható területre ér, ld. IntersectionObserver lent.
  // A stroke-dasharray/-dashoffset trükk: a vonal saját hosszára állítjuk a
  // szaggatást, elrejtve azt, majd 0-ra animáljuk - a lépcsőzött delay adja
  // a "kígyó" hatást. A találat-céllapok (.water-channel-hit) érintetlenek,
  // a rámutatás már az animáció közben is működik.
  // Ennyire kizoomolva sok apró feature (kis tó, rövid folyószakasz) a
  // pixel-kerekítés miatt NULLA hosszú path-ot ad (minden pontja ugyanarra
  // a 0,1 egységre kerekszik) - ezeken a dashoffset sosem VÁLTOZIK (0->0),
  // a böngésző (helyesen) nem indít animációt, a transitionend sosem tüzel.
  // Ezeket ezért ki is hagyjuk a kígyózásból, nem csak hiába rejtjük el.
  // A felhasználó kérésére a legkisebb csatornától a legnagyobbig kígyózik
  // végig, nem a rajzolási (fontossági) sorrendben - a feature saját km-je
  // adja a sorrendet, nem azt, melyik típus/réteg.
  const introPaths = [...svgEl.querySelectorAll("path[data-fid]")]
    .filter(p => !p.classList.contains("water-channel-hit") && p.getTotalLength() > 0.5)
    .sort((a, b) => visible[Number(a.dataset.fid)].km - visible[Number(b.dataset.fid)].km);
  const introLengths = introPaths.map(p => p.getTotalLength());
  introPaths.forEach((p, idx) => {
    const len = introLengths[idx];
    p.style.strokeDasharray = `${len}`;
    p.style.strokeDashoffset = `${len}`;
  });

  function playSnakeIntro(onDone) {
    if (!introPaths.length) { onDone(); return; }
    const INTRO_MS = 1600;
    const DRAW_MS = 420;
    let finished = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onDone();
    };
    // Biztonsági háló: ha a felhasználó zoomol/pannel az animáció KÖZBEN,
    // a render() újraépíti a DOM-ot (svgEl.innerHTML = markup), a még
    // függőben lévő transitionend-ek a RÉGI (már eltávolított) elemeken
    // SOHA nem tüzelnek el - enélkül a `finished` sosem éri el a célszámot,
    // és a görgetés-tiltás örökre beragadna. Egy felső korlát-időzítő
    // garantálja a feloldást akkor is, ha ez történik.
    setTimeout(finish, INTRO_MS + DRAW_MS + 400);
    // Dupla requestAnimationFrame: a böngészőnek TÉNYLEG ki kell festenie a
    // fenti "elrejtett" állapotot (1. keret), mielőtt az átmenetet elindítjuk
    // (2. keret) - egy szinkron reflow-olvasás (pl. getBoundingClientRect)
    // ehhez NEM elég, az átmenet "előző" állapota csak egy valódi kifestett
    // kereten át rögzül, különben a két stílusváltás egybeolvad, nincs
    // animáció, és a transitionend sosem tüzel el (a tó szaggatása is
    // beragadna).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        introPaths.forEach((p, idx) => {
          const delay = (idx / introPaths.length) * INTRO_MS;
          p.style.transition = `stroke-dashoffset ${DRAW_MS}ms ease ${delay}ms`;
          p.style.strokeDashoffset = "0";
          p.addEventListener("transitionend", () => {
            p.style.strokeDasharray = "";
            p.style.strokeDashoffset = "";
            p.style.transition = "";
            finished += 1;
            if (finished === introPaths.length) finish();
          }, { once: true });
        });
      });
    });
  }

  // A felhasználó kérésére: NEM azonnal indul a kígyózás, amint a térkép
  // akár csak egy kicsit is látszóvá válik - csak akkor, amikor a térkép
  // TELJESEN befért a látható ablakba (threshold majdnem 1 - a kerekítési
  // hibák miatt nem pontosan 1). ETTŐL a pillanattól tiltjuk le a
  // görgetést az animáció idejére, hogy ne tudjon félbehagyva, kapkodva
  // továbbgörgetni mellette. A tiltás az animáció végén (minden vonal
  // lekígyózott) magától feloldódik.
  if (introPaths.length && "IntersectionObserver" in window) {
    const introObserver = new IntersectionObserver((entries) => {
      if (entries.some(e => e.intersectionRatio >= 0.98)) {
        introObserver.disconnect();
        document.documentElement.classList.add("scroll-locked");
        document.body.classList.add("scroll-locked");
        playSnakeIntro(() => {
          document.documentElement.classList.remove("scroll-locked");
          document.body.classList.remove("scroll-locked");
        });
      }
    }, { threshold: [0, 0.98, 1] });
    introObserver.observe(svgEl);
  } else {
    playSnakeIntro(() => {});
  }

  // Valódi mini-vonalmintával (ugyanazzal a CSS-osztállyal, mint a térképen),
  // nem csak prózában leírva, melyik stílus melyik típust jelenti - ha a
  // térképi stílus változik, ez a legenda automatikusan követi, nincs két
  // helyen karbantartandó leírás. KATTINTHATÓ is: egy típus ki-/bekapcsolható,
  // a disabledTypes-on és a render() activeTypes-szűrésén keresztül hat.
  const LEGEND_TYPE_ORDER = ["canal", "river", "drain", "ditch", "lake"];
  const swatchRow = LEGEND_TYPE_ORDER.map(type => `
    <button type="button" class="water-legend-item" data-type="${type}" aria-pressed="true">
      <svg class="water-legend-swatch" viewBox="0 0 24 6" aria-hidden="true"><line x1="0" y1="3" x2="24" y2="3" class="water-channel-${type}"></line></svg>${CHANNEL_TYPE_LABEL[type]}
    </button>`).join("");
  legendEl.innerHTML = `<span class="water-legend-row">${swatchRow}</span>Csak a nevesített vízfolyások és tavak; a teli pont egy kis tó. Kattints a térképre, utána a görgő nagyít, a húzás mozgat (Escape: elengedi); érintőképernyőn csippentéssel nagyítható. Minél közelebb nagyítasz, annál több vízfolyás, város és megyehatár látszik. Rámutatva (vagy rákoppintva) a vízfolyás neve és hossza jelenik meg. A jelmagyarázatra kattintva ki-/bekapcsolható az adott típus.${elevationDataUrl ? " A háttér domborzat-árnyékolás (Copernicus DEM GLO-30)." : ""}`;

  legendEl.addEventListener("click", event => {
    const btn = event.target.closest(".water-legend-item");
    if (!btn) return;
    const type = btn.dataset.type;
    if (disabledTypes.has(type)) {
      disabledTypes.delete(type);
      btn.setAttribute("aria-pressed", "true");
      btn.classList.remove("water-legend-item-off");
    } else {
      disabledTypes.add(type);
      btn.setAttribute("aria-pressed", "false");
      btn.classList.add("water-legend-item-off");
    }
    scheduleRender();
  });
}

// ---- 3. Személyes: a keresett helyszín talajszelvénye (tájkép-metszet) ----
//
// Mélység-arányos tájkép-metszet (renderSoilCoreProfile): a rétegek vastagsága
// a valódi mélység, a vonalkázás sűrűsége a víz%-ot adja, mellé jön a rétegben
// lévő víz literben négyzetméterenként (nedvesség x mm). Az országos átlaghoz
// mért összevetést a szakasz szövegsorai adják.
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
  // A válasz "elevation" mezője (tengerszint feletti magasság) ingyen jár
  // mellé: az ábra a talajfelszín vonalánál mutatja, külön hívás nélkül.
  const moisture = WATER_DEPTH_BANDS.map(([lo, hi]) => data.hourly[`soil_moisture_${lo}_to_${hi}cm`][bestIdx]);
  return { moisture, elevation: typeof data.elevation === "number" ? data.elevation : null };
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

// A talajszelvény TÁJKÉP-metszet: felül a talajfelszín a keresett hely
// ismert épületével (vagy általános falusi képpel), alatta a talaj vízszintes
// rétegei teljes szélességben, a vastagság arányos a valódi mélységgel
// (0-81 cm), a vonalkázás sűrűsége a víz%-ot adja. Az épület NEM méretarányos
// a talajrétegekhez (ezt az ábra alatti jegyzet is kimondja). A 81 cm alatt
// nincs adat: ott csak egy halvány sáv és egy törésjel van, talajvizet,
// víztartó rétegeket vagy kutat szándékosan nem rajzolunk.
//
// A tereptárgy-sziluettek kézzel rajzolt, egyszerű körvonalak: helyi
// koordinátákban (x: középvonal, y: a talajszinttől felfelé negatív),
// mindegyik kb. 1,5 kB alatti útvonaladat. A kiválasztás település neve
// szerint, vagy a város koordinátájától 8 km-en belül történik (a
// koordináták a places-hu.json-ból valók).
function sclCrenel(x0, x1, y, w, h) {
  let d = `M${x0} ${y}`;
  for (let x = x0; x < x1; x += w * 2) d += `V${y - h}H${Math.min(x + w, x1)}V${y}H${Math.min(x + 2 * w, x1)}`;
  return d;
}

const SOIL_LANDMARKS = [
  { key: "budapest", name: "Budapest", lat: 47.498, lon: 19.04, label: "Országház", w: 260, h: 142, scale: 0.78,
    body: "M-130 0V-28H-124L-118 -64L-112 -28H-96L-90 -44L-84 -28H-60V-46H-34V-70H-22V-84C-22 -108 -8 -118 0 -122C8 -118 22 -108 22 -84V-70H34V-46H60V-28H84L90 -44L96 -28H112L118 -64L124 -28H130V0Z",
    detail: "M0 -122V-142M-130 -28H130M-120 -14H120M-8 -92H8M-8 -80H8" },
  { key: "szeged", name: "Szeged", lat: 46.253, lon: 20.148, label: "Fogadalmi templom (Dóm)", w: 124, h: 160, scale: 0.9,
    body: "M-60 0V-112L-47 -160L-34 -112V-62L0 -92L34 -62V-112L47 -160L60 -112V0Z",
    detail: "M-60 -112H-34M34 -112H60M-47 -100V-78M47 -100V-78M-10 0V-18A10 10 0 0 1 10 -18V0M-60 -30H-34M34 -30H60M0 -92V-80" , extra: `<circle cx="0" cy="-50" r="11" fill="var(--bg)"></circle>` },
  { key: "debrecen", name: "Debrecen", lat: 47.531, lon: 21.627, label: "Református Nagytemplom", w: 160, h: 142, scale: 0.95,
    body: "M-80 0V-96Q-80 -118 -63 -126Q-46 -118 -46 -96V-52H-40L0 -76L40 -52H46V-96Q46 -118 63 -126Q80 -118 80 -96V0Z",
    detail: "M-63 -126V-144M63 -126V-144M-46 -52H46M-24 -50V0M-8 -50V0M8 -50V0M24 -50V0M-68 -84V-62M68 -84V-62M-46 -96H-80M46 -96H80" },
  { key: "pecs", name: "Pécs", lat: 46.072, lon: 18.232, label: "Gázi Kászim pasa dzsámija", w: 184, h: 108, scale: 1.0,
    body: "M-92 0V-24H-62V-44H-48A48 40 0 0 1 48 -44H62V0Z",
    detail: "M0 -84V-106M-6 -98H6M-62 -24H-92M-42 0V-14A6 6 0 0 1 -30 -14V0M-6 0V-14A6 6 0 0 1 6 -14V0M30 0V-14A6 6 0 0 1 42 -14V0M-48 -44H48" },
  { key: "gyor", name: "Győr", lat: 47.687, lon: 17.65, label: "Városháza", w: 180, h: 172, scale: 0.85,
    body: "M-90 0V-50H-16V-120Q-24 -130 -10 -142Q-3 -152 0 -172Q3 -152 10 -142Q24 -130 16 -120V-50H90V0Z",
    detail: "M-90 -50H90M-16 -112H16M-76 -34V-20M-56 -34V-20M-36 -34V-20M36 -34V-20M56 -34V-20M76 -34V-20", extra: `<circle cx="0" cy="-92" r="8" fill="var(--bg)"></circle>` },
  { key: "esztergom", name: "Esztergom", lat: 47.793, lon: 18.74, label: "Bazilika", w: 200, h: 166, scale: 0.85,
    body: "M-100 0V-38H-90V-78L-79 -94L-68 -78V-38H-46V-56L-34 -60V-110A34 38 0 0 1 34 -110V-60L46 -56V-38H68V-78L79 -94L90 -78V-38H100V0Z",
    detail: "M-46 -56L0 -72L46 -56H-46M0 -148V-166M-5 -158H5M-24 -54V0M-8 -54V0M8 -54V0M24 -54V0M-28 -110V-78M-14 -110V-78M0 -110V-78M14 -110V-78M28 -110V-78" },
  { key: "eger", name: "Eger", lat: 47.903, lon: 20.373, label: "minaret és a vár", w: 190, h: 170, scale: 0.9,
    body: "M-120 0V-34H-100V-60Q-100 -64 -86 -80Q-72 -64 -72 -60V-34H-40V-34H24V-100H18V-106H48V-100H42V-132L33 -170L24 -132V-100H24V0Z",
    detail: "M-120 -34H24M-86 -80V-90M24 -106H48M28 -70H38M-86 -50V-38", crenel: [-120, -100, -34, 5, 6, -72, -40] },
  { key: "kecskemet", name: "Kecskemét", lat: 46.907, lon: 19.692, label: "Városháza", w: 220, h: 118, scale: 0.8,
    body: "M-110 0V-36H-96V-52L-90 -62L-84 -52V-36H-44V-60H-34V-72H-24V-84H-12V-96H12V-84H24V-72H34V-60H44V-36H84V-52L90 -62L96 -52V-36H110V0Z",
    detail: "M0 -96V-118M-110 -36H110M-90 -62V-70M90 -62V-70M-70 -22V-12M-50 -22V-12M50 -22V-12M70 -22V-12M-8 0V-16A8 8 0 0 1 8 -16V0M-12 -60H12" },
  { key: "sopron", name: "Sopron", lat: 47.685, lon: 16.59, label: "Tűztorony", w: 80, h: 178, scale: 0.9,
    body: "M-30 0V-34H-20V-86H-26V-92H26V-86H20V-34H30V0ZM-16 -92V-116Q-27 -126 -9 -140Q-3 -150 0 -178Q3 -150 9 -140Q27 -126 16 -116V-92Z",
    detail: "M-8 0V-14A8 8 0 0 1 8 -14V0M-20 -34H20M-16 -104H16M-8 -66V-50M8 -66V-50M0 -178V-188" },
];

// A kisebb, névtelen falusi kép: templom egy tornyos sziluettel.
const SOIL_GENERIC_CHURCH = {
  body: "M-38 0V-34H-16V-70H16V-34H38V0Z",
  detail: "M-16 -70L0 -112L16 -70M0 -112V-128M-5 -120H5M-38 -34H-16M16 -34H38M-4 0V-14A4 4 0 0 1 4 -14V0M-27 -18V-8M27 -18V-8",
  w: 76, h: 128, scale: 1,
};

function soilFold(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function soilLandmarkFor(point) {
  if (!point) return null;
  const name = soilFold(point.name);
  let best = SOIL_LANDMARKS.find(l => name && (name === soilFold(l.name) || name.startsWith(soilFold(l.name) + ",") || name.startsWith(soilFold(l.name) + " ")));
  if (!best && typeof point.lat === "number" && typeof point.lon === "number") {
    best = SOIL_LANDMARKS.find(l => distanceKm(point.lat, point.lon, l.lat, l.lon) < 8);
  }
  return best || null;
}

function soilHouse(x, scale = 1, variant = 0) {
  const w = (variant ? 38 : 46), h = (variant ? 22 : 26), roof = variant ? 12 : 16;
  return `<g transform="translate(${x} 0) scale(${scale})"><path d="M${-w / 2} 0V${-h}H${w / 2}V0ZM${-w / 2 - 4} ${-h}L0 ${-h - roof}L${w / 2 + 4} ${-h}" fill="var(--bg)"></path>` +
    `<path d="M-5 0V-12H5V0M${variant ? 12 : 14} -16h6v6h-6Z" fill="none"></path></g>`;
}

function soilTree(x, scale = 1) {
  return `<g transform="translate(${x} 0) scale(${scale})"><path d="M-3 0V-22M3 0V-22" fill="none"></path>` +
    `<path d="M0 -22C-26 -22 -28 -50 -12 -58C-10 -72 12 -72 14 -58C30 -52 26 -22 0 -22Z" fill="var(--bg)"></path>` +
    `<path d="M-8 -34C-4 -40 4 -40 8 -34" fill="none"></path></g>`;
}

function soilRoots(x, scale = 1) {
  // A fa gyökerei a felső rétegekbe nyúlnak: vékony vonal, háttér-színű
  // "glória" alatta, hogy a vonalkázásban is olvasható maradjon.
  const d = `M${x} 0Q${x - 6} 18 ${x - 20} 36M${x} 0Q${x + 4} 30 ${x + 12} 62M${x} 4Q${x + 18} 12 ${x + 34} 18M${x - 2} 10Q${x - 20} 14 ${x - 36} 12M${x - 8} 20Q${x - 14} 40 ${x - 12} 58M${x + 12} 30Q${x + 26} 38 ${x + 30} 54`;
  return `<path d="${d}" fill="none" stroke="var(--bg)" stroke-width="3.6" class="scl-root-halo"></path>` +
    `<path d="${d}" fill="none" stroke="var(--fg)" stroke-width="1" class="scl-root"></path>`;
}

function soilLandmarkSvg(lm, cx) {
  const sc = lm.scale;
  let crenel = "";
  if (lm.crenel) {
    // Eger: a vár kőfala fogazott koronával, a bástyán kúpos tetővel.
    crenel = `<path d="${sclCrenel(-120, 24, -34, 6, 7)}" fill="var(--bg)"></path>`;
  }
  return `<g transform="translate(${cx} 0) scale(${sc})">` +
    `<path d="${lm.body}" fill="var(--bg)"></path>${lm.extra || ""}` +
    `<path d="${lm.detail}" fill="none"></path>${crenel}</g>`;
}

// A kép felső (felszín feletti) része. A fák a talajrétegek fölé állnak
// (gyökerekkel), a házak a jobb oldali szabad sávba. Az épület nem méretarányos.
function soilSceneSvg(point, GY, elevationM, narrow = false, sc = 1) {
  const lm = soilLandmarkFor(point);
  const placeName = (point && point.name) ? point.name : "a keresett hely";
  const cx = 230;
  let scene;
  if (lm) {
    scene = soilLandmarkSvg(lm, cx);
  } else {
    scene = `<g transform="translate(${cx} 0) scale(${SOIL_GENERIC_CHURCH.scale})"><path d="${SOIL_GENERIC_CHURCH.body}" fill="var(--bg)"></path><path d="${SOIL_GENERIC_CHURCH.detail}" fill="none"></path></g>` +
      soilHouse(cx - 78, 1, 1) + soilHouse(cx + 70, 1, 0);
  }
  const trees = soilTree(372, 1.05) + soilTree(442, 0.85);
  const houses = soilHouse(540, 1, 0) + soilHouse(606, 0.85, 1) + soilHouse(670, 1, 1);
  const art = `<g class="scl-art" transform="translate(0 ${GY}) scale(${sc})" stroke="var(--fg)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${scene}${trees}${houses}</g>`;
  const hasElev = typeof elevationM === "number" && isFinite(elevationM);
  if (narrow) {
    // Keskeny kijelzőn külön elrendezés: a három fejlécsor egymás alatt, normál sorközzel.
    const head = `<text class="water-map-label scl-place" x="4" y="16"><tspan style="font-weight:600">${placeName}</tspan>` +
      (lm ? `<tspan x="4" dy="1.4em" style="fill:var(--muted)">${lm.label}</tspan>` : "") +
      (hasElev ? `<tspan x="4" dy="1.4em">${waterNum(Math.round(elevationM), 0)} m a tengerszint felett</tspan>` : "") + `</text>`;
    return head + art;
  }
  const labelBase = `<text class="water-map-label scl-place" x="80" y="26"><tspan style="font-weight:600">${placeName}</tspan>` +
    (lm ? `<tspan x="80" dy="1.35em" style="fill:var(--muted)">${lm.label}</tspan>` : "") + `</text>`;
  const elev = hasElev
    ? `<text class="water-map-label" x="716" y="26" text-anchor="end">${waterNum(Math.round(elevationM), 0)} m a tengerszint felett</text>` +
      `<polyline points="708,32 708,${GY - 2}" fill="none" stroke="var(--muted)" stroke-width="0.75" stroke-dasharray="2 3"></polyline>` +
      `<path d="M703 ${GY - 8}L708 ${GY - 1}L713 ${GY - 8}Z" fill="var(--fg)"></path>`
    : "";
  return labelBase + elev + art;
}

function soilHatchDefs(k) {
  // A vonalkázás képpontban állandó sűrűségű: a minta mérete a megjelenített
  // szélességgel arányosan nő, ahogy az ábra kisebbre skálázódik.
  const s = 1 / Math.max(0.35, Math.min(1.5, k));
  return WATER_HATCH_TILE_PX.map((tile, i) => `
    <pattern id="wh${i}" width="${(tile * s).toFixed(2)}" height="${(tile * s).toFixed(2)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="${(tile * s).toFixed(2)}" height="${(tile * s).toFixed(2)}" fill="var(--bg)"></rect>
      <line x1="${(tile * s / 2).toFixed(2)}" y1="0" x2="${(tile * s / 2).toFixed(2)}" y2="${(tile * s).toFixed(2)}" stroke="var(--accent)" stroke-width="${(1.2 * s).toFixed(2)}"></line>
    </pattern>`).join("");
}

const soilCoreObservers = new WeakMap();
const SOIL_NARROW_PX = 500;

// Két elrendezés: asztali (720 egység széles viewBox, jobb oldali feliratok
// vezetővonallal) és keskeny kijelzőre (a viewBox szélessége a megjelenített
// képpont-szélesség, így a betűk nem kicsinyednek; a feliratok a rétegeken
// BELÜL, háttér-lapon állnak). Keskenyen a legfelső réteg a felirat miatt a
// valódi aránynál vastagabbra van rajzolva (a jegyzet ezt kimondja).
function renderSoilCoreProfile(svgEl, moistureByDepth, point, elevationM) {
  const measured = svgEl.getBoundingClientRect().width;
  const narrow = measured > 0 && measured < SOIL_NARROW_PX;
  const VW = narrow ? Math.round(measured) : 720;
  const GY = narrow ? 150 : 214;
  const X0 = narrow ? 46 : 80, X1 = narrow ? VW - 8 : 480, LX = 500;
  const totalDepth = 81, perCm = narrow ? 3.4 : 4;
  const heights = WATER_DEPTH_BANDS.map(([lo, hi], i) => (narrow && i < 3) ? [6, 10, 22][i] : (hi - lo) * perCm);
  let y = GY;
  const boxes = WATER_DEPTH_BANDS.map(([lo, hi], i) => {
    const box = { lo, hi, y, h: heights[i] };
    y += box.h;
    return box;
  });
  const bottomY = y;

  const groups = [];
  let cursor = 0;
  while (cursor < boxes.length) {
    let end = cursor;
    while (end + 1 < boxes.length && boxes[end + 1].h < 30 && boxes[cursor].h < 30) end += 1;
    let wsum = 0, msum = 0, liters = 0;
    for (let k = cursor; k <= end; k++) {
      const th = WATER_DEPTH_BANDS[k][2];
      wsum += th; msum += moistureByDepth[k] * th;
      liters += moistureByDepth[k] * (boxes[k].hi - boxes[k].lo) * 10;
    }
    const y0 = boxes[cursor].y, y1 = boxes[end].y + boxes[end].h;
    groups.push({ lo: boxes[cursor].lo, hi: boxes[end].hi, y0, y1, mid: (y0 + y1) / 2, pct: Math.round(msum / wsum * 100), liters: Math.round(liters) });
    cursor = end + 1;
  }
  const totalLiters = Math.round(moistureByDepth.reduce((s, m, i) => s + m * (boxes[i].hi - boxes[i].lo) * 10, 0));
  const MIN_LABEL_GAP = 74;
  let prevLabelY = GY + 34 - MIN_LABEL_GAP; // az első felirat a házak alá kerül
  groups.forEach(g => {
    g.labelY = Math.max(g.mid, prevLabelY + MIN_LABEL_GAP);
    prevLabelY = g.labelY;
  });

  const rects = boxes.map((box, i) =>
    `<rect x="${X0}" y="${box.y.toFixed(1)}" width="${X1 - X0}" height="${box.h.toFixed(1)}" fill="url(#wh${waterHatchIndex(moistureByDepth[i])})" stroke="var(--fg)" stroke-width="1" vector-effect="non-scaling-stroke"></rect>`).join("");

  const tickYs = { 0: GY, 9: boxes[3].y, 27: boxes[4].y, 81: bottomY };
  const ticks = [0, 9, 27, 81].map(cm => {
    const yy = tickYs[cm];
    return `<line x1="${X0 - 8}" y1="${yy}" x2="${X0}" y2="${yy}" stroke="var(--fg)" stroke-width="1" vector-effect="non-scaling-stroke"></line>` +
      `<text class="water-map-label" x="${X0 - 11}" y="${yy + 4}" text-anchor="end">${cm === 81 ? "81 cm" : cm}</text>`;
  }).join("");

  let leaders = "", labels = "";
  if (narrow) {
    labels = groups.map(g =>
      `<rect x="${X0 + 6}" y="${(g.mid - 17).toFixed(1)}" width="124" height="34" fill="var(--bg)" stroke="var(--fg)" stroke-width="0.75" vector-effect="non-scaling-stroke"></rect>` +
      `<text class="water-map-label" x="${X0 + 12}" y="${(g.mid - 3).toFixed(1)}"><tspan style="font-weight:600">${g.lo}–${g.hi} cm, ${g.pct}% víz</tspan><tspan x="${X0 + 12}" dy="1.3em" style="fill:var(--muted)">kb. ${waterNum(g.liters, 0)} liter / m²</tspan></text>`).join("");
  } else {
    leaders = groups.map(g =>
      `<polyline points="${X1},${g.mid.toFixed(1)} ${X1 + 8},${g.mid.toFixed(1)} ${LX - 4},${g.labelY.toFixed(1)}" vector-effect="non-scaling-stroke"></polyline>`).join("");
    labels = groups.map(g =>
      `<text class="water-map-label" x="${LX}" y="${g.labelY.toFixed(1)}"><tspan dy="-0.2em" style="font-weight:600">${g.lo}–${g.hi} cm, ${g.pct}% víz</tspan><tspan x="${LX}" dy="1.35em" style="fill:var(--muted)">kb. ${waterNum(g.liters, 0)} liter / m²</tspan></text>`).join("");
  }

  const hits = groups.map((g, i) =>
    `<rect class="scl-hit" data-group="${i}" x="${X0}" y="${g.y0.toFixed(1)}" width="${X1 - X0}" height="${(g.y1 - g.y0).toFixed(1)}" tabindex="0" role="button" aria-label="${g.lo}–${g.hi} cm, ${g.pct}% víz, kb. ${g.liters} liter négyzetméterenként"></rect>`).join("");

  // A 81 cm alatt: halvány sáv törésjellel, adat nélkül. A törésjel háttér-
  // színű "glóriával" is kap, hogy a vonalkázás fölött is látsszon.
  const zig = [];
  for (let x = X0, up = false; x <= X1 + 0.1; x += 12, up = !up) zig.push(`${x},${bottomY + (up ? -5 : 5)}`);
  const bandH = narrow ? 60 : 74;
  const cx = (X0 + VW) / 2;
  const below = `<rect x="${X0}" y="${bottomY}" width="${VW - X0}" height="${bandH}" fill="url(#scl-fade)"></rect>` +
    `<polyline points="${zig.join(" ")}" fill="none" stroke="var(--bg)" stroke-width="4" vector-effect="non-scaling-stroke"></polyline>` +
    `<polyline points="${zig.join(" ")}" fill="none" stroke="var(--fg)" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline>` +
    `<text class="water-map-label" x="${cx}" y="${bottomY + (narrow ? 26 : 30)}" text-anchor="middle" style="fill:var(--muted)"><tspan>lejjebb: talajvíz és mélyebb rétegek,</tspan><tspan x="${cx}" dy="1.4em">erről itt nincs adat</tspan></text>`;

  // Jelmagyarázat: száraz -> vizes, a vonalkázás öt foka.
  const legY = bottomY + bandH + 20;
  const lx = narrow ? X0 + 8 : X0 + 64;
  const legend = WATER_HATCH_TILE_PX.map((_, i) =>
    `<rect x="${lx + 52 + i * 28}" y="${legY}" width="28" height="16" fill="url(#wh${i})" stroke="var(--fg)" stroke-width="1" vector-effect="non-scaling-stroke"></rect>`).join("") +
    `<text class="water-map-label" x="${lx + 44}" y="${legY + 12}" text-anchor="end">száraz</text>` +
    `<text class="water-map-label" x="${lx + 52 + 5 * 28 + 8}" y="${legY + 12}">vizes</text>`;

  const VH = legY + 28;
  svgEl.setAttribute("viewBox", `0 0 ${VW} ${VH}`);
  svgEl.parentElement.style.setProperty("--ar", (VW / VH).toFixed(3));

  const sc = narrow ? Math.min(0.55, (VW - 16) / 700) : 1;
  const k0 = svgEl.getBoundingClientRect().width / VW || 1;
  svgEl.innerHTML =
    `<defs><g id="scl-pat">${soilHatchDefs(k0)}</g>` +
    `<pattern id="scl-fade" width="9" height="9" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.8" fill="var(--muted)"></circle></pattern></defs>` +
    soilSceneSvg(point, GY, elevationM, narrow, sc) +
    `<line x1="0" y1="${GY}" x2="${VW}" y2="${GY}" stroke="var(--fg)" stroke-width="2" vector-effect="non-scaling-stroke"></line>` +
    rects +
    `<g transform="translate(0 ${GY}) scale(${sc})" class="scl-art">${soilRoots(372)}${soilRoots(442)}</g>` +
    ticks + below + legend +
    `<g stroke="var(--fg)" stroke-width="0.75" fill="none">${leaders}</g>${labels}${hits}`;

  const noteEl = document.getElementById("water-soil-note");
  if (noteEl) noteEl.innerHTML = `<strong>a felső 81 cm-ben összesen kb. ${waterNum(totalLiters, 0)} liter víz van négyzetméterenként</strong><br>az épület nem méretarányos a talajrétegekhez` +
    (narrow ? `<br>a legfelső, 0–9 cm-es réteg a felirat miatt vastagabbra van rajzolva a valódinál` : "");

  const tooltipEl = document.getElementById("water-soil-tooltip");
  const show = (g, x, y) => mapPopupShow(tooltipEl, x, y,
    `<strong>${g.lo}–${g.hi} cm</strong><span>${g.pct}% víz, kb. ${waterNum(g.liters, 0)} liter négyzetméterenként (nedvesség × vastagság)</span>`);
  svgEl.querySelectorAll(".scl-hit").forEach(el => {
    const g = groups[Number(el.dataset.group)];
    el.addEventListener("pointermove", e => { if (e.pointerType === "mouse") show(g, e.clientX, e.clientY); });
    el.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") mapPopupHide(tooltipEl); });
    el.addEventListener("click", e => { e.stopPropagation(); show(g, e.clientX, e.clientY); });
    el.addEventListener("focus", () => { const r = el.getBoundingClientRect(); show(g, r.left + r.width / 2, r.top + r.height / 2); });
    el.addEventListener("blur", () => mapPopupHide(tooltipEl));
  });
  if (renderSoilCoreProfile.closer) document.removeEventListener("click", renderSoilCoreProfile.closer);
  renderSoilCoreProfile.closer = () => mapPopupHide(tooltipEl);
  document.addEventListener("click", renderSoilCoreProfile.closer);

  watchFigureScale(svgEl, VW);
  // Méretváltozásnál: a vonalkázás sűrűsége követi; ha az elrendezés-mód vagy
  // (keskenyen) a szélesség változik, az ábra újrarajzolódik.
  if (soilCoreObservers.has(svgEl)) soilCoreObservers.get(svgEl).disconnect();
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(() => {
      const w = svgEl.getBoundingClientRect().width;
      if (w <= 0) return;
      const nowNarrow = w < SOIL_NARROW_PX;
      if (nowNarrow !== narrow || (narrow && Math.abs(w - VW) > 2)) {
        ro.disconnect();
        renderSoilCoreProfile(svgEl, moistureByDepth, point, elevationM);
        return;
      }
      const holder = svgEl.querySelector("#scl-pat");
      if (holder) holder.innerHTML = soilHatchDefs(w / VW || 1);
    });
    ro.observe(svgEl);
    soilCoreObservers.set(svgEl, ro);
  }
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
      <line x1="2.25" y1="0" x2="2.25" y2="4.5" stroke="var(--accent)" stroke-width="1.2" stroke-opacity="0.45"></line>
    </pattern>
  </defs>
  <g fill="var(--accent)" fill-opacity="0.24">
    <path d="M154 20C208 20 208 72.5 262 72.5V194.5C208 194.5 208 142 154 142Z"></path>
    <path d="M154 208.8C208 208.8 208 235.4 262 235.4V248.1C208 248.1 208 221.6 154 221.6Z"></path>
    <path d="M154 247.7C208 247.7 208 255.5 262 255.5V262.5C208 262.5 208 254.7 154 254.7Z"></path>
    <path d="M154 284.2C208 284.2 208 268.6 262 268.6V274.7C208 274.7 208 290.2 154 290.2Z"></path>
    <path d="M154 320.7C208 320.7 208 284.2 262 284.2V289.1C208 289.1 208 325.7 154 325.7Z"></path>
    <path d="M378 72.5C432 72.5 432 48.5 486 48.5V181.5C432 181.5 432 205.5 378 205.5Z"></path>
    <path d="M378 259.7C432 259.7 432 267.7 486 267.7V308.5C432 308.5 432 300.5 378 300.5Z"></path>
  </g>
  <g fill="var(--accent)" fill-opacity="0.14">
    <path d="M154 154C208 154 208 194.5 262 194.5V235.4C208 235.4 208 194.8 154 194.8Z"></path>
    <path d="M154 229.5C208 229.5 208 248.1 262 248.1V255.5C208 255.5 208 236.9 154 236.9Z"></path>
    <path d="M154 266.2C208 266.2 208 262.5 262 262.5V268.6C208 268.6 208 272.2 154 272.2Z"></path>
    <path d="M154 300.4C208 300.4 208 274.7 262 274.7V284.2C208 284.2 208 309.9 154 309.9Z"></path>
    <path d="M378 205.5C432 205.5 432 197.5 486 197.5V251.7C432 251.7 432 259.7 378 259.7Z"></path>
  </g>
  <path d="M154 341.7C208 341.7 208 289.1 262 289.1V399.3C208 399.3 208 451.9 154 451.9Z" fill="url(#wsk-air)"></path>
  <path d="M378 300.5C432 300.5 432 324.5 486 324.5V423.3C432 423.3 432 399.3 378 399.3Z" fill="url(#wsk-air)"></path>
  <g fill="var(--accent)">
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
  const tileW = 40, tileH = 24, rowCount = 10; // 10 csempe/sor: a darabszám egy pillantásra leolvasható
  const fullRows = Math.floor(count / rowCount);
  const remainder = count - fullRows * rowCount;
  const fullHeight = fullRows * tileH;
  const remWidth = remainder * tileW;
  let markup = `<defs><pattern id="wbal-tile" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse"><path transform="translate(2.5,2.5) scale(0.5)" fill="var(--accent)" d="${BALATON_TILE_ICON_PATH}"></path></pattern></defs>`;
  markup += `<rect x="0" y="0" width="${rowCount * tileW}" height="${fullHeight}" fill="url(#wbal-tile)"></rect>`;
  if (remWidth > 0) markup += `<rect x="0" y="${fullHeight}" width="${remWidth.toFixed(1)}" height="${tileH}" fill="url(#wbal-tile)"></rect>`;
  return markup;
}

// ---- 5. Tavak részletesen ----

// Szabályozási (ideális) sáv tavanként, a mérce saját cm-skáláján. A
// Tisza-tó SZÁNDÉKOSAN nincs itt és a tó-kártyák között sem: a "Kisköre alsó"
// a Tisza FOLYAMI mércéje a tározó alatt, saját, a hivatalos 735±5 cm-es
// üzemvízszint-skálától független 0-ponttal (élőben látott érték: -352 cm,
// miközben a tényleges tározó közel volt az üzemvízszinthez) - egy ilyen
// kártya félrevezető lenne, az üres mérce pedig csak zaj. Amíg nincs valódi
// tó-mérce, a Tisza-tó csak a méretösszehasonlító ábrán szerepel.
const WATER_LAKE_BANDS = {
  "Balaton": { lowCm: 110, highCm: 120, axisMin: 0, axisMax: 140 },
  "Velencei-tó": { lowCm: 140, highCm: 170, axisMin: 0, axisMax: 200 },
  "Fertő": { lowCm: null, highCm: null, axisMin: 0, axisMax: 0 },
};

// Egy path "d" szövegének befoglaló téglalapja (csak abszolút M/L parancsok,
// ahogy a LAKE_COMPARE_PATHS és a BALATON_TILE_ICON_PATH is épül).
function pathBounds(d) {
  const nums = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  const xs = nums.map(n => n[0]), ys = nums.map(n => n[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// A tó-kártya körvonala: szaggatott körvonal = a teli meder, a kitöltés az
// aktuális szint a szabályozási sávhoz (a sáv felső széléhez) képest. A
// Balaton a hossztengelye mentén tölt (ld. BALATON_TILT_DEG), a többi
// alulról. Sáv nélküli tónál (Fertő) nincs kitöltés, mert nincs mihez mérni.
function lakeShapeSvg(lakeKey, fraction, ariaLabel) {
  const isBalaton = lakeKey === "balaton";
  const d = LAKE_CARD_PATHS[lakeKey];
  const b = pathBounds(d);
  const pad = Math.max(b.w, b.h) * 0.04;
  const view = `${(b.x - pad).toFixed(1)} ${(b.y - pad).toFixed(1)} ${(b.w + 2 * pad).toFixed(1)} ${(b.h + 2 * pad).toFixed(1)}`;
  const clipId = `lake-card-clip-${lakeKey}`;
  let fill = "";
  if (fraction !== null) {
    if (isBalaton) {
      const span = BALATON_TILT_HALF_SPAN * 2;
      const topY = BALATON_TILT_PIVOT.y + BALATON_TILT_HALF_SPAN - fraction * span;
      fill = `<g clip-path="url(#${clipId})"><g transform="rotate(${BALATON_TILT_DEG} ${BALATON_TILT_PIVOT.x} ${BALATON_TILT_PIVOT.y})">` +
        `<rect x="${BALATON_TILT_PIVOT.x - 300}" y="${topY.toFixed(2)}" width="600" height="600" fill="var(--accent)"></rect></g></g>`;
    } else {
      const topY = b.y + b.h * (1 - fraction);
      fill = `<g clip-path="url(#${clipId})"><rect x="${b.x - pad}" y="${topY.toFixed(2)}" width="${b.w + 2 * pad}" height="${b.h + 2 * pad}" fill="var(--accent)"></rect></g>`;
    }
  }
  return `<svg class="water-lake-card-shape" viewBox="${view}" role="img" aria-label="${ariaLabel}">` +
    `<defs><clipPath id="${clipId}"><path d="${d}"></path></clipPath></defs>` +
    `<path d="${d}" fill="none" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" stroke-linejoin="round"></path>` +
    fill + `</svg>`;
}

// Közös vízszintes mérce minden tóhoz: tengely, vonalkázott ideális sáv, a
// jelenlegi szint jelölője. A skála-értékek (a tengely két vége, a sáv két
// széle) kimaradnak, ha egymáshoz vagy a jelölőhöz túl közel esnek, hogy ne
// írjanak egymásra (korábban a "40" tengelyjegy és a "38 cm" felirat
// egybefolyt). A viewBox 240 egység széles, a kártya kb. ennyi képpont: a
// betűméret --k-val állandó (ld. watchFigureScale).
function lakeGaugeSvg(lakeKey, band, levelCm, ariaLabel) {
  const W = 240, padX = 12, axisY = 22;
  const span = band.axisMax - band.axisMin;
  const xFor = cm => padX + ((Math.max(band.axisMin, Math.min(band.axisMax, cm)) - band.axisMin) / span) * (W - 2 * padX);
  const hatchId = `lake-hatch-${lakeKey}`;
  const bandX = xFor(band.lowCm), bandW = xFor(band.highCm) - bandX;
  const markerX = xFor(levelCm);
  const MIN_GAP = 22;
  const ticks = [];
  for (const cm of [band.axisMin, band.lowCm, band.highCm, band.axisMax]) {
    const x = xFor(cm);
    if (Math.abs(x - markerX) < MIN_GAP) continue;
    if (ticks.some(t => Math.abs(t.x - x) < MIN_GAP)) continue;
    ticks.push({ x, cm });
  }
  const tickMarkup = ticks.map(t =>
    `<line x1="${t.x.toFixed(1)}" y1="${axisY}" x2="${t.x.toFixed(1)}" y2="${axisY + 4}" stroke="var(--muted)" stroke-width="1"></line>` +
    `<text class="water-lake-gauge-text" x="${t.x.toFixed(1)}" y="${axisY + 6}" text-anchor="middle" dy="0.9em">${t.cm}</text>`).join("");
  return `<svg class="water-lake-gauge" viewBox="0 0 ${W} 44" role="img" aria-label="${ariaLabel}">` +
    `<defs><pattern id="${hatchId}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--accent)" stroke-width="1"></line></pattern></defs>` +
    `<rect x="${bandX.toFixed(1)}" y="${axisY - 9}" width="${bandW.toFixed(1)}" height="9" fill="url(#${hatchId})" stroke="var(--fg)" stroke-width="0.75"></rect>` +
    `<line x1="${padX}" y1="${axisY}" x2="${W - padX}" y2="${axisY}" stroke="var(--fg)" stroke-width="1"></line>` +
    tickMarkup +
    `<path d="M${(markerX - 5).toFixed(1)} ${axisY - 14} L${(markerX + 5).toFixed(1)} ${axisY - 14} L${markerX.toFixed(1)} ${axisY - 5} Z" fill="var(--accent)"></path>` +
    `</svg>`;
}

// A tavak egy sorban, azonos kártyákon (UX-terv 5.1): körvonal, szint cm-ben,
// közös mérce, egy állapotsor. Ahol nincs ideális sáv (Fertő), a kártya sáv
// nélkül, egy halvány megjegyzéssel jelenik meg. A 7 napos trend-vonal
// (station.history: számok vagy {level_cm} elemek) a tó-pillanatképben még
// nincs - amint a gyűjtő történetet ad, itt automatikusan megjelenik.
function renderLakeCards(container, cards) {
  container.innerHTML = "";
  for (const card of cards) {
    const band = WATER_LAKE_BANDS[card.name];
    const hasBand = band && band.lowCm !== null;
    const level = card.levelCm;
    const el = document.createElement("article");
    el.className = "water-lake-card";

    let fraction = null;
    if (hasBand && level !== null) {
      fraction = Math.max(0, Math.min(1, (level - band.axisMin) / (band.highCm - band.axisMin)));
    }
    let status = "";
    if (level === null) status = "jelenleg nem elérhető";
    else if (!hasBand) status = "";
    else if (level < band.lowCm) status = `${waterNum(band.lowCm - level, 0)} cm-rel az ideális sáv alatt`;
    else if (level > band.highCm) status = `${waterNum(level - band.highCm, 0)} cm-rel az ideális sáv felett`;
    else status = "az ideális sávban";

    const valueText = level === null ? "nincs adat" : `${waterNum(level, 0)} cm`;
    const history = Array.isArray(card.history)
      ? card.history.map(h => (typeof h === "number" ? h : h.level_cm)).filter(v => typeof v === "number")
      : [];
    el.innerHTML =
      `<h4 class="water-lake-card-name">${card.name}</h4>` +
      lakeShapeSvg(card.shapeKey, fraction, `${card.name} körvonala, kitöltve az aktuális szint arányában`) +
      `<p class="water-lake-card-value${level === null ? " water-lake-gauge-value-missing" : ""}">${valueText}</p>` +
      (hasBand && level !== null ? lakeGaugeSvg(card.shapeKey, band, level, `${card.name}: ${valueText}, ideális sáv ${band.lowCm} és ${band.highCm} cm között`) : "") +
      (status ? `<p class="water-lake-card-status">${status}</p>` : "") +
      (history.length > 1 ? `<div class="water-lake-card-trend">${popupSparklineSvg(history)}</div>` : "") +
      (!hasBand ? `<p class="water-lake-card-note">ehhez a tóhoz nincs megadva ideális sáv</p>` : "") +
      (card.note ? `<p class="water-lake-card-note">${card.note}</p>` : "");
    container.appendChild(el);
    const gauge = el.querySelector(".water-lake-gauge");
    if (gauge) watchFigureScale(gauge, 240);
  }
}

// ---- Cigánd: a tározó megnyitása (aktuális hír) ----
//
// A tartalom a kézzel karbantartott cigand.json-ból jön (tények, időrend,
// források, az `active` jelző), a térkép geometriája a cigand-geo.json-ból
// (egyszer, az OpenStreetMapból kivonva). NINCS élő adat a beáramlásról:
// minden szám bejelentés vagy számolt érték, ezt a címkék (tény /
// bejelentett / számolt / mért) és a "szemléltető ábra" felirat mondja ki.
// A negyedik, MÉRT csempe (a Tisza szintje Cigánd közelében) csak akkor
// jelenik meg, ha a rivers-snapshotban van "Dombrád" nevű állomás - a
// gyűjtő bővítése nélkül egyszerűen hiányzik.
const CIGAND_URL = "cigand.json?v=2";
const CIGAND_GEO_URL = "cigand-geo.json?v=2";
const CIGAND_STEP_MS = 2000;
const CIGAND_STEPS = [
  "megárad a Tisza",
  "nyílik a zsilip",
  "a víz beáramlik",
  "megtelik a vápa, a tározó mély sávja",
  "tovább a Tiszakarádi-főcsatornába és a mellékcsatornákba",
];
let cigandData = null;
let cigandGeo = null;
let cigandAnim = null; // az éppen futó animáció vezérlője (leállításhoz)

async function loadCigand() {
  if (!cigandData) {
    const [facts, geo] = await Promise.all([
      fetch(CIGAND_URL).then(r => r.json()),
      fetch(CIGAND_GEO_URL).then(r => r.json()),
    ]);
    cigandData = facts;
    cigandGeo = geo;
  }
  return { data: cigandData, geo: cigandGeo };
}

function cigandStopAnimation() {
  if (cigandAnim) cigandAnim.stop();
  cigandAnim = null;
}

// Egyszerű időzítéses átmenet: fn(0..1), a végén a callback.
function cigandTween(ms, fn, done) {
  let raf = 0, cancelled = false;
  const start = performance.now();
  const tick = now => {
    if (cancelled) return;
    const t = Math.min(1, (now - start) / ms);
    fn(t);
    if (t < 1) raf = requestAnimationFrame(tick);
    else if (done) done();
  };
  raf = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(raf); };
}

function cigandTagHtml(kind) {
  // "nem közölt": nincs hivatalos adat, ezért szaggatott körvonalú címke.
  return `<span class="cigand-chip${kind === "nem közölt" ? " cigand-chip-unknown" : ""}">${kind}</span>`;
}

function cigandTilesHtml(data, rivers) {
  const f = data.facts;
  const year = Number((data.updated || "").slice(0, 4)) || new Date().getFullYear();
  const pct = Math.round((f.volume_m3 / f.capacity_m3) * 100);
  const tiles = [
    { label: "mennyi víz", value: "közel 2 milliárd liter", sub: `${waterNum(f.volume_m3 / 1e6, 0)} millió m³; a kormányfő ${waterNum(f.volume_m3 / 1e6, 0)}-${waterNum(f.volume_high_m3 / 1e6, 0)} milliót mondott`, kind: "bejelentett" },
    { label: "mióta nem használták", value: `${year - f.built} év`, sub: `${f.built}-ban adták át`, kind: "tény" },
    { label: "a tározó ekkora részét tölti ki", value: `kb. ${pct} %`, sub: `${waterNum(f.capacity_m3 / 1e6, 0)} millió m³ fér bele`, kind: "számolt" },
  ];
  // A mért csempe: csak ha a gyűjtő ad Dombrád állomást (ld. a fejkommentet).
  const gauge = (rivers || []).find(s => s.name === "Dombrád");
  if (gauge) {
    let arrow = "";
    const past = gauge.history && gauge.history.length > 24 ? gauge.history[gauge.history.length - 25].level_cm : null;
    if (typeof past === "number") arrow = gauge.level_cm > past ? " ↑" : gauge.level_cm < past ? " ↓" : " →";
    tiles.push({ label: "a Tisza most", value: `${waterNum(gauge.level_cm, 0)} cm${arrow}`, sub: "Dombrád, hydroinfo.hu", kind: "mért" });
  }
  return tiles.map(t =>
    `<div class="cigand-tile"><span class="cigand-tile-label">${t.label}</span>` +
    `<span class="cigand-tile-value">${t.value}</span><span class="cigand-tile-sub">${t.sub}</span>${cigandTagHtml(t.kind)}</div>`).join("");
}

function cigandCompareHtml(data, minCellLiters) {
  const f = data.facts;
  const pools = Math.round(f.volume_m3 / 2500 / 50) * 50;
  const cm = Math.round(f.volume_m3 / (f.area_km2 * 1e6) * 100);
  const icons = {
    pool: `<svg viewBox="0 0 48 32" aria-hidden="true"><rect x="2" y="4" width="44" height="24" fill="none" stroke="currentColor" stroke-width="1.5"></rect><path d="M6 14 q4 -4 8 0 t8 0 t8 0 t8 0 M6 21 q4 -4 8 0 t8 0 t8 0 t8 0" fill="none" stroke="currentColor" stroke-width="1.5"></path></svg>`,
    depth: `<svg viewBox="0 0 48 32" aria-hidden="true"><rect x="2" y="4" width="44" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3"></rect><rect x="2" y="25" width="44" height="3" fill="currentColor"></rect></svg>`,
    cell: `<svg viewBox="0 0 48 32" aria-hidden="true"><rect x="2" y="2" width="44" height="28" fill="none" stroke="currentColor" stroke-width="1.5"></rect><rect x="2" y="2" width="2" height="28" fill="currentColor"></rect></svg>`,
  };
  const items = [
    { icon: icons.pool, text: `kb. ${waterNum(pools, 0)} olimpiai medence` },
    { icon: icons.depth, text: `kb. ${cm} cm vastag réteg, ha az egész tározót elborítaná` },
  ];
  if (minCellLiters > 0) {
    const share = (f.volume_m3 * 1000) / minCellLiters * 100;
    items.push({ icon: icons.cell, text: `kb. ${waterNum(Math.round(share), 0)} % abból, amennyit ma a legszárazabb mintaterület talaja tart (${waterNum(minCellLiters / 1e9, 0)} milliárd liter)` });
  }
  return items.map(i => `<div class="cigand-compare-item">${i.icon}<p>${i.text}</p></div>`).join("") +
    `<p class="cigand-compare-tag">${cigandTagHtml("számolt")}</p>`;
}

// "mennyi fér bele, és mennyi van benne?": vázlatos függőleges metszet. A
// magasság erősen túlozva, a vízszintes méret nem méretarányos; a "most" víz
// NEM mért szint, a bejelentett mennyiségből számolt (a vápa kitöltése csak
// szemlélteti, hogy a víz a mélyedésben van). A rajzstílus a tó-kártyákét
// követi: szaggatott "teli" vonal, vonalkázott víz, vékony vonalak.
function buildCigandSection(svgEl, data, narrow = false) {
  const f = data.facts;
  const y0 = 340, M = 40; // a tározó fenékszintje; 1 m = 40 egység
  const yAt = m => y0 - m * M;
  const pct = Math.round((f.volume_m3 / f.capacity_m3) * 100);
  const cm = Math.round(f.volume_m3 / (f.area_km2 * 1e6) * 100);
  const fullY = yAt(f.mean_depth_m);
  const crestY = yAt(f.dyke_height_m);
  const tiszaY = yAt(3.2); // a Tisza szintje csak szemléltető, nem adat
  const t = (x, y, txt, extra = "") => `<text class="water-map-label" x="${x}" y="${y}" ${extra}>${txt}</text>`;
  // Többsoros felirat: a sorköz em-ben, így a képpont-állandó betűmérettel együtt skálázódik.
  const tl = (x, y, lines, extra = "") => `<text class="water-map-label" x="${x}" y="${y}" ${extra}>` +
    lines.map((l, i) => `<tspan x="${x}"${i ? ` dy="1.35em"` : ""}${l.b ? ` style="font-weight:600"` : ""}>${l.t || l}</tspan>`).join("") + `</text>`;
  const barX = 60, barW = 640;
  const nowW = Math.max(2, barW * f.volume_m3 / f.capacity_m3);
  const ticks = [0, 1, 2, 3, 4, 5].map(m =>
    `<line x1="30" y1="${yAt(m)}" x2="38" y2="${yAt(m)}" stroke="var(--fg)" stroke-width="1"></line>` +
    t(26, yAt(m) + 4, m, `text-anchor="end"`)).join("");
  const full =
    `<defs>` +
    `<pattern id="cgx-water" width="4.5" height="4.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4.5" stroke="var(--accent)" stroke-width="1.2"></line></pattern>` +
    `<pattern id="cgx-closed" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="8" stroke="var(--muted)" stroke-width="1"></line></pattern>` +
    `<pattern id="cgx-ground" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="9" stroke="var(--muted)" stroke-width="0.8"></line></pattern>` +
    `</defs>` +
    // talaj a fenékszint alatt (halvány)
    `<rect x="170" y="${y0}" width="550" height="16" fill="url(#cgx-ground)"></rect>` +
    // a Tisza: meder, vízfelszín, vonalkázott víz
    `<path d="M61.5 ${tiszaY} L209 ${tiszaY} L170 ${y0} L150 395 L84 395 Z" fill="url(#cgx-water)"></path>` +
    `<path d="M60 ${tiszaY - 12} L84 395 L150 395 L170 ${y0}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"></path>` +
    `<line x1="61" y1="${tiszaY}" x2="209" y2="${tiszaY}" stroke="var(--accent)" stroke-width="1.6"></line>` +
    // az árvédelmi gát teste, és a rajta átvezető zsilip
    `<path d="M170 ${y0} L225 ${crestY} L290 ${crestY} L345 ${y0} Z" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.6" stroke-linejoin="round"></path>` +
    `<rect x="222" y="120" width="70" height="${y0 - 120}" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.6"></rect>` +
    `<rect x="222" y="96" width="12" height="24" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.6"></rect>` +
    `<rect x="280" y="96" width="12" height="24" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.6"></rect>` +
    `<rect x="236" y="196" width="42" height="66" fill="url(#cgx-closed)" stroke="var(--fg)" stroke-width="1.2"></rect>` +
    `<rect x="223" y="${y0 - 36}" width="68" height="36" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.2"></rect>` +
    // a víz útja az alsó nyíláson át
    `<path d="M120 ${y0 - 18} L395 ${y0 - 18}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="6 4"></path>` +
    `<path d="M392 ${y0 - 24} L404 ${y0 - 18} L392 ${y0 - 12} Z" fill="var(--accent)"></path>` +
    // a tározó feneke a vápával, a benne álló (számolt) víz
    `<path d="M400 ${y0} Q480 ${y0 + 40} 560 ${y0} Z" fill="url(#cgx-water)"></path>` +
    `<path d="M345 ${y0} L400 ${y0} Q480 ${y0 + 40} 560 ${y0} L690 ${y0}" fill="none" stroke="var(--fg)" stroke-width="1.6" stroke-linejoin="round"></path>` +
    `<line x1="400" y1="${y0}" x2="560" y2="${y0}" stroke="var(--fg)" stroke-width="1" stroke-dasharray="2 3"></line>` +
    // a túlsó gát
    `<path d="M672 ${y0} L700 ${crestY} L720 ${crestY} L720 ${y0} Z" fill="var(--bg)" stroke="var(--fg)" stroke-width="1.6" stroke-linejoin="round"></path>` +
    // a "tele" szint: szaggatott vonal, mellette a mérőszalag
    `<line x1="345" y1="${fullY}" x2="690" y2="${fullY}" stroke="var(--muted)" stroke-width="1.4" stroke-dasharray="6 4"></line>` +
    `<line x1="642" y1="${fullY}" x2="642" y2="${y0}" stroke="var(--muted)" stroke-width="1"></line>` +
    `<line x1="638" y1="${fullY}" x2="646" y2="${fullY}" stroke="var(--muted)" stroke-width="1"></line>` +
    `<line x1="638" y1="${y0}" x2="646" y2="${y0}" stroke="var(--muted)" stroke-width="1"></line>` +
    // függőleges méretskála, méterben
    `<line x1="38" y1="${y0}" x2="38" y2="${yAt(5)}" stroke="var(--fg)" stroke-width="1"></line>` + ticks +
    t(26, yAt(5) - 12, "m", `text-anchor="end" style="font-style:italic"`) +
    // feliratok
    t(110, y0 - 70, "Tisza", `style="font-style:italic;font-weight:600"`) +
    tl(257, 38, [{ t: `zsilip: ${f.gate_width_m} m széles`, b: 1 }, `pillérek: ${waterNum(f.pillar_m, 1)} m`], `text-anchor="middle"`) +
    tl(352, 270, [{ t: "árvédelmi gát", b: 1 }, `átlag ${waterNum(f.dyke_height_m, 1)} m, ${waterNum(f.dyke_km, 1)} km`]) +
    t(634, (fullY + y0) / 2 + 4, `${waterNum(f.mean_depth_m, 1)} m`, `text-anchor="end"`) +
    t(665, fullY - 8, `tele: ${waterNum(f.capacity_m3 / 1e6, 0)} millió m³`, `text-anchor="end" style="font-weight:600"`) +
    t(718, crestY - 10, "túlsó gát", `text-anchor="end"`) +
    t(480, y0 - 10, "vápa", `text-anchor="middle"`) +
    `<polyline points="480,${y0 + 14} 480,${y0 + 36}" fill="none" stroke="var(--fg)" stroke-width="0.75"></polyline>` +
    tl(352, y0 + 52, [{ t: `most: közel ${waterNum(f.volume_m3 / 1e6, 0)} millió m³`, b: 1 }, "(bejelentett)", "egyenletesen szétterítve", `kb. ${cm} cm lenne`]) +
    // 2 / 94 millió m³: egyszerű sáv
    `<rect x="${barX}" y="516" width="${barW}" height="12" fill="none" stroke="var(--fg)" stroke-width="1"></rect>` +
    `<rect x="${barX}" y="516" width="${nowW.toFixed(1)}" height="12" fill="url(#cgx-water)" stroke="var(--fg)" stroke-width="1"></rect>` +
    t(barX, 548, `${waterNum(f.volume_m3 / 1e6, 0)} a ${waterNum(f.capacity_m3 / 1e6, 0)} millió m³-ből: ${pct} %`, `style="font-weight:600"`);
  if (!narrow) {
    svgEl.innerHTML = full;
    svgEl.setAttribute("viewBox", "0 0 720 572");
    svgEl.parentElement.style.setProperty("--ar", "1.259");
    watchFigureScale(svgEl, 720);
    return;
  }

  // Keskeny kijelző: ugyanaz a rajz, de a felirat nélküli grafika arányosan
  // (a magasság kevésbé) összenyomva, a feliratok pedig képpont-méretben, a
  // néhány megtartott felirattal; a részletes adatok az ábra alatti listába
  // kerülnek (ld. cigandSectionListHtml). A vonalkázás mintája a skálázás
  // inverzével kapja a patternTransformot, hogy ne torzuljon.
  const W = Math.max(280, Math.round(Math.min(document.documentElement.clientWidth - 42, 480)));
  const fx = W / 720, fy = fx * 1.28;
  const X = x => (x * fx).toFixed(1), Y = y => (y * fy).toFixed(1);
  let art = full
    .replace(/<text[\s\S]*?<\/text>/g, "")
    .replace(/<polyline points="480,[^>]*><\/polyline>/g, "")
    .replace(/<rect x="60" y="516"[^>]*><\/rect>/g, "");
  const inv = `scale(${(1 / fx).toFixed(3)} ${(1 / fy).toFixed(3)}) `;
  art = art.replace(/patternTransform="rotate\(/g, `patternTransform="${inv}rotate(`);
  const labels =
    t(X(26), Y(yAt(5) - 14), "m", `text-anchor="end" style="font-style:italic"`) +
    [0, 1, 2, 3, 4, 5].map(m => t(X(26), (Y(yAt(m)) * 1 + 4).toFixed(1), m, `text-anchor="end"`)).join("") +
    t(X(110), Y(y0 - 70), "Tisza", `style="font-style:italic;font-weight:600"`) +
    t(X(257), Y(88), "zsilip", `text-anchor="middle" style="font-weight:600"`) +
    t(X(352), Y(284), `gát ${waterNum(f.dyke_height_m, 1)} m`, `style="font-weight:600"`) +
    t(X(665), (Number(Y(fullY)) - 6).toFixed(1), `tele: ${waterNum(f.mean_depth_m, 1)} m`, `text-anchor="end" style="font-weight:600"`) +
    t(X(480), Y(y0 - 12), "vápa", `text-anchor="middle"`) +
    `<polyline points="${X(480)},${Y(y0 + 12)} ${X(480)},${(Number(Y(y0)) + 30).toFixed(1)}" fill="none" stroke="var(--fg)" stroke-width="0.75"></polyline>` +
    t(X(480), (Number(Y(y0)) + 44).toFixed(1), `most: kb. ${pct} %`, `text-anchor="middle" style="font-weight:600"`);
  const barY = Math.round(Number(Y(y0)) + 78), bx0 = 12, bw = W - 24;
  const nowWn = Math.max(2, bw * f.volume_m3 / f.capacity_m3);
  const bar =
    `<rect x="${bx0}" y="${barY}" width="${bw}" height="12" fill="none" stroke="var(--fg)" stroke-width="1"></rect>` +
    `<rect x="${bx0}" y="${barY}" width="${nowWn.toFixed(1)}" height="12" fill="url(#cgx-water)" stroke="var(--fg)" stroke-width="1"></rect>` +
    t(bx0, barY + 32, `${waterNum(f.volume_m3 / 1e6, 0)} a ${waterNum(f.capacity_m3 / 1e6, 0)} millió m³-ből: ${pct} %`, `style="font-weight:600"`);
  const VH = barY + 44;
  svgEl.setAttribute("viewBox", `0 36 ${W} ${VH - 36}`);
  svgEl.parentElement.style.setProperty("--ar", (W / (VH - 36)).toFixed(3));
  svgEl.innerHTML = `<g class="cgx-art" transform="scale(${fx.toFixed(4)} ${fy.toFixed(4)})">${art}</g>${labels}${bar}`;
  watchFigureScale(svgEl, W);
}

function cigandSectionListHtml(data) {
  const f = data.facts;
  const pct = Math.round((f.volume_m3 / f.capacity_m3) * 100);
  const cm = Math.round(f.volume_m3 / (f.area_km2 * 1e6) * 100);
  const row = (k, v, kind) => `<div><dt>${k}</dt><dd>${v} ${cigandTagHtml(kind)}</dd></div>`;
  return row("zsilip", `${f.gate_width_m} m széles, ${waterNum(f.pillar_m, 1)} m magas pillérek; alsó nyílások a tájvíznek, nagyobb felső zsilipek árvízre (${f.flood_m3s} m³/s-ig)`, "tény") +
    row("árvédelmi gát", `átlag ${waterNum(f.dyke_height_m, 1)} m magas, összesen ${waterNum(f.dyke_km, 1)} km`, "tény") +
    row("tele", `${waterNum(f.capacity_m3 / 1e6, 0)} millió m³, átlag ${waterNum(f.mean_depth_m, 1)} m mély, kb. ${waterNum(f.area_km2, 0)} km²`, "tény") +
    row("most", `közel ${waterNum(f.volume_m3 / 1e6, 0)} millió m³, a tározó ${pct} %-a`, "bejelentett") +
    row("szétterítve", `egyenletesen kb. ${cm} cm lenne`, "számolt");
}



function cigandFaqHtml(data) {
  return (data.faq || []).map(i =>
    `<div class="cigand-faq-item"><h5 class="cigand-faq-q">${i.q}</h5><p class="cigand-faq-a">${i.a}</p>` +
    `<p class="cigand-faq-meta">${cigandTagHtml(i.kind)}${i.source ? ` <a href="${i.source.url}" target="_blank" rel="noopener">${i.source.name}</a>` : ""}</p></div>`).join("");
}

function cigandTimelineHtml(data) {
  return data.timeline.map(e =>
    `<li><span class="cigand-tl-date">${e.date}</span><span class="cigand-tl-text">${e.text} ` +
    `${cigandTagHtml(e.kind)} <a href="${e.source.url}" target="_blank" rel="noopener">${e.source.name}</a></span></li>`).join("");
}

// A térkép: a geometria a csatorna-térképpel azonos lapos vetítéssel
// (fitFlatProjection), víz = vonalvastagság, szaggatás, vonalkázás - szín nincs.
function buildCigandMap(svgEl, tooltipEl, data, geo, narrow = false) {
  // Keskeny kijelzőn a térkép a lényegre vágva (tározó, zsilip, Cigánd, a
  // Tisza e szakasza, a Tiszakarádi-főcsatorna eleje), a viewBox pedig valódi
  // képpontban van, így a feliratok 12 px-esek maradnak.
  const [minLon, minLat, maxLon, maxLat] = narrow ? [21.80, 48.235, 21.99, 48.35] : geo.bounds;
  const W = narrow ? Math.max(280, Math.round(Math.min(document.documentElement.clientWidth - 42, 480))) : 640;
  const H = Math.round(W * (maxLat - minLat) / ((maxLon - minLon) * Math.cos((minLat + maxLat) / 2 * Math.PI / 180)));
  svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svgEl.parentElement.style.setProperty("--ar", (W / H).toFixed(3));
  const project = fitFlatProjection(minLon, maxLon, minLat, maxLat, W, H);
  const xy = ([lon, lat]) => project(lat, lon);
  const pathOf = (lines, close = false) => lines.map(line =>
    line.map((p, i) => { const q = xy(p); return `${i === 0 ? "M" : "L"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`; }).join("") + (close ? "Z" : "")).join("");

  const sluice = xy(geo.sluice);
  const resPath = pathOf(geo.reservoir, true);
  const resPts = geo.reservoir.flat().map(xy);
  const rx0 = Math.min(...resPts.map(p => p.x)), rx1 = Math.max(...resPts.map(p => p.x));
  const ry0 = Math.min(...resPts.map(p => p.y)), ry1 = Math.max(...resPts.map(p => p.y));
  const nearest = (pts, to) => pts.reduce((a, b) => Math.hypot(b.x - to.x, b.y - to.y) < Math.hypot(a.x - to.x, a.y - to.y) ? b : a);
  // A műtárgy a tározó DK-i csücskében áll, a Tiszán FELJEBB (keletre) Cigánd
  // felett (OSM way 851514123); a beáramlás a Tiszából jön a zsilipen át, majd
  // a tározón belül a mély sávon (vápa) halad a Tiszakarádi-főcsatorna felé.
  const tiszaPt = xy(geo.inlet);
  const vapaPts = geo.vapa.map(xy);
  const vapaD = pathOf([geo.vapa]);

  const canalById = Object.fromEntries(geo.canals.map(c => [c.id, c]));
  const popups = {
    tisza: { title: "Tisza", text: "Ebből a folyóból engedik a vizet a tározóba." },
    bodrog: { title: "Bodrog", text: "A Bodrogköz északi-nyugati határa." },
    reservoir: { title: "Cigánd-Tiszakarádi árapasztó tározó", text: `${waterNum(data.facts.capacity_m3 / 1e6, 0)} millió m³, ${waterNum(data.facts.area_km2, 1)} km², ${data.facts.built}-ban adták át.` },
    sluice: { title: "zsilip", text: "A be- és leeresztő műtárgy a tározó délkeleti csücskében áll, a Tiszán Cigánd felett. Nov. 21-én nyitották meg, 2008 óta először." },
    tiszakaradi: { title: canalById.tiszakaradi.n, text: "A bodrogközi csatornahálózat része." },
    ricsei: { title: canalById.ricsei.n, text: "A bodrogközi csatornahálózat része." },
    felsoberecki: { title: canalById.felsoberecki.n, text: "Kapcsolódó bodrogközi intézkedés: közel 12 km, kiszáradt, gravitációs utánpótlást kap (MTI, nov. 23.). Nem állítjuk, hogy cigándi víz." },
  };

  const wetIds = ["tiszakaradi"]; // a vízügy közlése: a Tiszakarádi-főcsatorna, mellette "mellékcsatornák" (nem nevesítve)
  let canalsMarkup = "", hitMarkup = "";
  for (const c of geo.canals) {
    const d = pathOf(c.l);
    canalsMarkup += `<path class="cg-canal-dry" d="${d}"></path>`;
    if (wetIds.includes(c.id)) canalsMarkup += `<path class="cg-canal-wet" d="${d}"></path>`;
    hitMarkup += `<path class="cg-hit" data-popup="${c.id}" d="${d}" tabindex="0" role="button" aria-label="${popups[c.id].title}"></path>`;
  }
  hitMarkup += `<path class="cg-hit" data-popup="tisza" d="${pathOf(geo.tisza)}" tabindex="0" role="button" aria-label="Tisza"></path>`;
  hitMarkup += `<path class="cg-hit cg-hit-fill" data-popup="reservoir" d="${resPath}" tabindex="0" role="button" aria-label="a tározó"></path>`;
  hitMarkup += `<circle class="cg-hit cg-hit-fill" data-popup="sluice" cx="${sluice.x.toFixed(1)}" cy="${sluice.y.toFixed(1)}" r="14" tabindex="0" role="button" aria-label="zsilip"></circle>`;

  const placesMarkup = geo.places.filter(p => !narrow || p.n === "Cigánd" || p.n === "Ricse").map(p => {
    const q = xy([p.lon, p.lat]);
    const left = q.x > W - 90;
    return `<circle class="water-map-town" cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${(2 / 1).toFixed(1)}"></circle>` +
      `<text class="water-map-label" x="${(q.x + (left ? -5 : 5)).toFixed(1)}" y="${(q.y - 4).toFixed(1)}" text-anchor="${left ? "end" : "start"}">${p.n}</text>`;
  }).join("");
  // A "Tisza" felirat a vastag folyóvonal egy pontja mellé kerül (a 21,95 K
  // hosszúság környékén), nem a csatorna mellé.
  const tiszaLabel = (() => {
    const q = nearest(geo.tisza.flat().map(xy), narrow ? xy([21.93, 48.2525]) : xy([21.99, 48.2]));
    return { x: q.x - 6, y: q.y - 12 };
  })();
  const bodrogLabel = xy([21.63, 48.395]);
  const waterLabels =
    `<text class="water-map-label water-map-label-water" x="${tiszaLabel.x.toFixed(1)}" y="${tiszaLabel.y.toFixed(1)}">Tisza</text>` +
    (narrow ? "" : `<text class="water-map-label water-map-label-water" x="${bodrogLabel.x.toFixed(1)}" y="${bodrogLabel.y.toFixed(1)}">Bodrog</text>`) +
    `<text class="water-map-label water-map-label-water" x="${(rx0 - 8).toFixed(1)}" y="${((ry0 + ry1) / 2).toFixed(1)}" text-anchor="end">tározó</text>`;
  const canalLabels = geo.canals.filter(c => c.id === "tiszakaradi").map(c => {
    if (narrow) {
      const q = nearest(c.l[0].map(xy), xy([21.835, 48.282]));
      return `<text class="water-map-label water-map-label-water cg-canal-label" x="4" y="${(q.y + 22).toFixed(1)}">${c.n}</text>`;
    }
    const mid = c.l.flat()[Math.floor(c.l.flat().length / 2)];
    const q = xy(mid);
    return `<text class="water-map-label water-map-label-water cg-canal-label" x="${q.x.toFixed(1)}" y="${(q.y + 14).toFixed(1)}" text-anchor="middle">${c.n.replace("-főcsatorna", "")}</text>`;
  }).join("");

  // Léptékvonal (5 km) és kis hazai áttekintő a sarokban.
  const kmPerUnit = 111 / project.scale;
  const barW = 5 / kmPerUnit;
  const sx = W - 12 - barW;
  const scale = `<g pointer-events="none"><line x1="${sx.toFixed(1)}" y1="26" x2="${(W - 12).toFixed(1)}" y2="26" stroke="var(--fg)" stroke-width="2"></line><text class="water-map-label" x="${sx.toFixed(1)}" y="20">5 km</text></g>`;
  let inset = "";
  const ring = narrow ? null : selectCountryBorderRing(16, 23, 45.7, 48.6);
  if (ring) {
    const ih = 40, iw = 72;
    const small = fitFlatProjection(16, 23, 45.7, 48.6, iw, ih);
    const ox = W - iw - 10, oy = H - ih - 10;
    const d = ring.map(([lon, lat], i) => { const p = small(lat, lon); return `${i === 0 ? "M" : "L"}${(ox + p.x).toFixed(1)} ${(oy + p.y).toFixed(1)}`; }).join("") + "Z";
    const spot = small(48.26, 21.9);
    inset = `<g pointer-events="none"><rect x="${ox - 3}" y="${oy - 3}" width="${iw + 6}" height="${ih + 6}" fill="var(--bg)" opacity="0.85"></rect><path d="${d}" fill="none" stroke="var(--fg)" stroke-width="1"></path><circle cx="${(ox + spot.x).toFixed(1)}" cy="${(oy + spot.y).toFixed(1)}" r="3" fill="var(--fg)"></circle></g>`;
  }

  svgEl.innerHTML =
    `<defs>` +
    `<clipPath id="cg-res-clip"><path d="${resPath}"></path></clipPath>` +
    `<pattern id="cg-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--accent)" stroke-width="1.6"></line></pattern>` +
    `</defs>` +
    `<path class="cg-bodrog" d="${pathOf(geo.bodrog)}"></path>` +
    `<path class="cg-tisza" d="${pathOf(geo.tisza)}"></path>` +
    canalsMarkup +
    `<path class="cg-reservoir" d="${resPath}"></path>` +
    `<g clip-path="url(#cg-res-clip)" fill="none" stroke-linejoin="round">` +
    `<path class="cg-vapa-seg cg-vapa-edge" d="${vapaD}" pathLength="1"></path>` +
    `<path class="cg-vapa-seg cg-vapa-bg" d="${vapaD}" pathLength="1"></path>` +
    `<path class="cg-vapa-seg cg-vapa-hatch" d="${vapaD}" pathLength="1" stroke="url(#cg-hatch)"></path></g>` +
    `<path class="cg-dyke" d="${pathOf(geo.dyke)}"></path>` +
    `<path class="cg-flow-in" d="M${tiszaPt.x.toFixed(1)} ${tiszaPt.y.toFixed(1)}L${sluice.x.toFixed(1)} ${sluice.y.toFixed(1)}L${vapaPts[2].x.toFixed(1)} ${vapaPts[2].y.toFixed(1)}"></path>` +
    `<g class="cg-gate" transform="translate(${sluice.x.toFixed(1)} ${sluice.y.toFixed(1)})"><rect class="cg-gate-bar cg-gate-l" x="-6" y="-2.5" width="6" height="5"></rect><rect class="cg-gate-bar cg-gate-r" x="0" y="-2.5" width="6" height="5"></rect></g>` +
    (narrow
      ? `<text class="water-map-label cg-gate-label" x="${(sluice.x - 10).toFixed(1)}" y="${(sluice.y + 18).toFixed(1)}" text-anchor="end">zsilip</text>`
      : `<text class="water-map-label cg-gate-label" x="${(sluice.x + 9).toFixed(1)}" y="${(sluice.y - 6).toFixed(1)}">zsilip</text>`) +
    waterLabels + canalLabels + placesMarkup +
    (narrow
      ? `<text class="cg-counter" id="cg-counter" x="6" y="20"></text>`
      : `<text class="cg-counter" id="cg-counter" x="${((rx0 + rx1) / 2).toFixed(1)}" y="${(ry0 - 28).toFixed(1)}" text-anchor="middle"></text>`) +
    scale + inset + hitMarkup;

  // Buborékok: rámutatásra, koppintásra és fókuszra.
  const showPopup = (el, x, y) => {
    const p = popups[el.dataset.popup];
    mapPopupShow(tooltipEl, x, y, `<strong>${p.title}</strong><span>${p.text}</span>`);
  };
  svgEl.querySelectorAll(".cg-hit").forEach(el => {
    el.addEventListener("pointermove", e => { if (e.pointerType === "mouse") showPopup(el, e.clientX, e.clientY); });
    el.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") mapPopupHide(tooltipEl); });
    el.addEventListener("click", e => { e.stopPropagation(); showPopup(el, e.clientX, e.clientY); });
    el.addEventListener("focus", () => { const r = el.getBoundingClientRect(); showPopup(el, r.left + r.width / 2, r.top + r.height / 2); });
    el.addEventListener("blur", () => mapPopupHide(tooltipEl));
  });
  if (buildCigandMap.closer) document.removeEventListener("click", buildCigandMap.closer);
  buildCigandMap.closer = () => mapPopupHide(tooltipEl);
  document.addEventListener("click", buildCigandMap.closer);
  watchFigureScale(svgEl, W);

  return {};
}

// Az 5 lépéses animáció. A lépés az svg osztályain át hat (st-1..st-5,
// halmozódnak), a vonalkázás és a számláló requestAnimationFrame-mel nő.
// Egyszer indul, amikor az ábra láthatóvá válik; a pontok és a "lejátszás
// újra" gomb kézzel is léptet. Csökkentett mozgásnál a végállapot látszik, a
// lépések számozott listában.
function setupCigandAnimation(svgEl, geoInfo, data) {
  cigandStopAnimation();
  const captionEl = document.getElementById("cigand-step-caption");
  const dotsEl = document.getElementById("cigand-dots");
  const stepsList = document.getElementById("cigand-steps");
  const counterEl = svgEl.querySelector("#cg-counter");
  const vapaSegs = svgEl.querySelectorAll(".cg-vapa-seg");
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const volumeText = "közel 2 milliárd liter";

  dotsEl.innerHTML = CIGAND_STEPS.map((name, i) =>
    `<button type="button" class="cigand-dot" data-step="${i + 1}" aria-label="${i + 1}. lépés: ${name}"></button>`).join("");
  stepsList.innerHTML = CIGAND_STEPS.map(s => `<li>${s}</li>`).join("");

  let cancelFill = null, timer = null, current = 0;
  const setFill = t => {
    // A vápa-sáv a zsilipnél kezdve nő a Tiszakarádi-főcsatorna felé (pathLength=1).
    vapaSegs.forEach(el => { el.style.strokeDasharray = `${t.toFixed(3)} 2`; });
    const liters = 2 * t;
    counterEl.textContent = t >= 1 ? volumeText : t > 0 ? `${waterNum(liters, 1)} milliárd liter` : "";
  };

  function showStep(n, animate) {
    current = n;
    for (let i = 1; i <= 5; i++) svgEl.classList.toggle(`st-${i}`, i <= n);
    captionEl.textContent = n ? `${n}. ${CIGAND_STEPS[n - 1]}` : "indulás előtt: a zsilip zárva";
    dotsEl.querySelectorAll(".cigand-dot").forEach(b => {
      const k = Number(b.dataset.step);
      b.classList.toggle("is-done", k <= n);
      b.setAttribute("aria-current", k === n ? "step" : "false");
    });
    if (cancelFill) { cancelFill(); cancelFill = null; }
    if (n >= 4) {
      if (animate && n === 4) cancelFill = cigandTween(CIGAND_STEP_MS * 0.9, setFill);
      else setFill(1);
    } else {
      setFill(0);
    }
  }

  function stop() {
    clearTimeout(timer);
    if (cancelFill) cancelFill();
    cancelFill = null;
  }
  function play() {
    stop();
    showStep(0, false);
    let n = 0;
    const next = () => {
      n += 1;
      showStep(n, true);
      if (n < 5) timer = setTimeout(next, CIGAND_STEP_MS);
    };
    timer = setTimeout(next, 250);
  }
  dotsEl.onclick = e => {
    const b = e.target.closest(".cigand-dot");
    if (!b) return;
    stop();
    showStep(Number(b.dataset.step), false);
  };
  document.getElementById("cigand-replay").onclick = () => { stepsList.hidden = true; play(); };

  if (reduced) {
    stepsList.hidden = false;
    showStep(5, false);
    cigandAnim = { stop };
    return;
  }
  stepsList.hidden = true;
  showStep(0, false);
  let started = false;
  let observer = null;
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(entries => {
      if (!started && entries.some(e => e.isIntersecting)) {
        started = true;
        observer.disconnect();
        play();
      }
    }, { threshold: 0.5 });
    observer.observe(svgEl);
  } else {
    started = true;
    play();
  }
  cigandAnim = { stop: () => { stop(); if (observer) observer.disconnect(); } };
}

// Friss hírek: a cigand-news.json-t óránként frissíti a GitHub Action
// (.github/scripts/cigand_news.py). Hiba vagy 0 hír esetén semmit nem rajzol.
async function buildCigandNews(data) {
  const box = document.getElementById("cigand-news");
  const latestEl = document.getElementById("cigand-latest");
  box.hidden = true;
  latestEl.hidden = true;
  try {
    const d = new Date();
    const hour = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") +
      String(d.getUTCDate()).padStart(2, "0") + String(d.getUTCHours()).padStart(2, "0");
    const res = await fetch(`cigand-news.json?h=${hour}`);
    if (!res.ok) return;
    const news = await res.json();
    const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    // Az AI által kinyert, ellenőrzött legfrissebb szám: csak akkor jelenik meg,
    // ha újabb a kézzel vezetett cigand.json adatánál; azt nem írja felül.
    const ls = news.latest_status;
    if (ls && typeof ls.stored_volume_m3 === "number" && (ls.fact_date || ls.when || "") > data.facts.date) {
      const when = new Date((ls.fact_date || ls.when) + "T12:00:00");
      latestEl.innerHTML = `Legfrissebb hír szerint: kb. ${waterNum(ls.stored_volume_m3 / 1e6, 1)} millió m³ ` +
        `(<a href="${esc(ls.link)}" target="_blank" rel="noopener">${esc(ls.source)}</a>, ${new Intl.DateTimeFormat("hu-HU", { month: "short", day: "numeric" }).format(when)})`;
      latestEl.hidden = false;
    }
    const items = (news.items || []).filter(it => it.relevant !== false).slice(0, 5);
    if (!items.length) return;
    const fmt = new Intl.DateTimeFormat("hu-HU", { month: "short", day: "numeric" });
    document.getElementById("cigand-news-list").innerHTML = items.map(it => {
      const t = new Date(it.published);
      const isNew = Date.now() - t.getTime() < 48 * 3600 * 1000;
      return `<li><span class="cigand-news-date">${fmt.format(t)}</span> ` +
        `<a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a> ` +
        `<span class="cigand-news-src">${esc(it.source)}</span>` +
        (isNew ? ` <span class="cigand-news-new">új</span>` : "") +
        (it.summary ? `<span class="cigand-news-sum">${esc(it.summary)}</span>` : "") + `</li>`;
    }).join("");
    document.getElementById("cigand-news-note").textContent =
      `Automatikusan gyűjtve ${(news.sources || []).length} hírforrás RSS-csatornájából, óránként ellenőrizve.` +
      (items.some(it => it.summary) ? " Az összefoglalókat mesterséges intelligencia készíti a cikkekből, hibázhat; a pontos tartalomért nyisd meg a cikket." : "");
    box.hidden = false;
  } catch (err) {
    console.error(err);
  }
}

async function buildCigand(soil, rivers) {
  const section = document.getElementById("water-cigand-section");
  const tocLink = document.getElementById("water-toc-cigand");
  try {
    const { data, geo } = await loadCigand();
    document.getElementById("cigand-tag").textContent = data.active ? data.label : "";
    document.getElementById("cigand-tag").hidden = !data.active;
    document.getElementById("cigand-title").textContent = data.title;
    document.getElementById("cigand-lead").textContent = data.lead;
    document.getElementById("cigand-tiles").innerHTML = cigandTilesHtml(data, rivers && rivers.stations);
    const cells = soil.points.filter(p => p.in_hungary && p.liters_total > 0);
    const minCell = cells.length ? Math.min(...cells.map(p => p.liters_total)) : 0;
    document.getElementById("cigand-compare").innerHTML = cigandCompareHtml(data, minCell);
    document.getElementById("cigand-caveat").innerHTML =
      `Ez nem árvízi elárasztás: a tározó kb. 2 százalékáról van szó. A víz a vápát és a Tiszakarádi-főcsatornát tölti fel, onnan mellékcsatornákba jut (${data.operator}). Élő mérés nincs róla: a számok bejelentések.`;
    document.getElementById("cigand-faq").innerHTML = cigandFaqHtml(data);
    document.getElementById("cigand-timeline").innerHTML = cigandTimelineHtml(data);
    document.getElementById("cigand-sources").innerHTML = "Források: " +
      data.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a>`).join(", ") + `. Frissítve: ${data.updated}.`;

    // Keskeny kijelzőn (<= 520 px) külön, valódi képpontban rajzolt, vágott
    // térkép és metszet; az elrendezés váltásakor (pl. forgatás) újrarajzol.
    const narrowMq = window.matchMedia("(max-width: 520px)");
    const drawCigandFigures = () => {
      const narrow = narrowMq.matches;
      const mapEl = document.getElementById("cigand-map");
      const info = buildCigandMap(mapEl, document.getElementById("cigand-tooltip"), data, geo, narrow);
      setupCigandAnimation(mapEl, info, data);
      buildCigandSection(document.getElementById("cigand-section-svg"), data, narrow);
      document.getElementById("cigand-xs-list").innerHTML = cigandSectionListHtml(data);
      document.getElementById("cigand-xs-list").hidden = !narrow;
      document.getElementById("cigand-badge").hidden = narrow;
      document.getElementById("cigand-badge-line").hidden = !narrow;
    };
    drawCigandFigures();
    buildCigandNews(data);
    if (buildCigand.mq) buildCigand.mq.removeEventListener("change", buildCigand.onMq);
    buildCigand.mq = narrowMq;
    buildCigand.onMq = drawCigandFigures;
    narrowMq.addEventListener("change", drawCigandFigures);

    // Lejárt esemény: egy soros összefoglaló, az országos szakaszok alatt.
    const body = document.getElementById("cigand-body");
    const summary = document.getElementById("cigand-summary");
    const expand = document.getElementById("cigand-expand");
    if (!data.active) {
      const anchor = document.getElementById("water-methodology");
      anchor.parentNode.insertBefore(section, anchor);
      document.getElementById("cigand-summary-text").textContent = data.summary;
      summary.hidden = false;
      body.hidden = true;
      expand.setAttribute("aria-expanded", "false");
      expand.onclick = () => {
        const open = body.hidden;
        body.hidden = !open;
        expand.setAttribute("aria-expanded", open ? "true" : "false");
        expand.textContent = open ? "elrejtés" : "részletek";
      };
    } else {
      const firstSection = document.getElementById("water-local-section");
      firstSection.parentNode.insertBefore(section, firstSection);
      summary.hidden = true;
      body.hidden = false;
    }
    section.hidden = false;
    tocLink.hidden = false;
  } catch (err) {
    console.error(err);
    section.hidden = true;
    tocLink.hidden = true;
  }
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

// UX-audit T01: a csatorna-térkép ~5000 SVG node-ot épít - ezt a lenti
// IntersectionObserver csak akkor indítja, amikor a szakasz TÉNYLEG közelít
// a látható területhez, nem minden keresésnél azonnal. Mivel buildWaterPanel
// minden új keresésnél újrafut, a KORÁBBI megfigyelőt is le kell állítani,
// különben egy még ki nem oldott, régi megfigyelő egy már elavult
// (korábbi helyszínhez tartozó) closure-t sülne el később.
let channelsObserver = null;

// A betöltés alatt egy helyfoglaló doboz tartja a helyet, hogy a lap ne
// ugorjon, amikor az ábrák megérkeznek.
function setWaterLoading(on) {
  document.getElementById("water-skeleton").hidden = !on;
}

// Tartalomjegyzék: a jelenleg látott szakasz a tapadó sávban aria-current-et
// kap. Minden új felépítéskor újraindul (a régi megfigyelő leáll).
let waterTocObserver = null;
function watchWaterToc() {
  if (waterTocObserver) waterTocObserver.disconnect();
  if (!("IntersectionObserver" in window)) return;
  const links = [...document.querySelectorAll("#water-toc a")];
  const targets = links.map(a => document.querySelector(a.getAttribute("href")));
  const visible = new Set();
  const update = () => {
    // A legfelső, még látható szakasz a jelenlegi.
    const current = targets.find(t => t && visible.has(t));
    const toc = document.getElementById("water-toc");
    links.forEach((a, i) => {
      if (targets[i] && targets[i] === current) {
        a.setAttribute("aria-current", "true");
        // Keskeny kijelzőn a sáv vízszintesen görgethető: az aktív elem középre kerül.
        if (toc && toc.scrollWidth > toc.clientWidth) toc.scrollTo({ left: a.offsetLeft - (toc.clientWidth - a.offsetWidth) / 2, behavior: "smooth" });
      } else a.removeAttribute("aria-current");
    });
  };
  waterTocObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target); else visible.delete(e.target);
    }
    update();
  }, { rootMargin: "-56px 0px -45% 0px" });
  targets.forEach(t => { if (t) waterTocObserver.observe(t); });
}

async function buildWaterPanel(point) {
  const statusEl = document.getElementById("water-status");
  statusEl.hidden = false;
  statusEl.textContent = "töltés…";
  setWaterLoading(true);

  try {
    // A saját hely talajprofilja párhuzamosan jön, és a hibája nem buktatja
    // el az országos adatokat (null: a szekció rejtve marad).
    const [soil, rivers, lakes, , , , , localSoil] = await Promise.all([
      fetchWaterSnapshot("soil-snapshot"),
      fetchWaterSnapshot("rivers-snapshot"),
      fetchWaterSnapshot("lakes-snapshot"),
      loadWaterGeo(), // a legnagyobb folyók/Balaton valódi vonala a dombormű-térképhez (globális `waterGeo`)
      loadBorders(), // az ország valódi körvonala a dombormű-raszter vágásához (globális `borderRings`)
      loadPlaces(), // helynevek a térképek felirataihoz és a cellák neveihez
      loadCounties(), // megyehatárok a nagyított csatorna-térképhez
      fetchUserSoilProfile(point).catch(err => { console.error(err); return null; }),
    ]);

    // A HÁROM közül a legrégebbi generated_at-ot mutatjuk: ha bármelyik
    // forrás elavultabb, az számít (ne tűnjön frissebbnek az oldal, mint
    // amilyen a leglassabban frissülő adata ténylegesen).
    const updatedTimes = [soil, rivers, lakes]
      .map(s => s.generated_at)
      .filter(Boolean)
      .map(iso => new Date(iso));
    const updatedEl = document.getElementById("water-updated");
    if (updatedTimes.length) {
      const oldest = new Date(Math.min(...updatedTimes));
      updatedEl.textContent = `adatok frissítve: ${formatUpdatedAt(oldest)}`;
      updatedEl.hidden = false;
    } else {
      updatedEl.hidden = true;
    }

    // Cigánd: aktuális hír, a saját hibája nem buktatja el a panelt.
    await buildCigand(soil, rivers);

    const localMoisture = localSoil ? localSoil.moisture : null;
    // 1. Személyes: legfelül, mert ez szól a keresett helyre; az országos
    // adatok utána jönnek. Ugyanabban a lépésben jelenik meg, mint az
    // országos szekciók, hogy később ne ugorjon be föléjük.
    const avgMoisture = waterCountryAvgMoisture(soil);
    document.getElementById("water-local-question").textContent =
      `Mennyi víz van most a talajban ${point.name || "a keresett helyszín"} környékén?`;
    if (localMoisture) {
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
      renderSoilCoreProfile(document.getElementById("water-soil-core"), localMoisture, point, localSoil.elevation);
      document.getElementById("water-local-section").hidden = false;
    } else {
      document.getElementById("water-local-section").hidden = true;
    }

    // 2. Talajvíz: országos
    const totalCount = waterBalatonCount(soil.country_total_liters, 1);
    document.getElementById("water-soil-balaton-count").textContent = totalCount;
    document.getElementById("water-soil-balaton-label").textContent = "Balatonnyi, 81 cm mélységig";
    document.getElementById("water-soil-exact").textContent =
      `kb. ${waterNum(soil.country_total_liters / 1e9, 0)} milliárd liter (becslés, Open-Meteo talajmodell)`;
    renderBalatonStack(
      document.getElementById("water-balaton-stack"),
      soil.depth_bands_cm,
      soil.country_total_by_depth,
      avgMoisture
    );
    document.getElementById("water-soil-section").hidden = false;

    // 2. Országtérkép. A Balaton fölötti, adat nélküli (0 literes) cella nem
    // számít: se a legszárazabb, se a legnedvesebb nem lehet. A fejsor
    // helynevet ad (a legnagyobb település a cella területén), nem csak számot.
    const hungaryCells = soil.points.filter(p => p.in_hungary && p.liters_total > 0);
    const maxCell = hungaryCells.reduce((a, b) => (b.liters_total > a.liters_total ? b : a), hungaryCells[0]);
    const minCell = hungaryCells.reduce((a, b) => (b.liters_total < a.liters_total ? b : a), hungaryCells[0]);
    const cellHalf = soil.grid_step_deg / 2;
    const cellLabel = c => {
      const name = nearestPlaceName(c.lat, c.lon, cellHalf, cellHalf);
      return name ? `${name} környéke` : "egy mintaterület";
    };
    const cellPct = c => Math.round(waterWeightedAvg(c.moisture_by_depth) * 100);
    document.getElementById("water-map-headline").textContent =
      `legnedvesebb: ${cellLabel(maxCell)}`;
    document.getElementById("water-map-detail").textContent =
      `${cellPct(maxCell)}% átlagos víztartalom, legszárazabb: ${cellLabel(minCell)} (${cellPct(minCell)}%)`;
    buildReliefMap(
      document.getElementById("water-relief-map"),
      document.getElementById("water-map-legend"),
      soil,
      rivers.stations,
      lakes.stations,
      point,
      waterGeo
    );
    document.getElementById("water-map-section").hidden = false;
    watchFigureScale(document.getElementById("water-relief-map"), 640);

    // 2b. Folyók: a hálózat-térkép (rámutatásra mért vízállás + idősor) és a
    // lenti lista EGY szakasz: a térképen egy folyóra kattintva ugyanaz a
    // grafikon nyílik, mint a listában. A lista a billentyűzettel és
    // képernyőolvasóval elérhető megfelelő.
    const riverCount = rivers.stations.length;
    const riverNames = [...new Set(rivers.stations.map(s => s.river))];
    document.getElementById("water-rivers-headline").textContent =
      `${riverCount} mérőállomás, ${riverNames.length} nagyobb folyón`;
    document.getElementById("water-rivers-detail").textContent =
      "élő mérce-adat (hydroinfo.hu) - koppints egy folyóra az előrejelzéshez és a korábbi vízálláshoz";
    buildRiverList(document.getElementById("water-river-list"), rivers.stations);
    buildRiverNet(
      document.getElementById("water-river-net"),
      document.getElementById("water-river-net-tooltip"),
      rivers.stations
    );
    document.getElementById("water-river-net-section").hidden = false;
    watchFigureScale(document.getElementById("water-river-net"), 400);

    // 2d. Csatornák: lásd a buildChannelsMap fölötti kommentet. UX-audit
    // T01 - ez a (nagy payload-ú, ~5000 SVG node-ot építő) térkép a kezdeti
    // betöltéskor még biztosan a látható területen kívül van, ezért a
    // lekérést/építést nem itt, azonnal indítjuk, hanem csak akkor, amikor
    // a szakasz ténylegesen közelít hozzá (IntersectionObserver, 400px
    // előre-töltési margóval - mire a felhasználó odagörget, már kész).
    // A szakasz maga üresen, "töltés…" szöveggel már most látszik, hogy a
    // #water-toc ugrólink mindig érvényes célpontra mutasson (ld. I01).
    if (channelsObserver) channelsObserver.disconnect();
    document.getElementById("water-channels-headline").textContent = "";
    document.getElementById("water-channels-detail").textContent = "töltés…";
    document.getElementById("water-channels-longest").innerHTML = "";
    document.getElementById("water-channels-caveat").textContent = "";
    document.getElementById("water-channels-section").hidden = false;
    const loadChannelsSection = async () => {
      try {
        const channels = await fetchWaterSnapshot("channels-snapshot");
        await Promise.all([loadBorders(), loadElevation(), loadPlaces(), loadCounties()]);
        watchFigureScale(document.getElementById("water-channels-map"), 400);
        buildChannelsMap(
          document.getElementById("water-channels-map"),
          document.getElementById("water-channels-legend"),
          channels
        );
        const stats = channels.stats;
        document.getElementById("water-channels-headline").textContent =
          `${waterNum(stats.total_ways, 0)} folyó, csatorna, belvízelvezető, árok és tó`;
        document.getElementById("water-channels-detail").textContent =
          `összesen kb. ${waterNum(stats.total_km, 0)} km`;
        document.getElementById("water-channels-longest").innerHTML = stats.longest
          .slice(0, 8)
          .map(c => `<li><span>${c.name}</span><span>${waterNum(c.km, 1)} km</span></li>`)
          .join("");
        document.getElementById("water-channels-caveat").textContent =
          "A térkép csak a nevesített vízfolyásokat rajzolja ki, a fenti darabszám és hossz viszont mindegyikkel számol - a legtöbb kisebb árok nincs elnevezve. Egy folyó esetenként több néven is szerepelhet a listában (pl. határ menti kétnyelvű OSM-elnevezés), ezek külön sorként, nem összevonva jelennek meg.";
      } catch (err) {
        console.error(err);
        document.getElementById("water-channels-detail").textContent = "a térkép most nem érhető el";
      }
    };
    const channelsSectionEl = document.getElementById("water-channels-section");
    if ("IntersectionObserver" in window) {
      channelsObserver = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) {
          channelsObserver.disconnect();
          loadChannelsSection();
        }
      }, { rootMargin: "400px" });
      channelsObserver.observe(channelsSectionEl);
    } else {
      loadChannelsSection();
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
    document.getElementById("water-balaton-tiles-caption").textContent =
      `Soronként 10 Balaton: ${Math.floor(balanceBalatonCount / 10)} teli sor` +
      (balanceBalatonCount % 10 >= 0.05 ? ` és még ${waterNum(balanceBalatonCount % 10, 1)}.` : ".");
    document.getElementById("water-balance-section").hidden = false;

    // 5. Tavak. A Balaton átlagos vízállása a fejsorban, a kártyákon a tavak
    // közös, azonos felépítésű mérce-képe (ld. renderLakeCards). A Tisza-tó
    // nincs kártyán: nincs valódi tó-mérce hozzá (ld. WATER_LAKE_BANDS).
    const balatonAvg = findLakeStation(lakes.stations, "Balaton", "Balaton average");
    if (balatonAvg) {
      document.getElementById("water-balaton-level").textContent = `${waterNum(balatonAvg.level_cm, 0)} cm`;
      document.getElementById("water-balaton-detail").textContent =
        (balatonAvg.stale
          ? "átlagos vízállás (tegnapi adat), "
          : "átlagos vízállás, ")
        + "a mérce saját 0 pontjához képest, nem tengerszinthez";
    } else {
      document.getElementById("water-balaton-level").textContent = "jelenleg nem elérhető";
      document.getElementById("water-balaton-detail").textContent = "a Balaton vízállása most nem tölthető be";
    }
    document.getElementById("water-lake-compare").innerHTML =
      `<g fill="var(--accent)">` +
      Object.values(LAKE_COMPARE_PATHS).map(p => `<path${p.transform ? ` transform="${p.transform}"` : ""} d="${p.d}"></path>`).join("") +
      `</g><g font-size="12" fill="var(--muted)" text-anchor="middle">` +
      `<text x="105" y="134">Balaton</text><text x="268" y="134">Fertő</text><text x="340" y="134">Tisza-tó</text></g>`;

    const velencei = findLakeStation(lakes.stations, "Velencei-tó", "Agárd");
    const ferto = findLakeStation(lakes.stations, "Fertő", "Fertőrákos");
    renderLakeCards(document.getElementById("water-lake-gauges"), [
      { name: "Balaton", shapeKey: "balaton", levelCm: balatonAvg ? balatonAvg.level_cm : null, history: balatonAvg && balatonAvg.history },
      { name: "Velencei-tó", shapeKey: "velencei", levelCm: velencei ? velencei.level_cm : null, history: velencei && velencei.history },
      { name: "Fertő", shapeKey: "ferto", levelCm: ferto ? ferto.level_cm : null, history: ferto && ferto.history },
    ]);

    // "legrosszabbul álló tó": csak azok közül választunk, amiknek van
    // megbízható szabályozási sávja (a Balaton külön, a fejsorban szerepel) -
    // enélkül a "legrosszabbul" állítás megtévesztő lenne, mint a Tisza-tónál.
    const worstLakeCandidates = [
      { name: "Velencei-tó", levelCm: velencei ? velencei.level_cm : null },
      { name: "Fertő", levelCm: ferto ? ferto.level_cm : null },
    ]
      .map(c => {
        const band = WATER_LAKE_BANDS[c.name];
        return band && band.lowCm !== null && c.levelCm !== null
          ? { ...c, deficit: band.lowCm - c.levelCm }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.deficit - a.deficit);
    const worstLake = worstLakeCandidates[0];
    if (worstLake) {
      document.getElementById("water-lake-worst-headline").textContent =
        worstLake.deficit > 0 ? `${worstLake.name} áll a legrosszabbul` : `${worstLake.name} a legjobb állapotban`;
      document.getElementById("water-lake-worst-detail").textContent =
        worstLake.deficit > 0
          ? `${waterNum(worstLake.deficit, 0)} cm-rel az ideális szint alatt`
          : `${waterNum(-worstLake.deficit, 0)} cm-rel az ideális szint felett`;
    } else {
      document.getElementById("water-lake-worst-headline").textContent = "nincs elég adat az összevetéshez";
      document.getElementById("water-lake-worst-detail").textContent = "";
    }

    document.getElementById("water-lakes-section").hidden = false;

    statusEl.hidden = true;
    setWaterLoading(false);
    watchWaterToc();
  } catch (err) {
    console.error(err);
    statusEl.textContent = "a vízadatok most nem érhetők el";
    document.getElementById("water-updated").hidden = true;
    setWaterLoading(false);
  }
}

function resetWaterPanel() {
  const panel = document.getElementById("water-panel");
  panel.hidden = true;
  cigandStopAnimation();
  for (const id of ["water-cigand-section", "water-soil-section", "water-map-section", "water-river-net-section", "water-channels-section", "water-local-section", "water-balance-section", "water-lakes-section"]) {
    document.getElementById(id).hidden = true;
  }
  document.getElementById("water-status").hidden = false;
  document.getElementById("water-status").textContent = "töltés…";
  document.getElementById("water-updated").hidden = true;
  setWaterLoading(true);
  if (waterTocObserver) waterTocObserver.disconnect();
}

// ---- Indítás ----

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(err => console.error(err));
}

updateNotifyButton();

// UX-audit "megosztható (település-specifikus) link" (PROGRESS.md, Later
// roadmap): ?lat=&lon=&name=&cc= - ez EXPLICIT felhasználói szándék, a
// mentett/automatikus helynél is előrébb való. Elmentjük (hogy egy
// következő, paraméter nélküli látogatás is ezt találja, mint egy kézi
// keresés után), majd kitakarítjuk az URL-t, hogy egy frissítés ne fusson
// le kétszer ugyanarra.
function parseSharedLocationFromURL() {
  const params = new URLSearchParams(location.search);
  const lat = parseFloat(params.get("lat"));
  const lon = parseFloat(params.get("lon"));
  const name = params.get("name");
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { name, lat, lon, countryCode: params.get("cc") || null };
}

const sharedLoc = parseSharedLocationFromURL();
if (sharedLoc) {
  saveLocation(sharedLoc);
  showResult();
  runAndTrack(sharedLoc);
  history.replaceState(null, "", location.pathname);
} else {
  const saved = loadSavedLocation();
  if (saved) {
    showResult();
    runAndTrack(saved);
  } else {
    tryAutoLocate();
  }
}
