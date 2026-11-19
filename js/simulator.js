// Mode démo : simule un préconditionnement puis une session de recharge rapide
// sur un pack LFP. Sert à tester l'interface sans token (et pour du b-roll).
// Modèle thermique du 1er ordre : dT/dt = (P_chauffe − k·(T − T_ext)) / C.

export class Simulator {
  constructor({ start = Date.now() - 12 * 60000, ambient = -5, initial = 8 } = {}) {
    this.t = start;
    this.T = initial;          // °C, module le plus froid
    this.S = initial + 2;      // °C, stator du moteur arrière (chauffe la batterie)
    this.ambient = ambient;
    this.soc = 22;
    this.phase = 'precond';    // precond → hold → charge → idle
    this.phaseStart = start;
  }

  /** Avance la simulation jusqu'à `now` par pas de 10 s, retourne l'échantillon. */
  step(now = Date.now()) {
    while (this.t + 10000 <= now) this._tick(10000);
    return this._sample();
  }

  /** Génère un historique pour remplir le graphique dès l'ouverture. */
  history(now = Date.now(), everyMs = 30000) {
    const out = [];
    while (this.t + everyMs <= now) {
      const target = this.t + everyMs;
      while (this.t + 10000 <= target) this._tick(10000);
      out.push(this._sample());
    }
    return out;
  }

  _tick(dt) {
    const h = dt / 3600000;
    const elapsed = (this.t - this.phaseStart) / 60000;
    const C = 0.11;                         // kWh/°C, capacité thermique approx.
    const loss = 0.05 * (this.T - this.ambient) / 10; // kW
    let heat = 0;
    if (this.phase === 'precond') {
      heat = 7;                             // kW de chauffe
      // Cible atteinte : le BMS coupe la chauffe mais le préconditionnement reste
      // « actif » quelques minutes (comme observé sur une vraie auto).
      if (this.T >= 50 || elapsed > 40) this._next('hold');
    } else if (this.phase === 'hold') {
      if (elapsed > 5) this._next('charge');
    } else if (this.phase === 'charge') {
      const p = this._chargePower();
      heat = p * 0.015;                     // pertes I²R
      this.soc = Math.min(100, this.soc + (p * h) / 0.6);
      if (this.soc >= 80) this._next('idle');
    }
    this.T += ((heat - loss) * h) / C;
    // Stator : monte vite pendant la chauffe (moteur volontairement inefficace), puis redescend vers la batterie.
    const sTarget = this.phase === 'precond' ? 85 : this.T + 4;
    this.S += (sTarget - this.S) * (this.phase === 'precond' ? 0.03 : 0.01);
    this.t += dt;
  }

  _next(phase) { this.phase = phase; this.phaseStart = this.t; }

  _chargePower() {
    const warm = Math.min(1, Math.max(0.25, (this.T - 10) / 35));
    const taper = this.soc < 50 ? 1 : Math.max(0.25, 1 - (this.soc - 50) / 40);
    return 170 * warm * taper;
  }

  _sample() {
    const noise = () => (Math.random() - 0.5) * 0.3;
    const q = (v) => Math.round(v * 2) / 2;
    const charging = this.phase === 'charge';
    const heating = this.phase === 'precond';
    const precond = heating || this.phase === 'hold';
    const pChg = charging ? this._chargePower() : 0;
    const voltage = 330 + this.soc * 0.6 + (charging ? 25 : 0) + noise();
    // Même convention que tessie.js : positif = énergie qui sort de la batterie.
    const powerKw = charging ? -pChg : heating ? 7.4 : precond ? 0.8 : 0.3;
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
      chargerCurrent: charging ? Math.round(-current) : 0,
      chargingState: charging ? 'Charging' : 'Disconnected',
      fastCharger: charging,
      fastChargerType: charging ? 'Tesla' : null,
      heaterOn: false,          // sur l'auto testée, ce drapeau reste faux pendant la chauffe
      preconditioning: precond,
      outsideTemp: this.ambient,
      statorTemp: Math.round(this.S * 10) / 10,
      heatsinkTemp: Math.round(((this.S + this.T) / 2) * 10) / 10,
      minutesToFull: null,
      chargeLimit: 80,
      vehicleState: 'online',
    };
  }
}
