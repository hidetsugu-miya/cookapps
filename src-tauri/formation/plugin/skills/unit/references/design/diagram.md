# The architecture diagram

The approval page ([6-approval](6-approval.md)) shows the design as one Mermaid flowchart, in a `diagram` block: the DESIGN items as nodes, and what depends on what as arrows.
It helps the owner see the shape of the design at a glance. It is a supplement: no reviewer inspects it, and it never settles or changes the design.

- Every node, arrow and label comes from `design.json`. Add nothing that the design does not state, and infer nothing from the code of a repository.
- Read `design.json` only with `jq`. Never write the file from here.
- Draw one flowchart. Draw no HTML and no image: the page draws the block.

## Steps

1. List the names of the items: `jq -r '.designs[] | "\(.id)\t\(.name)"' "{case root}/design.json"`.
2. Polish the names. Launch `feature-dev:prose-polisher` with one section for each name (headed by its `DESIGN-NN`), `body_only` `true`, and `design.json` as `materials`. Together with them polish the heading and the caption of the change section: `設計の全体像` and `基本設計の構成図`. Keep the final drafts as they come.
3. Make the labels and run the program (below). The labels are the final drafts of the names, as `{"DESIGN-01": "…"}`:

   ```sh
   jq -nr --slurpfile design "{case root}/design.json" --argjson labels '{labels as JSON}' -f "{jq dir}/design-diagram.jq" > "{scratch}/design-diagram.mmd"
   ```

   The program `design-diagram` is at the end of this file. It writes the node of each item, labelled `{id} {name}`; when the design has more than 12 items, it groups the nodes in one `subgraph` for each repository, in the order of `implementation_order`, which the design itself states; and for each `depends_on` an arrow from the item depended on to the item that depends on it.
4. Make the block, and put it in the change section of the page you are writing ([6-approval](6-approval.md), "Write the page"):

   ```sh
   p="{records}/page-{nn}.json"
   jq --rawfile m "{scratch}/design-diagram.mmd" --arg h "{heading}" --arg c "{caption}" '.changes = ((.changes // []) + [{heading: $h, blocks: [{type: "diagram", mermaid: $m, caption: $c}]}])' "$p" > "$p.new" && mv "$p.new" "$p"
   ```

   Do it once the page file is written, and before you send `PAGE`.
5. When the page tool refuses the page for the labels (a refusal that lists Japanese lines of the diagram that were not polished, or a syntax error of the Mermaid), fix the `.mmd` from the violations, polish the lines it lists in one run, replace them, rebuild the block and send the page again.
6. A diagram never blocks the unit. When you cannot make a valid one in three tries, leave the `diagram` block out of the page, and say in your `DONE` summary that the diagram was not shown.

## The program

```jq design-diagram
def esc: gsub("\""; "'");
def nid: "D" + .id[7:];
($ARGS.named.labels // {}) as $l
| $design[0] as $d
| ($d.designs | length) as $n
| ($d.implementation_order | to_entries | map({key: .value, value: "R\(.key + 1)"}) | from_entries) as $rid
| def node: "\(nid)[\"\(.id) \(($l[.id] // .name // "") | esc)\"]";
  "flowchart LR",
  (if $n > 12
   then ($d.implementation_order[] as $r
         | "  subgraph \($rid[$r])[\"\($r | esc)\"]",
           ($d.designs[] | select(.repository == $r) | "    " + node),
           "  end")
   else ($d.designs[] | "  " + node) end),
  ($d.designs[] | . as $x | $x.depends_on[]? | "  \({id: .id} | nid) --> \($x | nid)")
```
