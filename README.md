# Tesla Battery Dash

Petit dashboard web pour suivre la **température de la batterie** pendant le préconditionnement et la recharge rapide, avec une **estimation du temps restant** avant d'atteindre la température cible.

Données via l'API de [Tessie](https://developer.tessie.com). Page statique, sans étape de build : elle s'héberge telle quelle sur GitHub Pages.

## Ce que ça affiche

- **Graphique de température** : module min et max (bande), ligne de cible et projection pointillée jusqu'à la cible.
- **ETA** : temps restant, heure d'arrivée et plage d'incertitude.
- **Puissance** : pack (V × I) et chargeur, en kW.
- **Jauges en barres verticales** (panneau de gauche) : tension, courant, puissance, charge (avec repère de la limite), chargeur et température extérieure, avec la valeur en texte dessous. Les grandeurs signées partent d'une ligne du zéro : vers le haut si positif, vers le bas si négatif. Les échelles fixes se modifient dans `GAUGES` (`js/app.js`).
- **États** : recharge, chauffage batterie, préconditionnement.
- **Coupures du chauffage observées** : chaque fois que le chauffage batterie passe d'actif à inactif, la température est notée. Ça permet de **calibrer la vraie cible du BMS** (voir plus bas).
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

## Dans la Tesla

Le navigateur de l'auto est un Chromium parfois ancien (version 79 sur certains véhicules), sans console de débogage. Le dashboard en tient compte :

- **Code compatible ES2019** : aucune syntaxe récente (`?.`, `??`, méthodes `#privées`). GitHub Actions le vérifie à chaque push.
- **Mode auto** : détecté automatiquement (« Tesla » dans le navigateur) ou forcé avec `?auto` dans l'URL. Le texte et les boutons sont plus grands, et la page s'affiche en 2 colonnes sans défiler sur l'écran paysage.
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
2. Regarde la section *Coupures du chauffage observées*.
3. Clique **Utiliser comme cible** sur une valeur cohérente.

## Notes et limites

- **Données en cache** : Tessie sert ses données en cache (`use_cache=true`), donc l'auto n'est pas réveillée. La fraîcheur dépend de Tessie ; le statut indique « Données d'il y a X min » quand elles sont vieilles.
- **Signe du courant** : la convention retenue est *courant positif = énergie qui entre dans la batterie*. À confirmer sur une vraie session de recharge.
- **Historique** : 12 h maximum, gardé localement par VIN. Il se remplit seulement quand la page est ouverte.

## Diagnostic de l'historique Tessie

*Réglages → Avancé → Tester l'historique Tessie* lit l'historique (`/{vin}/states`) sur 6 h, puis 48 h, puis 7 jours jusqu'à trouver des points (une auto endormie n'en ajoute pas), et affiche un rapport : nombre de points, intervalle réel entre les points, et champs disponibles (températures des modules, tension, courant, chauffage, etc.). Ce rapport sert à concevoir la future page « Sessions ». Il ne contient ni le token, ni le VIN, ni de position.

## Pistes pour la suite

- Proxy Cloudflare Worker : token secret et historique enregistré même page fermée.
- Pré-remplir le graphique avec l'endpoint d'historique de Tessie (`/{vin}/states`).
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
js/simulator.js     mode démo
js/store.js         stockage local (réglages, historique)
test/               tests node:test
```
