// Vízállás-grafikonok a /vizallas/* oldalakon és a /beagyaz/vizallas/ beágyazó oldalon.
// Önálló, klasszikus script (nem tölti a script.js-t és a water.js-t). Két grafikon állomásonként:
//   "friss": mért vízállás (8 nap óránként, 30 nap és 1 év naponta), előrejelzés, készültségi szintek;
//   "hossz": éves legalacsonyabb-legmagasabb sáv és az átlag vonala (10/30/50 év, összes).
// Adat: /data/vizallas/<allomas>.json (tools/build_pages.py írja). A friss grafikon az élő
// worker-pillanatképből frissíti a mai szintet, a 8 napos történetet és az előrejelzést.
// Minden szín CSS-változó (--fg, --bg, --muted, --border, --accent); a PNG-exportnál a kiszámolt
// (világos) értékek. A szöveg-méretek képpontban állandóak: az SVG viewBox = a keret képpont-mérete.
(function () {
  "use strict";

  const WORKER = "https://holazeso-push-worker.kovizozi.workers.dev";
  const MON = ["jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."];
  const SVGNS = "http://www.w3.org/2000/svg";
  const MINUS = "−";
  const DAY = 864e5;
  const HOUR = 36e5;
  const SOURCE_LINE = "Forrás: hydroinfo.hu (OVF) · holazeso.hu";
  const BASE = "https://holazeso.hu";

  // A képernyőn a CSS-változók (sötét módban is jók); a PNG-hez fix, világos értékek.
  // Az --accent itt a style.css világos értékét tükrözi: ha ott hangolod, ezt is igazítsd.
  const SCREEN = { fg: "var(--fg)", muted: "var(--muted)", bg: "var(--bg)", grid: "var(--border)", accent: "var(--accent)", font: "var(--font)" };
  const PRINT = {
    fg: "#111111", muted: "#6b6b6b", bg: "#ffffff", grid: "#dddddd", accent: "#1f4e9c",
    font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  };

  // ---- Kis segédek ----
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const rnd = n => Math.round(n);
  const num = n => (rnd(n) < 0 ? MINUS + Math.abs(rnd(n)) : String(rnd(n)));
  const cmTxt = n => num(n) + " cm";
  const f1 = n => (Math.round(n * 10) / 10).toString();
  const pad2 = n => (n < 10 ? "0" : "") + n;
  const dateMs = iso => { const p = iso.split("-").map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
  const dayLabel = ms => { const d = new Date(ms); return MON[d.getUTCMonth()] + " " + d.getUTCDate() + "."; };
  const fullDay = ms => new Date(ms).getUTCFullYear() + ". " + dayLabel(ms);
  const hm = ms => { const d = new Date(ms); return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()); };
  const isoLabel = iso => { const p = iso.split("-").map(Number); return p[0] + ". " + MON[p[1] - 1] + " " + p[2] + "."; };
  const mdLabel = md => { const p = md.split("-").map(Number); return MON[p[0] - 1] + " " + p[1] + "."; };
  const textW = (s, size) => s.length * (size || 12) * 0.54;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  let tzf = null;
  try {
    tzf = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Budapest", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (e) { tzf = null; }
  // Budapesti "falióra-idő", UTC-ként ábrázolva: így a tengely napjai a magyar naptár napjai.
  function wall(ms) {
    if (!tzf) return ms + HOUR;
    const p = {};
    for (const x of tzf.formatToParts(new Date(ms))) p[x.type] = x.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }

  function niceTicks(lo, hi, maxN) {
    const span = Math.max(hi - lo, 1);
    const raw = span / Math.max(maxN, 2);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    let step = p * 10;
    for (const m of [1, 2, 2.5, 5, 10]) { if (m * p >= raw) { step = m * p; break; } }
    // a tartomány pontosan az adat (+ kis ráhagyás), a rácsvonalak csak a belsejében: nincs üres extra lépcső
    const a = Math.ceil(lo / step - 1e-9) * step;
    const b = Math.floor(hi / step + 1e-9) * step;
    const ticks = [];
    for (let v = a; v <= b + step * 1e-6; v += step) ticks.push(Math.round(v * 100) / 100);
    return { ticks, lo, hi };
  }

  // ---- Adat ----
  const dataCache = new Map();
  let livePromise = null;

  function loadData(url) {
    if (!dataCache.has(url)) {
      dataCache.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }));
    }
    return dataCache.get(url);
  }

  function isLiveHost() {
    return /(^|\.)holazeso\.hu$/.test(location.hostname) || /[?&]live\b/.test(location.search);
  }

  // Az élő pillanatkép: egyszer kérjük oldalanként. Localhoston (CORS) a statikus másolat marad.
  function loadLive() {
    if (!livePromise) {
      livePromise = !isLiveHost() ? Promise.resolve(null) : Promise.race([
        fetch(WORKER + "/rivers-snapshot").then(r => (r.ok ? r.json() : null)),
        new Promise(res => setTimeout(() => res(null), 6000)),
      ]).catch(() => null);
    }
    return livePromise;
  }

  // Az élő állomás adatával frissíti a statikus adatot (a hely helyett új objektum nem készül).
  function applyLive(data, live) {
    if (!live || !data.snap || !Array.isArray(live.stations)) return false;
    const st = live.stations.find(s => s.river === data.snap.river && s.name === data.snap.name);
    if (!st || typeof st.level_cm !== "number" || !live.generated_at) return false;
    if (data.now && Date.parse(live.generated_at) < Date.parse(data.now.at)) return false;
    const gen = Date.parse(live.generated_at);
    data.now = { cm: st.level_cm, at: new Date(gen).toISOString().slice(0, 16) + "Z" };
    const hist = st.history || [];
    if (hist.length >= 3) {
      const t0 = Math.floor(Date.parse(hist[0].at) / 6e4) * 6e4;
      data.hourly = { t0: new Date(t0).toISOString().slice(0, 16) + "Z", dt: hist.map(h => Math.round((Date.parse(h.at) - t0) / 6e4)), cm: hist.map(h => h.level_cm) };
    }
    if (Array.isArray(st.forecast_cm) && st.forecast_cm.length) {
      // forecast_cm[i]: a pillanatkép napját követő (1 + i.) nap 07:00-ra (helyi idő) szóló előrejelzés
      const d0 = wall(gen);
      const day0 = d0 - (d0 % DAY) + DAY;
      data.forecast = { t0: new Date(day0).toISOString().slice(0, 10), cm: st.forecast_cm };
    }
    return true;
  }

  // ---- Modellek ----
  function alertLines(data) {
    const out = [];
    if (data.alerts) data.alerts.levels.forEach((v, i) => out.push({ v, label: ["I. fok", "II. fok", "III. fok"][i], short: ["I.", "II.", "III."][i] }));
    if (data.limit) out.push({ v: data.limit.cm, label: data.limit.label, limit: true });
    return out;
  }

  function frissFilters(data) {
    const f = [];
    if (data.hourly) f.push({ key: "8", label: "8 nap" });
    if (data.daily) { f.push({ key: "30", label: "30 nap" }); f.push({ key: "365", label: "1 év" }); }
    return f;
  }

  function frissModel(data, key) {
    const pts = [];
    // a más mérce (Balaton átlag) napi sorához a Siófok mai szintje nem illik: ott nincs "most" pont
    const nowT = data.now && !(data.daily_note && key !== "8") ? wall(Date.parse(data.now.at)) : null;
    if (key === "8" && data.hourly) {
      const t0 = Date.parse(data.hourly.t0);
      data.hourly.dt.forEach((dt, i) => pts.push({ t: wall(t0 + dt * 6e4), v: data.hourly.cm[i], kind: "hour" }));
    } else if (data.daily) {
      const d0 = dateMs(data.daily.start);
      data.daily.cm.forEach((v, i) => { if (v !== null) pts.push({ t: d0 + i * DAY + 7 * HOUR, v, kind: "day" }); });
      const lastT = Math.max(pts.length ? pts[pts.length - 1].t : 0, nowT || 0);
      const start = lastT - (key === "365" ? 364 : 29) * DAY;
      while (pts.length && pts[0].t < start - 12 * HOUR) pts.shift();
    }
    if (nowT !== null && (!pts.length || nowT > pts[pts.length - 1].t)) pts.push({ t: nowT, v: data.now.cm, kind: "now" });
    else if (pts.length) pts[pts.length - 1].last = true;
    const nObs = pts.length;
    if (data.forecast && key !== "365" && nObs) {
      const f0 = dateMs(data.forecast.t0);
      data.forecast.cm.forEach((v, i) => {
        const t = f0 + i * DAY + 7 * HOUR;
        if (t > pts[nObs - 1].t) pts.push({ t, v, kind: "fc", band: data.forecast.band ? data.forecast.band[i] : null });
      });
    }
    const obs = pts.slice(0, nObs);
    let imin = 0, imax = 0;
    obs.forEach((p, i) => { if (p.v < obs[imin].v) imin = i; if (p.v > obs[imax].v) imax = i; });
    let dataHi = Math.max.apply(null, pts.map(p => p.v));
    const lines = alertLines(data).map(l => {
      // Csak akkor rajzoljuk, ha a nézet a közelébe ér: az első szint a legmagasabb érték 60%-ától,
      // a többi 85%-ától; különben csak a jelmagyarázatban és a buborékban szerepel.
      const first = !l.limit && l.short === "I.";
      const drawn = l.v > 0 ? dataHi >= l.v * (first || l.limit ? 0.6 : 0.85) : true;
      return Object.assign({}, l, { drawn });
    });
    return { type: "time", key, pts, nObs, imin, imax, lines, hasFc: pts.length > nObs, data };
  }

  function yearsFilters(data) {
    const rows = data.years;
    const span = rows[rows.length - 1][0] - rows[0][0] + 1;
    const f = [];
    for (const n of [10, 30, 50]) if (span > n) f.push({ key: String(n), label: n + " év" });
    f.push({ key: "all", label: "összes" });
    return f;
  }

  function bucketize(rows, size) {
    const groups = new Map();
    for (const r of rows) {
      const k = Math.floor(r[0] / size);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return [...groups.values()].map(rs => {
      let lo = rs[0], hi = rs[0], n = 0, sum = 0;
      for (const r of rs) {
        if (r[1] < lo[1]) lo = r;
        if (r[3] > hi[3]) hi = r;
        n += r[6]; sum += r[5] * r[6];
      }
      return {
        a: rs[0][0], b: rs[rs.length - 1][0], min: lo[1], minD: lo[0] + "-" + lo[2], max: hi[3], maxD: hi[0] + "-" + hi[4],
        mean: sum / n, alt: rs.some(r => r[7] & 1), partial: rs.some(r => r[7] & 2), n,
      };
    });
  }

  function yearsModel(data, key) {
    let rows = data.years;
    const last = rows[rows.length - 1][0];
    const span = last - rows[0][0] + 1;
    if (key !== "all") rows = rows.filter(r => r[0] > last - Number(key));
    const size = key === "50" ? 5 : key === "all" ? (span <= 40 ? 1 : span <= 80 ? 5 : 10) : 1;
    const buckets = bucketize(rows, size);
    return { type: "years", key, buckets, size, data };
  }

  // ---- Rajzolás ----
  function legendLayout(items, maxW) {
    const rows = [[]];
    let x = 0;
    for (const raw of items) {
      const it = Object.assign({}, raw);
      const maxChars = Math.floor((maxW - 34) / (12 * 0.54));
      if (it.t.length > maxChars) it.t = it.t.replace(/ \([^)]*\)$/, "");
      if (it.t.length > maxChars) it.t = it.t.slice(0, maxChars - 1) + "\u2026";
      const w = (it.sw === undefined ? 24 : it.sw) + 6 + textW(it.t) + 16;
      if (x + w > maxW && rows[rows.length - 1].length) { rows.push([]); x = 0; }
      rows[rows.length - 1].push(Object.assign({ x, w }, it));
      x += w;
    }
    return rows;
  }

  function legendSwatch(it, x, y, P, uid) {
    const mid = y - 4;
    switch (it.k) {
      case "line": return `<path d="M${x} ${mid}h20" stroke="${P.accent}" stroke-width="2.25" fill="none" stroke-linecap="round"/>`;
      case "dash": return `<path d="M${x} ${mid}h20" stroke="${P.accent}" stroke-width="2.25" stroke-dasharray="4 3" fill="none"/>`;
      case "band": return `<rect x="${x}" y="${y - 10}" width="20" height="12" fill="${P.accent}" fill-opacity="0.2"/>`;
      case "hatch": return `<rect x="${x}" y="${y - 10}" width="20" height="12" fill="url(#vzh${uid})" stroke="${P.accent}" stroke-opacity="0.5"/>`;
      case "ref": return `<path d="M${x} ${mid}h20" stroke="${P.fg}" stroke-width="1" stroke-dasharray="5 3" fill="none"/>`;
      case "dot": return `<circle cx="${x + 10}" cy="${mid}" r="3.5" fill="${P.fg}"/>`;
      default: return "";
    }
  }

  // Közös keret: margók, tengelyek, rács, jelmagyarázat. A modell-specifikus rész a callback.
  function frame(o, spec) {
    const W = o.W, H = o.H, P = o.pal;
    const narrow = W < 520;
    const L = narrow ? 50 : 62, R = narrow ? 12 : 18;
    // A jelmagyarázat jobbra igazítva a rajzfelület tetején áll (a cím/szűrők alatt, exportban a címblokk alatt).
    const rows = legendLayout(spec.legend, W - L - R);
    const legTop = o.exp ? 64 : 4;
    const T = legTop + rows.length * 18 + 12;
    const legH = 44;   // az x tengely számai és felirata alatti rész
    const foot = o.exp ? 26 : 0;
    const x0 = L, x1 = W - R;
    const y1 = H - foot - legH;
    const y0 = T;
    const ph = Math.max(y1 - y0, 40);
    const yTicks = niceTicks(spec.yLo, spec.yHi, Math.max(3, Math.floor(ph / 44)));
    const yFor = v => y1 - (v - yTicks.lo) / (yTicks.hi - yTicks.lo) * (y1 - y0);
    const xFor = spec.xFor(x0, x1);
    const out = [];
    out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${P.bg}"/>`);
    if (o.exp) {
      out.push(`<text x="${L}" y="30" font-size="20" font-weight="700" fill="${P.fg}">${esc(o.title)}</text>`);
      out.push(`<text x="${L}" y="52" font-size="14" fill="${P.muted}">${esc(o.subtitle)}</text>`);
    }
    // rács és y tengely
    for (const v of yTicks.ticks) {
      const y = yFor(v);
      out.push(`<path d="M${x0} ${y.toFixed(1)}H${x1}" stroke="${P.grid}" stroke-width="1" fill="none"/>`);
      out.push(`<text x="${x0 - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="${P.muted}">${num(v)}</text>`);
    }
    const yTitle = ph >= 200 ? "Vízállás (cm, a mérce 0 pontjához)" : "Vízállás (cm)";
    out.push(`<text transform="translate(14 ${((y0 + y1) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-size="12" fill="${P.muted}">${yTitle}</text>`);
    out.push(`<path d="M${x0} ${y0}V${y1}H${x1}" stroke="${P.fg}" stroke-opacity="0.55" stroke-width="1" fill="none"/>`);
    // x tengely
    let lastLabelEnd = -1e9;
    for (const t of spec.xTicks(x0, x1, xFor)) {
      const x = xFor(t.v);
      if (x < x0 - 0.5 || x > x1 + 0.5) continue;
      out.push(`<path d="M${x.toFixed(1)} ${y1}v5" stroke="${P.fg}" stroke-opacity="0.55" fill="none"/>`);
      const w = textW(t.label);
      if (x - w / 2 > lastLabelEnd + 6 || t.major) {
        const anchor = x - w / 2 < x0 - 8 ? "start" : x + w / 2 > x1 + R - 2 ? "end" : "middle";
        out.push(`<text x="${x.toFixed(1)}" y="${y1 + 19}" text-anchor="${anchor}" font-size="12" fill="${P.muted}"${t.major ? ' font-weight="700"' : ""}>${esc(t.label)}</text>`);
        lastLabelEnd = x + w / 2;
      }
    }
    out.push(`<text x="${((x0 + x1) / 2).toFixed(1)}" y="${y1 + 38}" text-anchor="middle" font-size="12" fill="${P.muted}">${spec.xTitle}</text>`);
    return { out, geo: { x0, x1, y0, y1, yFor, xFor, W, H, L, R, narrow, legRows: rows, legY: legTop, foot, ticks: yTicks }, P };
  }

  function drawLegend(fr, o, items) {
    const out = [];
    fr.geo.legRows.forEach((row, ri) => {
      const y = fr.geo.legY + ri * 18 + 12;
      const last = row[row.length - 1];
      const start = fr.geo.x1 - (last.x + last.w - 16);   // jobbra igazítva a rajzfelület szélére
      for (const it of row) {
        const x = start + it.x;
        out.push(legendSwatch(it, x, y, fr.P, o.uid));
        out.push(`<text x="${x + (it.sw === undefined ? 24 : it.sw) + 6}" y="${y}" font-size="12" fill="${fr.P.fg}">${esc(it.t)}</text>`);
      }
    });
    return out.join("");
  }

  // Címkék ütközés-kerüléssel: items: [{x, y, lines, side: "above"|"below", align?}], a terület a rajzfelület.
  // short: keskeny rajzfelület, a címke vízszintes igazítása is változhat (közép, balra, jobbra a ponttól)
  function placeLabels(items, area, taken, short) {
    const out = [];
    const boxes = taken.slice();
    const hit = (b) => boxes.some(q => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y);
    for (const it of items) {
      const w = Math.max.apply(null, it.lines.map(s => textW(s))) + 6;
      const h = it.lines.length * 14 + 2;
      let best = null;
      const sides = it.side === "below" ? ["below", "above"] : ["above", "below"];
      const aligns = short && it.fixedX === undefined ? [0, 1, -1] : [0];
      for (const side of sides) {
        for (let k = 0; k < 6 && !best; k++) {
          for (const al of aligns) {
            if (best) break;
            const dy = (side === "above" ? -1 : 1) * (it.gap + k * 15);
            let bx = it.fixedX !== undefined ? it.fixedX - w : al === 0 ? it.x - w / 2 : al === 1 ? it.x - 4 : it.x - w + 4;
            bx = clamp(bx, area.x0 + 2, area.x1 - w - 2);
            let by = side === "above" ? it.y + dy - h : it.y + dy;
            if (by < area.y0 - 2 || by + h > area.y1 + 2) continue;
            const b = { x: bx, y: by, w, h };
            if (!hit(b)) best = b;
          }
        }
        if (best) break;
      }
      if (!best) continue;
      boxes.push(best);
      out.push({ box: best, lines: it.lines, bold: it.bold, item: it });
    }
    return out;
  }

  // A vonal mentén mintavételezett kis dobozok: a címkék ne kerüljenek a vonalra (keskeny nézetben).
  function lineBoxes(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      out.push({ x: pts[i][0] - 4, y: pts[i][1] - 4, w: 8, h: 8 });
      if (i === 0) continue;
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      const n = Math.min(Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 5), 400);
      for (let k = 1; k < n; k++) out.push({ x: pts[i - 1][0] + dx * k / n - 3, y: pts[i - 1][1] + dy * k / n - 3, w: 6, h: 6 });
    }
    return out;
  }

  // Keskeny nézetben előbb a vonalat kerülve helyez; ami így nem fér el, az a vonal-akadályok nélkül kap helyet.
  function placeAll(items, area, taken, extra, short) {
    if (!short) return placeLabels(items, area, taken, false);
    const first = placeLabels(items, area, taken.concat(extra), true);
    const done = new Set(first.map(p => p.item));
    const rest = items.filter(it => !done.has(it));
    if (!rest.length) return first;
    return first.concat(placeLabels(rest, area, taken.concat(first.map(p => p.box)), true));
  }

  function labelSvg(placed, P) {
    return placed.map(p => {
      const ts = p.lines.map((s, i) => `<tspan x="${(p.box.x + 3).toFixed(1)}" y="${(p.box.y + 12 + i * 14).toFixed(1)}"${i === 0 && p.bold ? ' font-weight="700"' : ""}>${esc(s)}</tspan>`).join("");
      return `<text font-size="12" fill="${P.fg}" stroke="${P.bg}" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke">${ts}</text>`;
    }).join("");
  }

  function timeTicks(t0, t1, pw) {
    const span = (t1 - t0) / DAY;
    const out = [];
    const mid0 = Math.ceil(t0 / DAY) * DAY;
    if (span <= 75) {
      const steps = span <= 12 ? [1, 2, 3, 4] : [1, 2, 3, 5, 7, 10, 14];
      let step = steps[steps.length - 1];
      for (const s of steps) { if (pw / span * s >= 64) { step = s; break; } }
      for (let t = mid0; t <= t1 + 1; t += step * DAY) out.push({ v: t, label: dayLabel(t) });
    } else {
      const d = new Date(t0);
      let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
      const stepsM = [1, 2, 3, 6];
      let step = 6;
      for (const s of stepsM) { if (pw / (span / 30.4) * s >= 38) { step = s; break; } }
      if (m % step !== 0 && step > 1) m = Math.ceil(m / step) * step;
      for (let k = 0; k < 40; k++) {
        const t = Date.UTC(y, m, 1);
        if (t > t1 + 1) break;
        const mm = new Date(t);
        if (t >= t0) out.push(mm.getUTCMonth() === 0 ? { v: t, label: String(mm.getUTCFullYear()), major: true } : { v: t, label: MON[mm.getUTCMonth()] });
        m += step;
      }
    }
    return out;
  }

  function drawTime(m, o) {
    const P = o.pal, data = m.data, pts = m.pts;
    const short = o.W < 600 && !o.exp;
    const legend = [{ k: "line", t: short ? "Mért" : "Mért vízállás" }];
    if (m.hasFc) legend.push({ k: "dash", t: short ? "Előrejelzés" : "Előrejelzés (reggel 7 órára)" });
    legend.push({ k: "dot", t: "Szélsőérték", sw: 20 });
    const lines = m.lines;
    if (lines.length) {
      const al = lines.filter(l => !l.limit);
      const lim = lines.find(l => l.limit);
      let txt = "";
      if (al.length) txt = "Készültségi szint: " + al.map(l => l.short + " " + l.v).join(", ") + " cm";
      if (lim) txt += (txt ? "; " : "") + lim.label;
      const out = lines.filter(l => !l.drawn).length;
      if (out) txt += " (" + (out === lines.length ? "messze a nézet felett" : "részben a nézeten kívül") + ")";
      if (short) {
        txt = al.length ? al[0].label + ": " + al[0].v + " cm" : lim ? lim.label : "";
      }
      legend.push({ k: "ref", t: txt });
    }
    let vlo = Infinity, vhi = -Infinity;
    for (const p of pts) {
      const lo = p.band ? Math.min(p.v, p.band[0]) : p.v, hi = p.band ? Math.max(p.v, p.band[1]) : p.v;
      vlo = Math.min(vlo, lo); vhi = Math.max(vhi, hi);
    }
    let yLo = vlo, yHi = vhi;
    for (const l of lines) if (l.drawn) yHi = Math.max(yHi, l.v);
    const pad = Math.max((yHi - yLo) * 0.06, 3);
    yLo -= pad + (short ? (yHi - yLo) * 0.2 : 0);   // keskeny nézetben hely a legalacsonyabb pont alatti címkének
    yHi += pad;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const fr = frame(o, {
      legend, yLo, yHi, xTitle: "Dátum (budapesti idő)",
      xFor: (x0, x1) => t => x0 + (t - t0) / Math.max(t1 - t0, 1) * (x1 - x0),
      xTicks: (x0, x1) => timeTicks(t0, t1, x1 - x0).map(t => ({ v: t.v, label: t.label, major: t.major })),
    });
    const g = fr.geo, out = fr.out;
    const X = i => g.xFor(pts[i].t), Y = i => g.yFor(pts[i].v);
    // készültségi szintek
    for (const l of lines) {
      if (!l.drawn) continue;
      const y = g.yFor(l.v);
      out.push(`<path d="M${g.x0} ${y.toFixed(1)}H${g.x1}" stroke="${P.fg}" stroke-width="1" stroke-dasharray="5 3" fill="none"/>`);
      out.push(`<text x="${g.x1 - 3}" y="${(y - 4).toFixed(1)}" text-anchor="end" font-size="12" fill="${P.fg}" stroke="${P.bg}" stroke-width="3" paint-order="stroke">${esc(l.limit ? l.label : l.label + ": " + l.v + " cm")}</text>`);
    }
    // előrejelzési sáv (ha az adat tartalmaz)
    const bandPts = pts.map((p, i) => ({ p, i })).filter(q => q.p.band);
    if (bandPts.length) {
      const lastObs = m.nObs - 1;
      const up = [`${X(lastObs).toFixed(1)},${Y(lastObs).toFixed(1)}`].concat(bandPts.map(q => `${X(q.i).toFixed(1)},${g.yFor(q.p.band[1]).toFixed(1)}`));
      const dn = bandPts.map(q => `${X(q.i).toFixed(1)},${g.yFor(q.p.band[0]).toFixed(1)}`).reverse();
      out.push(`<polygon points="${up.concat(dn).join(" ")}" fill="${P.accent}" fill-opacity="0.15"/>`);
    }
    // mért vonal
    const seg = [];
    for (let i = 0; i < m.nObs; i++) {
      const gap = i > 0 && pts[i].t - pts[i - 1].t > (pts[i].kind === "hour" ? 3 * HOUR : 3.5 * DAY);
      seg.push((i === 0 || gap ? "M" : "L") + X(i).toFixed(1) + " " + Y(i).toFixed(1));
    }
    out.push(`<path d="${seg.join("")}" stroke="${P.accent}" stroke-width="2.25" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`);
    if (m.hasFc) {
      const d = ["M" + X(m.nObs - 1).toFixed(1) + " " + Y(m.nObs - 1).toFixed(1)];
      for (let i = m.nObs; i < pts.length; i++) d.push("L" + X(i).toFixed(1) + " " + Y(i).toFixed(1));
      out.push(`<path d="${d.join("")}" stroke="${P.accent}" stroke-width="2.25" stroke-dasharray="5 4" fill="none" stroke-linejoin="round"/>`);
      const nx = X(m.nObs - 1);
      out.push(`<path d="M${nx.toFixed(1)} ${g.y0}V${g.y1}" stroke="${P.muted}" stroke-width="1" stroke-dasharray="2 3" fill="none"/>`);
    }
    if (pts.length <= 40) {
      pts.forEach((p, i) => out.push(`<circle cx="${X(i).toFixed(1)}" cy="${Y(i).toFixed(1)}" r="${p.kind === "fc" ? 2.5 : 2.25}" fill="${p.kind === "fc" ? P.bg : P.accent}" stroke="${P.accent}" stroke-width="1.25"/>`));
    }
    // "most" pont
    const ni = m.nObs - 1;
    if (pts[ni].kind === "now" || pts[ni].last) out.push(`<circle cx="${X(ni).toFixed(1)}" cy="${Y(ni).toFixed(1)}" r="5" fill="${P.accent}" stroke="${P.bg}" stroke-width="2"/>`);
    // szélsőértékek
    const items = [];
    const ext = [[m.imin, "legalacsonyabb", "below"], [m.imax, "legmagasabb", "above"]];
    if (m.imin === m.imax) ext.pop();
    for (const e of ext) {
      const p = pts[e[0]];
      out.push(`<circle cx="${X(e[0]).toFixed(1)}" cy="${Y(e[0]).toFixed(1)}" r="4" fill="${P.fg}" stroke="${P.bg}" stroke-width="1.5"/>`);
      const when = p.kind === "hour" ? dayLabel(p.t) + " " + hm(p.t) : dayLabel(p.t);
      items.push({ x: X(e[0]), y: Y(e[0]), side: e[2], gap: 8, lines: [e[1] + ": " + cmTxt(p.v), when], bold: true });
    }
    const taken = [{ x: X(ni) - 9, y: Y(ni) - 9, w: 18, h: 18 }];
    out.push(labelSvg(placeAll(items, g, taken, short ? lineBoxes(pts.map((p, i) => [X(i), Y(i)])) : [], short), P));
    out.push(drawLegend(fr, o));
    const hov = hoverGroup(P, 1);
    out.push(hov);
    g.pts = pts.map((p, i) => ({ x: X(i), ys: [Y(i)] }));
    return { svg: out, geo: g };
  }

  function hoverGroup(P, n) {
    let s = `<g class="vz-hov" visibility="hidden" pointer-events="none"><path class="vz-cross" d="M0 0V0" stroke="${P.fg}" stroke-width="1" fill="none"/>`;
    for (let i = 0; i < n; i++) s += `<circle class="vz-hdot" r="4.5" cx="0" cy="0" fill="${P.bg}" stroke="${P.fg}" stroke-width="2"/>`;
    return s + "</g>";
  }

  function yearTicks(a, b, pw) {
    const span = b - a;
    const steps = [1, 2, 5, 10, 20, 25, 50];
    let step = 50;
    for (const s of steps) { if (pw / span * s >= 46) { step = s; break; } }
    const out = [];
    for (let y = Math.ceil(a / step) * step; y <= b + 1e-9; y += step) out.push({ v: y, label: String(y) });
    return out;
  }

  function drawYears(m, o) {
    const P = o.pal, data = m.data, bk = m.buckets;
    const hasAlt = bk.some(b => b.alt), hasPartial = bk.some(b => b.partial);
    const short = o.W < 600 && !o.exp;
    const legend = [{ k: "band", t: short ? "Min-max sáv" : "Legalacsonyabb-legmagasabb napi érték" }, { k: "line", t: "Átlag" }];
    if (hasAlt) legend.push({ k: "hatch", t: short ? (data.water === "Fertő" ? "Osztrák adat" : "Balaton-átlag") : data.water === "Fertő" ? "Osztrák (burgenlandi) adat" : "A Balaton átlagos vízállása" });
    if (hasPartial) legend.push({ k: "dash", t: "Nem teljes év" });
    legend.push({ k: "dot", t: "Szélsőérték", sw: 20 });
    if (data.now) legend.push({ k: "ref", t: short ? "Ma" : "Mai vízállás" });
    const ever = data.ever;
    let vlo = Math.min.apply(null, bk.map(b => b.min)), vhi = Math.max.apply(null, bk.map(b => b.max));
    if (ever) { vlo = Math.min(vlo, ever.min[0]); vhi = Math.max(vhi, ever.max[0]); }
    if (data.now) { vlo = Math.min(vlo, data.now.cm); vhi = Math.max(vhi, data.now.cm); }
    const pad = Math.max((vhi - vlo) * 0.06, 3);
    const xa = bk[0].a, xb = bk[bk.length - 1].b + 1;
    const fr = frame(o, {
      legend, yLo: vlo - pad, yHi: vhi + pad, xTitle: "Év",
      xFor: (x0, x1) => y => x0 + (y - xa) / Math.max(xb - xa, 1) * (x1 - x0),
      xTicks: (x0, x1) => yearTicks(xa, xb, x1 - x0),
    });
    const g = fr.geo, out = fr.out;
    const cx = b => g.xFor((b.a + b.b + 1) / 2);
    out.push(`<defs><pattern id="vzh${o.uid}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V5" stroke="${P.accent}" stroke-width="1.6"/></pattern></defs>`);
    // folytonos szakaszok (hiányzó évnél megszakad); azonos forrású (alt) szakaszok külön
    const runs = [];
    bk.forEach((b, i) => {
      const prev = runs[runs.length - 1];
      if (prev && prev.alt === b.alt && b.a <= bk[i - 1].b + 1) prev.items.push(i);
      else runs.push({ alt: b.alt, items: [i] });
      if (prev && prev.alt !== b.alt && b.a <= bk[i - 1].b + 1) runs[runs.length - 1].items.unshift(i - 1);
    });
    for (const r of runs) {
      const it = r.items.map(i => bk[i]);
      const fill = r.alt ? `url(#vzh${o.uid})` : P.accent;
      const fo = r.alt ? "1" : "0.2";
      if (it.length === 1) {
        const b = it[0];
        const w = Math.max((g.x1 - g.x0) * (b.b - b.a + 1) / Math.max(xb - xa, 1), 3);
        out.push(`<rect x="${(cx(b) - w / 2).toFixed(1)}" y="${g.yFor(b.max).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(g.yFor(b.min) - g.yFor(b.max), 1).toFixed(1)}" fill="${fill}" fill-opacity="${fo}"/>`);
        continue;
      }
      const up = it.map(b => `${cx(b).toFixed(1)},${g.yFor(b.max).toFixed(1)}`);
      const dn = it.map(b => `${cx(b).toFixed(1)},${g.yFor(b.min).toFixed(1)}`).reverse();
      out.push(`<polygon points="${up.concat(dn).join(" ")}" fill="${fill}" fill-opacity="${fo}"/>`);
      out.push(`<polyline points="${up.join(" ")}" fill="none" stroke="${P.accent}" stroke-opacity="0.45" stroke-width="1"/>`);
      out.push(`<polyline points="${dn.slice().reverse().join(" ")}" fill="none" stroke="${P.accent}" stroke-opacity="0.45" stroke-width="1"/>`);
    }
    // átlag vonala (a nem teljes év szakasza szaggatott)
    const mean = bk.map(b => `${cx(b).toFixed(1)} ${g.yFor(b.mean).toFixed(1)}`);
    let solid = bk.length, dashed = false;
    if (bk[bk.length - 1].partial && bk.length > 1) { solid = bk.length - 1; dashed = true; }
    let d = "";
    bk.forEach((b, i) => {
      if (i >= solid) return;
      const gap = i > 0 && b.a > bk[i - 1].b + 1;
      d += (i === 0 || gap ? "M" : "L") + mean[i];
    });
    if (d) out.push(`<path d="${d}" stroke="${P.accent}" stroke-width="2.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`);
    if (dashed) out.push(`<path d="M${mean[solid - 1]}L${mean[solid]}" stroke="${P.accent}" stroke-width="2.5" stroke-dasharray="4 3" fill="none"/>`);
    if (bk.length <= 45) bk.forEach((b, i) => out.push(`<circle cx="${cx(b).toFixed(1)}" cy="${g.yFor(b.mean).toFixed(1)}" r="2.5" fill="${P.accent}" stroke="${P.bg}" stroke-width="1"/>`));
    // ma
    const taken = [];
    if (data.now) {
      const y = g.yFor(data.now.cm);
      out.push(`<path d="M${g.x0} ${y.toFixed(1)}H${g.x1}" stroke="${P.fg}" stroke-width="1" stroke-dasharray="5 3" fill="none"/>`);
      const lab = "ma: " + cmTxt(data.now.cm);
      const ly = y - 5 > g.y0 + 12 ? y - 5 : y + 14;
      out.push(`<text x="${g.x1 - 3}" y="${ly.toFixed(1)}" text-anchor="end" font-size="12" font-weight="700" fill="${P.fg}" stroke="${P.bg}" stroke-width="3" paint-order="stroke">${esc(lab)}</text>`);
      taken.push({ x: g.x1 - textW(lab) - 6, y: ly - 12, w: textW(lab) + 6, h: 16 });
    }
    // szélsőértékek: a valaha mért (pont vagy vonal), a nézet saját szélsőértékei
    const items = [];
    const find = year => bk.findIndex(b => year >= b.a && year <= b.b);
    const viewMin = bk.reduce((a, b) => (b.min < a.min ? b : a));
    const viewMax = bk.reduce((a, b) => (b.max > a.max ? b : a));
    const marked = [];
    const mark = (b, v, kind, label, dateTxt) => {
      const x = cx(b), y = g.yFor(v);
      out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${P.fg}" stroke="${P.bg}" stroke-width="1.5"/>`);
      items.push({ x, y, side: kind === "max" ? "above" : "below", gap: 8, lines: [label + ": " + cmTxt(v), dateTxt], bold: true });
      marked.push(kind + b.a);
    };
    const refLine = (v, kind, label, dateTxt) => {
      const y = g.yFor(v);
      out.push(`<path d="M${g.x0} ${y.toFixed(1)}H${g.x1}" stroke="${P.fg}" stroke-width="1" stroke-dasharray="2 3" fill="none"/>`);
      items.push({ x: g.x1, fixedX: g.x1 - 2, y, side: kind === "max" ? "above" : "below", gap: 3, lines: [label + ": " + cmTxt(v), dateTxt + " (a nézeten kívül)"], bold: true });
    };
    const everDone = {};
    if (ever) {
      for (const kind of ["max", "min"]) {
        const e = ever[kind];
        const yr = Number(e[1].slice(0, 4));
        const i = find(yr);
        const word = kind === "max" ? "valaha legmagasabb" : "valaha legalacsonyabb";
        const dt = isoLabel(e[1]) + (e[2] === "bgld" ? " (osztrák adat)" : "");
        if (i >= 0) { mark(bk[i], e[0], kind, word, dt); everDone[kind] = true; }
        else refLine(e[0], kind, word, dt);
      }
    }
    for (const kind of ["max", "min"]) {
      const b = kind === "max" ? viewMax : viewMin;
      const v = kind === "max" ? b.max : b.min;
      if (marked.includes(kind + b.a)) continue;
      if (ever && everDone[kind] && ever[kind][0] === v) continue;
      mark(b, v, kind, kind === "max" ? "a nézet legmagasabbja" : "a nézet legalacsonyabbja", isoLabel(kind === "max" ? b.maxD : b.minD));
    }
    const extra = short ? lineBoxes(bk.map(b => [cx(b), g.yFor(b.mean)])) : [];
    if (short && data.now) extra.push({ x: g.x0, y: g.yFor(data.now.cm) - 3, w: g.x1 - g.x0, h: 6 });
    out.push(labelSvg(placeAll(items, g, taken, extra, short), P));
    out.push(drawLegend(fr, o));
    out.push(hoverGroup(P, 3));
    g.pts = bk.map(b => ({ x: cx(b), ys: [g.yFor(b.max), g.yFor(b.mean), g.yFor(b.min)] }));
    return { svg: out, geo: g };
  }

  function buildSvg(m, o) {
    const r = m.type === "time" ? drawTime(m, o) : drawYears(m, o);
    const label = esc(o.aria);
    const svg = `<svg xmlns="${SVGNS}" viewBox="0 0 ${o.W} ${o.H}" width="${o.W}" height="${o.H}" font-family="${o.pal.font.replace(/"/g, "&quot;")}" role="img" aria-label="${label}">${r.svg.join("")}${o.exp ? `<text x="${r.geo.L}" y="${o.H - 10}" font-size="12" fill="${o.pal.muted}">${esc(SOURCE_LINE)}</text>` : ""}</svg>`;
    return { svg, geo: r.geo };
  }

  // ---- Buborék-szöveg ----
  function tipFor(m, i) {
    const data = m.data;
    if (m.type === "time") {
      const p = m.pts[i];
      let head, rows = [];
      if (p.kind === "hour") head = fullDay(p.t) + " " + hm(p.t);
      else if (p.kind === "day") head = fullDay(p.t) + " (reggeli mérés)";
      else if (p.kind === "now") head = "most (" + dayLabel(p.t) + " " + hm(p.t) + ")";
      else head = "előrejelzés: " + fullDay(p.t);
      rows.push((p.kind === "fc" ? "Előrejelzett vízállás: " : "Vízállás: ") + cmTxt(p.v));
      if (p.band) rows.push("Sáv: " + cmTxt(p.band[0]) + " és " + cmTxt(p.band[1]) + " között");
      if (i === m.imin && m.imin !== m.imax) rows.push("a nézet legalacsonyabb értéke");
      if (i === m.imax && m.imin !== m.imax) rows.push("a nézet legmagasabb értéke");
      const al = m.lines.filter(l => !l.limit);
      if (al.length) {
        let reached = null;
        for (const l of al) if (p.v >= l.v) reached = l;
        rows.push(reached ? "Készültségi szint: " + reached.label + " elérve" : "Készültségi szint: nem érte el (I. fok: " + al[0].v + " cm)");
      }
      const lim = m.lines.find(l => l.limit);
      if (lim) rows.push("Szabályozási felső határ: " + lim.v + " cm");
      return { head, rows };
    }
    const b = m.buckets[i];
    const span = b.a === b.b ? String(b.a) : b.a + "-" + b.b;
    const dt = md => (b.a === b.b ? mdLabel(md.slice(5)) : isoLabel(md));
    const rows = [
      "Legalacsonyabb: " + cmTxt(b.min) + " (" + dt(b.minD) + ")",
      "Átlag: " + cmTxt(b.mean),
      "Legmagasabb: " + cmTxt(b.max) + " (" + dt(b.maxD) + ")",
    ];
    if (b.alt) rows.push("Forrás: " + (data.water === "Fertő" ? "osztrák (burgenlandi) tószint-adat" : "a Balaton átlagos vízállása"));
    if (b.partial) rows.push("nem teljes év");
    const lnv = data.alerts && data.alerts.lnv;
    if (lnv) { const y = Number(lnv[1].slice(0, 4)); if (y >= b.a && y <= b.b) rows.push("Hivatalos legnagyobb vízállás (LNV): " + lnv[0] + " cm, " + isoLabel(lnv[1])); }
    return { head: span + (b.a !== b.b ? " (" + (b.b - b.a + 1) + " év)" : ""), rows };
  }

  // ---- Figure ----
  let uidCounter = 0;
  const FILTER_NOTE = { "8": "8 nap", "30": "30 nap", "365": "1 év", "10": "10 év", "50": "50 év", all: "összes" };

  function titleOf(data, chart) {
    return data.water + ", " + data.name + ": " + (chart === "friss" ? "vízállás" : "éves vízállás-tartomány");
  }

  function buildFigure(fig, data, opts) {
    opts = opts || {};
    if (fig._vzDestroy) fig._vzDestroy();
    const cleanups = [];
    const onDoc = fn => { document.addEventListener("pointerdown", fn); cleanups.push(() => document.removeEventListener("pointerdown", fn)); };
    const chart = fig.dataset.vzChart;
    const uid = ++uidCounter;
    const filters = chart === "friss" ? frissFilters(data) : yearsFilters(data);
    if (!filters.length) return;
    const frame = fig.querySelector(".vz-frame");
    const ctl = fig.querySelector(".vz-ctl");
    const bar = fig.querySelector(".vz-bar");
    const startKey = filters.some(f => f.key === opts.filter) ? opts.filter : chart === "friss" ? filters[0].key : "all";
    const state = { key: startKey, idx: null, model: null, geo: null };
    frame.textContent = "";
    ctl.textContent = "";
    // szűrők
    if (filters.length > 1) {
      const seg = document.createElement("div");
      seg.className = "vz-seg";
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", "Időtartam");
      for (const f of filters) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = f.label;
        b.dataset.key = f.key;
        b.setAttribute("aria-pressed", String(f.key === state.key));
        b.addEventListener("click", () => { state.key = f.key; state.idx = null; draw(); syncButtons(); });
        seg.appendChild(b);
      }
      ctl.appendChild(seg);
    }
    function syncButtons() {
      ctl.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.key === state.key)));
    }
    // tooltip és élő régió
    const tip = document.createElement("div");
    tip.className = "vz-tip";
    tip.hidden = true;
    const live = document.createElement("div");
    live.className = "vz-live";
    live.setAttribute("aria-live", "polite");
    const holder = document.createElement("div");
    holder.className = "vz-svgbox";
    frame.append(holder, tip, live);

    function make(model, o) {
      return buildSvg(model, Object.assign({ pal: SCREEN, uid: "s" + uid }, o));
    }
    function ariaText(model) {
      if (model.type === "time") {
        const p = model.pts;
        return titleOf(data, chart) + ", " + FILTER_NOTE[model.key] + ": legalacsonyabb " + cmTxt(p[model.imin].v) + ", legmagasabb " + cmTxt(p[model.imax].v) + ", most " + cmTxt(p[model.nObs - 1].v) + ". Nyilakkal léptethető.";
      }
      const b = model.buckets;
      return titleOf(data, chart) + ", " + FILTER_NOTE[model.key] + ": " + b[0].a + " és " + b[b.length - 1].b + " között. Nyilakkal léptethető.";
    }
    function draw() {
      const W = Math.round(frame.clientWidth), H = Math.round(frame.clientHeight);
      if (W < 100 || H < 100) return;
      const model = chart === "friss" ? frissModel(data, state.key) : yearsModel(data, state.key);
      if (model.type === "time" && !model.pts.length) return;
      state.model = model;
      const o = { W, H, aria: ariaText(model) };
      const r = make(model, o);
      holder.innerHTML = r.svg;
      state.geo = r.geo;
      const svg = holder.firstElementChild;
      svg.setAttribute("tabindex", "0");
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.classList.add("vz-svg");
      state.svg = svg;
      if (state.idx !== null) showAt(Math.min(state.idx, model.type === "time" ? model.pts.length - 1 : model.buckets.length - 1), false);
      else hide();
    }
    function nearest(px) {
      const pts = state.geo.pts;
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].x < px) lo = mid; else hi = mid; }
      return Math.abs(pts[lo].x - px) <= Math.abs(pts[hi].x - px) ? lo : hi;
    }
    function showAt(i, announce) {
      const g = state.geo, p = g.pts[i];
      if (!p) return;
      state.idx = i;
      const hov = state.svg.querySelector(".vz-hov");
      hov.setAttribute("visibility", "visible");
      hov.querySelector(".vz-cross").setAttribute("d", `M${p.x.toFixed(1)} ${g.y0}V${g.y1}`);
      hov.querySelectorAll(".vz-hdot").forEach((c, k) => {
        c.setAttribute("cx", p.x.toFixed(1));
        c.setAttribute("cy", (p.ys[k] === undefined ? p.ys[0] : p.ys[k]).toFixed(1));
        c.setAttribute("visibility", p.ys[k] === undefined && k > 0 ? "hidden" : "visible");
      });
      const t = tipFor(state.model, i);
      tip.innerHTML = `<strong>${esc(t.head)}</strong>` + t.rows.map(r => `<span>${esc(r)}</span>`).join("");
      tip.hidden = false;
      const w = tip.offsetWidth;
      const left = p.x + 14 + w > g.W - 4 ? p.x - 14 - w : p.x + 14;
      tip.style.left = Math.max(4, left) + "px";
      tip.style.top = (g.y0 + 6) + "px";
      if (announce) live.textContent = t.head + ". " + t.rows.join(". ");
    }
    function hide() {
      state.idx = null;
      tip.hidden = true;
      if (state.svg) { const h = state.svg.querySelector(".vz-hov"); if (h) h.setAttribute("visibility", "hidden"); }
    }
    function pos(ev) { const r = state.svg.getBoundingClientRect(); return ev.clientX - r.left; }
    holder.addEventListener("pointermove", ev => {
      if (!state.geo) return;
      if (ev.pointerType === "mouse" || ev.buttons || ev.pointerType === "pen") showAt(nearest(pos(ev)), false);
    });
    holder.addEventListener("pointerdown", ev => {
      if (!state.geo) return;
      if (ev.pointerType !== "mouse") showAt(nearest(pos(ev)), false);
    });
    holder.addEventListener("pointerleave", ev => { if (ev.pointerType === "mouse") hide(); });
    holder.addEventListener("keydown", ev => {
      if (!state.geo) return;
      const n = state.geo.pts.length;
      const cur = state.idx === null ? n - 1 : state.idx;
      let next = null;
      const big = ev.shiftKey ? 10 : 1;
      if (ev.key === "ArrowLeft") next = cur - big;
      else if (ev.key === "ArrowRight") next = cur + big;
      else if (ev.key === "PageUp") next = cur - 10;
      else if (ev.key === "PageDown") next = cur + 10;
      else if (ev.key === "Home") next = 0;
      else if (ev.key === "End") next = n - 1;
      else if (ev.key === "Escape") { hide(); return; }
      else return;
      ev.preventDefault();
      showAt(clamp(next, 0, n - 1), true);
    });
    holder.addEventListener("focusin", () => { if (state.geo && state.idx === null && !fig.matches(".is-pointer")) showAt(state.geo.pts.length - 1, true); });
    onDoc(ev => { if (!fig.contains(ev.target)) { if (state.idx !== null) hide(); } });

    // ⋯ menü
    const existingMenu = bar.querySelector(".vz-menu-wrap");
    if (existingMenu) existingMenu.remove();
    const wrap = document.createElement("div");
    wrap.className = "vz-menu-wrap";
    const mb = document.createElement("button");
    mb.type = "button";
    mb.className = "vz-menu-btn";
    mb.textContent = "⋯";
    mb.setAttribute("aria-label", "A grafikon menüje");
    mb.setAttribute("aria-haspopup", "menu");
    mb.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "vz-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    const items = [["png", "Letöltés PNG-ként"]];
    if (!opts.embed) items.push(["embed", "Beágyazás"]);
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.dataset.act = it[0];
      b.textContent = it[1];
      menu.appendChild(b);
    }
    wrap.append(mb, menu);
    bar.appendChild(wrap);
    function closeMenu(focus) {
      menu.hidden = true;
      mb.setAttribute("aria-expanded", "false");
      if (focus) mb.focus();
    }
    mb.addEventListener("click", () => {
      const open = menu.hidden;
      menu.hidden = !open;
      mb.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector("button").focus();
    });
    menu.addEventListener("keydown", ev => {
      const bs = [...menu.querySelectorAll("button")];
      const i = bs.indexOf(document.activeElement);
      if (ev.key === "ArrowDown") { ev.preventDefault(); bs[(i + 1) % bs.length].focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
      else if (ev.key === "Escape") { ev.preventDefault(); closeMenu(true); }
      else if (ev.key === "Tab") closeMenu(false);
    });
    onDoc(ev => { if (!wrap.contains(ev.target)) closeMenu(false); });
    menu.addEventListener("click", ev => {
      const b = ev.target.closest("button");
      if (!b) return;
      closeMenu(true);
      if (b.dataset.act === "png") downloadPng();
      else toggleEmbed(true);
    });

    // PNG
    function exportTitleAndSub() {
      const m = state.model;
      const stamp = data.now ? "Állás: " + fullDay(wall(Date.parse(data.now.at))) : "";
      return { title: titleOf(data, chart), subtitle: "Nézet: " + FILTER_NOTE[m.key] + (stamp ? " · " + stamp : "") };
    }
    function downloadPng() {
      const model = chart === "friss" ? frissModel(data, state.key) : yearsModel(data, state.key);
      const ts = exportTitleAndSub();
      // 800x450 logikai méret 1,5x-re nagyítva: 1200x675 képpontos, cikkbe illő PNG, olvasható betűkkel
      const r = buildSvg(model, { W: 800, H: 450, pal: PRINT, uid: "x" + uid, exp: true, title: ts.title, subtitle: ts.subtitle, aria: ts.title });
      const url = URL.createObjectURL(new Blob([r.svg], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = 1200; c.height = 675;
        const ctx2 = c.getContext("2d");
        ctx2.fillStyle = "#ffffff";
        ctx2.fillRect(0, 0, c.width, c.height);
        ctx2.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(blob => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "vizallas-" + data.slug + "-" + chart + "-" + state.key + ".png";
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        }, "image/png");
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    }

    // Beágyazás
    let embedBox = null;
    const SIZES = [["Kicsi", 480, 300], ["Közepes", 640, 400], ["Nagy", 960, 540]];
    function embedCode(w, h) {
      const src = BASE + "/beagyaz/vizallas/?allomas=" + encodeURIComponent(data.slug) + "&grafikon=" + chart + "&nezet=" + encodeURIComponent(state.key);
      return `<iframe src="${src}" width="${w}" height="${h}" style="border:0;max-width:100%" loading="lazy" title="${esc(titleOf(data, chart))}"></iframe>`;
    }
    function toggleEmbed(show) {
      if (embedBox && !show) { embedBox.hidden = true; return; }
      if (!embedBox) {
        embedBox = document.createElement("div");
        embedBox.className = "vz-embedbox";
        embedBox.setAttribute("role", "group");
        embedBox.setAttribute("aria-label", "Beágyazás");
        const name = "vz-size-" + uid;
        embedBox.innerHTML = `<p class="vz-embed-h">Beágyazás másik oldalba</p><div class="vz-seg vz-sizes" role="radiogroup" aria-label="Méret"></div>` +
          `<textarea readonly rows="3" aria-label="Beágyazó kód"></textarea>` +
          `<div class="vz-embed-act"><button type="button" class="vz-copy">Másolás</button><button type="button" class="vz-close">Bezárás</button><span class="vz-copied" aria-live="polite"></span></div>`;
        const sizes = embedBox.querySelector(".vz-sizes");
        SIZES.forEach((s, i) => {
          const lab = document.createElement("label");
          lab.innerHTML = `<input type="radio" name="${name}" value="${i}"${i === 1 ? " checked" : ""}><span>${s[0]} (${s[1]}×${s[2]})</span>`;
          sizes.appendChild(lab);
        });
        const ta = embedBox.querySelector("textarea");
        const fill = () => { const i = Number(embedBox.querySelector("input:checked").value); ta.value = embedCode(SIZES[i][1], SIZES[i][2]); };
        embedBox.addEventListener("change", fill);
        embedBox.fill = fill;
        embedBox.querySelector(".vz-close").addEventListener("click", () => { embedBox.hidden = true; mb.focus(); });
        embedBox.querySelector(".vz-copy").addEventListener("click", () => {
          const done = ok => { embedBox.querySelector(".vz-copied").textContent = ok ? "Másolva" : "Jelöld ki és másold (Ctrl+C)"; setTimeout(() => { const el = embedBox.querySelector(".vz-copied"); if (el) el.textContent = ""; }, 2500); };
          ta.select();
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(() => done(true), () => { try { done(document.execCommand("copy")); } catch (e) { done(false); } });
          else { try { done(document.execCommand("copy")); } catch (e) { done(false); } }
        });
        embedBox.addEventListener("keydown", ev => { if (ev.key === "Escape") { embedBox.hidden = true; mb.focus(); } });
        ctl.insertAdjacentElement("afterend", embedBox);
      }
      embedBox.fill();
      embedBox.hidden = false;
      embedBox.querySelector("input:checked").focus();
    }

    // átméretezés
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); });
    ro.observe(frame);
    draw();
    fig._vzRedraw = () => { if (embedBox && !embedBox.hidden) embedBox.fill(); draw(); };
    fig._vzKey = () => state.key;
    // Újraépítés (másik állomás) vagy eltávolítás előtt: figyelők, menü és beágyazó doboz leszedése.
    fig._vzDestroy = () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cleanups.forEach(fn => fn());
      wrap.remove();
      if (embedBox) embedBox.remove();
      fig.classList.remove("is-ready", "is-pointer");
      fig._vzDestroy = null; fig._vzRedraw = null; fig._vzKey = null;
    };
    holder.addEventListener("pointerenter", ev => { if (ev.pointerType === "mouse") fig.classList.add("is-pointer"); });
    holder.addEventListener("pointerleave", () => fig.classList.remove("is-pointer"));
    fig.classList.add("is-ready");
  }

  function initFigure(fig) {
    const url = fig.dataset.vzSrc;
    loadData(url).then(data => {
      buildFigure(fig, data, {});
      loadLive().then(live => { if (applyLive(data, live) && fig._vzRedraw) fig._vzRedraw(); });
    }).catch(err => { console.error(err); });
  }

  // ---- Nyilvános API: grafikon beszerelése egy tetszőleges helyre (a főoldali vízpanel is ezt használja) ----
  // mount(container, data, { chart: "friss", filter: "8"|"30"|"365", live: <rivers-snapshot>, embed: false })
  //   container: elem; ha nincs benne .vz-fig, a rajzoló létrehozza (cím, szűrősor, keret), ha van, újra felhasználja
  //   (így a hívó előre foglalhatja a keretet). data: egy data/vizallas/<slug>.json tartalma.
  //   compact: alacsonyabb keret (a főoldali panel); a helyet a CSS aspect-ratio-ja foglalja
  //   live: a worker /rivers-snapshot objektuma (generated_at, stations): a mai szint, a történet és az előrejelzés
  //   ebből frissül; ha nincs megadva, a holazeso.hu-n a rajzoló maga kéri le (egyszer oldalanként).
  // Visszaad: { destroy(), filter() }. Ugyanarra a konténerre újrahívva az előző grafikon lebomlik.
  function mount(container, data, opts) {
    opts = opts || {};
    const chart = opts.chart === "hossz" && data.years ? "hossz" : "friss";
    let fig = container.querySelector(".vz-fig");
    if (!fig) {
      fig = document.createElement("figure");
      fig.className = "vz-fig";
      fig.innerHTML = '<div class="vz-bar"><h3 class="vz-title"></h3></div><div class="vz-ctl"></div><div class="vz-frame"></div>';
      container.appendChild(fig);
    }
    fig.dataset.vzChart = chart;
    fig.classList.toggle("vz-fig-compact", !!opts.compact);
    const title = fig.querySelector(".vz-title");
    if (title) title.textContent = titleOf(data, chart);
    if (opts.live) applyLive(data, opts.live);
    buildFigure(fig, data, { embed: !!opts.embed, filter: opts.filter });
    if (!opts.live) loadLive().then(live => { if (fig._vzRedraw && applyLive(data, live)) fig._vzRedraw(); });
    return {
      destroy() { if (fig._vzDestroy) fig._vzDestroy(); },
      filter() { return fig._vzKey ? fig._vzKey() : null; },
    };
  }
  window.HolazesoVizallas = { mount };

  // ---- Térkép: a víz nevének kiírása rámutatáskor ----
  function initMap(svg) {
    const fig = svg.parentElement;
    const tip = document.createElement("div");
    tip.className = "vz-tip vz-maptip";
    tip.hidden = true;
    fig.appendChild(tip);
    // --k: képpont / viewBox-egység, hogy a felirat betűmérete a szélességtől függetlenül állandó legyen
    const setK = () => fig.style.setProperty("--k", String(Math.max(svg.getBoundingClientRect().width / 400, 0.3)));
    setK();
    if (window.ResizeObserver) new ResizeObserver(setK).observe(svg);
    svg.querySelectorAll("a[data-name]").forEach(a => {
      const t = a.querySelector("title");
      if (t) t.remove();
    });
    function show(a, ev) {
      const r = fig.getBoundingClientRect();
      tip.textContent = a.dataset.name;
      tip.hidden = false;
      const x = ev ? ev.clientX - r.left : a.getBoundingClientRect().left - r.left + a.getBoundingClientRect().width / 2;
      const y = ev ? ev.clientY - r.top : a.getBoundingClientRect().top - r.top;
      tip.style.left = clamp(x + 12, 4, r.width - tip.offsetWidth - 4) + "px";
      tip.style.top = Math.max(4, y - tip.offsetHeight - 8) + "px";
    }
    svg.addEventListener("pointermove", ev => { const a = ev.target.closest("a[data-name]"); if (a) show(a, ev); else tip.hidden = true; });
    svg.addEventListener("pointerleave", () => { tip.hidden = true; });
    svg.addEventListener("focusin", ev => { const a = ev.target.closest("a[data-name]"); if (a) show(a, null); });
    svg.addEventListener("focusout", () => { tip.hidden = true; });
  }

  // ---- Beágyazó oldal ----
  function initEmbed(root) {
    const q = new URLSearchParams(location.search);
    const slug = (q.get("allomas") || "").toLowerCase();
    let chart = q.get("grafikon") === "hossz" ? "hossz" : "friss";
    if (!/^[a-z0-9-]+$/.test(slug)) { root.textContent = "Ismeretlen állomás."; return; }
    const url = "/data/vizallas/" + slug + ".json?h=" + new Date().toISOString().slice(0, 13).replace(/\D/g, "");
    // Kis iframe-ben (pl. 480x300) a keret 200 px-es minimuma kilógatná a forrás-sort: engedjük kisebbre.
    const st = document.createElement("style");
    st.textContent = ".vz-embed .vz-frame{min-height:120px}.vz-embed-main{min-height:0}";
    document.head.appendChild(st);
    const fig = document.createElement("figure");
    fig.className = "vz-fig is-embed";
    fig.dataset.vzChart = chart;
    fig.innerHTML = '<div class="vz-bar"><h1 class="vz-title"></h1></div><div class="vz-ctl"></div><div class="vz-frame"></div>';
    root.textContent = "";
    root.appendChild(fig);
    loadData(url).then(data => {
      if (chart === "hossz" && !data.years) { chart = "friss"; fig.dataset.vzChart = "friss"; }
      fig.querySelector(".vz-title").textContent = titleOf(data, chart);
      document.title = titleOf(data, chart) + " | hol az eső?";
      buildFigure(fig, data, { embed: true, filter: q.get("nezet") });
      loadLive().then(live => { if (applyLive(data, live) && fig._vzRedraw) fig._vzRedraw(); });
    }).catch(() => { root.textContent = "A grafikon nem tölthető be."; });
  }

  function start() {
    const embed = document.getElementById("vz-embed");
    if (embed) { initEmbed(embed); return; }
    document.querySelectorAll(".vz-map").forEach(initMap);
    const figs = [...document.querySelectorAll(".vz-fig[data-vz-src]")];
    if (!figs.length) return;
    if (!("IntersectionObserver" in window)) { figs.forEach(initFigure); return; }
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); initFigure(e.target); }
    }, { rootMargin: "400px 0px" });
    figs.forEach(f => io.observe(f));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
