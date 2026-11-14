// Persistance locale (navigateur uniquement). Tout est enveloppé dans try/catch :
// en navigation privée ou si le stockage est bloqué, l'app fonctionne quand même.

const PREFIX = 'tbd:';
const MAX_AGE_MS = 12 * 3_600_000;
const MAX_SAMPLES = 4000;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
  catch { return false; }
}
function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignoré */ }
}

export const settings = {
  load(defaults) {
    const s = { ...defaults, ...read('settings', {}) };
    // Le token est soit en localStorage (« se souvenir »), soit en sessionStorage.
    let token = read('token', null);
    if (!token) { try { token = sessionStorage.getItem(PREFIX + 'token'); } catch { /* */ } }
    return { ...s, token: token ?? '' };
  },
  save(s) {
    const { token, ...rest } = s;
    write('settings', rest);
    remove('token');
    try { sessionStorage.removeItem(PREFIX + 'token'); } catch { /* */ }
    if (token) {
      if (rest.rememberToken) write('token', token);
      else { try { sessionStorage.setItem(PREFIX + 'token', token); } catch { /* */ } }
    }
  },
};

export const history = {
  load(vin) {
    const list = read(`hist:${vin}`, []);
    return Array.isArray(list) ? prune(list) : [];
  },
  save(vin, list) {
    let l = prune(list);
    // Si le quota est dépassé, on réduit de moitié et on réessaie.
    while (l.length && !write(`hist:${vin}`, l)) l = l.slice(Math.floor(l.length / 2));
  },
  clear(vin) { remove(`hist:${vin}`); },
};

export const observations = {
  load(vin) { return read(`obs:${vin}`, []); },
  add(vin, obs) {
    const list = [...this.load(vin), obs].slice(-20);
    write(`obs:${vin}`, list);
    return list;
  },
};

function prune(list) {
  const cutoff = Date.now() - MAX_AGE_MS;
  return list.filter((s) => s && s.t >= cutoff).slice(-MAX_SAMPLES);
}

/** Ajoute un échantillon s'il est nouveau (horodatage différent). */
export function appendSample(list, sample) {
  const last = list[list.length - 1];
  if (last && sample.t <= last.t) {
    if (sample.t === last.t) list[list.length - 1] = { ...last, ...sample };
    return false;
  }
  list.push(sample);
  return true;
}
