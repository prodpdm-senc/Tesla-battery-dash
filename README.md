# Tesla Battery Dash

Petit dashboard web pour suivre la **température de la batterie** pendant le préconditionnement et la recharge rapide, avec une **estimation du temps restant** avant d'atteindre la température cible.

Données via l'API de [Tessie](https://developer.tessie.com). Page statique, sans étape de build : elle s'héberge telle quelle sur GitHub Pages.

## Ce que ça affiche

- **Graphique de température** : module min et max (bande), ligne de cible et projection pointillée jusqu'à la cible.
- **ETA** : temps restant, heure d'arrivée et plage d'incertitude.
- **Moteur arrière** (graphique du bas) : températures du stator, de l'onduleur et du dissipateur de l'unité arrière. Sur une Model 3 LFP, c'est surtout ce moteur, opéré de façon volontairement inefficace, qui chauffe le glycol puis la batterie. La puissance reste dans les jauges.
- **Jauges en barres verticales** (panneau de gauche) : tension, courant, puissance, charge (avec repère de la limite), chargeur et température extérieure, avec la valeur en texte dessous. Les grandeurs signées partent d'une ligne du zéro : vers le haut si positif, vers le bas si négatif. Les échelles fixes se modifient dans `GAUGES` (`js/app.js`).
- **États** : recharge, chauffage batterie, préconditionnement.
- **Fins de chauffe observées** (dans Réglages) : la température est notée quand le préconditionnement se termine, ou quand la puissance consommée chute alors que l'auto est stationnée et le préconditionnement encore actif. Le drapeau « chauffage batterie » ne suffit pas : il peut rester faux pendant la chauffe. Ça permet de **calibrer la vraie cible du BMS** (voir plus bas).
- **Mode démo** : préconditionnement simulé d'un pack LFP. Il sert à essayer le dashboard sans token.

## Démarrage

1. Activer GitHub Pages : *Settings → Pages → Deploy from a branch → `main` / root*.
2. Ouvrir la page, puis **Réglages** :
   - le **token** Tessie (tessie.com → Settings → API) ;
   - **Trouver** remplit le VIN automatiquement.
3. Laisser la page ouverte pendant le préconditionnement.

En local : `npm run serve`, puis http://localhost:8000.

### Le token

Le token reste dans **ce navigateur seulement** :
- par défaut en `sessionStorage`, effacé à la fermeture de l'onglet ;
- en `localStorage` si tu coches « Se souvenir ».

Il n'est jamais envoyé ailleurs qu'à l'API configurée.

### Si ça bloque (« Requête bloquée (réseau ou CORS) »)

Il faut confirmer que `api.tessie.com` accepte les appels directs depuis un navigateur. Si ce n'est pas le cas, la solution prévue est un petit proxy (par exemple un Cloudflare Worker) qui garde le token côté serveur. Il suffit ensuite de changer l'**URL de l'API** dans *Réglages → Avancé*, sans toucher au code.

## Températures du moteur (Fleet Telemetry)

Stator, onduleur et dissipateur de l'unité arrière (`DiStatorTempR`, `DiInverterTR`, `DiHeatsinkTR`, en °C).

**Pour les recevoir : activer le Profiler dans Tessie (web).** Ces valeurs n'apparaissent ni dans `/state` ni dans l'historique : elles arrivent par le **flux en direct** de Tessie (`wss://streaming.tessie.com/{VIN}`, messages `{ vin, createdAt, isResend, data: [{ key, value }] }`, seulement les champs qui ont changé). En mode Direct, le dashboard garde une connexion ouverte à ce flux (reconnexion automatique) et applique les dernières températures du moteur aux mesures, ce qui alimente le graphique « Moteur arrière » et la pastille « Moteur arr. ».

Dans *Réglages → Avancé → Moteur arrière* :

- **Vérifier** (lecture seule) : champs configurés, indicateurs (`synced`, `limit_reached`, `key_paired`…), valeurs dans l'état et l'historique.
- **Tester le flux (60 s)** : connexion, messages et champs reçus.
- **Activer ces 3 champs** : seulement utile sans le Profiler. Envoie `{ fields }` (champs actuels inchangés + les 3 du moteur) ; jamais le reste de la configuration de Tessie ; rien n'est envoyé si la configuration est illisible ou si `limit_reached` est vrai.

## Page Sessions

Bouton **Direct / Sessions** en haut. La page Sessions lit l'historique de Tessie (24 h, 7 jours ou 30 jours) et détecte :

- **Chauffes de batterie** (préconditionnement, à l'arrêt ou en roulant) : montée de la température du module le plus froid d'au moins 0,25 °C/min (régression sur une fenêtre glissante), hors recharge. Pour chacune : températures de départ et d'arrivée, durée, °C/min, température extérieure, énergie consommée (à l'arrêt seulement : en roulant, la propulsion s'y mêle), et la recharge qui a suivi. Bouton **Utiliser comme cible**.
- **Recharges rapides (DC)** : % de départ et d'arrivée, énergie ajoutée, puissance de pointe et moyenne, durée, température de la batterie au branchement. Les recharges AC (maison, pointe < 25 kW) ne sont pas affichées : la température de la batterie n'y limite pas la puissance. Leur nombre est indiqué dans le résumé de la période.
- **Graphiques** : courbes de chauffe superposées (depuis le début de chaque chauffe) et puissance de recharge selon le % de charge, colorée du bleu (batterie froide) à l'ambre (batterie chaude).

Tessie n'enregistre pas l'état « préconditionnement » : les chauffes sont déduites de la température. Sur 7 et 30 jours, les points sont demandés aux 60 s et aux 5 min pour garder la réponse légère.

À l'ouverture, la vue Direct se remplit aussi avec les dernières heures de l'historique Tessie.

## Dans la Tesla

Le navigateur de l'auto est un Chromium parfois ancien (version 79 sur certains véhicules), sans console de débogage. Le dashboard en tient compte :

- **Code compatible ES2019** : aucune syntaxe récente (`?.`, `??`, méthodes `#privées`). GitHub Actions le vérifie à chaque push.
- **Conduite à gauche** : tout ce qui se touche (boutons, sélecteur de période, graphiques, listes de sessions) est à gauche, du côté du conducteur ; les jauges en lecture seule sont à droite.
- **Tout à l'écran, sans défiler** : dès 600 px de large (navigateur de l'auto en plein écran ou non), la page remplit exactement la fenêtre. Jauges à gauche, résumé et graphiques à droite ; graphiques et barres prennent l'espace restant. Sous 600 px (téléphone), la page défile.
- **Mode auto** : détecté automatiquement (« Tesla » dans le navigateur) ou forcé avec `?auto` dans l'URL. Boutons et zones tactiles plus grands.
- **Écran tactile** : toucher un graphique affiche les valeurs ; toucher ailleurs les masque.
- **Erreurs à l'écran** : si la page ne démarre pas, un encadré rouge affiche l'erreur et la version du navigateur. Prends-le en photo pour le diagnostic.
- **Token mémorisé** : dans l'auto, « Se souvenir » est coché par défaut pour ne pas retaper le token.

### Entrer le token sans le retaper

Dans *Réglages → Avancé*, **Créer un lien de configuration** produit une URL qui contient le token et le VIN. Ouverte dans le navigateur de l'auto, elle les enregistre puis s'efface de la barre d'adresse. Ce lien est un mot de passe : ne le partage pas.

Sinon, tape le token une seule fois dans l'auto avec « Se souvenir » coché.

## Méthode de calcul de l'ETA

`js/estimator.js` est un module pur, couvert par des tests (`npm test`).

1. **Température suivie** : par défaut le **module le plus froid** (`module_temp_min`), parce que c'est lui qui limite la puissance de recharge. On peut aussi choisir la moyenne ou le max.
2. **Pente dT/dt** : régression linéaire par moindres carrés sur une **fenêtre glissante** (5 min par défaut). Le BMS rapporte la température par pas de 0,5 °C ; une simple différence entre deux points donnerait des sauts, alors que la régression lisse cette quantification.
3. **Lissage** : moyenne mobile exponentielle (α = 0,4) de la pente.
4. **ETA** = (T_cible − T_ajustée) / pente lissée.
5. **Plage** : la même formule avec la pente ± 1 erreur-type de la régression.

États possibles : *collecte de données*, *en chauffe* (avec ETA), *stable*, *refroidit*, *cible atteinte*.

## Cible de température (LFP)

**Tesla n'expose pas la température cible du préconditionnement dans l'API.** Elle est donc configurable (50 °C par défaut, **valeur à valider**).

Pour trouver la vraie valeur sur ton auto :
1. Laisse le dashboard ouvert pendant quelques préconditionnements.
2. Regarde la section *Fins de chauffe observées*, dans **Réglages**.
3. Clique **Utiliser comme cible** sur une valeur cohérente.

## Notes et limites

- **Données en cache** : Tessie sert ses données en cache (`use_cache=true`), donc l'auto n'est pas réveillée. La fraîcheur dépend de Tessie ; le statut indique « Données d'il y a X min » quand elles sont vieilles.
- **Signe du courant et de la puissance** : positif = énergie qui **sort** de la batterie (chauffage, conduite) ; négatif = recharge ou régénération. Tessie donne l'inverse ; la conversion est faite dans `js/tessie.js`.
- **Historique** : 12 h maximum, gardé localement par VIN. Il se remplit seulement quand la page est ouverte.

## Diagnostic de l'historique Tessie

*Réglages → Avancé → Tester l'historique Tessie* lit l'historique (`/{vin}/states`) sur 6 h, puis 48 h, puis 7 jours jusqu'à trouver des points (une auto endormie n'en ajoute pas), et affiche un rapport : nombre de points, intervalle réel entre les points, et champs disponibles (températures des modules, tension, courant, chauffage, etc.). Ce rapport sert à concevoir la future page « Sessions ». Il ne contient ni le token, ni le VIN, ni de position.

## Mise à jour et cache

Chaque fichier est chargé avec un numéro de version dans son adresse (`?v=11`), pour que les navigateurs (Chrome sur iPhone, navigateur de l'auto) ne gardent pas une ancienne version en mémoire. **À chaque mise en ligne, augmenter `APP_VERSION` dans `js/app.js` et les `?v=` correspondants** ; `test/version.test.mjs` échoue si un numéro est oublié. La version courante s'affiche dans *Réglages → Avancé* et en tête du rapport d'historique.

## Pistes pour la suite

- Proxy Cloudflare Worker : token secret et historique enregistré même page fermée.
- Modèle thermique du 1er ordre (exponentiel) au lieu d'une droite, plus juste près de la cible.
- Courbe de puissance de recharge en fonction du SOC et de la température.

## Structure

```
index.html          page unique
css/style.css       thème clair et sombre
js/app.js           boucle de lecture, rendu, réglages
js/tessie.js        client API et normalisation des champs
js/estimator.js     régression, EMA, ETA (pur, testé)
js/charts.js        graphiques D3
js/gauges.js        jauges en barres verticales
js/history.js       analyse de l'historique Tessie (pur, testé)
js/events.js        détection des fins de chauffe (pur, testé)
js/sessions.js      détection des chauffes et des recharges dans l'historique (pur, testé)
js/sessionsView.js  page Sessions (listes et graphiques)
js/telemetry.js     télémétrie du moteur arrière : configuration, lecture, flux (testé)
js/simulator.js     mode démo
js/store.js         stockage local (réglages, historique)
test/               tests node:test
```
