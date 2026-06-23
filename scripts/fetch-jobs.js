#!/usr/bin/env node
/*
 * scripts/fetch-jobs.js — run by the GitHub Action every 10 minutes.
 *
 * Regenerates jobs.json (the data the static site polls). It:
 *   1. reads the current jobs.json as a never-empty baseline (the verified jobs),
 *   2. IF Adzuna keys are present in the environment (GitHub Action secrets — never
 *      on the live website), fetches fresh school catering/kitchen-assistant jobs,
 *   3. excludes mobile/roving roles and anything out of range or not a school role,
 *   4. preserves each job's first-seen time (so genuinely new jobs are flagged),
 *   5. writes jobs.json with a fresh generatedAtISO timestamp.
 *
 * No API key on the host: the key (if any) is read from process.env only.
 * Node 18+ (global fetch). No external dependencies.
 */
const fs = require('fs');
const path = require('path');
const { computeBusTimes } = require('./bus-times');   // free, keyless UK bus times (gov.uk BODS)

const OUT = path.join(__dirname, '..', 'jobs.json');
const ORIGIN = { lat: 51.30824, lon: -0.791777 };        // 348 Pinewood Park, GU14 9LJ (postcodes.io centroid)
const HOME_PC = 'GU14 9LJ';
const RADIUS_MI = 10;
const NEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;   // "New" = POSTED within the last 3 days

// ---- relevance (mirrors functions/api/jobs.js) ----
const SETTING = "(?:catering|kitchen|canteen|servery|serveries|dining|food[\\s-]*service[s]?|school[\\s-]*meals?|midday[\\s-]*meals?|lunchtime|dinner|meal[\\s-]*time)";
const ROLE = "(?:assistant|asst|operative|helper|porter|staff|server|service|supervisor|team[\\s-]*member|attendant|cook|hand|worker|person|colleague|crew)";
const ROLE_RE = new RegExp(`\\b${SETTING}\\b[\\w\\s/&.,'()-]{0,30}\\b${ROLE}\\b|\\b${ROLE}\\b[\\w\\s/&.,'()-]{0,30}\\b${SETTING}\\b|\\b(?:dinner[\\s-]*lady|school[\\s-]*cook|catering[\\s-]*assistant|kitchen[\\s-]*assistant|catering[\\s-]*operative)\\b`, 'i');
const SETTING_RE = new RegExp(`\\b${SETTING}\\b`, 'i');
const SCHOOL_RE = /(school|academy|academies|college|sixth[\s-]*form|primary|secondary|pupils?|students?|term[\s-]?time|nursery|education[\s-]*catering|multi[\s-]?academy|\bMAT\b|\btrust\b|chartwells|caterlink|aspens|pabulum|dolce|innovate|elior|harrison catering|cucina|mellors|hc3s)/i;
const NEGATIVE_RE = /(head[\s-]*chef|sous[\s-]*chef|chef[\s-]*de[\s-]*partie|commis[\s-]*chef|pastry[\s-]*chef|hospital\b|care[\s-]*home|nursing[\s-]*home|restaurant[\s-]*manager|bar[\s-]*manager|barista|cabin[\s-]*crew|hotel\b)/i;
const MOBILE_RE = /\b(?:mobile|peripatetic|relief|roving|roaming|driver|driving)\b|\bown\s+(?:transport|car|vehicle)\b|\barea\s+catering\b|cover(?:ing|s)?\s+(?:multiple|several|various|the\s+[\w\s]+?\s+)?(?:schools|sites|area)|across\s+(?:multiple\s+)?(?:schools|sites)|multiple\s+(?:schools|sites|kitchens)/i;

const isCateringRole = (t, d) => !NEGATIVE_RE.test(`${t} ${d || ''}`) && (ROLE_RE.test(t || '') || SETTING_RE.test(t || ''));
const isSchool = (t, d, c) => SCHOOL_RE.test(`${t} ${d} ${c}`);
const isMobile = (t, d, l) => MOBILE_RE.test(`${t || ''} ${d || ''} ${l || ''}`);

function haversineMi(lat, lon) {
  if (lat == null || lon == null) return null;
  const R = 3958.8, r = (x) => (x * Math.PI) / 180;
  const dLat = r(lat - ORIGIN.lat), dLon = r(lon - ORIGIN.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(ORIGIN.lat)) * Math.cos(r(lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.asin(Math.sqrt(a)) * 10) / 10;
}
function extractHourly(text, salaryMin) {
  const m = String(text || '').match(/£\s*([0-9]{1,2}(?:\.[0-9]{1,2})?)\s*(?:-\s*£?\s*[0-9.]+)?\s*(?:per\s*hour|p\/?h|\/\s*hour|\/\s*hr|an?\s*hour|hourly)/i);
  if (m) return parseFloat(m[1]);
  if (salaryMin != null && salaryMin > 6 && salaryMin < 60) return Math.round(salaryMin * 100) / 100;
  return null;
}
function relLabel(iso, now) {
  if (!iso) return null;
  const d = Math.floor((now - Date.parse(iso)) / 86400000);
  if (isNaN(d)) return null;
  if (d <= 0) return 'Posted today';
  if (d === 1) return 'Posted yesterday';
  if (d < 14) return `Posted ${d} days ago`;
  if (d < 31) return `Posted ${Math.floor(d / 7)} weeks ago`;
  return `Posted ${Math.floor(d / 30)} months ago`;
}

async function fetchAdzuna() {
  const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return { ok: false, jobs: [] };
  const km = Math.round(RADIUS_MI * 1.60934);
  const build = (extra) => {
    const u = new URL('https://api.adzuna.com/v1/api/jobs/gb/search/1');
    u.searchParams.set('app_id', id); u.searchParams.set('app_key', key);
    u.searchParams.set('results_per_page', '50'); u.searchParams.set('where', 'Farnborough');
    u.searchParams.set('distance', String(km)); u.searchParams.set('content-type', 'application/json');
    Object.entries(extra).forEach(([k, v]) => u.searchParams.set(k, v));
    return u;
  };
  const urls = [build({ category: 'hospitality-catering-jobs' }), build({ what_or: 'catering kitchen canteen servery dinner lunchtime dining' })];
  const out = [];
  for (const u of urls) {
    try {
      const res = await fetch(u);
      if (!res.ok) continue;
      const data = await res.json();
      for (const r of (data.results || [])) {
        out.push({
          id: `adzuna:${r.id}`, title: r.title || '', employer: r.company?.display_name || 'Employer not stated',
          url: r.redirect_url, source: 'Adzuna', location: r.location?.display_name || '',
          lat: r.latitude ?? null, lon: r.longitude ?? null,
          desc: (r.description || '').replace(/\s+/g, ' ').trim(),
          postedDateISO: r.created || null, salaryMin: r.salary_min ?? null,
        });
      }
    } catch (e) { /* tolerate */ }
  }
  return { ok: out.length > 0, jobs: out };
}

// ---- commute: real walk/cycle (keyless OSM) + optional bus (free TransportAPI key) ----
const TOWN_PC = { aldershot: 'GU11 1AA', farnborough: 'GU14 7JA', frensham: 'GU10 3AH', farnham: 'GU9 7AA', fleet: 'GU51 3AA', 'church crookham': 'GU52 6AA', camberley: 'GU15 3AA', blackwater: 'GU17 9AA', frimley: 'GU16 7AA' };
const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normPC = (p) => p.toUpperCase().replace(/\s+/g, '').replace(/(\d[A-Z]{2})$/, ' $1');

async function geocodePostcode(pc) {
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.result ? { lat: j.result.latitude, lon: j.result.longitude } : null;
  } catch (e) { return null; }
}
function jobPostcode(job) {
  const m = `${job.location || ''} ${job.desc || ''}`.match(POSTCODE_RE);
  if (m) return { pc: normPC(m[1]), approx: false };
  const loc = (job.location || '').toLowerCase();
  for (const t of Object.keys(TOWN_PC)) if (loc.includes(t)) return { pc: TOWN_PC[t], approx: true };
  return null;
}
async function osrm(profile, from, to) {
  try {
    const u = `https://routing.openstreetmap.de/routed-${profile}/route/v1/${profile}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
    const r = await fetch(u);
    if (!r.ok) return null;
    const j = await r.json();
    return (j.routes && j.routes[0]) ? Math.round(j.routes[0].duration / 60) : null;
  } catch (e) { return null; }
}
function hmsToMin(s) { const m = String(s).match(/(\d+):(\d+)(?::\d+)?/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
async function busMin(from, to) {
  const id = process.env.TRANSPORTAPI_APP_ID, key = process.env.TRANSPORTAPI_APP_KEY;
  if (!id || !key) return null;     // bus stays off until a free TransportAPI key is in Secrets
  try {
    const u = `https://transportapi.com/v3/uk/public/journey/from/lonlat:${from.lon},${from.lat}/to/lonlat:${to.lon},${to.lat}.json?app_id=${id}&app_key=${key}&service=southeast&modes=bus`;
    const r = await fetch(u);
    if (!r.ok) return null;
    const j = await r.json();
    let best = null;
    for (const rt of (j.routes || [])) { const m = rt.duration ? hmsToMin(rt.duration) : null; if (m != null && (best == null || m < best)) best = m; }
    return best;
  } catch (e) { return null; }
}
function easeLabel(min) {
  if (min == null) return null;
  if (min <= 15) return 'Very easy';
  if (min <= 30) return 'Easy';
  if (min <= 45) return 'Moderate';
  if (min <= 70) return 'Doable';
  return 'Far';
}
// recompute the best mode/time/ease across whatever modes have real data (incl. bus)
function recomputeBest(c) {
  const modes = [];
  if (c.walkMin != null) modes.push(['walk', c.walkMin]);
  if (c.cycleMin != null) modes.push(['cycle', c.cycleMin]);
  if (c.busMin != null) modes.push(['bus', c.busMin]);
  if (!modes.length) return;
  const best = modes.reduce((a, b) => (b[1] < a[1] ? b : a));
  c.bestMode = best[0]; c.bestMin = best[1]; c.ease = easeLabel(best[1]);
  c.source = c.busMin != null ? 'OpenStreetMap routing + BODS bus timetable (gov.uk)' : 'OpenStreetMap routing';
}
async function computeCommute(job) {
  const pcInfo = jobPostcode(job);
  if (!pcInfo) return null;
  const to = await geocodePostcode(pcInfo.pc);
  if (!to) return null;
  const walk = await osrm('foot', ORIGIN, to);
  const cycle = await osrm('bike', ORIGIN, to);
  const bus = await busMin(ORIGIN, to);
  const modes = [];
  if (walk != null) modes.push({ mode: 'walk', min: walk });
  if (cycle != null) modes.push({ mode: 'cycle', min: cycle });
  if (bus != null) modes.push({ mode: 'bus', min: bus });
  if (!modes.length) return null;
  const best = modes.reduce((a, b) => (b.min < a.min ? b : a));
  return {
    fromPostcode: HOME_PC, jobPostcode: pcInfo.pc, approx: pcInfo.approx,
    walkMin: walk, cycleMin: cycle, busMin: bus,
    bestMode: best.mode, bestMin: best.min, ease: easeLabel(best.min),
    source: bus != null ? 'OpenStreetMap + bus timetable' : 'OpenStreetMap routing',
    lat: to.lat, lon: to.lon,
  };
}

(async () => {
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  let baseline = { jobs: [] };
  try { baseline = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* first run */ }
  const firstSeenById = {};
  for (const j of (baseline.jobs || [])) firstSeenById[j.id || j.url] = j.firstSeenISO || j.postedDateISO || nowISO;

  const adz = await fetchAdzuna();
  let jobs;
  if (adz.ok) {
    // fresh live set, filtered + deduped
    const seen = new Set();
    jobs = [];
    for (const r of adz.jobs) {
      const k = (r.url || '').split(/[?#]/)[0].toLowerCase() || `${r.title}|${r.employer}`.toLowerCase();
      if (seen.has(k)) continue; seen.add(k);
      if (!isCateringRole(r.title, r.desc)) continue;
      if (isMobile(r.title, r.desc, r.location)) continue;
      if (!isSchool(r.title, r.desc, r.employer)) continue;
      const distanceMiles = haversineMi(r.lat, r.lon);
      if (distanceMiles != null && distanceMiles > RADIUS_MI + 0.6) continue;
      const firstSeenISO = firstSeenById[r.id] || nowISO;
      jobs.push({
        id: r.id, title: r.title, employer: r.employer, url: r.url, source: r.source,
        location: r.location, distanceMiles,
        salaryHourly: extractHourly(`${r.title} ${r.desc}`, r.salaryMin),
        salaryText: extractHourly(`${r.title} ${r.desc}`, r.salaryMin) ? null : 'Rate not stated by listing',
        postedDateISO: r.postedDateISO, firstSeenISO,
        isNew: r.postedDateISO ? (now - Date.parse(r.postedDateISO) < NEW_WINDOW_MS) : false,
        dateLabel: relLabel(r.postedDateISO, now) || 'Live — apply now',
        desc: r.desc.length > 300 ? r.desc.slice(0, 297) + '…' : r.desc, school: true,
      });
    }
    console.log(`Adzuna: ${jobs.length} school catering jobs after filtering (mobile excluded).`);
  } else {
    // no key (or no results) → keep the verified baseline, just re-stamp & recompute "new"
    jobs = (baseline.jobs || []).filter((j) => !isMobile(j.title, j.desc, j.location)).map((j) => ({
      ...j, isNew: j.postedDateISO ? (now - Date.parse(j.postedDateISO) < NEW_WINDOW_MS) : false,
    }));
    console.log(`No Adzuna key (or no results) — kept ${jobs.length} baseline jobs, refreshed timestamp.`);
  }

  // real commute times (cached per job — only compute for jobs we haven't measured yet,
  // so the free OSM/postcodes services aren't hammered every 10 minutes)
  const commuteCache = {};
  for (const j of (baseline.jobs || [])) if (j.commute) commuteCache[j.id || j.url] = j.commute;
  let computed = 0;
  for (const j of jobs) {
    const key = j.id || j.url;
    if (commuteCache[key]) { j.commute = commuteCache[key]; }
    else { j.commute = await computeCommute(j); if (j.commute) computed++; await sleep(300); }
    if (j.commute && j.commute.lat != null) j.distanceMiles = haversineMi(j.commute.lat, j.commute.lon);
  }
  console.log(`Commute: ${jobs.filter((j) => j.commute).length}/${jobs.length} jobs have times (${computed} newly computed, from ${HOME_PC}).`);

  // real bus times from gov.uk BODS (keyless). Only for jobs not yet bus-checked, in ONE
  // GTFS pass — so the heavy 700 MB stream runs only when there are genuinely new jobs.
  const needBus = jobs.filter((j) => j.commute && !j.commute.busChecked);
  if (needBus.length) {
    try {
      const busRes = await computeBusTimes(ORIGIN, jobs.filter((j) => j.commute));
      for (const j of jobs) {
        if (!j.commute || j.commute.busChecked) continue;
        const b = busRes[j.id];
        if (b) {
          j.commute.busMin = b.busMin;
          j.commute.bus = { route: b.route, rideMin: b.rideMin, fromStop: b.fromStop, toStop: b.toStop, waitMin: b.waitMin, headwayMin: b.headwayMin, source: b.source };
        }
        j.commute.busChecked = true;
        recomputeBest(j.commute);
      }
      console.log(`Bus: ${jobs.filter((j) => j.commute && j.commute.busMin != null).length}/${jobs.length} jobs have a direct bus; best mode now includes bus.`);
    } catch (e) { console.log('Bus times unavailable (kept walk/cycle):', e.message); }
  }

  // newest-seen first
  jobs.sort((a, b) => (Date.parse(b.firstSeenISO || 0) || 0) - (Date.parse(a.firstSeenISO || 0) || 0)
    || (Date.parse(b.postedDateISO || 0) || 0) - (Date.parse(a.postedDateISO || 0) || 0));

  const payload = { generatedAtISO: nowISO, origin: 'GU14 9LJ', radiusMiles: RADIUS_MI, count: jobs.length, live: adz.ok, jobs };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`Wrote ${OUT} — ${jobs.length} jobs @ ${nowISO}`);
})();
