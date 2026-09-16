# Five- to ten-minute educational demo story (content revision 2)

This is the **educational** telling of the walkthrough in `../replay-demo-runbook.md`. It keeps the runbook's sequence and timings, but the sentence at each step is about what a learner practices. Every step carries an honesty label for the build as implemented:

- **Implemented:** works as described in the native deployment or local build.
- **Substitute:** the runbook's step is done with a local stand-in, and the presenter says so.
- **Unknown:** deployed but without evidence of the specific behavior; the presenter says "not yet qualified".
- **Pending:** not built or not shown. The presenter says so or skips the step.

The presenter never pretends a pending integration exists and never presents territory outcome as a judgment of reasoning.

## The sentence to retain

"You play a continuous exercise against an opponent that plays to win. Afterward you go back to the decisions that mattered, see exactly what you knew and when, and practice the alternative. Then you find out how well you can explain yourself."

## Ten-minute version

| Time | Runbook step | Educational story | Label |
| --- | --- | --- | --- |
| 0:00–0:40 | Native entry | Sign in on the Kamiwaza card. Point at "Kamiwaza identity", the workroom name, the mapped seat and the access badge, then the Live label and tick clock. Say: "The workroom assigned my seat. I cannot change it here." If presenting locally, show the "Local demo identity" badge and say so. | Implemented (native sign-in qualified once) / Substitute (local) |
| 0:40–1:20 | Role relevance | Show the commander's Orders panel with the collapsible Decision note, then a second browser in the Intelligence seat: no orders, an Assessment log with a report picker. Say: "The analyst's product is a sourced assessment. The commander's product is orders with a written reason. We look at the writing, not the winning." | Implemented |
| 1:20–2:30 | Build a staff agent | In Watches, add "alert me when the opposing force estimate changes". Close the panel. Say: "This is a standing task. It checks every ten seconds and at every release, and posts only when something material happened, naming the reports." Show "Deterministic provenance watch · free" and the tool disclosure. Mention that paid analysis is a separate opt-in. | Implemented |
| 2:30–3:30 | Autonomous play | Write a one-line decision note citing the initial report, issue an expand order. Show the receipt and, in the Learning panel, "reason recorded · contemporaneous". Show a Red baseline action in the timeline. Say: "Red plays to its objective. By default it is a fixed policy; a model-driven controller can be switched on and each of its actions comes with a short summary of what it did and the tools it called. That summary is not its thinking." Only show a `model_decision` if one exists in a recorded exercise. | Implemented (baseline) / Implemented, off by default (model) |
| 3:30–5:20 | Exact review | End the exercise or open a Recorded one. Scrub to a release tick. Show the reconstructed map with its fingerprint, the reports available then, and the order that followed with its cited report tagged current or superseded. Say: "Which report was current? What did you write down? If the map could not be reconstructed you would see an error, not a guess." | Implemented (fingerprint-verified rewind; 72,000-tick accelerated qualification) |
| 5:20–6:50 | Take the other side | Toggle to Red, show Red's reports. Press "Branch at tick N", command Red, issue one order. Return to the source and show its tick and record unchanged. Say: "State one assumption, then play it differently. The dossier files this as informed practice, not improvement." | Implemented (browser-verified by automation) |
| 6:50–7:50 | Personal practice | Open "My practice". Read the role summary, the attempt table with its labels, one gap, one targeted practice item and the Limitations aloud. Say: "These are counts of what I did and wrote. Not a score. Other people's sessions are excluded by identity." Optionally show a cached validated debrief and its "hindsight" tags; if none exists, say generating one is a paid, post-exercise step. | Implemented |
| 7:50–9:10 | Kamiwaza connection | Open Platform. Show "Connected to a native Kamiwaza platform" with the ForwardAuth validation line, the inference ledger and the ontology panel. Say: "Identity and workroom scope are live. The workroom graph instance and the local embedding service are deployed; ingestion and search are not yet qualified, so I am not claiming them." | Implemented (identity) / Unknown (graph ingest and search) |
| 9:10–10:00 | Execution and transition | Return to the live exercise. Say: "What the pilot needs next is an instructor, a few learners, a reviewed source, and a subject-matter expert who will tell us where this rubric is wrong. Whether it teaches anything is the question we are asking, not the claim we are making." | Implemented (live exercise) / Pending (Spark placement, not shown) |

## Five-minute version

| Time | Story beat | Label |
| --- | --- | --- |
| 0:00–0:30 | Sign-in, mapped seat, live clock | Implemented (native) / Substitute (local) |
| 0:30–1:20 | Order with a decision note, receipt, watch created, Red baseline action | Implemented |
| 1:20–2:40 | Rewind to a release; which report was current; what the learner wrote | Implemented |
| 2:40–3:40 | Branch as Red with a stated assumption; original unchanged | Implemented |
| 3:40–4:25 | Dossier: counts, gaps, limitations read aloud | Implemented |
| 4:25–5:00 | Platform view: identity live; graph ingest and search unknown; learning is the research question | Implemented / Unknown |

## Things the presenter must say if asked

- "Is the AI explaining its reasoning?" No. It returns a summary of selected actions alongside tool calls. The debrief validator rejects any sentence that attributes motives to it.
- "Does this teach decision-making?" We do not know. That is what a small pilot with written probes would measure, and we will report the limits.
- "Is this based on doctrine?" No doctrine is loaded. Candidate sources exist as catalog metadata and go through a written review before any use.
- "Does it model real forces?" No. It is an abstract territory game with fictional side names.
- "Can I see the learner's reasons?" Only what they wrote, labeled with when they wrote it. Nothing infers reasons from clicks.
- "Who won?" The end state is recorded. It does not score anything.
- "Is the knowledge graph working?" The instance exists and the embedding service answers. Ingestion and search have not been qualified.

## Recovery paths that keep the story honest

| Failure | Say |
| --- | --- |
| Rewind reports a fingerprint mismatch | "Reconstruction failed for that tick and the app refused to show an approximate state. That refusal is the feature." |
| Staff answer or debrief errors with a budget or credential message | "The model route is unavailable; the deterministic watch and every record still work." |
| Debrief shows "discarded" | "The model cited something that was not in the evidence, so the app logged it and showed nothing. That is the validator working." |
| Native access refused | "The platform decides access on every request; this seat was refused and the app failed closed." |
| No finished exercise to review | End the live one on stage. Review works on a just-ended exercise. |
| Branch takes long | Say it is reconstructing from the prefix; do not narrate it as instant. |
