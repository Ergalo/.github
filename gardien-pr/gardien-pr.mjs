// Gardien des PR (commun à tous les dépôts de l'organisation Ergalo). Sans IA : seulement l'API GitHub.
//
// Constat du 04/11 sur site : 13 PR ouvertes, dont six visaient des branches intermédiaires (nuit/v2…) déjà
// fusionnées dans main et jamais supprimées (R-47, R-48) : elles ne pouvaient plus arriver. D'autres restaient
// rouges ou en conflit des jours sans que personne le voie. Pour chaque PR ouverte, le gardien :
//   (a) base déjà fusionnée dans la branche par défaut : recible la PR vers celle-ci et le note ;
//   (b) conflit avec sa base : étiquette « a-revoir » et liste des fichiers modifiés des deux côtés ;
//   (c) une autre PR étiquetée « a-fusionner » touche les mêmes fichiers : le dit, avec l'ordre de passage conseillé ;
//   (d) CI rouge depuis plus de 24 h : étiquette « a-revoir » et le dit ;
//   (e) une seule note par PR, mise à jour sur place (jamais deux fois la même chose).
// L'étiquette « a-revoir » n'est retirée que si c'est le gardien qui l'a posée et que le problème a disparu.
// Il ne lance jamais le code d'une PR et ne touche ni à « a-fusionner » ni à « fusion-bloquee » (la file de fusion).
//
//   node gardien-pr/gardien-pr.mjs                (dépôts : GARDIEN_DEPOTS="Ergalo/site,Ergalo/integrations"
//                                                   ou GARDIEN_PORTEE=organisation, tous les dépôts de l'application)
// Jeton : FUSION_APP_ID + FUSION_APP_PRIVATE_KEY (application ergalo-fusion, fabriqué ici), sinon GH_TOKEN.
// GARDIEN_ESSAI=1 : n'écrit rien, dit seulement ce qu'il ferait. GARDIEN_IGNORER : motifs de branches (tête ou
// base) à laisser de côté, séparés par des virgules, « * » en fin de motif ; l'étiquette « gardien-ignore » aussi.

import { createSign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MARQUE = "<!-- gardien-pr -->";
export const ETIQUETTE_A_REVOIR = "a-revoir";
export const ETIQUETTE_FILE = "a-fusionner";
export const ETIQUETTE_IGNORE = "gardien-ignore";
export const DELAI_ROUGE_MS = 24 * 3600 * 1000;
const ECHECS = new Set(["failure", "timed_out", "startup_failure"]);

// ---------------------------------------------------------------------------------------------------------------
// Logique pure (testée sans réseau)

/** Vrai si la branche correspond à l'un des motifs (« nuit/v2* » ou nom exact). */
export function correspond(branche, motifs) {
  return motifs.some((m) => (m.endsWith("*") ? branche.startsWith(m.slice(0, -1)) : branche === m));
}

export function motifsIgnores(texte) {
  return (texte ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** La PR est-elle laissée de côté (étiquette gardien-ignore, ou tête ou base dans les motifs) ? */
export function ignoree(pr, motifs) {
  return pr.etiquettes.includes(ETIQUETTE_IGNORE) || correspond(pr.tete, motifs) || correspond(pr.base, motifs);
}

/**
 * La base est-elle déjà entièrement dans la branche par défaut ? `comparaison` : résultat de compare(defaut...base)
 * ({ ahead_by }) ; `fusionnee` : une PR fusionnée avait cette base pour tête. Les deux sont exigés : une branche
 * fraîche, sans commit, ne doit pas être prise pour une branche déjà fusionnée.
 */
export function baseFusionnee({ base, defaut, comparaison, fusionnee }) {
  if (base === defaut) return false;
  return Boolean(comparaison && comparaison.ahead_by === 0 && fusionnee);
}

/** Contrôles rouges depuis plus de 24 h sur le dernier commit, sans contrôle encore en cours. */
export function rougesAnciens(checks, maintenant) {
  if (checks.some((c) => c.status !== "completed")) return [];
  return checks
    .filter((c) => ECHECS.has(c.conclusion) && c.completed_at && maintenant - Date.parse(c.completed_at) > DELAI_ROUGE_MS)
    .map((c) => ({ nom: c.name, depuis: c.completed_at }));
}

/**
 * Recouvrements avec les PR de la file. `file` : [{ numero, fichiers, depuis }] (depuis : date de pose de
 * « a-fusionner », ou null), déjà triée dans l'ordre de passage. Rend [{ numero, fichiers, avant }] où `avant` dit
 * si l'autre PR passe avant celle-ci.
 */
export function recouvrements(pr, fichiers, file) {
  const miens = new Set(fichiers);
  const ma_place = file.findIndex((q) => q.numero === pr.numero);
  const trouves = [];
  file.forEach((q, i) => {
    if (q.numero === pr.numero) return;
    const communs = q.fichiers.filter((f) => miens.has(f));
    if (!communs.length) return;
    trouves.push({ numero: q.numero, fichiers: communs, avant: ma_place === -1 || i < ma_place });
  });
  return trouves;
}

/** Ordre de la file : date de pose de « a-fusionner », sinon numéro. */
export function ordreFile(file) {
  return [...file].sort((a, b) => {
    if (a.depuis && b.depuis && a.depuis !== b.depuis) return a.depuis < b.depuis ? -1 : 1;
    if (a.depuis && !b.depuis) return -1;
    if (!a.depuis && b.depuis) return 1;
    return a.numero - b.numero;
  });
}

function liste(fichiers, max = 15) {
  const montres = fichiers.slice(0, max).map((f) => `\`${f}\``).join(", ");
  return fichiers.length > max ? `${montres} et ${fichiers.length - max} autres` : montres;
}

/** Lit l'état caché d'une note existante. */
export function lireEtat(corps) {
  const m = /<!-- gardien-pr-etat: (\{.*?\}) -->/s.exec(corps ?? "");
  if (!m) return { a_revoir_pose: false, historique: [] };
  try {
    const e = JSON.parse(m[1]);
    return { a_revoir_pose: Boolean(e.a_revoir_pose), historique: Array.isArray(e.historique) ? e.historique : [] };
  } catch {
    return { a_revoir_pose: false, historique: [] };
  }
}

/**
 * Décide pour une PR. Entrée : { pr: { numero, base, tete, etiquettes }, defaut, baseFusionnee, conflit,
 * fichiersConflit, rouges, recouvrements, note (corps existant ou null), aujourdhui (AAAA-MM-JJ) }.
 * Sortie : { recibler, ajouter: [], retirer: [], note: corps à écrire ou null (rien à changer) }.
 */
export function decider(e) {
  const etat = lireEtat(e.note);
  const historique = [...etat.historique];
  const sortie = { recibler: false, ajouter: [], retirer: [], note: null };
  const points = [];

  let base = e.pr.base;
  if (e.baseFusionnee) {
    sortie.recibler = true;
    historique.push(`${e.aujourdhui} : la base \`${base}\` était déjà fusionnée dans \`${e.defaut}\` ; PR reciblée vers \`${e.defaut}\`.`);
    base = e.defaut;
  }
  if (e.conflit) {
    points.push(
      `**Conflit avec \`${base}\`** : la PR ne peut pas être fusionnée telle quelle.` +
        (e.fichiersConflit?.length ? ` Fichiers modifiés des deux côtés : ${liste(e.fichiersConflit)}.` : "") +
        ` À faire : remettre la branche à jour sur \`${base}\` et résoudre le conflit, puis reposer \`${ETIQUETTE_FILE}\`.`,
    );
  }
  for (const r of e.rouges) {
    points.push(`**CI rouge depuis plus de 24 h** : « ${r.nom} » a échoué le ${r.depuis.slice(0, 10)} et rien n'a été relancé depuis. À faire : corriger, ou fermer la PR si elle n'a plus lieu d'être.`);
  }
  for (const r of e.recouvrements) {
    const ordre = r.avant
      ? `Ordre conseillé : #${r.numero} d'abord, puis cette PR, remise à jour sur \`${e.defaut}\` après sa fusion.`
      : `Ordre conseillé : cette PR d'abord (elle est avant dans la file), puis #${r.numero}, qui sera remise à jour.`;
    points.push(`**Mêmes fichiers que #${r.numero}**, qui est dans la file de fusion : ${liste(r.fichiers)}. ${ordre}`);
  }

  const aRevoir = Boolean(e.conflit || e.rouges.length);
  const porte = e.pr.etiquettes.includes(ETIQUETTE_A_REVOIR);
  let pose = etat.a_revoir_pose;
  if (aRevoir) {
    if (!porte) sortie.ajouter.push(ETIQUETTE_A_REVOIR);
    if (!porte) pose = true;
  } else if (porte && etat.a_revoir_pose) {
    sortie.retirer.push(ETIQUETTE_A_REVOIR);
    pose = false;
  }

  if (!points.length && !historique.length && e.note == null) return sortie; // rien à dire, aucune note : on se tait
  const lignes = [MARQUE, "### Gardien des PR", ""];
  if (points.length) lignes.push(...points.map((p) => `- ${p}`));
  else lignes.push("Rien à signaler pour l'instant.");
  if (historique.length) lignes.push("", "Fait par le gardien :", ...historique.map((h) => `- ${h}`));
  lignes.push("", "_Note tenue à jour automatiquement à chaque changement de la PR et une fois par heure._");
  lignes.push(`<!-- gardien-pr-etat: ${JSON.stringify({ a_revoir_pose: pose, historique })} -->`);
  const corps = lignes.join("\n");
  if (corps !== e.note) sortie.note = corps;
  return sortie;
}

// ---------------------------------------------------------------------------------------------------------------
// Accès à GitHub

export function preparerCle(brute) {
  let cle = (brute ?? "").replace(/\r/g, "").replace(/\\n/g, "\n").trim();
  const m = /-----BEGIN ([A-Z ]+)-----\s*([\s\S]*?)\s*-----END \1-----/.exec(cle);
  if (!m) throw new Error("clé de l'application illisible (lignes BEGIN et END introuvables)");
  const corps = m[2].replace(/\s+/g, "");
  cle = `-----BEGIN ${m[1]}-----\n${corps.match(/.{1,64}/g).join("\n")}\n-----END ${m[1]}-----\n`;
  return cle;
}

function b64url(texte) {
  return Buffer.from(texte).toString("base64url");
}

export function jwtApplication(appId, cle, maintenant = Date.now()) {
  const t = Math.floor(maintenant / 1000);
  const entete = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const charge = b64url(JSON.stringify({ iat: t - 60, exp: t + 540, iss: String(appId) }));
  const signe = createSign("RSA-SHA256").update(`${entete}.${charge}`).sign(preparerCle(cle), "base64url");
  return `${entete}.${charge}.${signe}`;
}

export function clientGitHub(jeton, { fetchFn = fetch, racine = "https://api.github.com", essai = false } = {}) {
  async function appel(methode, chemin, corps) {
    if (essai && methode !== "GET") {
      console.log(`  [essai] ${methode} ${chemin}${corps ? " " + JSON.stringify(corps).slice(0, 200) : ""}`);
      return null;
    }
    const url = chemin.startsWith("http") ? chemin : racine + chemin;
    for (let tentative = 1; ; tentative++) {
      const r = await fetchFn(url, {
        method: methode,
        headers: {
          authorization: `Bearer ${jeton}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "ergalo-gardien-pr",
          ...(corps ? { "content-type": "application/json" } : {}),
        },
        body: corps ? JSON.stringify(corps) : undefined,
      });
      if (r.status >= 500 && tentative < 3) continue;
      const texte = await r.text();
      const donnees = texte ? JSON.parse(texte) : null;
      if (!r.ok) {
        const err = new Error(`${methode} ${chemin} : ${r.status} ${donnees?.message ?? ""}`);
        err.status = r.status;
        throw err;
      }
      return { donnees, lien: r.headers.get("link") };
    }
  }
  return {
    async get(chemin) {
      return (await appel("GET", chemin)).donnees;
    },
    async tout(chemin, cle) {
      const resultats = [];
      let url = chemin + (chemin.includes("?") ? "&" : "?") + "per_page=100";
      while (url) {
        const { donnees, lien } = await appel("GET", url);
        resultats.push(...(cle ? donnees[cle] : donnees));
        url = /<([^>]+)>;\s*rel="next"/.exec(lien ?? "")?.[1] ?? null;
      }
      return resultats;
    },
    async ecrire(methode, chemin, corps) {
      return (await appel(methode, chemin, corps))?.donnees ?? null;
    },
  };
}

async function jetonApplication({ appId, cle, organisation, depots, fetchFn = fetch }) {
  const jwt = jwtApplication(appId, cle);
  const app = clientGitHub(jwt, { fetchFn });
  const installation = await app.get(`/orgs/${organisation}/installation`);
  const corps = depots?.length ? { repositories: depots.map((d) => d.split("/")[1]) } : {};
  const r = await app.ecrire("POST", `/app/installations/${installation.id}/access_tokens`, corps);
  return r.token;
}

const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Une PR lue en détail ; `mergeable` peut être null le temps que GitHub calcule : trois essais. */
async function lirePr(api, depot, numero, pause) {
  let pr;
  for (let i = 0; i < 3; i++) {
    pr = await api.get(`/repos/${depot}/pulls/${numero}`);
    if (pr.mergeable !== null) break;
    await attendre(pause);
  }
  return pr;
}

async function fichiersPr(api, depot, numero) {
  return (await api.tout(`/repos/${depot}/pulls/${numero}/files`)).map((f) => f.filename);
}

async function dateFile(api, depot, numero) {
  try {
    const evts = await api.tout(`/repos/${depot}/issues/${numero}/events`);
    const poses = evts.filter((e) => e.event === "labeled" && e.label?.name === ETIQUETTE_FILE);
    return poses.length ? poses[poses.length - 1].created_at : null;
  } catch {
    return null;
  }
}

async function fichiersEnConflit(api, depot, pr) {
  try {
    const c = await api.get(`/repos/${depot}/compare/${encodeURIComponent(pr.base.ref)}...${pr.head.sha}`);
    const base = await api.get(`/repos/${depot}/compare/${c.merge_base_commit.sha}...${encodeURIComponent(pr.base.ref)}`);
    const cote = new Set((base.files ?? []).map((f) => f.filename));
    return (c.files ?? []).map((f) => f.filename).filter((f) => cote.has(f));
  } catch {
    return [];
  }
}

async function estBaseFusionnee(api, depot, base, defaut) {
  if (base === defaut) return false;
  let comparaison = null;
  try {
    comparaison = await api.get(`/repos/${depot}/compare/${encodeURIComponent(defaut)}...${encodeURIComponent(base)}`);
  } catch {
    return false;
  }
  if (comparaison.ahead_by !== 0) return false;
  const proprietaire = depot.split("/")[0];
  const fermees = await api.tout(`/repos/${depot}/pulls?state=closed&head=${proprietaire}:${encodeURIComponent(base)}`);
  const fusionnee = fermees.some((p) => p.merged_at);
  return baseFusionnee({ base, defaut, comparaison, fusionnee });
}

async function noteExistante(api, depot, numero) {
  const commentaires = await api.tout(`/repos/${depot}/issues/${numero}/comments`);
  return commentaires.find((c) => c.user?.type === "Bot" && c.body?.includes(MARQUE)) ?? null;
}

/** Passe le gardien sur un dépôt. Rend un résumé par PR. */
export async function garderDepot(api, depot, { motifs = [], maintenant = Date.now(), pause = 3000, journal = console.log } = {}) {
  const infos = await api.get(`/repos/${depot}`);
  if (infos.archived) return [];
  const defaut = infos.default_branch;
  const ouvertes = await api.tout(`/repos/${depot}/pulls?state=open`);
  const prs = ouvertes.map((p) => ({
    numero: p.number,
    base: p.base.ref,
    tete: p.head.ref,
    etiquettes: (p.labels ?? []).map((l) => l.name),
    brut: p,
  }));

  // La file de fusion : PR étiquetées « a-fusionner », dans l'ordre de pose de l'étiquette.
  const fichiers = new Map();
  const fichiersDe = async (n) => {
    if (!fichiers.has(n)) fichiers.set(n, await fichiersPr(api, depot, n));
    return fichiers.get(n);
  };
  const file = [];
  for (const p of prs.filter((p) => p.etiquettes.includes(ETIQUETTE_FILE))) {
    file.push({ numero: p.numero, fichiers: await fichiersDe(p.numero), depuis: await dateFile(api, depot, p.numero) });
  }
  const fileTriee = ordreFile(file);
  const aujourdhui = new Date(maintenant).toISOString().slice(0, 10);
  const resume = [];

  for (const pr of prs) {
    if (ignoree(pr, motifs)) {
      journal(`${depot}#${pr.numero} : laissée de côté (${pr.tete} -> ${pr.base}).`);
      resume.push({ depot, numero: pr.numero, ignoree: true });
      continue;
    }
    const fusionnee = await estBaseFusionnee(api, depot, pr.base, defaut);
    if (fusionnee) {
      await api.ecrire("PATCH", `/repos/${depot}/pulls/${pr.numero}`, { base: defaut });
      journal(`${depot}#${pr.numero} : base ${pr.base} déjà fusionnée, reciblée vers ${defaut}.`);
    }
    const detail = await lirePr(api, depot, pr.numero, pause);
    const conflit = detail.mergeable === false || detail.mergeable_state === "dirty";
    const fichiersConflit = conflit ? await fichiersEnConflit(api, depot, detail) : [];
    const runs = await api.get(`/repos/${depot}/commits/${detail.head.sha}/check-runs?filter=latest&per_page=100`);
    const rouges = rougesAnciens(runs.check_runs ?? [], maintenant);
    const recouv = recouvrements(pr, await fichiersDe(pr.numero), fileTriee);
    const note = await noteExistante(api, depot, pr.numero);

    const d = decider({
      pr, defaut, baseFusionnee: fusionnee, conflit, fichiersConflit, rouges, recouvrements: recouv,
      note: note?.body ?? null, aujourdhui,
    });
    for (const e of d.ajouter) await api.ecrire("POST", `/repos/${depot}/issues/${pr.numero}/labels`, { labels: [e] });
    for (const e of d.retirer) {
      try {
        await api.ecrire("DELETE", `/repos/${depot}/issues/${pr.numero}/labels/${encodeURIComponent(e)}`);
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    if (d.note) {
      if (note) await api.ecrire("PATCH", `/repos/${depot}/issues/comments/${note.id}`, { body: d.note });
      else await api.ecrire("POST", `/repos/${depot}/issues/${pr.numero}/comments`, { body: d.note });
    }
    const constats = [
      fusionnee && "reciblée",
      conflit && "conflit",
      rouges.length && "CI rouge > 24 h",
      recouv.length && `recouvre ${recouv.map((r) => "#" + r.numero).join(" ")}`,
    ].filter(Boolean);
    journal(`${depot}#${pr.numero} : ${constats.length ? constats.join(", ") : "rien à signaler"}${d.note ? " (note mise à jour)" : ""}.`);
    resume.push({ depot, numero: pr.numero, constats, note: Boolean(d.note), ajouter: d.ajouter, retirer: d.retirer });
  }
  return resume;
}

async function principal() {
  const env = process.env;
  const essai = env.GARDIEN_ESSAI === "1";
  const organisation = env.GARDIEN_ORGANISATION || (env.GITHUB_REPOSITORY ?? "Ergalo/").split("/")[0];
  let depots = motifsIgnores(env.GARDIEN_DEPOTS);
  const toutes = env.GARDIEN_PORTEE === "organisation";
  let jeton = env.GH_TOKEN;
  if (env.FUSION_APP_ID && env.FUSION_APP_PRIVATE_KEY) {
    jeton = await jetonApplication({
      appId: env.FUSION_APP_ID, cle: env.FUSION_APP_PRIVATE_KEY, organisation, depots: toutes ? null : depots,
    });
    if (env.GITHUB_ACTIONS) console.log(`::add-mask::${jeton}`);
  }
  if (!jeton) throw new Error("aucun jeton (FUSION_APP_ID et FUSION_APP_PRIVATE_KEY, ou GH_TOKEN)");
  const api = clientGitHub(jeton, { essai });
  if (toutes) {
    const repos = await api.tout("/installation/repositories", "repositories");
    depots = repos.filter((r) => !r.archived).map((r) => r.full_name);
  }
  if (!depots.length) throw new Error("aucun dépôt à garder (GARDIEN_DEPOTS ou GARDIEN_PORTEE=organisation)");
  const motifs = motifsIgnores(env.GARDIEN_IGNORER);
  console.log(`Gardien des PR${essai ? " (essai, rien n'est écrit)" : ""} : ${depots.join(", ")}`);
  let echecs = 0;
  const lignes = ["## Gardien des PR", ""];
  for (const depot of depots) {
    try {
      const r = await garderDepot(api, depot, { motifs });
      for (const p of r) {
        lignes.push(`- ${depot}#${p.numero} : ${p.ignoree ? "laissée de côté" : p.constats.length ? p.constats.join(", ") : "rien à signaler"}`);
      }
      if (!r.length) lignes.push(`- ${depot} : aucune PR ouverte`);
    } catch (err) {
      echecs++;
      console.log(`::error::${depot} : ${err.message}`);
      lignes.push(`- ${depot} : erreur, ${err.message}`);
    }
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, lignes.join("\n") + "\n");
  if (echecs) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  principal().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
