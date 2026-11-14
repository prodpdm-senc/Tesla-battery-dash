// Détection de la fin d'une chauffe de batterie. Module pur, testé.
//
// Sur certaines autos, le drapeau « chauffage batterie » reste faux pendant le
// préconditionnement (la chauffe passe probablement par les moteurs). On combine donc :
//   1. la fin d'un drapeau : chauffage ou préconditionnement passe de vrai à faux ;
//   2. une chute de puissance : préconditionnement toujours actif, auto stationnée,
//      la consommation du pack tombe d'au moins HEAT_ON_KW à au plus HEAT_OFF_KW.
// Convention : powerKw positif = énergie qui sort de la batterie.

export const HEAT_ON_KW = 4;
export const HEAT_OFF_KW = 1.5;
export const DEDUP_MS = 10 * 60000;

function parked(s) {
  const shiftOk = s.shiftState == null || s.shiftState === 'P';
  const speedOk = s.speed == null || s.speed === 0;
  return shiftOk && speedOk;
}

/**
 * @returns {null | {t:number, tempMin:number|null, tempMax:number|null, reason:string}}
 */
export function detectHeatingEnd(prev, cur, lastObs = null) {
  if (!prev || !cur) return null;
  if (lastObs && cur.t - lastObs.t < DEDUP_MS) return null;

  const wasFlag = prev.heaterOn === true || prev.preconditioning === true;
  const isFlag = cur.heaterOn === true || cur.preconditioning === true;
  let reason = null;

  if (wasFlag && !isFlag) {
    reason = prev.preconditioning === true ? 'fin du préconditionnement' : 'chauffage arrêté';
  } else if (
    cur.preconditioning === true && cur.chargingState !== 'Charging' && parked(prev) && parked(cur)
    && prev.powerKw != null && cur.powerKw != null
    && prev.powerKw >= HEAT_ON_KW && cur.powerKw <= HEAT_OFF_KW
  ) {
    reason = 'chute de puissance';
  }
  if (!reason) return null;
  // Température au moment où la chauffe s'arrête : celle du dernier point « en chauffe ».
  return { t: cur.t, tempMin: prev.tempMin, tempMax: prev.tempMax, reason };
}
