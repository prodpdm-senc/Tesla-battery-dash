// Client Tessie minimal + normalisation des données en un « échantillon » plat.
// Docs : https://developer.tessie.com

export class ApiError extends Error {
  constructor(message, { status = 0, kind = 'http' } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // 'http' | 'auth' | 'network' | 'timeout'
  }
}

export class TessieClient {
  constructor({ token, baseUrl = 'https://api.tessie.com', timeoutMs = 15000 }) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async get(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new ApiError('Délai dépassé', { kind: 'timeout' });
      // Un refus CORS ou une coupure réseau arrivent ici sans détail.
      throw new ApiError(
        'Requête bloquée (réseau ou CORS). Si ça persiste, il faudra passer par un proxy — voir README.',
        { kind: 'network' });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError('Token refusé par Tessie', { status: res.status, kind: 'auth' });
    }
    if (!res.ok) {
      throw new ApiError(`Tessie a répondu ${res.status}`, { status: res.status });
    }
    return res.json();
  }

  vehicles() { return this.get('/vehicles?only_active=true'); }
  battery(vin) { return this.get(`/${encodeURIComponent(vin)}/battery`); }
  // use_cache=true : ne réveille pas l'auto.
  state(vin) { return this.get(`/${encodeURIComponent(vin)}/state?use_cache=true`); }

  /** Interroge /battery et /state en parallèle ; tolère l'échec de l'un des deux. */
  async sample(vin) {
    const [b, s] = await Promise.allSettled([this.battery(vin), this.state(vin)]);
    if (b.status === 'rejected' && s.status === 'rejected') throw b.reason;
    return normalize(
      b.status === 'fulfilled' ? b.value : null,
      s.status === 'fulfilled' ? s.value : null,
    );
  }
}

const num = (...vals) => {
  for (const v of vals) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
};
const bool = (...vals) => {
  for (const v of vals) if (typeof v === 'boolean') return v;
  return null;
};
const toMs = (t) => {
  const n = num(t);
  if (n == null) return null;
  return n < 1e12 ? n * 1000 : n; // secondes → ms
};

/** Fusionne les réponses /battery et /state en un échantillon plat. */
export function normalize(battery, state) {
  const st = state || {};
  const b = battery || {};
  const cs = st.charge_state || {};
  const cl = st.climate_state || {};
  const voltage = num(b.pack_voltage, cs.pack_voltage);
  const current = num(b.pack_current, cs.pack_current);
  return {
    t: num(toMs(b.timestamp), toMs(cs.timestamp), toMs(st.timestamp), Date.now()),
    tempMin: num(b.module_temp_min, cs.module_temp_min),
    tempMax: num(b.module_temp_max, cs.module_temp_max),
    voltage,
    current,
    // Convention à confirmer : courant positif = énergie qui entre dans la batterie.
    powerKw: voltage != null && current != null ? (voltage * current) / 1000 : null,
    soc: num(b.battery_level, cs.battery_level, cs.usable_battery_level),
    energyKwh: num(b.energy_remaining),
    chargerPowerKw: num(cs.charger_power),
    chargerVoltage: num(cs.charger_voltage),
    chargerCurrent: num(cs.charger_actual_current),
    chargingState: cs.charging_state || null,
    fastCharger: bool(cs.fast_charger_present),
    fastChargerType: cs.fast_charger_type || null,
    heaterOn: bool(cs.battery_heater_on, cl.battery_heater),
    preconditioning: bool(cl.is_preconditioning, cs.preconditioning_enabled),
    outsideTemp: num(cl.outside_temp),
    minutesToFull: num(cs.minutes_to_full_charge),
    chargeLimit: num(cs.charge_limit_soc),
    vehicleState: st.state || null,
  };
}
