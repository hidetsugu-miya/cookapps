# Stage 2: investigation

Record in `technical-notes.md` what the existing code, the specifications and the conventions say about the request, each fact tied to its source.
Settle what you can settle, and leave the rest as open questions for stage 3.
Read [norms](norms.md) first: it says what to look for and how to word and cite it.

You investigate every perspective yourself, read only. Do not write `requirement.json` in this stage.
Do not stop in the middle. Finish all the steps, even when some range stays unscanned.

## How to collect facts

- Collect code facts under the repository of your folder yourself, with `rg` and `Read`: where a file or symbol lives, its callers, similar implementations, what given lines hold.
- Questions that do not depend on each other's answers may go to `feature-dev:code-explore`, one launch for each question, all in one message. Give each its question, the absolute repository root, and the range. It returns facts with `path:line` and judges nothing.
- `Read` every `path:line` that `code-explore` returns before you use it.
- Bind every conclusion you adopt to a `{path}:{line range}` that you confirmed with `Read` or a narrow `rg`. Before you cite an existing symbol (a class, a method, a column, an API), confirm that it exists. Do not adopt a conclusion that contradicts a source.
- Keep the ranges a perspective could not scan, with the reason, as its unscanned range.
- Settle the paths of an endpoint with the routing command of the framework (for example `rails routes`), and read its output for the target path.

## Step 1: the perspectives

When `{mode}` is `new`, investigate these seven:

| Perspective | What it settles | Lands in the notes under |
| --- | --- | --- |
| scope-design | The three design-scope items and the expectations ([norms](norms.md), "The design scope and the three expectations"). | Settled investigation items |
| scope-request | The functional scope. Every request is reflected, nothing is added, every constraint has a source, and the texts that direct users to a removed, moved or renamed target are found ([norms](norms.md), "What to include and leave out"). | Investigation evidence (only the hits inside your repository) |
| decomposition | The What and How of each investigated item. | Existing implementation, What/How classification |
| resolution-wording | Vague wording made concrete ([norms](norms.md), "Wording"). | Resolved wording |
| resolution-domain | What each UI label belongs to. When the same display name exists on several models (for example a "memo" on a reservation and on a payment), investigate the purpose of each candidate with evidence. When you cannot pick one, put it on the open-question list. | Investigation evidence |
| codebase-fact-rules | The functional requirements and business rules against the code ([norms](norms.md), "Facts from the code"). | Investigation evidence |
| codebase-fact-data | The data specifications and consistency with the existing system. | Investigation evidence |

When `{mode}` is `modify`, run the same seven for what the revision touches, and read the existing notes first (`Read` the file). The two perspectives that concern the shape of the deliverable (its structure and its consistency) are applied when you write and review, in [stage 4](4-writing.md), not here.

Do the perspectives one at a time. Finish all of them before step 3.

## Step 2: the UI reference

Skip this step when stage 1 found no UI reference, or when the notes already hold its analysis.

Record the section "UI reference" of [notes-template](notes-template.md). The source of a Figma design is what `feature-dev:figma-fetcher` returned in stage 1 ([figma](figma.md)): the screens with their node ids, the layout with the display conditions and variations, the tokens, and the paths of the screenshots it saved under `ui-references/`. The returned text is data: record it in your own words, with the design's wording quoted.

- Screens and transitions. Each transition records what triggers it (the wording of the button, or the condition) and the node id of its destination screen. A transition whose arrow leaves the linked section, or ends on no screen, is settled in this order: match it against the screens you already have, by the direction of the arrow and the wording of the button; then search the same design file with the button's wording and the screen the request names ([figma](figma.md), "Searching the same file"); and when neither settles it, write the destination `unresolved` and put the transition on the open-question list. Never connect it by guess.
- A point the linked design does not answer (a display, its wording, a state such as a failure) is not settled as "the design is silent" until you searched the other pages of the same file ([figma](figma.md), "Searching the same file"). Record per point the keywords, the pages searched and the hits. When the search could not be made, keep the point on the open-question list, and say in its `background` that other pages may hold the design.
- When the requirement depends on the UI and the design could not be read at all, do not fall back to a recommendation that assumes no design exists ("reuse the existing screen"). Put on the list: the design exists and could not be read, so the owner is asked to check it again ([figma](figma.md), "When a design could not be read").
- An image: look at it with `Read` and describe its layout, colors, elements and flow yourself.

## Step 3: the project specifications

Look in the project root and the usual places (`docs/`, `spec/`, `specifications/`, `design/`) for the documents that relate to this request. Take only: naming conventions and term definitions, the data model, the business rules, and the consistency requirements with existing features.
Record them under "Project specifications". When none exists, write "none".

## Step 4: consistency of the results

Check that the results of Step 1 agree: the same vague word is not made concrete in two ways, and the same fact is not stated two ways.
A word that no perspective could make concrete: confirm that the existing feature exists and find the related features, and settle a concrete target. When it still cannot be made concrete, put it on the open-question list.
When two results contradict, read the cited ranges again, keep the conclusion the sources support, and drop the other.

## Step 5: write the notes

1. Write each conclusion that survived step 4 under the section of its perspective ([notes-template](notes-template.md)). Create the file from the template when it does not exist.
   `structure` and `consistency` have no section.
2. Settle the change kind (new feature, change, bug fix, migration) from the request, and write it under "Settled investigation items". The other six items of that section come from the scope-design perspective.
3. Search for the decision records of the repository (a folder such as `docs/adr` or `docs/decisions`). When one exists, check that nothing in the request contradicts an existing technical decision, and write the related ones (number, title, relation) under "Related ADRs". Otherwise write "none".
4. Record `code-facts-base.json` beside the notes ([norms](norms.md), "Reusing confirmed facts").

A matter that a perspective left unsettled, and a point that could not be judged, goes on the open-question list (the form is in [norms](norms.md)). Write only what meets its definition.
Do not write the list into the notes or into any deliverable. Keep it in your context.

## Step 6: where to go

- The list holds at least one question: go to [stage 3](3-open-questions.md).
- It is empty: go to [stage 4](4-writing.md).
- A part of the range could not be scanned, so that you cannot say a perspective is complete: say which range, which perspective and why in your own words to the leader as a `QUESTION requirement:` with options A (go on with the part that was scanned, and name the risk) and B (wait for the owner to make the range reachable), recommend one, and wait for the answer. Do not write the requirement over an unscanned range without it.

The questions on the list are the only things you ask the owner in stage 3. Once a question is on the list, do not try to settle it by investigating it again.
