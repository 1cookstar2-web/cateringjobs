// functions/api/jobs.js — Cloudflare Pages Function
// GET /api/jobs?radius=10&schoolsOnly=1   (no keyword — the role set is fixed)
//
// Queries real job-board APIs (Adzuna + optional Reed), keeps only SCHOOL
// catering-assistant roles within the radius of GU14 9LJ, tracks when each
// vacancy was first seen (KV) so genuinely new jobs sort to the top as "New",
// and returns each job with its OWN individual posting URL — never a search page.
//
// Bindings (set in wrangler.toml / dashboard):
//   env.ADZUNA_APP_ID, env.ADZUNA_APP_KEY  (free: https://developer.adzuna.com)
//   env.REED_API_KEY                        (optional, free: https://www.reed.co.uk/developers)
//   env.JOBS_KV                             (KV namespace, for first-seen tracking)

const ORIGIN = { lat: 51.2845, lon: -0.7596, label: 'GU14 9LJ' }; // Farnborough (approx)
const NEW_WINDOW_MS = 36 * 60 * 60 * 1000;   // "New" if first seen within 36h
const SEEN_TTL_S = 60 * 60 * 24 * 90;        // remember a job's first-seen for 90 days

// --- relevance matching --------------------------------------------------
// We deliberately cover EVERY common title for this job family. Two building
// blocks — a "setting" word (catering/kitchen/...) and a "role" word
// (assistant/operative/porter/...) — matched in either order, plus a list of
// fixed phrases that don't fit that shape (dinner lady, school cook, ...).
const SETTING = '(?:catering|kitchen|canteen|servery|serveries|dining|food[\\s-]*service[s]?|school[\\s-]*meals?|midday[\\s-]*meals?|lunchtime|dinner|meal[\\s-]*time)';
const ROLE = '(?:assistant|asst|operative|helper|porter|staff|server|service|supervisor|team[\\s-]*member|attendant|cook|hand|worker|person|colleague|crew)';
const ROLE_RE = new RegExp(
  `\\b${SETTING}\\b[\\w\\s/&.,'()-]{0,30}\\b${ROLE}\\b` +     // "catering ... assistant"
  `|\\b${ROLE}\\b[\\w\\s/&.,'()-]{0,30}\\b${SETTING}\\b` +    // "assistant ... catering"
  `|\\b(?:dinner[\\s-]*lady|dinner[\\s-]*ladies|school[\\s-]*cook|cook[\\s-]*in[\\s-]*charge|catering[\\s-]*assistant|kitchen[\\s-]*assistant|catering[\\s-]*operative|food[\\s-]*service[s]?[\\s-]*assistant|midday[\\s-]*supervisor|lunchtime[\\s-]*supervisor)\\b`,
  'i');
// a catering-flavoured title on its own is enough (search is already scoped)
const SETTING_RE = new RegExp(`\\b${SETTING}\\b`, 'i');
const SCHOOL_RE = /(school|academy|academies|college|sixth[\s-]*form|primary|secondary|pupils?|students?|term[\s-]?time|nursery|nurseries|education[\s-]*catering|multi[\s-]?academy|\bMAT\b|\btrust\b|chartwells|caterlink|aspens|pabulum|dolce|innovate|elior|alliance in partnership|harrison catering|cucina|mellors|hc3s|twelve15|hcl education)/i;
const NEGATIVE_RE = /(head[\s-]*chef|sous[\s-]*chef|chef[\s-]*de[\s-]*partie|commis[\s-]*chef|pastry[\s-]*chef|hospital\b|care[\s-]*home|nursing[\s-]*home|restaurant[\s-]*manager|bar[\s-]*manager|barista|cabin[\s-]*crew|hotel\b)/i;

// Is this title a catering / kitchen assistant-type role? (title-based = precise)
function isCateringRole(title, desc) {
  const t = title || '';
  if (NEGATIVE_RE.test(`${t} ${desc || ''}`)) return false;
  return ROLE_RE.test(t) || SETTING_RE.test(t);
}
function isSchool(title, desc, company) {
  return SCHOOL_RE.test(`${title} ${desc} ${company}`);
}
// Mobile / roving roles are excluded entirely (mobile, relief, driver, peripatetic,
// "area catering", own-transport, covers multiple schools/sites).
const MOBILE_RE = /\b(?:mobile|peripatetic|relief|roving|roaming|driver|driving)\b|\bown\s+(?:transport|car|vehicle)\b|\barea\s+catering\b|cover(?:ing|s)?\s+(?:multiple|several|various|the\s+[\w\s]+?\s+)?(?:schools|sites|area)|across\s+(?:multiple\s+)?(?:schools|sites)|multiple\s+(?:schools|sites|kitchens)/i;
function isMobileRole(title, desc, location) {
  return MOBILE_RE.test(`${title || ''} ${desc || ''} ${location || ''}`);
}

// --- distance ------------------------------------------------------------
function haversineMiles(lat, lon) {
  if (lat == null || lon == null) return null;
  const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat - ORIGIN.lat), dLon = toRad(lon - ORIGIN.lon);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(ORIGIN.lat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.asin(Math.sqrt(a)) * 10) / 10;
}

// --- salary: try hard to get a real £/hour -------------------------------
function extractHourly(text, salaryMin) {
  if (text) {
    const m = String(text).match(/£\s*([0-9]{1,2}(?:\.[0-9]{1,2})?)\s*(?:-\s*£?\s*[0-9.]+)?\s*(?:per\s*hour|p\/?h|\/\s*hour|\/\s*hr|an?\s*hour|hourly)/i);
    if (m) return parseFloat(m[1]);
  }
  if (salaryMin != null && salaryMin > 6 && salaryMin < 60) return Math.round(salaryMin * 100) / 100;
  return null;
}

function relTime(iso, now) {
  if (!iso) return null;
  const d = Math.floor((now - Date.parse(iso)) / 86400000);
  if (isNaN(d)) return null;
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  if (d < 14) return 'last week';
  if (d < 31) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

// --- Adzuna --------------------------------------------------------------
async function fetchAdzuna(env, radiusMi) {
  if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) return [];
  const km = Math.max(1, Math.round(radiusMi * 1.60934));
  const build = (params) => {
    const u = new URL('https://api.adzuna.com/v1/api/jobs/gb/search/1');
    u.searchParams.set('app_id', env.ADZUNA_APP_ID);
    u.searchParams.set('app_key', env.ADZUNA_APP_KEY);
    u.searchParams.set('results_per_page', '50');
    u.searchParams.set('where', 'Farnborough');
    u.searchParams.set('distance', String(km));
    u.searchParams.set('content-type', 'application/json');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  };
  // Two broad passes for high recall (no single keyword can miss a variant):
  //  1) the whole Hospitality & Catering category near GU14 9LJ
  //  2) any role mentioning a catering/kitchen setting (catches school roles
  //     filed under Education/Other) — what_or matches ANY of these words.
  const urls = [
    build({ category: 'hospitality-catering-jobs' }),
    build({ what_or: 'catering kitchen canteen servery dinner lunchtime dining' }),
  ];
  const settled = await Promise.allSettled(urls.map((u) =>
    fetch(u, { cf: { cacheTtl: 300 } }).then((r) => {
      if (!r.ok) throw new Error(`Adzuna HTTP ${r.status}`);
      return r.json();
    })));
  const ok = settled.filter((s) => s.status === 'fulfilled');
  if (!ok.length) throw new Error(settled[0]?.reason?.message || 'Adzuna failed');
  return ok.flatMap((s) => s.value.results || []).map((r) => ({
    id: `adzuna:${r.id}`,
    title: r.title || '',
    employer: r.company?.display_name || 'Employer not stated',
    url: r.redirect_url,                 // individual posting (Adzuna redirector → the one vacancy)
    location: r.location?.display_name || '',
    lat: r.latitude ?? null,
    lon: r.longitude ?? null,
    desc: (r.description || '').replace(/\s+/g, ' ').trim(),
    postedISO: r.created || null,
    salaryMin: r.salary_min ?? null,
    source: 'Adzuna',
  }));
}

// --- Reed (optional) -----------------------------------------------------
async function fetchReed(env, radiusMi) {
  if (!env.REED_API_KEY) return [];
  const auth = btoa(`${env.REED_API_KEY}:`);
  // Reed matches a phrase, so query each title variant and merge.
  const terms = ['catering assistant', 'kitchen assistant', 'school catering',
    'catering operative', 'canteen assistant', 'school cook'];
  const build = (kw) => {
    const u = new URL('https://www.reed.co.uk/api/1.0/search');
    u.searchParams.set('keywords', kw);
    u.searchParams.set('locationName', 'Farnborough');
    u.searchParams.set('distanceFromLocation', String(Math.round(radiusMi)));
    u.searchParams.set('resultsToTake', '50');
    return u;
  };
  const settled = await Promise.allSettled(terms.map((kw) =>
    fetch(build(kw), { headers: { Authorization: `Basic ${auth}` } }).then((r) => {
      if (!r.ok) throw new Error(`Reed HTTP ${r.status}`);
      return r.json();
    })));
  const ok = settled.filter((s) => s.status === 'fulfilled');
  if (!ok.length) throw new Error(settled[0]?.reason?.message || 'Reed failed');
  return ok.flatMap((s) => s.value.results || []).map((r) => ({
    id: `reed:${r.jobId}`,
    title: r.jobTitle || '',
    employer: r.employerName || 'Employer not stated',
    url: r.jobUrl || `https://www.reed.co.uk/jobs/${r.jobId}`, // individual posting
    location: r.locationName || '',
    lat: null, lon: null,
    desc: (r.jobDescription || '').replace(/\s+/g, ' ').trim(),
    postedISO: r.date ? toISO(r.date) : null,
    salaryMin: r.minimumSalary ?? null,
    source: 'Reed',
  }));
}

function toISO(dmy) {
  // Reed dates come as DD/MM/YYYY
  const m = String(dmy).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}T00:00:00Z` : null;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  const qs = new URL(request.url).searchParams;
  const radius = Math.min(30, Math.max(1, Number(qs.get('radius')) || 10));
  const schoolsOnly = qs.get('schoolsOnly') !== '0';   // default ON: school catering only

  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  };

  if (!env.ADZUNA_APP_ID && !env.REED_API_KEY) {
    return new Response(JSON.stringify({
      live: false, jobs: [],
      reason: 'No job-board API keys configured. Add ADZUNA_APP_ID/ADZUNA_APP_KEY (and optionally REED_API_KEY) — see README. The page is showing its verified snapshot instead.',
    }), { headers });
  }

  // pull both sources; tolerate one failing
  const settled = await Promise.allSettled([
    fetchAdzuna(env, radius),
    fetchReed(env, radius),
  ]);
  const errors = settled.filter((s) => s.status === 'rejected').map((s) => String(s.reason));
  let raw = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));

  // dedup by url, then title+employer
  const seenKey = new Set();
  raw = raw.filter((j) => {
    const k = (j.url || '').split(/[?#]/)[0].toLowerCase() || `${j.title}|${j.employer}`.toLowerCase();
    if (seenKey.has(k)) return false;
    seenKey.add(k);
    return true;
  });

  // relevance + distance filter
  let jobs = [];
  for (const j of raw) {
    if (!isCateringRole(j.title, j.desc)) continue;             // must be a catering/kitchen role
    if (isMobileRole(j.title, j.desc, j.location)) continue;    // never include mobile / roving roles
    if (schoolsOnly && !isSchool(j.title, j.desc, j.employer)) continue;  // schools only (default)
    const distance = haversineMiles(j.lat, j.lon);
    if (distance != null && distance > radius + 0.6) continue;
    jobs.push({
      ...j,
      distanceMiles: distance,
      salaryHourly: extractHourly(`${j.title} ${j.desc}`, j.salaryMin),
    });
  }

  // first-seen tracking (KV) → drives "New" + date-seen ordering
  if (env.JOBS_KV) {
    await Promise.all(jobs.map(async (j) => {
      const k = `seen:${j.id}`;
      let firstSeen = await env.JOBS_KV.get(k);
      if (!firstSeen) {
        firstSeen = nowISO;
        context.waitUntil(env.JOBS_KV.put(k, firstSeen, { expirationTtl: SEEN_TTL_S }));
      }
      j.firstSeenISO = firstSeen;
      j.isNew = now - Date.parse(firstSeen) < NEW_WINDOW_MS;
    }));
  } else {
    jobs.forEach((j) => { j.firstSeenISO = j.postedISO || nowISO; j.isNew = false; });
  }

  // order: newest *seen* first, then newest *posted*
  jobs.sort((a, b) =>
    Date.parse(b.firstSeenISO || 0) - Date.parse(a.firstSeenISO || 0) ||
    Date.parse(b.postedISO || 0) - Date.parse(a.postedISO || 0)
  );

  const out = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    employer: j.employer,
    url: j.url,
    source: j.source,
    location: j.location,
    distanceMiles: j.distanceMiles,
    salaryHourly: j.salaryHourly,
    salaryText: j.salaryHourly ? null : 'Rate not stated by listing',
    postedDateISO: j.postedISO,
    firstSeenISO: j.firstSeenISO,
    isNew: j.isNew,
    dateLabel: j.isNew ? 'Seen today' : (relTime(j.firstSeenISO, now) ? `Seen ${relTime(j.firstSeenISO, now)}` : 'Seen recently'),
    desc: j.desc.length > 320 ? j.desc.slice(0, 317) + '…' : j.desc,
    school: true,
  }));

  return new Response(JSON.stringify({
    live: true,
    count: out.length,
    origin: ORIGIN.label,
    radius,
    fetchedAtISO: nowISO,
    sources: [...new Set(raw.map((r) => r.source))],
    errors: errors.length ? errors : undefined,
    jobs: out,
  }), { headers });
}
