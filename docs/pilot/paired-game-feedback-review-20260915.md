# What the paired games tell us to improve

The four paired games are preserved under `evidence/paired-red-evaluation/taiwan-paired-20260915`. All 96 model replies produced canonical inputs admitted by the harness; admission is not proof of an intended effect. Main independently checked provider artifacts, prompts, source hashes and final engine reconstruction for each game.

Sponsored Sol reviewed the saved traces in `evidence/codex/hackathon-paired-game-quality-review-20260915T065924.jsonl`. Its recommendations are useful product hypotheses, not expert learning validation:

1. Show local objective events alongside a decision: transport landing, station-control change and point tally. A board delta alone cannot attribute an effect to one order.
2. Make the ending rules explicit. In Pair0002 with Sol Blue, Blue led 33–27 but was eliminated at tick 2280. Points did not override elimination.
3. Preserve unresolved orders when a game ends. A launched transport or accepted construction is not a completed action.

The first implemented response is `round-feedback/2`, an opt-in for **new offline games**. Both players see the current and next queue order, cadence and advancement rule. Each also sees the status of its own last five orders and up to three earlier board observations. It adds no opponent private reply, future choice or invented causal explanation. Existing games retain their exact original snapshots and prompts.

Main ran 20 TypeScript harness tests, 38 Python runner tests and typecheck. The legacy qualifier still passes a saved paired game. A separate bounded comparison uses new seed HELD0001, both model-seat assignments and both observation versions, with at most 12 rounds per game and 96 provider calls overall. It uses sponsored Codex and Claude Max, no app Luna calls, and no automatic retries. A round-limit ending is reported as a cap rather than a victory.

Compare whether players explicitly distinguish admission from completion, notice current objective/ending rules and correctly refer to their previous information. Check traces before judging quality. One seed and four games cannot establish stronger play or human learning. The new profile is not yet deployed to the native continuous Red harness.


## Held-out comparison completed

All four new games independently verified: 88 provider calls, 44 rounds, no retries or app inference. All four initial fingerprints match. Legacy Sol Blue ended by Red elimination at tick1949 (Blue15/Red32). Feedback-v2 Sol Blue reached the12-round cap at3285 (50/44); feedback-v2 Opus Blue reached the same cap (55/44); legacy Opus Blue also reached it (59/35). The three capped games have no winner. Different stopping times and one stochastic sample per condition prevent causal or general strength conclusions.

A useful recorded example is Red decision7 in the feedback-v2 Sol-Blue game: it correctly references the current Blue-first queue and an82-tick earlier transport landing, and explicitly distinguishes admission from landing. Blue decision9 still calls a1432-tile interval gain the effect of its previous attack, despite the observation labelling that attack unobserved and warning that board differences combine multiple actions. Clearer context therefore does not eliminate causal overstatement. Exact source paths, hashes and saved excerpts are in `evidence/feedback-comparison/held0001-20260915/explanation-review.json`; the result table is in adjacent `report.json`. Next improve evidence-linked review and obtain expert playability feedback before making difficulty claims.
