// ---- Referenciatelepülések ----
// Ezek alapján döntjük el, esik-e valahol a közeledben, és milyen messze.
// A magyar városok sűrűbb mintát adnak itthonra, a világvárosok pedig azt
// biztosítják, hogy külföldről is legyen mihez hasonlítani.
const HU_TOWNS = [
  { name: "Budapest", lat: 47.4979, lon: 19.0402 },
  { name: "Debrecen", lat: 47.5316, lon: 21.6273 },
  { name: "Szeged", lat: 46.2530, lon: 20.1414 },
  { name: "Miskolc", lat: 48.1035, lon: 20.7784 },
  { name: "Pécs", lat: 46.0727, lon: 18.2330 },
  { name: "Győr", lat: 47.6875, lon: 17.6504 },
  { name: "Nyíregyháza", lat: 47.9495, lon: 21.7244 },
  { name: "Kecskemét", lat: 46.9062, lon: 19.6913 },
  { name: "Székesfehérvár", lat: 47.1860, lon: 18.4221 },
  { name: "Szombathely", lat: 47.2307, lon: 16.6218 },
  { name: "Szolnok", lat: 47.1747, lon: 20.1830 },
  { name: "Kaposvár", lat: 46.3593, lon: 17.7967 },
  { name: "Békéscsaba", lat: 46.6736, lon: 21.0877 },
  { name: "Eger", lat: 47.9025, lon: 20.3772 },
  { name: "Veszprém", lat: 47.0932, lon: 17.9115 },
  { name: "Zalaegerszeg", lat: 46.8417, lon: 16.8416 },
  { name: "Vác", lat: 47.7757, lon: 19.1343 },
  { name: "Szekszárd", lat: 46.3474, lon: 18.7062 },
];

const WORLD_CITIES = [
  { name: "London", lat: 51.5074, lon: -0.1278 },
  { name: "Párizs", lat: 48.8566, lon: 2.3522 },
  { name: "Berlin", lat: 52.5200, lon: 13.4050 },
  { name: "Amszterdam", lat: 52.3676, lon: 4.9041 },
  { name: "Dublin", lat: 53.3498, lon: -6.2603 },
  { name: "Bergen", lat: 60.3913, lon: 5.3221 },
  { name: "Zürich", lat: 47.3769, lon: 8.5417 },
  { name: "Reykjavík", lat: 64.1466, lon: -21.9426 },
  { name: "Tokió", lat: 35.6762, lon: 139.6503 },
  { name: "Lagos", lat: 6.5244, lon: 3.3792 },
  { name: "Szingapúr", lat: 1.3521, lon: 103.8198 },
  { name: "Vancouver", lat: 49.2827, lon: -123.1207 },
  { name: "Mumbai", lat: 19.0760, lon: 72.8777 },
  { name: "Rio de Janeiro", lat: -22.9068, lon: -43.1729 },
];

const REFERENCE_CITIES = [...HU_TOWNS, ...WORLD_CITIES];

const NEARBY_LIMIT_KM = 70; // eddig számít "közelinek" egy esős település
const RAIN_THRESHOLD_MM = 0.1; // ennél kevesebb csapadékot zajnak tekintünk

// ---- Segédfüggvények ----

// Két koordináta közti távolság kilométerben (haversine-képlet)
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
  return { name: r.name, lat: r.latitude, lon: r.longitude };
}

// Koordinátából településnév az OpenStreetMap-alapú, kulcs nélküli BigDataCloud
// reverse geocoding API-val. Ha nem sikerül, null-t adunk vissza, és általános
// szöveggel folytatjuk. A koordináta enélkül is elég a válaszhoz.
async function reverseGeocode(lat, lon) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=hu`;
  const res = await fetch(url);
  const data = await res.json();
  return data.city || data.locality || null;
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

// Egyetlen hívásban lekérjük a felhasználó helyét ÉS az összes referenciatelepülést
async function fetchAllPrecipitation(userLoc) {
  const allPoints = [userLoc, ...REFERENCE_CITIES];
  const lats = allPoints.map(p => p.lat).join(",");
  const lons = allPoints.map(p => p.lon).join(",");
  // forecast_days=2, hogy a "hamarosan" (következő 3 óra) ablak éjfél körül is
  // átnyúlhasson a következő napra, ne csak az aktuális nap 23:00-jánál vágja le.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=precipitation&hourly=precipitation&forecast_days=2&timezone=auto`;
  const res = await fetch(url);
  const data = await res.json();

  // A válasz ugyanabban a sorrendben jön vissza, ahogy küldtük a koordinátákat
  return {
    user: data[0],
    reference: data.slice(1),
  };
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
    const { user, reference } = await fetchAllPrecipitation(userLoc);
    render(userLoc, user, reference);
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

function render(userLoc, userForecast, referenceForecasts) {
  document.getElementById("q1-question").textContent =
    `hol az eső ${userLoc.name} környékén?`;

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

  // --- Keressük meg a hozzád legközelebbi esős referenciahelyet ---
  const raining = REFERENCE_CITIES
    .map((city, i) => ({ city, forecast: referenceForecasts[i] }))
    .filter(({ forecast }) => isRainingNow(forecast))
    .map(({ city }) => ({
      ...city,
      distance: distanceKm(userLoc.lat, userLoc.lon, city.lat, city.lon),
    }))
    .sort((a, b) => a.distance - b.distance);

  if (raining.length > 0) {
    const nearest = raining[0];
    const isNearby = nearest.distance <= NEARBY_LIMIT_KM;
    setHero(
      isNearby ? "Közelben" : "Távolban",
      isNearby ? "a közeli térségben esik" : "egy távolabbi városban esik"
    );
    setQ2(
      "de hol esik pontosan?",
      `<p class="place-line">${nearest.name}</p>
       <p class="context">kb. ${Math.round(nearest.distance)} km innen</p>`
    );
    return;
  }

  // --- A teljes figyelt hálózatban sehol nem esik ---
  setHero("Sehol", "a közeledben most száraz idő van");
  setQ2(null);
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
    let name = null;
    try {
      name = await reverseGeocode(coords.lat, coords.lon);
    } catch (err) {
      console.error(err);
    }
    const loc = { name: name || "a jelenlegi helyzeted", lat: coords.lat, lon: coords.lon };
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
