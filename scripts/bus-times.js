/*
 * scripts/bus-times.js — real, free, keyless UK bus journeys for the commute feature.
 *
 * Uses the UK government's Bus Open Data Service (BODS) GTFS timetable
 * (https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file/south_east/) —
 * no API key, no account. For each job it finds a real, scheduled, DIRECT bus from
 * a stop near home to a stop near the job, on a typical weekday, and returns a
 * door-to-door estimate: walk-to-stop + typical wait + scheduled ride + walk-from-stop.
 *
 * Exports computeBusTimes(home, jobs) -> { [jobId]: busResult|null }.
 * Run directly (node scripts/bus-times.js) to print results for the current jobs.json.
 *
 * Heavy step (streaming the 700 MB stop_times.txt) only runs when called for jobs
 * that don't yet have a cached bus time, so the Action isn't burdened every 10 min.
 */
const fs = require('fs');
const https = require('https');
const readline = require('readline');
const { spawn } = require('child_process');

const GTFS_URL = 'https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file/south_east/';
const ZIP = '/tmp/bods_se_gtfs.zip';
const ACCESS_MI = 0.4;          // how far we'll walk to/from a bus stop
const WALK_MPH = 3.0;           // access/egress walking pace
const MAX_WAIT = 15;            // cap the typical wait (min)

const miBetween = (a, b) => {
  const R = 3958.8, r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  return R * 2 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2));
};
const toMin = (s) => { const m = String(s).split(':'); return m.length >= 2 ? (+m[0]) * 60 + (+m[1]) : null; };
const walkMin = (miles) => Math.max(1, Math.round((miles / WALK_MPH) * 60));

function downloadIfNeeded() {
  return new Promise((resolve, reject) => {
    try { const st = fs.statSync(ZIP); if (st.size > 50e6 && (Date.now() - st.mtimeMs) < 6 * 3600e3) return resolve('cached'); } catch (e) {}
    const f = fs.createWriteStream(ZIP);
    https.get(GTFS_URL, { headers: { 'User-Agent': 'cateringjobs-bot' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error('GTFS HTTP ' + res.statusCode)); return; }
      res.pipe(f); f.on('finish', () => f.close(() => resolve('downloaded')));
    }).on('error', reject);
  });
}
function readZip(name) { // small files → full string
  return new Promise((resolve, reject) => {
    const p = spawn('unzip', ['-p', ZIP, name]); let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.on('close', () => resolve(out)); p.on('error', reject);
  });
}
function parseCsv(text) {
  const lines = text.split(/\r?\n/); const hdr = lines[0].split(',');
  const idx = {}; hdr.forEach((h, i) => { idx[h.trim()] = i; });
  return { idx, rows: lines.slice(1).filter(Boolean) };
}
function activeServices(calText, datesText, yyyymmdd, dow) {
  const active = new Set();
  const cal = parseCsv(calText), DAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dow];
  for (const ln of cal.rows) {
    const c = ln.split(','); const sid = c[cal.idx.service_id];
    if (c[cal.idx[DAY]] === '1' && c[cal.idx.start_date] <= yyyymmdd && yyyymmdd <= c[cal.idx.end_date]) active.add(sid);
  }
  if (datesText) { const cd = parseCsv(datesText);
    for (const ln of cd.rows) { const c = ln.split(','); if (c[cd.idx.date] !== yyyymmdd) continue;
      const sid = c[cd.idx.service_id]; if (c[cd.idx.exception_type] === '1') active.add(sid); else if (c[cd.idx.exception_type] === '2') active.delete(sid); } }
  return active;
}

async function computeBusTimes(home, jobs) {
  await downloadIfNeeded();

  // pick the next Wednesday (a reliably-served weekday) for the schedule
  const d = new Date(); do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 3);
  const yyyymmdd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');

  // stops near home + near each job
  const stops = parseCsv(await readZip('stops.txt'));
  const SI = stops.idx;
  const stopList = stops.rows.map((ln) => { const c = ln.split(','); return { id: c[SI.stop_id], name: (c[SI.stop_name] || '').replace(/"/g, ''), lat: +c[SI.stop_lat], lon: +c[SI.stop_lon] }; }).filter((s) => s.lat);
  const near = (pt) => stopList.map((s) => ({ s, d: miBetween(pt, s) })).filter((x) => x.d <= ACCESS_MI).sort((a, b) => a.d - b.d);
  const homeStops = near(home);
  if (!homeStops.length) return {};
  const homeAccess = {}; homeStops.forEach((x) => { homeAccess[x.s.id] = walkMin(x.d); });
  const jobStops = {}; const interesting = new Set(homeStops.map((x) => x.s.id));
  for (const j of jobs) {
    if (!j.commute || j.commute.lat == null) { jobStops[j.id] = []; continue; }
    const list = near({ lat: j.commute.lat, lon: j.commute.lon }).slice(0, 6);
    jobStops[j.id] = list.map((x) => ({ id: x.s.id, name: x.s.name, egress: walkMin(x.d) }));
    list.forEach((x) => interesting.add(x.s.id));
  }

  // trip -> {service, route}; services active that weekday; route short names
  const trips = parseCsv(await readZip('trips.txt')); const TI = trips.idx; const tripMeta = {};
  for (const ln of trips.rows) { const c = ln.split(','); tripMeta[c[TI.trip_id]] = { svc: c[TI.service_id], route: c[TI.route_id] }; }
  const services = activeServices(await readZip('calendar.txt'), await readZip('calendar_dates.txt'), yyyymmdd, 3);
  const routes = parseCsv(await readZip('routes.txt')); const RI = routes.idx; const routeName = {};
  for (const ln of routes.rows) { const c = ln.split(','); routeName[c[RI.route_id]] = (c[RI.route_short_name] || c[RI.route_long_name] || '').replace(/"/g, ''); }

  // single streaming pass over stop_times, keeping only interesting stops on active weekday trips
  const perTrip = {};
  await new Promise((resolve, reject) => {
    const p = spawn('unzip', ['-p', ZIP, 'stop_times.txt']);
    const rl = readline.createInterface({ input: p.stdout }); let hdr = null;
    rl.on('line', (ln) => {
      if (!hdr) { hdr = ln.split(','); return; }
      const c = ln.split(','); const sid = c[3];
      if (!interesting.has(sid)) return;
      const trip = c[0]; const meta = tripMeta[trip]; if (!meta || !services.has(meta.svc)) return;
      (perTrip[trip] = perTrip[trip] || []).push({ sid, arr: toMin(c[1]), dep: toMin(c[2]), seq: +c[4] });
    });
    rl.on('close', resolve); p.on('error', reject);
  });

  // for each job: fastest direct ride home-stop -> job-stop, plus frequency for wait
  const out = {};
  for (const j of jobs) {
    const js = new Map((jobStops[j.id] || []).map((s) => [s.id, s]));
    if (!js.size) { out[j.id] = null; continue; }
    let best = null; const tripDep = new Map();   // distinct trip -> earliest valid home departure
    for (const trip in perTrip) {
      const meta = tripMeta[trip]; const rows = perTrip[trip];
      const hRows = rows.filter((r) => homeAccess[r.sid] != null);
      const jRows = rows.filter((r) => js.has(r.sid));
      for (const a of hRows) for (const b of jRows) {
        if (a.seq < b.seq && a.dep != null && b.arr != null) {
          const ride = b.arr - a.dep;
          if (ride > 0 && ride < 180) {
            if (!tripDep.has(trip) || a.dep < tripDep.get(trip)) tripDep.set(trip, a.dep);
            if (!best || ride < best.ride) best = { ride, route: routeName[meta.route] || '?', fromStop: homeStops.find((x) => x.s.id === a.sid).s.name, toStop: js.get(b.sid).name, access: homeAccess[a.sid], egress: js.get(b.sid).egress };
          }
        }
      }
    }
    if (!best) { out[j.id] = null; continue; }
    // typical wait from DISTINCT daytime departures (deduped by trip)
    const day = [...tripDep.values()].filter((m) => m >= 6 * 60 && m <= 19 * 60).sort((x, y) => x - y);
    const headway = day.length > 1 ? Math.round((day[day.length - 1] - day[0]) / (day.length - 1)) : null;
    const wait = headway ? Math.max(4, Math.min(Math.round(headway / 2), MAX_WAIT)) : MAX_WAIT;
    out[j.id] = {
      rideMin: best.ride, route: best.route, fromStop: best.fromStop, toStop: best.toStop,
      accessMin: best.access, egressMin: best.egress, waitMin: wait, headwayMin: headway,
      tripsPerDay: day.length,
      busMin: best.access + wait + best.ride + best.egress,
      source: 'BODS GTFS (gov.uk) · weekday daytime',
    };
  }
  return out;
}

module.exports = { computeBusTimes };

// CLI: node scripts/bus-times.js  → compute for current jobs.json and print
if (require.main === module) {
  (async () => {
    const data = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'jobs.json'), 'utf8'));
    const HOME = { lat: 51.30824, lon: -0.791777 };
    const res = await computeBusTimes(HOME, data.jobs);
    for (const j of data.jobs) {
      const b = res[j.id]; const c = j.commute || {};
      if (!b) { console.log(`  ${(j.location || '').slice(0, 30).padEnd(30)} bus: no direct route  (walk ${c.walkMin}m / cycle ${c.cycleMin}m)`); continue; }
      const best = Math.min(c.walkMin ?? 1e9, c.cycleMin ?? 1e9, b.busMin);
      const bestMode = best === b.busMin ? 'BUS' : best === (c.cycleMin ?? 1e9) ? 'cycle' : 'walk';
      console.log(`  ${(j.location || '').slice(0, 30).padEnd(30)} BUS ${b.busMin}m (${b.accessMin}+${b.waitMin}w+${b.rideMin}ride+${b.egressMin}) route ${b.route} ${b.fromStop}→${b.toStop} | walk ${c.walkMin} cycle ${c.cycleMin} → BEST: ${bestMode}`);
    }
  })().catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
