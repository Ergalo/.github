// Essais du gardien des PR avec des PR fictives : node --test gardien-pr/gardien-pr.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  baseFusionnee, correspond, decider, garderDepot, ignoree, jwtApplication, lireEtat, MARQUE, ordreFile,
  preparerCle, recouvrements, rougesAnciens,
} from "./gardien-pr.mjs";

const MAINTENANT = Date.parse("2026-11-04T12:00:00Z");
const pr = (numero, extra = {}) => ({ numero, base: "main", tete: `branche-${numero}`, etiquettes: [], ...extra });
const vide = (extra) => ({
  pr: pr(1), defaut: "main", baseFusionnee: false, conflit: false, fichiersConflit: [], rouges: [],
  recouvrements: [], note: null, aujourdhui: "2026-11-04", ...extra,
});

test("base fusionnée : seulement si aucun commit d'avance et une PR fusionnée l'avait pour tête", () => {
  assert.equal(baseFusionnee({ base: "nuit/v2", defaut: "main", comparaison: { ahead_by: 0 }, fusionnee: true }), true);
  assert.equal(baseFusionnee({ base: "nuit/v2", defaut: "main", comparaison: { ahead_by: 0 }, fusionnee: false }), false);
  assert.equal(baseFusionnee({ base: "nuit/v2", defaut: "main", comparaison: { ahead_by: 2 }, fusionnee: true }), false);
  assert.equal(baseFusionnee({ base: "main", defaut: "main", comparaison: { ahead_by: 0 }, fusionnee: true }), false);
});

test("décision : base fusionnée, la PR est reciblée et la note le garde en mémoire", () => {
  const d = decider(vide({ pr: pr(306, { base: "nuit/v2-reprise" }), baseFusionnee: true }));
  assert.equal(d.recibler, true);
  assert.match(d.note, /nuit\/v2-reprise/);
  assert.match(d.note, /reciblée vers `main`/);
  assert.equal(lireEtat(d.note).historique.length, 1);
  assert.deepEqual(d.ajouter, []);
});

test("décision : conflit, étiquette a-revoir et fichiers en conflit", () => {
  const d = decider(vide({ conflit: true, fichiersConflit: ["app/page.tsx", "lib/a.ts"] }));
  assert.deepEqual(d.ajouter, ["a-revoir"]);
  assert.match(d.note, /Conflit avec `main`/);
  assert.match(d.note, /`app\/page.tsx`, `lib\/a.ts`/);
  assert.equal(lireEtat(d.note).a_revoir_pose, true);
});

test("décision : CI rouge depuis plus de 24 h", () => {
  const rouges = rougesAnciens(
    [{ name: "Vérifications", status: "completed", conclusion: "failure", completed_at: "2026-11-02T08:00:00Z" },
      { name: "Lint", status: "completed", conclusion: "success", completed_at: "2026-11-02T08:00:00Z" }],
    MAINTENANT,
  );
  assert.deepEqual(rouges, [{ nom: "Vérifications", depuis: "2026-11-02T08:00:00Z" }]);
  const d = decider(vide({ rouges }));
  assert.deepEqual(d.ajouter, ["a-revoir"]);
  assert.match(d.note, /CI rouge depuis plus de 24 h/);
});

test("CI rouge récente, ou contrôle encore en cours : rien", () => {
  assert.deepEqual(rougesAnciens([{ name: "x", status: "completed", conclusion: "failure", completed_at: "2026-11-04T08:00:00Z" }], MAINTENANT), []);
  assert.deepEqual(rougesAnciens([
    { name: "x", status: "completed", conclusion: "failure", completed_at: "2026-11-01T08:00:00Z" },
    { name: "y", status: "in_progress", conclusion: null, completed_at: null },
  ], MAINTENANT), []);
});

test("recouvrement de fichiers avec la file de fusion, et ordre de passage", () => {
  const file = ordreFile([
    { numero: 20, fichiers: ["a.ts", "b.ts"], depuis: "2026-11-04T10:00:00Z" },
    { numero: 30, fichiers: ["b.ts"], depuis: "2026-11-04T09:00:00Z" },
  ]);
  assert.deepEqual(file.map((q) => q.numero), [30, 20]);
  // PR hors de la file : les deux passent avant elle.
  const hors = recouvrements(pr(40), ["b.ts", "c.ts"], file);
  assert.deepEqual(hors, [{ numero: 30, fichiers: ["b.ts"], avant: true }, { numero: 20, fichiers: ["b.ts"], avant: true }]);
  const d = decider(vide({ pr: pr(40), recouvrements: hors }));
  assert.match(d.note, /Mêmes fichiers que #30/);
  assert.match(d.note, /#30 d'abord, puis cette PR/);
  assert.deepEqual(d.ajouter, []); // un recouvrement seul ne bloque pas
  // La 20 est derrière la 30 dans la file.
  assert.deepEqual(recouvrements(pr(20), ["a.ts", "b.ts"], file), [{ numero: 30, fichiers: ["b.ts"], avant: true }]);
  // La 30 est devant la 20.
  const r30 = recouvrements(pr(30), ["b.ts"], file);
  assert.deepEqual(r30, [{ numero: 20, fichiers: ["b.ts"], avant: false }]);
  assert.match(decider(vide({ pr: pr(30), recouvrements: r30 })).note, /cette PR d'abord/);
});

test("une seule note : rien de neuf, rien n'est réécrit ; problème réglé, a-revoir retiré s'il venait du gardien", () => {
  const premiere = decider(vide({ conflit: true }));
  const pareille = decider(vide({ conflit: true, note: premiere.note, pr: pr(1, { etiquettes: ["a-revoir"] }) }));
  assert.equal(pareille.note, null);
  assert.deepEqual(pareille.ajouter, []);
  const reglee = decider(vide({ note: premiere.note, pr: pr(1, { etiquettes: ["a-revoir"] }) }));
  assert.deepEqual(reglee.retirer, ["a-revoir"]);
  assert.match(reglee.note, /Rien à signaler/);
  // a-revoir posé par quelqu'un d'autre : on n'y touche pas.
  const autre = decider(vide({ pr: pr(1, { etiquettes: ["a-revoir"] }) }));
  assert.deepEqual(autre.retirer, []);
  assert.equal(autre.note, null);
});

test("PR laissées de côté : motifs de branche et étiquette gardien-ignore", () => {
  assert.equal(correspond("nuit/v2-emails", ["nuit/v2*"]), true);
  assert.equal(correspond("nuit/v3", ["nuit/v2*"]), false);
  assert.equal(ignoree(pr(1, { base: "nuit/v2" }), ["nuit/v2*"]), true);
  assert.equal(ignoree(pr(1, { etiquettes: ["gardien-ignore"] }), []), true);
  assert.equal(ignoree(pr(1), ["v2/rattrapage"]), false);
});

test("jeton d'application : clé collée sur une ligne remise en forme, signature valide", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const uneLigne = pem.replace(/\n/g, "\\n");
  assert.equal(preparerCle(uneLigne), pem);
  const jwt = jwtApplication(42, uneLigne, MAINTENANT);
  const [e, c, s] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(c, "base64url")).iss, "42");
  assert.equal(createVerify("RSA-SHA256").update(`${e}.${c}`).verify(publicKey, s, "base64url"), true);
  assert.throws(() => preparerCle("SHA256:abc"), /BEGIN/);
});

// ---------------------------------------------------------------------------------------------------------------
// Un dépôt fictif complet : quatre PR, une base fusionnée, un conflit, un recouvrement, une CI rouge ancienne.

function depotFictif() {
  const ecrits = [];
  const P = (number, base, head, labels = [], extra = {}) => ({
    number, base: { ref: base }, head: { ref: head, sha: `sha${number}`, repo: { owner: { login: "Ergalo" } } },
    labels: labels.map((name) => ({ name })), mergeable: true, mergeable_state: "clean", ...extra,
  });
  const prs = {
    10: P(10, "nuit/v2", "nuit/v2-cas"), // base déjà fusionnée
    11: P(11, "main", "conflit", [], { mergeable: false, mergeable_state: "dirty" }),
    12: P(12, "main", "dans-la-file", ["a-fusionner"]),
    13: P(13, "main", "recouvre"),
    14: P(14, "main", "rouge"),
    15: P(15, "nuit/v2-emails", "nuit/v2-secu-emails"), // laissée de côté
  };
  const fichiers = { 10: ["x.ts"], 11: ["app/page.tsx"], 12: ["lib/commun.ts", "y.ts"], 13: ["lib/commun.ts"], 14: ["z.ts"], 15: ["w.ts"] };
  const commentaires = { 13: [{ id: 900, user: { type: "Bot" }, body: `${MARQUE}\nancienne note` }] };
  const routes = [
    [/^\/repos\/Ergalo\/site$/, () => ({ default_branch: "main", archived: false })],
    [/^\/repos\/Ergalo\/site\/pulls\?state=open/, () => Object.values(prs)],
    [/^\/repos\/Ergalo\/site\/pulls\/(\d+)\/files/, (m) => fichiers[m[1]].map((filename) => ({ filename }))],
    [/^\/repos\/Ergalo\/site\/pulls\/(\d+)$/, (m) => prs[m[1]]],
    [/^\/repos\/Ergalo\/site\/issues\/(\d+)\/events/, () => [{ event: "labeled", label: { name: "a-fusionner" }, created_at: "2026-11-04T09:00:00Z" }]],
    [/^\/repos\/Ergalo\/site\/issues\/(\d+)\/comments/, (m) => commentaires[m[1]] ?? []],
    [/^\/repos\/Ergalo\/site\/compare\/main\.\.\.nuit%2Fv2$/, () => ({ ahead_by: 0, status: "behind" })],
    [/^\/repos\/Ergalo\/site\/compare\/main\.\.\.sha11$/, () => ({ merge_base_commit: { sha: "mb" }, files: [{ filename: "app/page.tsx" }] })],
    [/^\/repos\/Ergalo\/site\/compare\/mb\.\.\.main$/, () => ({ files: [{ filename: "app/page.tsx" }, { filename: "autre.ts" }] })],
    [/^\/repos\/Ergalo\/site\/pulls\?state=closed&head=Ergalo:nuit%2Fv2$/, () => [{ merged_at: "2026-11-03T10:00:00Z" }]],
    [/^\/repos\/Ergalo\/site\/commits\/sha14\/check-runs/, () => ({ check_runs: [{ name: "Vérifications", status: "completed", conclusion: "failure", completed_at: "2026-11-01T10:00:00Z" }] })],
    [/^\/repos\/Ergalo\/site\/commits\/sha\d+\/check-runs/, () => ({ check_runs: [{ name: "Vérifications", status: "completed", conclusion: "success", completed_at: "2026-11-04T10:00:00Z" }] })],
  ];
  const api = {
    async get(chemin) {
      for (const [re, f] of routes) {
        const m = re.exec(chemin);
        if (m) return f(m);
      }
      throw Object.assign(new Error(`route inconnue ${chemin}`), { status: 404 });
    },
    async tout(chemin) {
      return this.get(chemin);
    },
    async ecrire(methode, chemin, corps) {
      ecrits.push({ methode, chemin, corps });
      if (methode === "PATCH" && /pulls\/10$/.test(chemin)) prs[10].base.ref = corps.base;
      return {};
    },
  };
  return { api, ecrits };
}

test("passage complet sur un dépôt fictif", async () => {
  const { api, ecrits } = depotFictif();
  const journal = [];
  const r = await garderDepot(api, "Ergalo/site", { motifs: ["nuit/v2-emails*"], maintenant: MAINTENANT, pause: 0, journal: (l) => journal.push(l) });
  const quoi = (n) => ecrits.filter((e) => e.chemin.includes(`/${n}/`) || e.chemin.endsWith(`/${n}`) || e.chemin.includes(`comments/9`) && n === 13);

  // (a) reciblée vers main, avec une note
  assert.deepEqual(quoi(10)[0], { methode: "PATCH", chemin: "/repos/Ergalo/site/pulls/10", corps: { base: "main" } });
  assert.match(quoi(10).find((e) => e.methode === "POST").corps.body, /nuit\/v2/);
  // (b) conflit : a-revoir et le fichier
  assert.deepEqual(quoi(11).find((e) => e.chemin.endsWith("/labels")).corps, { labels: ["a-revoir"] });
  assert.match(quoi(11).find((e) => e.chemin.endsWith("/comments")).corps.body, /`app\/page.tsx`/);
  // (c) recouvrement : la note existante est mise à jour, pas une deuxième
  const maj13 = ecrits.filter((e) => e.chemin === "/repos/Ergalo/site/issues/comments/900");
  assert.equal(maj13.length, 1);
  assert.match(maj13[0].corps.body, /Mêmes fichiers que #12/);
  assert.equal(ecrits.filter((e) => e.chemin === "/repos/Ergalo/site/issues/13/comments").length, 0);
  // la PR de la file elle-même : rien à dire, rien d'écrit
  assert.equal(quoi(12).length, 0);
  // (d) CI rouge ancienne
  assert.match(quoi(14).find((e) => e.chemin.endsWith("/comments")).corps.body, /CI rouge depuis plus de 24 h/);
  // laissée de côté : aucune écriture
  assert.equal(quoi(15).length, 0);
  assert.equal(r.find((p) => p.numero === 15).ignoree, true);
});

test("deuxième passage sur le même état : aucun nouveau commentaire", async () => {
  const { api, ecrits } = depotFictif();
  await garderDepot(api, "Ergalo/site", { maintenant: MAINTENANT, pause: 0, journal: () => {} });
  // On rejoue en faisant comme si les notes et étiquettes écrites étaient là.
  const notes = {};
  for (const e of ecrits) {
    const m = /issues\/(\d+)\/comments$/.exec(e.chemin);
    if (m) notes[m[1]] = e.corps.body;
  }
  const { api: api2, ecrits: ecrits2 } = depotFictif();
  const get = api2.get.bind(api2);
  api2.get = async (chemin) => {
    const m = /issues\/(\d+)\/comments/.exec(chemin);
    if (m && notes[m[1]]) return [{ id: 1, user: { type: "Bot" }, body: notes[m[1]] }];
    const p = /pulls\/(\d+)$/.exec(chemin);
    const r = await get(chemin);
    if (p && ["11", "14"].includes(p[1])) return { ...r, labels: [{ name: "a-revoir" }] };
    if (/pulls\?state=open/.test(chemin)) {
      return r.map((x) => (["11", "14"].includes(String(x.number)) ? { ...x, labels: [{ name: "a-revoir" }] } : x))
        .map((x) => (x.number === 10 ? { ...x, base: { ref: "main" } } : x));
    }
    return r;
  };
  await garderDepot(api2, "Ergalo/site", { maintenant: MAINTENANT, pause: 0, journal: () => {} });
  const nouveaux = ecrits2.filter((e) => e.methode === "POST");
  assert.deepEqual(nouveaux, []);
});
