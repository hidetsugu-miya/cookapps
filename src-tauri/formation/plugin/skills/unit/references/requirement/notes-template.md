# technical-notes.md

`{case root}/technical-notes.md` is the notes of the investigation of stage 2: internal material that the requirement stage, its reviewers and the design stage read.
It is outside the owner's approval. Write it in English.
Create it from the template below when it does not exist. Leave no `{{...}}` placeholder: replace each with its content or, where the template says so, delete the section.

```markdown
# Technical Investigation Notes

## UI reference

{{The source (a design file URL and node id, or the image path under ui-references/). The screen list, each with its node id (for a board that lays several screens in one frame, each screen's child node id), and the screen-transition flow: each transition with its trigger (the wording of the button, or the condition) and its destination screen's node id, or `unresolved`. Per screen: the layout, the main UI elements, the text. The display conditions and variations (count-dependent display, scrolling, hide conditions, differences by state). Design tokens (colors as hex, font size and weight, spacing and dimensions in px, component names). The searched pages: per point the linked design did not answer, the keywords, the pages searched and the hits. When there is no UI reference, delete this section.}}

## Project specifications

{{Paths of the specifications found under the project root and in the usual places (docs/, spec/, specifications/, design/), the naming conventions and term definitions, the data model, the business rules, and the consistency requirements with existing features. When none exists, write "none".}}

## Existing implementation

### {{feature or module under investigation}}

#### File paths

{{paths}}

#### Summary

{{what it does}}

#### Libraries

{{library names and what they are for}}

#### Implementation pattern

{{the pattern in use}}

## What/How classification

{{One entry per investigated item, in this form.}}

- item: {{item investigated}}
- classification: {{what | how}}
- category: {{processing-content | technology-choice | numeric-detail | architecture | database-identifier | code-identifier}}
- basis: {{file path:line, or the grounds of the investigation}}

## Resolved wording

{{One entry per vague expression that the investigation made concrete. An expression that could not be made concrete is not recorded here: it goes on the open-question list.}}

- original: {{the original wording}}
- resolved: {{the concrete target}}
- basis: {{file path:line, or the grounds of the investigation}}

## Investigation evidence

{{The grounds that show how the requirement corresponds to the existing implementation or specification, one entry per item.}}

- investigation-item: {{the item confirmed}}
- basis: {{file path:line}} and {{the matching code, 1 to 3 lines}}
- conclusion: {{what the evidence shows}}

## Settled investigation items

### Design scope

- Need for data migration: {{settled value}} (basis: {{...}})
- Impact on the API contract: {{settled value}} (basis: {{...}})
- Premises of the existing infrastructure: {{settled value}} (basis: {{...}})

### Other settled items

- Change kind: {{settled value}} (basis: {{...}})
- External-system-integration expectation: {{settled value}} (basis: {{...}})
- Operations expectation: {{settled value}} (basis: {{...}})
- Non-functional expectation: {{settled value}} (basis: {{...}})

## Related ADRs

{{The number, title and relation to the requirement of each related decision record. "none" when there is no record or no folder of them.}}
```
