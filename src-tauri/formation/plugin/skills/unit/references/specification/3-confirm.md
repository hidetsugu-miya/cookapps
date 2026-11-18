# Stage 3: Confirm

Check the written specification once against the check perspectives of [conventions](conventions.md), fix what the check finds with one fix run, and look again at only the fixed places.
There is no owner gate. The only judge is the check perspectives: a finding that matches none of them is not a defect.

## What to read

- The specification files of Stage 2.
- The DESIGN items and REQs of `design.json` and `requirement.json` that the specification covers, with `jq`.
- The code facts you collected in Stage 2.
- Whether the entry-point paths and the related-specification references the specification writes exist (`rg`, `ls`). Do not investigate the code beyond those existence checks.

## Steps

1. Read each file and check it against the nine perspectives. Record each defect as: the location (`path:line` and the heading), the gist of the defect, and the gist of how to fix it.
2. **No defect**: go to [Stage 4](4-complete.md).
3. **A defect**: fix it with one fix run, and only one.
   - Go back to [Stage 2](2-write.md), steps 3 and 4, as a fix run: the files that carry a defect are updated in place at the recorded places and at what they spread to. A `file-structure-choice` defect applies Case B again to its domain and settles the option its criteria select; the files that option creates or restructures are written too.
   - Polish what you changed, as Stage 2 says.
4. Look again only at the locations you recorded, and check whether each defect is resolved. Keep each one that is not resolved for the report: its location, the gist, and the reason it remains (the reason you could not resolve it, or `修正後も残存`).
5. Do not run a second fix for what the fix left. Go to [Stage 4](4-complete.md).
