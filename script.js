// ---- Keresési rács ----
// Nincs fix településlista: a felhasználó koordinátája köré generálunk egy
// gyűrűkből álló ponthálót, és abban keressük a legközelebbi esőt. Ez minden
// országban egyformán pontos, nem csak Magyarországon vagy egy előre
// kiválasztott városlistán.
//
// Ha az első körben (600 km-ig) nem találunk esőt, egyre távolabbi köröket
// próbálunk, amíg nem találunk, vagy amíg el nem fogynak a körök.
const SEARCH_BATCHES_KM = [
  [30, 70, 150, 300, 600],
  [1000, 1500, 2200, 3000],
  [4000, 5500, 7000, 9000],
];
const SEARCH_BEARINGS_DEG = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

const NEARBY_LIMIT_KM = 70; // eddig számít "közelinek" egy esős hely
const RAIN_THRESHOLD_MM = 0.1; // ennél kevesebb csapadékot zajnak tekintünk

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

  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
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
  for (const distance of rings) {
    for (const bearing of SEARCH_BEARINGS_DEG) {
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
  return {
    name: data.city || data.locality || null,
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
async function fetchPrecipitation(points) {
  const lats = points.map(p => p.lat).join(",");
  const lons = points.map(p => p.lon).join(",");
  // forecast_days=2, hogy a "hamarosan" (következő 3 óra) ablak éjfél körül is
  // átnyúlhasson a következő napra, ne csak az aktuális nap 23:00-jánál vágja le.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=precipitation&hourly=precipitation&forecast_days=2&timezone=auto`;
  const res = await fetch(url);
  return res.json();
}

// A legközelebbi esős pontot adja vissza egy pont- és előrejelzés-listából,
// vagy null-t, ha egyikben sem esik.
function findNearestRaining(points, forecasts) {
  const raining = points
    .map((point, i) => ({ point, forecast: forecasts[i] }))
    .filter(({ forecast }) => isRainingNow(forecast))
    .sort((a, b) => a.point.distance - b.point.distance);
  return raining.length > 0 ? raining[0].point : null;
}

function isRainingNow(forecast) {
  return forecast.current.precipitation >= RAIN_THRESHOLD_MM;
}

function isRainingSoon(forecast) {
  // A "current.time" perc-pontosságú (pl. "...T18:45"), az "hourly.time" viszont
  // csak egész órás bontású ("...T18:00"), ezért kerekítsük le óra-pontosságra egyezéshez.
  const currentHour = forecast.current.time.slice(0, 13) + ":00";
  const idx = forecast.hourly.time.indexOf(currentHour);
  if (idx === -1) return false;
  return forecast.hourly.precipitation
    .slice(idx, idx + 3)
    .some(v => v >= RAIN_THRESHOLD_MM);
}

// ---- Fő logika ----

async function run(userLoc) {
  showLoading(true);
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

    // Első kör: saját hely + legközelebbi gyűrűk egyetlen hívásban
    const firstGrid = generateSearchGrid(userLoc, SEARCH_BATCHES_KM[0]);
    const firstForecasts = await fetchPrecipitation([userLoc, ...firstGrid]);
    const userForecast = firstForecasts[0];

    // --- Nálad esik, vagy hamarosan fog ---
    if (isRainingNow(userForecast)) {
      setHero("Nálad", "most esik");
      setQ2(null);
      return;
    }
    if (isRainingSoon(userForecast)) {
      setHero("Nálad", "hamarosan elkezdődik");
      setQ2(null);
      return;
    }

    // --- Keressük meg a legközelebbi esős pontot, egyre táguló körökben ---
    let nearest = findNearestRaining(firstGrid, firstForecasts.slice(1));
    for (let i = 1; i < SEARCH_BATCHES_KM.length && !nearest; i++) {
      const grid = generateSearchGrid(userLoc, SEARCH_BATCHES_KM[i]);
      const forecasts = await fetchPrecipitation(grid);
      nearest = findNearestRaining(grid, forecasts);
    }

    if (nearest) {
      await showNearestRain(nearest, userLoc);
    } else {
      setHero("Sehol", "a közeledben most száraz idő van");
      setQ2(null);
    }
  } catch (err) {
    console.error(err);
    setHero("Hiba", "");
    setQ2(null);
    document.getElementById("q1-context").textContent =
      "Nem sikerült lekérni az adatokat. Próbáld újra kicsit később.";
  } finally {
    showLoading(false);
  }
}

async function showNearestRain(nearest, userLoc) {
  const isNearby = nearest.distance <= NEARBY_LIMIT_KM;
  setHero(
    isNearby ? "Közelben" : "Távolban",
    isNearby ? "a közeli térségben esik" : "egy távolabbi térségben esik"
  );

  let place = { name: null, countryCode: null, countryName: null };
  try {
    place = await reverseGeocode(nearest.lat, nearest.lon);
  } catch (err) {
    console.error(err);
  }

  const isForeign = place.countryCode && userLoc.countryCode && place.countryCode !== userLoc.countryCode;
  const placeLabel = place.name
    ? (isForeign ? `${place.name}, ${place.countryName}` : place.name)
    : "egy közeli térségben";

  const direction = compassLabel(nearest.bearing);
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${userLoc.lat},${userLoc.lon}&destination=${nearest.lat},${nearest.lon}`;
  setQ2(
    "de hol esik pontosan?",
    `<p class="place-line">${placeLabel}</p>
     <p class="context">kb. ${Math.round(nearest.distance)} km innen
     <span class="direction-arrow" style="transform: rotate(${nearest.bearing}deg)" title="${direction} irányban" aria-label="${direction} irányban">↑</span></p>
     <a class="map-link" href="${mapsUrl}" target="_blank" rel="noopener">útvonal</a>`
  );
}

function setHero(answer, context) {
  document.getElementById("q1-answer").textContent = answer;
  document.getElementById("q1-context").textContent = context;
}

function setQ2(question, html) {
  const block = document.getElementById("q2-block");
  if (question === null) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  document.getElementById("q2-question").textContent = question;
  document.getElementById("q2-answer").innerHTML = html;
}

// ---- UI-vezérlés ----

function showLoading(on, text = "töltés…") {
  const el = document.getElementById("loading");
  el.textContent = text;
  el.hidden = !on;
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
    run(loc);
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
  run(loc);
});

document.getElementById("change-location").addEventListener("click", () => {
  showPicker();
});

document.getElementById("retry-geo").addEventListener("click", () => {
  document.getElementById("location-error").hidden = true;
  tryAutoLocate();
});

// ---- Indítás ----

const saved = loadSavedLocation();
if (saved) {
  showResult();
  run(saved);
} else {
  tryAutoLocate();
}
