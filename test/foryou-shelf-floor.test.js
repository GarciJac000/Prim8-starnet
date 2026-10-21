/* node test/foryou-shelf-floor.test.js — the FOR YOU shelf is never empty, even after "not interested" on everything.

   Found live by the onboarding sweep (2026-10-20): on a fresh station, WORK › recipes, clicking the ✕ ("not
   interested — stop recommending this") on every FOR YOU card. The declined filter gates the INPUT pool (the
   shelf-sink law), so the row refilled from what remained — until nothing remained: after 42 declines it showed 2
   cards, after 43 one, and after the 45th (the whole catalog) the FOR YOU shelf vanished entirely. The lane law:
   hostile recommender inputs must still return something.

   Behavioral: the REAL forYouShelfHTML (lifted from marketplace.js) runs over the REAL recipe catalog and ranker,
   with only its rendering helpers stubbed. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const Recipes = require('../frontend/app/recipes.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'marketplace.js'), 'utf8');
const body = A.fnBody(src, 'function forYouShelfHTML(');
A.ok(body && body.length < 8000, 'marketplace.js has forYouShelfHTML');

function shelf(declined) {
  const fn = new Function('Recipes', 'shelfDeclined',
    "const hasRecipes = () => true, catFilter = 'all', query = '';\n"
    + "const profileApi = () => null, recommendationsReady = () => false, learnedTopics = () => [];\n"
    + "const goalText = () => '', painText = () => '', recipeVisits = () => 0;\n"
    + "const becauseText = () => '', whyGrammar = s => s, trackRecommendation = () => {};\n"
    + "const coldHead = s => '<h>' + s + '</h>', noticedHead = s => '<h>' + s + '</h>';\n"
    + "const forYouCardHTML = r => '<card data-id=\"' + r.id + '\"></card>';\n"
    + body + '\nreturn forYouShelfHTML();');
  return fn(Recipes, name => declined(name));
}
const cards = html => (String(html).match(/<card /g) || []).length;

const all = Recipes.list();
A.ok(all.length >= 3, 'the catalog has recipes to rank');

const none = shelf(() => false);
A.eq(cards(none), 3, 'nothing declined: a full row of three');

const keepTwo = new Set(all.slice(0, 2).map(r => r.name));
A.ok(cards(shelf(n => !keepTwo.has(n))) >= 1, 'two survivors still render');

const everything = shelf(() => true);
A.ok(cards(everything) >= 1, 'every recipe declined: the FOR YOU row still returns something (got ' + cards(everything) + ')');
A.ok(/passed on every recipe/.test(everything), 'and its header says why the declined library is back: ' + (everything.match(/<h>[^<]*<\/h>/) || [''])[0]);
A.ok(!/passed on every recipe/.test(none), 'the exhausted header appears only when everything was declined');

A.report('foryou-shelf-floor.test');
