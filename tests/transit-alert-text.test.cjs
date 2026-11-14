const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const text = loadTypeScript("lib/transit/alert-text.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("shared plural line lists are scoped to each named route, including numbers in words", () => {
  for (const list of ["6 et 7", "6, 7", "6 / 7", "six et sept"]) {
    const source = `Manifestation : lignes ${list} déviées dans les deux sen - Peyrou et Albert 1er non desservis.`;
    for (const id of ["6", "7"]) {
      const clauses = text.scopedAlertClauses(source, id);
      assert.equal(clauses.length, 1);
      assert.equal(text.affirmativeServiceWording(clauses[0], "detour"), true);
      assert.equal(text.bothDirections(clauses[0]), true);
    }
    assert.deepEqual(plain(text.scopedAlertClauses(source, "8")), []);
  }
});

test("separate line sentences and repeated line prefixes do not leak closures to another route", () => {
  const source = "Ligne 6 déviée. Les arrêts Alpha non desservis. Ligne 7 interrompue. Les arrêts Bravo non desservis.";
  assert.equal(text.scopedAlertClauses(source, "6").join(" ").includes("Bravo"), false);
  assert.equal(text.scopedAlertClauses(source, "7").join(" ").includes("Alpha"), false);
  assert.deepEqual(plain(text.mentionedLines("Ligne 6 et ligne 7 : retards.")), ["6", "7"]);
  assert.deepEqual(plain(text.scopedAlertClauses("Les arrêts Alpha non desservis.", "6", true)), []);
});

test("hypotheses, negations and resumed service never become detours or closures", () => {
  for (const clause of ["Si la ligne 6 est déviée, Peyrou non desservi", "Ligne 6 pourrait être déviée - Peyrou non desservi",
    "Déviation possible de la ligne 6 - Peyrou non desservi", "Ligne 6 n’est plus déviée", "Fin de la déviation de la ligne 6", "Reprise du service - Peyrou non desservi"]) {
    assert.equal(text.affirmativeServiceWording(clause, "detour"), false, clause);
    assert.deepEqual(plain(text.closureSubjects(clause)), [], clause);
  }
  assert.deepEqual(plain(text.closureSubjects("Report aux arrêts Alpha et Bravo non desservis")), []);
});

test("stop abbreviations require a unique whole-word station name and compact quays", () => {
  const stop = (id, name, lat = 43.6) => ({ id, name, lat, lon: 3.8, routeIds: ["6"] });
  const stops = [stop("p0", "Peyrou - Arc de Triomphe"), stop("p1", "Peyrou - Arc de Triomphe", 43.6001), stop("a", "Albert 1er - Jardin des Plantes"), stop("b", "Léon Blum")];
  assert.deepEqual(plain(text.resolveStopLabel("Peyrou", stops).stops.map((stop) => stop.id)), ["p0", "p1"]);
  assert.equal(text.resolveStopLabel("Albert 1er", stops).status, "matched");
  assert.equal(text.resolveStopLabel("L. Blum", stops).status, "matched");
  assert.equal(text.resolveStopLabel("Peyrou Quai Inconnu", stops).status, "unknown");
  assert.equal(text.resolveStopLabel("Albert 1er", [...stops, stop("c", "Albert 1er - Cathédrale")]).status, "ambiguous");
  assert.equal(text.resolveStopLabel("Peyrou", [...stops, stop("far", "Peyrou - Arc de Triomphe", 43.62)]).status, "ambiguous");
});

test("abbreviations do not split station labels into unrelated sentences", () => {
  assert.equal(text.alertClauses("Les stations St. Eloi et L. Blum non desservies.").length, 1);
  assert.deepEqual(plain(text.closureSubjects("Les stations St Eloi et L Blum non desservies")), [{ text: "st eloi et l blum", explicit: true }]);
});

test("explicit closed and removed stops are understood without treating their negations as closures", () => {
  for (const predicate of ["sont fermés", "seront supprimés", "supprimés", "fermés"]) {
    assert.deepEqual(plain(text.closureSubjects(`Les arrêts Alpha et Bravo ${predicate}`)), [{ text: "alpha et bravo", explicit: true }]);
  }
  assert.deepEqual(plain(text.closureSubjects("Les arrêts Alpha ne sont pas fermés")), []);
  assert.equal(text.bothDirections("pas dans les deux sens"), false);
  assert.equal(text.bothDirections("dans les deux sens, mais un seul sens pour cet arrêt"), false);
});
