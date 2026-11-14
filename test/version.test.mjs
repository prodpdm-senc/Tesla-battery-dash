import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Chaque fichier local (CSS, modules JS) est chargé avec ?v=<version> pour que
// les navigateurs ne gardent pas une ancienne version en cache. Ce test vérifie
// qu'aucune adresse n'oublie le numéro et qu'il est le même partout.
const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const version = /export const APP_VERSION = '(\d+)'/.exec(read('js/app.js'))[1];

test('index.html charge le CSS et app.js avec la version courante', () => {
  const html = read('index.html');
  assert.match(html, new RegExp(`href="css/style\\.css\\?v=${version}"`));
  assert.match(html, new RegExp(`src="js/app\\.js\\?v=${version}"`));
});

test('chaque import local porte ?v=<version>', () => {
  for (const f of readdirSync(new URL('js/', root)).filter((n) => n.endsWith('.js'))) {
    const src = read(`js/${f}`);
    for (const m of src.matchAll(/from '(\.\/[^']+)'/g)) {
      assert.equal(m[1].split('?v=')[1], version, `${f} importe ${m[1]} sans ?v=${version}`);
    }
  }
});
