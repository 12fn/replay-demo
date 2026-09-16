# REPLAY 0.28 — instructor workspace

## What changed

A persistent sidebar separates navigation from exercise selection and identity. The UI uses a consistent light reading surface, readable semantic colors, visible focus states, and responsive layouts. The map keeps a distinct dark visualization surface. The prepared instructor case shows one task at a time; technical receipts and detailed provenance remain available inside the task they support.

- **Instructor case:** The decision → The evidence → AI assistance → Your review → Next practice.
- **Exercise:** map plus Orders / Staff / Mission / Forces / Team. End for review is a page action.
- **Review:** Decision record / Debrief & handoff. Decision records separate Decisions / Timeline / Reports.
- **My practice:** Practice history / Current exercise reflection. Written reasons are under Reasons & sources.
- **Library:** searchable regional cases and reference material.
- **Platform:** Evidence archive / Connections & tools / Usage & records.

The backend, deterministic engine, authorization, native deployment contract, graph traversal, original cases, and model budget are unchanged. Native sign-in still validates against Kamiwaza; seamless platform browser SSO handoff remains separate work.

## Ten-minute native presenter route

Before presenting, sign in using your authorized workroom account. Open **Instructor case → Return to original case**. The native case says **Recorded native workflow**, decision tick970. Local isolated demonstrations instead show an explicitly authored synthetic case with different ticks. Do not conflate those records.

| Time | Action | Value to demonstrate |
| --- | --- | --- |
| 0–1 min | **The decision → Open decision and source timeline**. | Reconstruct the choice using the evidence available then. |
| 1–3 min | Return to **Instructor case → The evidence → Retrieve this decision’s evidence**. Search **Bulletin: reed-flat reserves**, select the node, inspect its source, then **Open original evidence at this tick**. | Repetition is not independent corroboration. Inspect assumptions, conflicts, alternatives and what would change the judgment. |
| 3–5 min | **Instructor case → AI assistance → Read the saved Luna analysis and cited evidence**. Open a citation and recorded tradeoffs. Expand **Recorded native receipts and correction**. | Inspect an actual saved model result and tool receipt. Opening these makes no new model call. The correction was scripted, not human acceptance. |
| 5–6 min | **Your review**. Open the original if prompted. Edit **Your qualified review and next practice → Save post-hoc review note**. Expand the saved file and choose **Inspect original file**. | Retain the signed-in instructor’s interpretation without rewriting the original decision. |
| 6–8 min | **Next practice → Start a new legal practice branch**. In **Orders**, use10percent commitment and add a decision note with a report citation. Expand **Available costs & boat landings → Check available options → Inspect destination → Boat to tile**. **Staff → Watches → Report provenance → Add watch**. Use the page action **End for review → Confirm: end for review**. | Try a legal alternative with recorded reasoning. Native world-map landings must be checked; a ground Expand is not universally legal. |
| 8–9 min | **My practice → Reasons & sources**. Inspect the new reason. **Review → Debrief & handoff → Download evidence bundle**. | Produce a durable instructor handoff with branch ancestry and sources. |
| 9–10 min | **Platform → Evidence archive**. Search `taiwan-sol-blue-opus-red-full-20260915`; **3. Model decisions → Apply → first result → Saved reply → Open saved source → Verified source**. | Show managed archive evidence and native receipts. This trial is separate from the instructor case. |

Return to **Instructor case → Return to original case** to repeat. This preserves prior branches and notes. Opening saved analysis, retrieving the decision graph and creating a rules-based watch require no model inference. Do not enable a model opponent, generate a debrief or start Tomo inference merely to follow this route.

The decision graph remains REPLAY’s scoped traversal. The platform catalog is an app projection of managed archived evidence. No educational-effectiveness or operational-readiness claim follows from this software demonstration.

## Verification

Full existing suite:1931tests in134files. Browser qualification exercises source drilldown, saved citations, attributed note intake, legal branch orders, free watch creation, completion, persistence and export. It checks all six destinations at1440,1024and390pixel widths, with keyboard navigation and computed HTML text/background contrast. This does not replace screen-reader evaluation, visual review of every state or a human instructor playtest.

Run the isolated browser qualifier using `scripts/qualify-frontend-redesign.py` with the disposable local server on5195; it deliberately cannot target the native origin. Receipts are retained under `evidence/browser/frontend-rebuild/`.
