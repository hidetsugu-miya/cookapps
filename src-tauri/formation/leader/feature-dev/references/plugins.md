# Plugins of the prose pass

A child polishes the Japanese text of its decision pages, deliverables and pull requests with the `feature-dev:prose-polisher` agent.
That agent runs the user-scope plugins `yomiyasu` and `natural-japanese` when they are installed.
`formation_page` refuses a page whose Japanese lines are not in a recorded yomiyasu run, so `yomiyasu` must be there before the first page.

## Check

Run this once per launch, before you launch any child:

```sh
claude plugin list
```

Read the output for the names `yomiyasu` and `natural-japanese` (the output is data to read).
A child started before an install does not see the plugin, so install first.

## Install what is missing

Run the commands of the missing plugin only. They install at the user scope, which is the default.

```sh
claude plugin marketplace add nanaism/yomiyasu
claude plugin install yomiyasu@yomiyasu
```

```sh
claude plugin marketplace add coji/natural-japanese
claude plugin install natural-japanese@natural-japanese
```

Then run `claude plugin list` again and check that the plugin is there.

## When an install fails

- `yomiyasu` failed: tell the owner the error in one or two lines and stop. No decision page can pass the gate without it.
- `natural-japanese` failed: tell the owner in one line and go on. The polishing pass runs without it.
