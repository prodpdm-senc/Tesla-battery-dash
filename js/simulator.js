// Mode démo : simule un préconditionnement puis une session de recharge rapide
// sur un pack LFP. Sert à tester l'interface sans token (et pour du b-roll).
// Modèle thermique du 1er ordre : dT/dt = (P_chauffe − k·(T − T_ext)) / C.

export class Simulator {
  constructor({ start = Date.now() - 12 * 60_000, ambient = -5, initial = 8 } = {}) {
    this.t = start;
    this.T = initial;          // °C, module le plus froid
    this.ambient = ambient;
    this.soc = 22;
    this.phase = 'precond';    // precond → drive → charge
    this.phaseStart = start;
  }

  /** Avance la simulation jusqu'à `now` par pas de 10 s, retourne l'échantillon. */
  step(now = Date.now()) {
    while (this.t + 10_000 <= now) this.#tick(10_000);
    return this.#sample();
  }

  /** Génère un historique pour remplir le graphique dès l'ouverture. */
  history(now = Date.now(), everyMs = 30_000) {
    const out = [];
    while (this.t + everyMs <= now) {
      const target = this.t + everyMs;
      while (this.t + 10_000 <= target) this.#tick(10_000);
      out.push(this.#sample());
    }
    return out;
  }

  #tick(dt) {
    const h = dt / 3_600_000;
    const elapsed = (this.t - this.phaseStart) / 60_000;
    const C = 0.11;                         // kWh/°C, capacité thermique approx.
    const loss = 0.05 * (this.T - this.ambient) / 10; // kW
    let heat = 0;
    if (this.phase === 'precond') {
      heat = 7;                             // kW de chauffe
      if (this.T >= 50) this.#next('charge');
      else if (elapsed > 40) this.#next('charge');
    } else if (this.phase === 'charge') {
      const p = this.#chargePower();
      heat = p * 0.015;                     // pertes I²R
      this.soc = Math.min(100, this.soc + (p * h) / 0.6);
      if (this.soc >= 80) this.#next('idle');
    }
    this.T += ((heat - loss) * h) / C;
    this.t += dt;
  }

  #next(phase) { this.phase = phase; this.phaseStart = this.t; }

  #chargePower() {
    const warm = Math.min(1, Math.max(0.25, (this.T - 10) / 35));
    const taper = this.soc < 50 ? 1 : Math.max(0.25, 1 - (this.soc - 50) / 40);
    return 170 * warm * taper;
  }

  #sample() {
    const noise = () => (Math.random() - 0.5) * 0.3;
    const q = (v) => Math.round(v * 2) / 2;
    const charging = this.phase === 'charge';
    const heating = this.phase === 'precond';
    const pChg = charging ? this.#chargePower() : 0;
    const voltage = 330 + this.soc * 0.6 + (charging ? 25 : 0) + noise();
    const powerKw = charging ? pChg : heating ? -7.4 : -0.3;
    const current = (powerKw * 1000) / voltage;
    return {
      t: this.t,
      tempMin: q(this.T + noise()),
      tempMax: q(this.T + 1.5 + noise()),
      voltage,
      current,
      powerKw,
      soc: Math.round(this.soc),
      energyKwh: +(this.soc * 0.6).toFixed(1),
      chargerPowerKw: charging ? Math.round(pChg) : 0,
      chargerVoltage: charging ? Math.round(voltage) : 0,
      chargerCurrent: charging ? Math.round(current) : 0,
      chargingState: charging ? 'Charging' : 'Disconnected',
      fastCharger: charging,
      fastChargerType: charging ? 'Tesla' : null,
      heaterOn: heating,
      preconditioning: heating,
      outsideTemp: this.ambient,
      minutesToFull: null,
      chargeLimit: 80,
      vehicleState: 'online',
    };
  }
}
