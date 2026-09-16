import { describe, expect, it } from "vitest";
import { createPresetCatalog } from "../../src/catalog/seed";
import { CATALOG_SOURCES } from "../../src/catalog/sources";
import type { CatalogAorId, CatalogKind, CatalogRecord } from "../../src/catalog/types";

const bundle = createPresetCatalog();
const byId = new Map(bundle.records.map((r) => [r.id, r]));
const of = (kind: CatalogKind, aorId?: CatalogAorId) =>
  bundle.records.filter((r) => r.kind === kind && (!aorId || r.aorId === aorId));
const AORS: CatalogAorId[] = ["taiwan", "caribbean", "hormuz"];
const casesFor = (personaId: string) => of("case").filter((c) => c.personaId === personaId);
const reportsOf = (caseId: string) =>
  of("report").filter((r) => r.caseId === caseId).sort((a, b) => Number(a.fields.sequence) - Number(b.fields.sequence));
const eventsOf = (caseId: string) =>
  of("event").filter((r) => r.caseId === caseId).sort((a, b) => Number(a.fields.sequence) - Number(b.fields.sequence));
const targets = (r: CatalogRecord, relation: string) => r.links.filter((l) => l.relation === relation).map((l) => l.targetId);
const idFields = (value: unknown): string[] =>
  typeof value === "string" && /^(taiwan|caribbean|hormuz)\//.test(value)
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(idFields)
      : [];

describe("preset catalog seed", () => {
  it("is deterministic and free of wall-clock or random values", () => {
    expect(JSON.stringify(createPresetCatalog())).toBe(JSON.stringify(bundle));
    expect(bundle.schema).toBe("replay.preset-catalog/1");
    expect(bundle.version).toBe("preset-catalog/1");
    expect(JSON.stringify(bundle)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it("meets target counts per AOR", () => {
    expect(bundle.aors.map((a) => a.id)).toEqual(AORS);
    for (const aor of AORS) {
      const personas = of("persona", aor);
      expect(personas).toHaveLength(12);
      for (const role of ["commander", "intelligence", "instructor"])
        expect(personas.filter((p) => p.fields.role === role)).toHaveLength(4);
      expect(of("case", aor)).toHaveLength(36);
      expect(of("report", aor)).toHaveLength(216);
      expect(of("event", aor)).toHaveLength(288);
      expect(of("asset", aor)).toHaveLength(9);
      expect(of("glossary", aor)).toHaveLength(12);
      expect(of("lesson", aor)).toHaveLength(6);
      expect(of("organization", aor)).toHaveLength(3);
      expect(of("red-profile", aor)).toHaveLength(1);
      expect(of("historical", aor)).toHaveLength(1);
    }
    expect(of("persona")).toHaveLength(36);
    expect(of("case")).toHaveLength(108);
  });

  it("marks Taiwan playable and the other AORs context-only", () => {
    const aor = Object.fromEntries(bundle.aors.map((a) => [a.id, a]));
    expect(aor.taiwan.playableScenarioId).toBe("taiwan-strait/1");
    expect(aor.caribbean.playableScenarioId).toBeNull();
    expect(aor.hormuz.playableScenarioId).toBeNull();
  });

  it("keeps region vocabulary specific rather than label-swapped", () => {
    const sectorsByAor = Object.fromEntries(
      AORS.map((aor) => [aor, new Set(of("case", aor).map((c) => String(c.fields.sector)))]),
    );
    for (const aor of AORS) {
      const text = bundle.records.filter((r) => r.aorId === aor).map((r) => r.body).join("\n");
      for (const other of AORS.filter((a) => a !== aor))
        for (const sector of sectorsByAor[other]) expect(text).not.toContain(sector);
    }
    const titles = (kind: CatalogKind, aor: CatalogAorId) => new Set(of(kind, aor).map((r) => r.title));
    for (const kind of ["lesson", "glossary", "asset", "organization", "red-profile"] as CatalogKind[]) {
      const [a, b, c] = AORS.map((aor) => titles(kind, aor));
      expect([...a].filter((t) => b.has(t) || c.has(t))).toEqual([]);
      expect([...b].filter((t) => c.has(t))).toEqual([]);
    }
  });

  it("uses unique safe IDs and fully resolvable relationships and sources", () => {
    const ids = bundle.records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const sourceIds = new Set(CATALOG_SOURCES.map((s) => s.id));
    expect(bundle.sources.map((s) => s.id)).toEqual(CATALOG_SOURCES.map((s) => s.id));
    for (const r of bundle.records) {
      expect(r.id).toMatch(/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/);
      if (r.kind === "report" || r.kind === "event") expect(r.id.startsWith(`${r.caseId}/${r.kind}-`)).toBe(true);
      else expect(r.id.startsWith(`${r.aorId}/${r.kind}/`)).toBe(true);
      for (const l of r.links) {
        expect(byId.has(l.targetId), `${r.id} -> ${l.targetId}`).toBe(true);
        expect(byId.get(l.targetId)!.aorId).toBe(r.aorId);
      }
      for (const s of r.sourceIds) expect(sourceIds.has(s)).toBe(true);
      for (const value of Object.values(r.fields))
        for (const ref of idFields(value)) expect(byId.has(ref), `${r.id} field ${ref}`).toBe(true);
      if (r.personaId) expect(byId.get(r.personaId)?.kind).toBe("persona");
      if (r.caseId) expect(byId.get(r.caseId)?.kind).toBe("case");
      for (const t of r.tags) expect(t).toMatch(/^[a-z0-9-]+$/);
    }
    for (const a of bundle.aors) for (const s of a.sourceIds) expect(sourceIds.has(s)).toBe(true);
  });

  it("reuses source-provided summaries verbatim on historical cards", () => {
    for (const h of of("historical")) {
      expect(h.provenance).toBe("public-reference");
      expect(h.sourceIds).toHaveLength(1);
      const source = CATALOG_SOURCES.find((s) => s.id === h.sourceIds[0])!;
      expect(h.summary).toBe(source.summary);
      expect(h.title).toBe(source.title);
    }
    expect(of("historical").map((h) => h.sourceIds[0]).sort()).toEqual(
      ["eia-chokepoints", "navy-midway-1942", "state-cuba-1962"],
    );
  });

  it("marks every persona and case record synthetic and fictional", () => {
    for (const r of bundle.records.filter((x) => x.kind !== "historical")) expect(r.provenance).toBe("synthetic");
    const names = new Set<string>();
    for (const p of of("persona")) {
      expect(p.title).toMatch(/^Demo [A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(p.sourceIds).toEqual([]);
      expect(p.fields).toMatchObject({ profileBasis: "authored-preset", inferredSkill: false, fictional: true, authenticatedUser: false });
      expect(String(p.fields.criterionStatus)).toMatch(/^criterion-/);
      expect(String(p.fields.criterionRule)).toContain("not mastery");
      names.add(p.title);
    }
    expect(names.size).toBe(36);
    for (const c of of("case")) {
      expect(c.fields).toMatchObject({ recordedGame: false, engineReplay: false, dataStatus: "authored-synthetic-example" });
      expect(c.body).toContain("not a recorded game");
    }
    for (const r of of("report")) expect(r.fields).toMatchObject({ illustrative: true, engineObservation: false });
  });

  it("links personas to exactly their own three cases with a same-lesson contrast pair", () => {
    for (const p of of("persona")) {
      const cases = casesFor(p.id);
      expect(cases).toHaveLength(3);
      expect([...(p.fields.caseIds as string[])].sort()).toEqual(cases.map((c) => c.id).sort());
      const linkKeys = p.links.map((l) => `${l.relation}:${l.targetId}`);
      expect(new Set(linkKeys).size).toBe(linkKeys.length);
      for (const c of cases) {
        expect(targets(c, "authored-by")).toEqual([p.id]);
        expect(c.roles).toContain(p.fields.role);
      }
      const [a, b] = (p.fields.contrastCaseIds as string[]).map((id) => byId.get(id)!);
      expect(targets(a, "contrasts-with")).toEqual([b.id]);
      expect(targets(b, "contrasts-with")).toEqual([a.id]);
      expect(a.fields.lessonId).toBe(b.fields.lessonId);
      expect(a.fields.behavior).not.toBe(b.fields.behavior);
      expect(a.fields.relayDelayTicks).not.toBe(b.fields.relayDelayTicks);
      expect(Number(a.fields.decisionDeadlineTick) - Number(a.fields.startTick)).toBe(
        Number(b.fields.decisionDeadlineTick) - Number(b.fields.startTick),
      );
      const variants = [a, b].map((c) => c.fields.variant).sort();
      expect(variants).toEqual(["early-corroboration", "late-correction"]);
    }
  });

  it("covers every authored behavior with balanced counts and separates outcome from reasoning", () => {
    const behaviors = new Map<string, number>();
    for (const c of of("case")) behaviors.set(String(c.fields.behavior), (behaviors.get(String(c.fields.behavior)) ?? 0) + 1);
    expect([...behaviors.keys()].sort()).toEqual([
      "calibration", "conservative-hold", "derivative-double-count-corrected",
      "evidence-update-delegation", "premature-commitment", "waits-for-corroboration",
    ]);
    for (const n of behaviors.values()) expect(n).toBe(18);
    const combos = new Set(of("case").map((c) => `${c.fields.outcomeRating}/${c.fields.reasoningRating}`));
    expect(combos.has("favorable/unsupported")).toBe(true);
    expect([...combos].some((x) => /^(mixed|costly)\/supported$/.test(x))).toBe(true);
  });

  it("gives each case six coherent reports with derivative, correction and conflicting accounts", () => {
    for (const c of of("case")) {
      const reports = reportsOf(c.id);
      expect(reports.map((r) => r.id)).toEqual(c.fields.reportIds);
      expect(reports).toHaveLength(6);
      for (const r of reports) {
        expect(r.observedTick!).toBeLessThanOrEqual(r.availableAtTick!);
        for (const l of r.links.filter((x) => x.relation !== "belongs-to")) {
          const target = byId.get(l.targetId)!;
          expect(target.caseId).toBe(c.id);
          expect(target.availableAtTick!).toBeLessThanOrEqual(r.availableAtTick!);
        }
      }
      const derivative = reports.filter((r) => r.fields.lineage === "derivative");
      expect(derivative).toHaveLength(1);
      const [origin] = targets(derivative[0], "derived-from");
      expect(derivative[0].fields.independent).toBe(false);
      expect(byId.get(origin)!.fields.lineageRoot).toBe(derivative[0].fields.lineageRoot);

      const corrections = reports.filter((r) => targets(r, "supersedes").length);
      expect(corrections).toHaveLength(1);
      const superseded = byId.get(targets(corrections[0], "supersedes")[0])!;
      expect(superseded.fields.supersededByReportId).toBe(corrections[0].id);
      expect(corrections[0].observedTick!).toBeGreaterThan(superseded.observedTick!);

      const conflicts = reports.filter((r) => targets(r, "disputes").length);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].fields.independent).toBe(true);
      expect(conflicts[0].fields.lineageRoot).not.toBe(byId.get(targets(conflicts[0], "disputes")[0])!.fields.lineageRoot);

      const reserve = byId.get(String(c.fields.reserveAssetId))!;
      expect(reserve.fields.reserveEligible).toBe(true);
      const reserveName = reserve.title.replace(/^Demo /, "").toLowerCase();
      for (const r of reports) expect(String(r.fields.sourceLabel).toLowerCase()).not.toContain(reserveName);

      const independentContact = new Set(
        reports.filter((r) => r.fields.topic === "contact" && r.fields.independent).map((r) => r.fields.lineageRoot),
      );
      expect(independentContact.size).toBe(3);
    }
  });

  it("orders eight events, cites only released reports, and ends with post-hoc reviews of decisions", () => {
    for (const c of of("case")) {
      const events = eventsOf(c.id);
      expect(events).toHaveLength(8);
      expect(events.map((e) => e.id)).toEqual(c.fields.eventIds);
      events.forEach((e, i) => {
        expect(e.observedTick).toBe(e.availableAtTick);
        if (i > 0) expect(e.availableAtTick!).toBeGreaterThan(events[i - 1].availableAtTick!);
        expect(targets(e, "precedes")).toEqual(i < 7 ? [events[i + 1].id] : []);
        for (const reportId of targets(e, "cites")) {
          const report = byId.get(reportId)!;
          expect(report.kind).toBe("report");
          expect(report.caseId).toBe(c.id);
          expect(report.availableAtTick!).toBeLessThanOrEqual(e.availableAtTick!);
        }
        expect(targets(e, "cites")).toEqual(e.fields.citedReportIds);
      });
      const reviews = events.slice(6);
      expect(reviews.map((e) => e.fields.reviewFocus)).toEqual(["outcome", "reasoning"]);
      expect(events.slice(0, 6).every((e) => e.fields.phase === "in-exercise")).toBe(true);
      for (const r of reviews) {
        expect(r.fields.phase).toBe("post-hoc");
        const reviewed = targets(r, "reviews").map((id) => byId.get(id)!);
        expect(reviewed.length).toBeGreaterThan(0);
        for (const d of reviewed) {
          expect(d.caseId).toBe(c.id);
          expect(d.fields.phase).toBe("in-exercise");
          expect(d.availableAtTick!).toBeLessThan(r.availableAtTick!);
        }
      }
      expect(reviews[0].fields.rating).toBe(c.fields.outcomeRating);
      expect(reviews[1].fields.rating).toBe(c.fields.reasoningRating);
      const deadline = events.find((e) => e.fields.isDecisionDeadline)!;
      expect(deadline.availableAtTick).toBe(c.fields.decisionDeadlineTick);
      const released = reportsOf(c.id).filter((r) => r.availableAtTick! <= deadline.availableAtTick!).length;
      expect(released).toBe(c.fields.variant === "early-corroboration" ? 6 : 4);
    }
  });

  it("records derivative double counts as not independent and corrects them where authored", () => {
    for (const c of of("case")) {
      const events = eventsOf(c.id);
      const initial = events.find((e) => e.fields.slot === "initial")!;
      const conflict = events.find((e) => e.fields.slot === "conflict")!;
      expect(initial.fields.actualIndependentSupportingLineages).toBe(1);
      expect(targets(initial, "cites")).toHaveLength(2);
      if (c.fields.behavior === "derivative-double-count-corrected") {
        expect(initial.fields.countedIndependentSupportingLineages).toBe(2);
        expect(conflict.fields.countedIndependentSupportingLineages).toBe(1);
      }
      if (["waits-for-corroboration", "conservative-hold", "evidence-update-delegation", "calibration"].includes(String(c.fields.behavior)))
        expect(initial.fields.countedIndependentSupportingLineages).toBe(1);
    }
  });

  it("supports required lowercase tag searches in every AOR", () => {
    for (const aor of AORS)
      for (const tag of ["reserve", "provenance", "weather", "transport", "communication", "corroboration", "confidence", "source-change"])
        for (const kind of ["case", "report", "event"] as CatalogKind[])
          expect(of(kind, aor).some((r) => r.tags.includes(tag)), `${aor} ${kind} ${tag}`).toBe(true);
  });
});
