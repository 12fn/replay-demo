# REPLAY learner quick start

You are about to play a fictional, abstract strategy exercise: Blue versus Red, territory and forces on a map. Nothing in it represents a real place, force, or doctrine. The point is not to win. The point is to practice making decisions with imperfect, aging information, and to be able to explain them afterward. How much territory you end with is recorded as a fact and is never used to judge your reasoning.

## Signing in and your seat

- In the pilot you sign in with your Kamiwaza account. Your workroom assigns your seat; you cannot change it in the app, and the header shows it. (Internal dry runs may use a local persona instead; the header says "Local demo identity" in that case.)
- In development version 0.4.1, use **Team → Join** with the code your instructor provides to enter a shared exercise. Your assigned seat stays the same, and your personal dossier counts your own contributions. The preserved 0.3.0 video/ZIP predates this feature.
- **Commander (Blue).** You issue orders. Click a tile, then use the Orders panel: expand into unclaimed land, attack Red where you share a border, send troops by boat, build (City, Defense Post, Port, Warship), or cancel an attack under way. A slider sets how many troops to commit.
- **Intelligence (Blue).** You cannot issue orders. You read reports, ask the staff, create standing watches, and write the assessment log. Your assessment log is your main product.
- The clock is in ticks. Ten ticks are one second. The header shows the current tick and the minute:second clock.

## The decision note (optional, but it is your evidence)

Under the commit slider there is a collapsible **Decision note**. Before you press an order button, write one line: what you expect, which report you are relying on (tick the box), what you are holding back and why, what you do not know. It is saved with that order as written at the time. It is optional. The game never pauses for it. Nobody will guess your reasons later: an order with no note is recorded as "reason not observed", not as a mistake.

If you tick a report that had not been released to your side yet, the order is refused with an explanation. Fix the note and send again.

After play you may add a statement to an order that has no note. It is labeled "post-hoc" and kept separate from what you wrote at the time.

## The map and the reports

- The map is fully visible to both sides. There is no hidden terrain.
- Reports are side-specific. Each side gets its own reports about the other side's forces. A report is an observation **at a stated tick**. It was true then. It gets stale. A newer report replaces the older one; the older one stays in the record as history and is shown as "superseded".
- The instructor releases reports during play. Each release is recorded.

## The staff panel

- **Watches.** Type an objective such as "alert me when the opposing force estimate changes". A watch keeps running after you close the panel and posts an update only when something material happens, naming the reports it used. By default it is a free deterministic check, not a model.
- **Ask staff.** A typed question gets one model answer generated from the current state and your side's recent reports. It cannot issue orders. It may be unavailable; if so, play on. If the answer cites something it was not shown, it is discarded rather than shown to you.
- Staff answers, watch updates and questions are recorded and visible in the review.

## The opponent

Red is controlled by software. By default it follows a simple fixed policy. The instructor may switch it to a model-driven controller; you will not be told during play. Either way, Red plays to its own objective. Nobody is steering it to teach you a lesson. If a side loses all territory the exercise ends on its own.

## What gets recorded

- Every order you submit, the tick you were looking at, your resources at that moment, and the result. Rejected orders too.
- Your decision notes, post-hoc statements and assessment entries, with when they were written.
- Every report and when it was released to your side; every watch update; your staff questions and the answers.
- The map state at every tick, so the review can return to any moment exactly.

Not recorded: your reasons unless you wrote them, audio or video, keystrokes, or any model "thinking". If the model opponent is on, its short summaries describe what it did, not why.

## The review

After the exercise ends, you and the instructor go back to a few moments in the Review view. You see exactly what was on your screen then, read your note, and talk through it. The "My practice" page shows your dossier: what you did and wrote, where the record is silent, and what to practice next. It contains counts, not scores. You may also see Red's reports and, if the model controller was on, its action summaries.

You may create a **branch**: pick a moment, pick a side (yours or Red's), state one assumption in writing, and play it differently. The original stays as it was. Branch play counts as practice with hindsight, not as proof you improved.

Optionally, after the end, a model may write a short debrief of one of your orders. It can use only the recorded evidence and must label anything you could not have known at the time as hindsight. If it breaks those rules, you will see "discarded" instead of a debrief.

## What this is not

- Not a graded test of you. Pilot scores describe observable behavior in this game and are used to find out whether the exercise itself is useful.
- Not a model of real tactics or any organization's doctrine.
- Not a measure of your reasoning ability. The record can only show what you did and what you wrote.

## Before you start

- Complete the short written probe. There is another after the session. They are not scored against you.
- Read and sign the consent text if you have not.
- Know your exercise ID (header exercise selector). It is how your session is found later.

## Choosing a practice situation

The New dialog offers classic Crosscurrent (the recorded demonstration), connected-land maneuver and overseas crossing. The latter two are experimental. Their scripted opponent can expand, construct, retain reserves and use transports. Neither has a promised duration: elimination ends the contest, and the facilitator may end early for review. The clock runs continuously after deployment.

Your seat determines your work: commanders issue orders; intelligence participants inspect sources and publish assessments; instructors manage the exercise and review evidence. Join the same exercise through its Team code when working together. Paid Luna inference starts off.
