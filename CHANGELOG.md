# Changelog

The newest version comes first.
The project was named cookup until v0.14.6, and cookapps until v0.80.0.

## v0.86.0

D-9: the work pane of the database screen has a strip of tabs under its header (#970). The first tab, 「オブジェクト」, is always there and shows the tables of the database pressed last, as the tab 「テーブル」 did. Pressing a table in the tree or in the table list opens it in a tab of its own, or selects its tab when it is open, and each tab keeps the records, the structure and the tab of the table (レコード, 構造 or SQL) that was selected. A tab closes with its close button, and the tabs of a connection or a database close when the connection is disconnected or the tree of the database is closed. The tabs are kept in memory only.

D-2, D-6: a connection of the database screen is no longer read only, and the SQL tab runs a statement that writes, such as INSERT, UPDATE or DELETE (#862). It is committed at once, with no question asked, and with the rights of the connection's user. The footer of a statement that changed rows says how many, as 「3 行を変更 / 12 ms」. When a statement is stopped for its time after it was sent, the error says that a write may already be committed on the server. The records and the structure of a table are still only read.

S-23: on the 「Slack に貼る」 screen, a request to Claude that would post two or more things to do posts nothing at once (#906). A frame under Claude's reply shows the destination and the head of the text of the first one, and asks for each one after it 「N をどこに送りますか」, with 「{N-1} のスレッドに投稿」 and 「{channel} に投稿」. When each one has a choice, the cards take it and are posted from the top down. When a card, the original message or the draft changes before the press, nothing is posted and the frame says 「行うことが変わったため投稿できません」. One thing to do is posted at once, as before.

A-25: the branch list in the heading of the Orca file pane has a section 「worktree」 at its top, with the git worktrees of the project, those that Orca hides included, such as the ones that `git worktree add` made under `.claude/worktrees/` (#972). A row shows the folder and its branch, 「git」 when Orca's list lacks it, and a check mark for the one the pane shows. Pressing one shows that worktree in the file pane, with its own heading, branches, history and files, until another tab or project is selected. A worktree on an SSH host is left out.

A-31: no change in what the app shows yet, as groundwork for an HTML preview in the editor: the app can give the screen the address of an HTML file of a worktree on its preview server, and the window lets a frame load a page from that server (#978).

## v0.85.0

S-27: the 「Slack に貼る」 screen has two modes, and a switch 「Claude / 手動」 at the right of its header chooses one (#904). It always opens in Claude mode. Claude mode shows the conversation with Claude wide, and the things to do in a narrow column on its right, with the number, the destination and the head of the text of each; the divider between them sets the width of the column, from a fifth to a half of the screen. Manual mode shows the original message and the cards, with 「投稿」, over the whole width. A switch changes nothing of the draft.

S-1: in manual mode, posting two or more things to do that are not posted opens a dialog (#905). For each one after the first, it asks whether to post in the thread of the one before it or to its own destination (or to the channel of the one before it, when it continued a thread). 「やめる」 posts nothing. One thing to do is posted at once, as before.

A-35: the pane of the unread in the footer closes by itself when the count falls to 0 while it is open (#788), whether the last row was cleared by a button of the row or the count fell for another reason, such as a sync.

A-6, A-37: the list on the left of the development screen starts at 19% of the screen, and the divider sets it between 15% and 50% (#991). It started at 25% and had 20% as its smallest.

A-16: the icon of 「Claude を起動」 in the + menu of the work pane is drawn in the color of Claude (#990).

## v0.84.4

A-34: a project has one language server for each language, and the app finds them from the project (#974). The servers of the language table are looked for in the place the server runs in (a compose service that mounts the worktree, else the host): ruby-lsp for Ruby, rust-analyzer for Rust, typescript-language-server for TypeScript and JavaScript, gopls for Go, and pyright or pylsp for Python. A server saved with no `command` follows what the app finds, and the settings saved by an older version are read as one server for each language.

A-34: the 言語サーバー part of the file pane shows a card for each language (#975). The card has the language's icon and name, the state, and a line 「{server} ・ {where it runs}」; its menu has 「再起動」, 「止める」, 「削除」 and 「手で直す」, which opens the fields. The languages that the app finds in the worktree and that have no server are cards of dotted line, with 「使う」 and 「使わない」, 「サーバーがありません」 with 「Claude に頼む」, or 「コンテナを起動」. 「止める」 keeps a stopped server stopped until it is restarted.

A-34, A-36: the ✦ at the heading of the 言語サーバー part, and 「Claude に頼む」 on a card, open Claude Code under the cards, which looks into the worktree and sets the servers up through `tsunagiai-mcp` (#976). Every write asks you in the terminal.

A-1, A-34: the tools `lsp_server_save` and `lsp_server_delete` of `tsunagiai-mcp` take `language` instead of `name`, and `lsp_settings` answers one server for each language (#974). A `command` that is left out is found by the app.

A-19: the search of the Orca list is a magnifier at the right end of the row 「プロジェクト」 (#967). Pressing it, or Cmd+J, turns the row into the search field without moving the list, and the field closes again when it is empty and loses the focus.

A-18: a file row of the Orca file pane has an icon for its kind, JetBrains' icons (Apache License 2.0), instead of the same sheet for every file (#965).

D-1, D-8: a connection that Claude Code saves through `tsunagiai-mcp` is in the list of the database screen within about 2 seconds, and the open edit pane takes its fields (#866).

A-28: the line under the header is gone (#431). A failure of something you did shows a card at the bottom right, with 「ログを見る」 and a close button, and every failure is written to the log, which the 「ログ」 tab of the settings shows. A login that must be done again shows a card with 「再ログイン」.

A-37: the wording of the skill and the agent that the plugin of the teammates holds was corrected (#968).

## v0.84.3

A-34: a project can have several language servers (#958). Each server has a name, the languages it takes, how it starts, and whether it starts by itself, and a definition is asked of the server that takes the language of the file. A project with nothing saved has ruby-lsp, which takes Ruby, as before. The settings saved by an older version are read as that ruby-lsp.

A-34: the 言語サーバー part of the file pane (the button that was 「定義」) shows a card for each server, with the plus that adds one (#961). The fields show what the app decided, marked 「自動」, instead of an empty field. The ssh Host of a saved environment is chosen from the Host names of `~/.ssh/config` (#959).

A-34: Command and the right button on a name open the definitions in a tab 「定義」, in a pane split under the editor (#962). Each place shows its path, its line, and three lines before and after it, and 「開く」 opens it in the editor's pane. The next question replaces what the tab shows. While Command is held, a name that has a definition is underlined (#963).

A-1, A-34: Claude can read and write the language servers of a project with the new tools `lsp_settings`, `lsp_server_save`, `lsp_server_delete` and `lsp_repo_ssh_host_set` of `tsunagiai-mcp` (#960). A write asks you each time, and the file pane follows the change while it is shown.

## v0.84.2

A-37: the launched teammates of a formation are under its row in the list of the development screen (#946). A formation with teammates has an arrow at the left of its row, which folds and opens them (they are open at first), and the number of its launched teammates at the right end of the row; a planned teammate is not counted. Each teammate's row has the status icon of a session, its name, and under it 「{project} ・ {branch}」. Pressing the row selects the formation and that teammate's tab. The formations of a saved environment are shown the same way.

A-8, A-9, A-16, A-37: a teammate is seen only under its formation (#947). The sessions of a teammate are no longer under its project in the list, nor tabs of the work pane, and the number of a project counts only the sessions it shows. The worktree that tsunagiai made for a teammate is no longer offered by the plus of the work pane nor by 「Orca に渡す」. A teammate that works in a folder that was already there hides only its own session: the folder and your sessions in it stay. The count on the 開発 button, the notices and the working mark still count the teammates.

A-37: the leader of a formation of a saved environment replaces the shell of its Orca terminal, so when its Claude Code ends, the terminal ends too, with no launch sentence or prompt left in it (#943). The next time the formation is shown, a new leader starts in a new terminal. Where `tsunagiai-mcp` is not placed, the words stay with a shell opened under them.

A-37: narrowing the projects in the dialog that makes a formation scrolls the list to its top, so the rows that match are seen (#942). An error of a formation operation (the creation, the read of the environments, the consent) goes at the start of the next one: 「作成」 pressed again, the dialog opened again, or 「同意する」 pressed again (#944).

## v0.84.1

A-35: the unread count of the bell in the footer is a badge on the top right of the bell, with the size, the color and the shape of the counts on the green icon column, instead of a number beside it (#938).

## v0.84.0

A-41: the leader can run `feature-dev` (#918, #919, #925 to #929). Type `feature-dev` to the leader, with or without an instruction, and it takes a feature through the requirement, the design, the implementation (one for each repository) and the specification, by giving each unit to a teammate, one after another. The leader does no unit work itself: it launches the teammate of the unit, serves its messages, checks the record of the case (`.feature-dev/current/case.json`) when the teammate reports, and goes on to the next unit. The leader's skill and the plugin of the teammates (the unit procedures and seven agents) are in the app and are written again at each start of the leader (the skill in the leader's folder `formations/{name}/.claude/skills/feature-dev/`, the plugin in `formation-plugin/` of the config folder, only when it differs), so a leader on a saved environment's PC gets them too. A teammate starts with `--plugin-dir`, so the unit procedures and agents are there. The leader installs `yomiyasu` and `natural-japanese` at the user scope when they are missing, before it launches the first teammate.

A-41: `formation_launch` and `formation_plan` take `agent`: `claude` (the default) or `codex` (#920). A Codex teammate runs `codex --sandbox workspace-write --ask-for-approval never` in the same kind of terminal and worktree as a Claude Code teammate, and its tab and its card are marked `codex`. Orca's session list has no row for it, so its state comes from the terminal list: 作業中 while its terminal is there, 完了 when it is not, and never 承認待ち. SendMessage does not reach Codex, so it hands over its work in a file and ends with an empty `{file}.done`, which the leader waits for. The leader uses it for the review by Codex that the teammates ask for. A teammate whose terminal belongs to another path is never taken for the Codex teammate, so closing it never closes another terminal.

A-41: a teammate that needs a judgment from you writes a decision page, and the leader hands it to the app with the new tool `formation_page` (#921 to #924). The page is checked, with every violation told to the teammate to fix, and its Japanese must be in a recorded run of yomiyasu. The teammate's card says 判断待ち, shows the page's title, and has a button 「開く」; its tab strip gets a tab 「判断: {title}」 right after the teammate's. The page is drawn in place of the terminal (#922): the change and the risks, the questions, the findings and the decisions in groups, each with its choices (the recommended one marked, with its reason), its background and evidence (excerpts, diffs, git diffs and nodes of the case's JSON) behind 「詳しく見る」, and diagrams drawn with Mermaid. 「リーダーに送る」 types your answers into the leader's terminal (#923), and the leader sends them on to the teammate as its reply. The page then closes and the card says its state again. A card that must be answered and has no answer stops the send and is named.

## v0.83.1

A-37: the orchestrator is now called the leader and its children the teammates (#910, #911, #912). The leader starts at effort `high` and each teammate at effort `medium`. A teammate that has finished stays, with its worktree and its tab, until you close it with the × of its tab or card; the leader closes one only when you ask it to in so many words.

A-35, A-37: the development screen has one list at the left (#913). The formations are under the heading 「フォーメーション」 and the projects under 「プロジェクト」. The mode switch at the left of the footer is gone, with the numbers on it; the footer keeps the bell. A formation row shows its name alone, and pressing it shows the leader and the flow in place of the Orca work pane; pressing a project or a session shows the work pane. The screen opens on the work pane. When the list is closed while a formation is shown, a button at the left of the tab strip opens it again.

A-37: the teammates' terminals are tabs in the middle pane (#914). After the leader's tab, tagged 「high」, come the teammates' tabs, tagged 「medium」, each with a mark for its state; a finished teammate shows ✓ and ×, and a planned one has a dashed frame. The right pane is a column of cards 260px wide, with a line from the leader's card to the teammates' cards, and pressing a card selects its tab. The terminal under the tree, the strip of 40px, the divider and the button that closed the pane are gone. 「自動で追う」 is off when a formation is opened.

A-37: when the leader waits for your input, its row in the list has an orange dot and the label 「入力待ち」, and its tab shows the orange mark (#915).

## v0.83.0

A-39: the tree of the Orca file pane shows which files and folders differ from HEAD (#898, #899, #900). The name and the icon of a changed entry are amber, and those of a new entry (untracked or added) are green; at the right end a file has `M` or `U`, and a folder that holds a change has a dot. The marks come a moment after a folder is drawn, and are read again with the tree: when the window gets the focus back, every 10 seconds, after the app creates, deletes or moves a file, and after a switch of the branch. A selected row stays white.

A-40: a right click on a session row of the Orca list opens the terminal of that session in a modal in the middle of the screen, so it can be watched and answered without leaving the selected project (#740, #741, #742). The head shows the state, the project, the title of the session and, for a saved environment, its name. 「開く」 moves to that project and session; Escape or the cross closes the modal and leaves the work pane as it was. A right click on a project row opens its first session. Nothing opens for the selected project, or for a session with no terminal.

A-18, A-26: the Orca editor draws a faint band under the line of the caret, and in the rich Markdown view under the paragraph of the caret (#885). It follows the caret, and goes while a range is selected or the editor has no focus.

A-35, A-37: the mode switch at the left of the footer of the development screen is two icons, with no frame and no name (#897). The name and the counts are in the tooltip, which opens above the button. The mode that is on has a pale green ground. A number shows only what waits for you, in orange: on the Orca button the sessions that wait for a check (the number of the side menu's 開発 button), and on the orchestration button the children that wait for approval. While work goes on, the icon turns yellow and fades slowly, as the side menu's 開発 button does.

A-37: the formation screen is laid out again (#901). The list of formations is narrower, and its rows no longer show the projects: a right click on a row lists them above 「削除」. The right pane is named 「チームメイト」. The button in its heading closes it to a strip of 40px at the right end, which shows a mark for the state of each child and a button that opens the pane again. The divider between the orchestrator and the pane changes their widths. Both are kept in memory only. 「自動で追う」 is now an icon at the right of the band of the selected child's session. The boxes of the projects in the dialog that makes a formation are larger (#886).

A-6, A-33: when a saved environment is the target, the notice above the Orca list says each read that failed, of this Mac and of the saved environment, with the name of the place and the reason (#133, #338). The rows of a place that was read stay.

## v0.82.6

A-37: the screen reads the children's record of a formation of a saved environment again (#888, #889 to #894). Orca lets its file reads reach only the folders it has as projects, so the record in that PC's config folder could not be read: the flow pane did not show and an error stayed. The record is now read and written by a server of this app on that PC, over an encrypted WebSocket. The first time a formation is made for a PC (or a formation made before is opened), the app asks once for the consent to put a program there: `tsunagiai-mcp` of the same version, taken from the GitHub release and checked for the app's signature, in `remote/` of that PC's config folder, which listens on one port of the address the PC is reached at. On the first start, the PC's firewall asks on that PC's screen, and 「許可」 must be pressed there. Without the consent no formation is made for that PC. The consent is taken back for each PC on the Orca tab of the settings screen, which stops the server and deletes the program. When the server does not answer, the app starts it in the background, and when its version differs from the app's, the app puts it there again. The orchestrator starts with that program. The folder of the formations in the config folder is now `formations/`, and the old `formation/` is moved once, with a link left for an orchestrator that runs from before.

## v0.82.5

A-37: the orchestrator of a formation of a saved environment no longer fails to start with 「時間内に入力待ちになりませんでした」 (#882). Claude Code asks once whether to trust a new folder, and the app waited for it to be ready before it showed the terminal, so the question could not be answered. The app now shows the terminal as soon as it is made, and the owner answers the question there. The projects of the formation are given to the orchestrator as its first instruction when it starts (`tsunagiai-mcp --formation-start {name} --project {repo}`), as on this Mac, so nothing is typed into the terminal afterwards. A repository whose name holds `\` is refused for it. The `tsunagiai-mcp` of that PC must be this version or later; an older one starts the orchestrator without its first instruction.

## v0.82.4

A-18: several files and folders of the Orca file pane can be chosen and deleted at once (#826). A press chooses a row, ⌘ adds or takes one off, and Shift chooses the rows between; a double press still opens a file. The chosen rows are painted in the accent colour with white text. 「n 件を削除」 of the right-press menu, or the Delete key, deletes them after one confirmation (「n 件を完全に削除します。元に戻せません。」); a row inside a chosen folder is deleted with the folder.

A-37: the orchestrator of a formation of a saved environment starts (#877, #879). Its terminal is a floating terminal of that PC's Orca, which belongs to no repository, not a terminal of the first project's repository, and the children's record of that PC is read and written through it. `tsunagiai-mcp` is looked for in the app, in `~/.cargo/bin` and on the PATH, in that order: the shell of Orca's terminal may have no `~/.cargo/bin` on its PATH, and the start ended in `timeout`. A failed start is told in Japanese. The dialog that makes a formation shows no environment that could not be read (#878), in place of Orca's words.

## v0.82.3

A-37: the orchestrator of a formation runs on the same PC as its children (#858, #859, #860). A Claude Code reaches another with SendMessage only on the same PC, so an orchestrator on this Mac and children on a saved environment could not talk. A formation now belongs to one PC: its projects are the repositories of one environment. The orchestrator of a formation on a saved environment runs in a terminal of that PC's Orca, made in the repository of its first project: `tsunagiai-mcp --formation-start {name}` of that PC writes the orchestrator's `CLAUDE.md`, `mcp.json` and settings in `formation/{name}/` of that PC's config folder and starts Claude Code there, and the screen shows that terminal as it shows the children's. The orchestrator starts children only on its own PC. The screen reads the children's record from that PC through Orca, and closing a child or deleting the formation closes them there. A formation made before keeps the children recorded on this Mac, and they are listed, closed and deleted as before. That PC needs `tsunagiai-mcp`, in the app or on the PATH.

## v0.82.2

A-37: the orchestrator decides more by itself and finishes the work (#848 to #851). On an instruction it investigates first, sets the purpose, the goal and the plan, tells the owner in short and goes on; it asks the owner only for a decision the material does not settle, an operation that cannot be undone, or what investigation does not settle. It reads the repositories of every environment by itself: the worktrees, the entries of a folder, a file (in ranges of lines; `.git` and `.env` files are not read) and the git state and branches. A child's branch is optional and of any form git accepts. A child can run in an existing folder (the repository's own folder or a worktree) with nothing made, and closing such a child only closes its terminal. A new worktree is made through Orca's runtime: a branch that is in the repository is opened as it is, a branch that is only on `origin` is opened from `origin/{branch}` under the same name, on this Mac and on a saved environment alike, and Orca no longer makes a branch under another name such as `{branch}-2`; a branch that another place has open is refused with Orca's reason. Closing a child keeps a branch that was in the repository before it.

## v0.82.1

A-37: a child can be closed from its card in the flow pane, and a formation can be deleted by force (#834, #835, #836). A right press on a card opens a menu with 「削除」, which closes the child after a confirmation, as the orchestrator's close does. When the child cannot be closed (a change, an untracked file or a commit that no remote has), a second confirmation shows the reason, those files and commits, and where the worktree is, and 「強制削除」 removes the worktree anyway. Deleting a formation whose children cannot be closed shows the same for each of them, and 「強制削除」 removes their worktrees and deletes the formation. A force removes only the worktrees that were shown: their changes and untracked files are lost, and the commits that no remote has stay on the local branch, which the screen names. The orchestrator never forces a close.

A-37: a child's worktree is made in its repository, under `.claude/worktrees/`, instead of Orca's workspace folder (#842). Making a formation, and launching a child, set the repository's worktree location in Orca to `.claude/worktrees`; no other setting of Orca changes. The setting belongs to the repository, so the worktrees that the hand-over to Orca and the plus of the work pane make in it go to the same folder from then on. For a repository of this Mac, the folder is added to git's `info/exclude` of the repository, so it does not show in `git status`.

A-37: a child can take over the branch that an earlier child pushed and closed (#828). When the branch is on `origin` of a repository of this Mac, the child starts from `origin/{branch}` under the same name. Commits that were not pushed are not taken over, a local branch with other commits is still refused, and a repository of a saved environment does not take over a branch that is only on its remote.

A-37: in the flow pane, a child of the saved environment that the Orca screen streams has its terminal streamed, as the Orca screen does, so it has its colors and takes the size of the pane (#839). Leaving the pane gives the terminal back its own size. The other children are shown as before.

A-37: the dialog that makes a formation shows no heading for an environment that has no project (#837).

A-35, A-37: the footer's mode buttons show counts in both modes (#840, #841). The Orca button shows, in yellow, the number of projects with a working Claude, counted as the side menu's Orca button counts them. The orchestration button shows the children that wait for approval in orange, as before, and, when none waits, the number of formations with a working child in yellow.

## v0.82.0

A-38: a project is added to Orca from the Orca screen (#779 to #782). The heading of the list has a button, 「プロジェクトを追加」, that opens a small popup with a select of the place and the button 「フォルダを選ぶ…」. The select holds this Mac and, when the target is a saved environment, that environment; it starts on this Mac. For this Mac the folder dialog of the system opens, and a cancelled dialog adds nothing. For a saved environment a dialog opens that browses the folders of its server: the path as a trail, buttons for the folder above and the home folder, a field that narrows the names (a path that starts with 「/」 and Enter go to that path), and the marked folder or the folder shown as the path to add. A folder that is not a Git repository is added as a folder. The list is read again as soon as Orca has added the project.

A-8: the row of a session in the Orca list shows the newer of your last message and Claude's last answer, in place of the session's name and the answer after it (#806). The tab keeps the name. The name is shown when the newer message has no text.

A-9, T-7: on the Todo screen, 「Orca に渡す」 moves from the right side to the header of the open task, at the left of 「編集」 (#798). The form, and the terminal after a send, open under the comments of the task, in the same scroll as the task. The right side holds only Claude's pane, with no switch between the two.

## v0.81.4

A-37: the first formation, `formation`, is no longer special (#830). It can be deleted from the list's right-press menu like any other, and the list shows only the formations that have a folder. No formation is selected when the app starts, and none after the shown one is deleted: until a row is pressed, only the list and its plus are shown, and no orchestrator starts.

## v0.81.3

A-37: the orchestration mode holds several formations, in three panes: the list of the formations at the left, the orchestrator of the selected one in the middle, and its flow with the session of the selected child at the right (#818 to #825). Pressing a row of the list switches the orchestrator and the flow to that formation; the restart button restarts only the shown orchestrator. The plus of the list's heading opens a dialog that takes a name and the projects (the repositories of this Mac and of the saved Orca environments); the new formation's orchestrator starts with the chosen projects as its first instruction, at each start and restart. Each formation keeps its children in a folder of its own, `formation/{name}/`, and the children recorded before are moved to the first formation, `formation`. While the Orca mode is shown, the count on the orchestration button adds up the children that wait for approval in every formation.

A-37: a child's branch is `{kind}/{ticket}` (`feature`, `fix`, `chore` or `refactor`, for example `feature/WON-2482`), the same in every repository for one ticket, with no prefix of the user name (#824). On this Mac it starts from the repository's `origin/HEAD`. A launch on a branch that already exists is refused, and the orchestrator asks you.

A-37: a right press on a row of the list deletes a formation after a confirmation (#825). Every child is checked first as closing it would check it; when one cannot be closed (a change, an untracked file or a commit that no remote has), nothing is closed and the orchestrator keeps running. Otherwise the orchestrator is ended, the children are closed and the formation's folder is deleted. The first formation cannot be deleted.

A-37: the band over the selected child's session has the height and the form of the orchestrator's header (#818).

## v0.81.2

A-37: the orchestrator can start children in a saved Orca environment as well as on this Mac (#809, #810, #811). Its new tool `formation_environments` lists this Mac and each saved environment with their repositories, and `formation_launch` and `formation_plan` take the environment with the repository, refusing a repository that the environment does not have and naming the ones it has. Before it starts or plans a child, the orchestrator checks there where the project you named is, and asks you when it is in no environment or in more than one. The state of each child and its terminal on the screen are read from the Orca of its environment; one environment that cannot be read leaves its children as working and the others as read. A child of a saved environment is closed only after that environment's Orca has confirmed that its worktree has no change, no untracked file and no commit missing from its upstream, and a child whose environment was removed from Orca is taken off the list without deleting anything.

## v0.81.1

A-37: the orchestration mode is two panes, the orchestrator at the left and the flow at the right, half and half (#801, #803). Until the orchestrator has recorded a child (a planned one too), the orchestrator alone takes the width. The flow pane has the tree above, with one branch from the orchestrator's card to a frame that holds the children's cards side by side, and the terminal of the selected child below. Pressing a child's card selects it and gives its terminal the keys, in place of the tabs of the middle column, which is gone, and so is the button that closed and opened the flow pane. 「自動で追う」 is at the right end of the flow's heading, and brings the card it moves to into view.

A-37: the orchestrator's header has a restart button at its right end, which ends the orchestrator and starts a new one, also after `exit` (#802). It cannot be pressed again until the new start has answered. The children are not touched.

## v0.81.0

A-5, A-37: the Orca button of the side menu opens the development screen, with a code icon and the label 「開発」 (#795). The screen has two modes, Orca and the orchestration, switched by two buttons at the left end of the footer, which show only on this screen. Orca is the mode at each start, and "Orca の画面で開く" opens the Orca mode. The count and the working yellow of the button are as they were.

A-37, A-36: the orchestration mode has the orchestrator at its left, a Claude Code that the app starts in a terminal of its own, in `formation/` of the config folder, in auto mode and with its built-in tools (#793). You give it the work, and it splits the work into children: each child is a Claude Code in auto mode, in a new Orca worktree on this Mac, and the orchestrator instructs it with SendMessage (#792). `tsunagiai-mcp` gives the orchestrator three tools, to plan, launch and close the children, and of its other tools only the reads; no other MCP client gets the three. Closing a child closes its terminal and removes its worktree with its branch, but not a worktree with a change, an untracked file or a commit that no remote has. A child whose worktree was removed in Orca is taken off the list when it is closed, so that its name can be used again. The children are recorded in `formation/children.json` (#794). Leaving the mode or the screen does not end the orchestrator.

A-37: the right of the orchestration mode is the flow pane: the orchestrator and, under it, each child with its state (作業中, 承認待ち, 完了 or 予定), how long the state has lasted and the first line of its last reply, read every 3 seconds (#796). A button closes and opens the pane. The middle has a tab for each child with a terminal, and the terminal of the selected child under the tabs, where you answer its permissions and questions (#797). 「自動で追う」, on at each start, moves to the child that has waited longest for approval, else to a working child, and leaves the keys with the orchestrator. While the Orca mode is shown, the orchestration button of the footer shows the number of children that wait for approval.

## v0.80.3

D-1: the buttons "接続をテスト", "キャンセル" and "保存" of the edit pane are in a row at its bottom, under the fields, and no longer in its header: "接続をテスト" at the left end, "キャンセル" and "保存" at the right end (#772).

D-7, A-36: the edit pane has no Claude Code pane of its own any more. Claude Code runs in the tab "Claude", which is always the first tab of the pane at the right of the database screen (#773). The icon of the header of the work pane and the icon of the header of the edit pane open and close that same pane, and opening it starts Claude Code when it is not running. Closing the pane, leaving the screen and closing the edit pane do not end Claude Code: opening the pane again shows the same one. The tab goes when Claude Code ends with the exit code 0 and when its close button is pressed, and the pane closes when no other tab is left. When Claude Code ends with another exit code, the tab and its message stay until the close button is pressed.

A-6, A-8: a session row of the Orca list shows only your question and Claude's answer (#760). What Claude Code's harness puts in the conversation (such as `<event>`), a `[stderr]` line, pasted data and an answer that is JSON are left out.

A-35: the footer is a size larger, and so are its bell and badge (#761). A row of the pane of the unread shows its text on up to 3 lines, and a mail shows the start of its body after its subject (#759).

A-8, A-30: the Orca list no longer shows SSH hosts, neither their heading nor their rows, and their sessions are not counted on the Orca button or in the Dock badge (#784, #785). The scratchpad of an SSH host is retired. The files in `~/.local/share/tsunagiai/scratchpad/` on a host are left where they are.

## v0.80.2

The app shows its name as つなぎAI: in the window title, in Finder and the Dock, and on its screens (#764). The README and the documentation use the name too. The app file, the settings folder and the identifier keep the name `tsunagiai`, so nothing moves.

## v0.80.1

The app is renamed from cookapps to つなぎあい (tsunagiai) (#750, #751, #752). Its identifier is `jp.mysis.tsunagiai`. At its first start the app copies the settings folder of `jp.mysis.cookapps` into its own, and it copies each keychain item the first time it uses it; the old folder and items are kept. An update puts the new app in the place of the old one, so it stays at `/Applications/cookapps.app` until you rename it to `tsunagiai.app`.

The MCP server is now `tsunagiai-mcp` (#751): register it again as `docs/mcp.md` describes, and point Claude Desktop at the new path. The release file is `tsunagiai.app.tar.gz`.

D-1: a pre-script gets the port of the connection as `TSUNAGIAI_PORT`, and as `COOKAPPS_PORT` too, so that the scripts saved before keep working (#752). A-30: the scratchpad of an SSH host is `~/.local/share/tsunagiai/scratchpad/`, and the old folder on the host is moved there the first time it is used. A-32: saved skills keep working.

## v0.80.0

A-36: Claude Code can run in a pane of the app, as a terminal that the app opens itself, with no Orca in between (#730). It runs `claude` in the folder `claude-code/` of the config folder, with `cookapps-mcp` as its only MCP server, and with `--permission-mode manual`, so that Claude Code asks before every tool that writes. It signs in the way the Claude tab chose (the subscription or the API key), and the font, the colors and the keys are those of the Orca terminals. A pane that is hidden keeps Claude Code running, and a pane whose Claude Code has ended starts it again when it is shown again. When `claude` or `cookapps-mcp` cannot be found, the pane says so.

D-1: the icon at the right end of the header of the edit pane opens the Claude Code pane at the right of the edit pane, in place of the terminal pane of D-7 (#720). Claude Code there keeps its built-in tools, so that it can run `aws` and other commands to try a pre-script, and it saves and tests the connection through `cookapps-mcp`; the edit pane reads the saved connection into the fields that were not changed by hand, as before. Closing the edit pane or leaving the screen ends Claude Code. The terminal pane of D-7 keeps its own icon in the header of the work pane, and both panes can be open.

D-1, D-2: the edit pane has no tabs "直接" and "スクリプト経由" any more (#745). Every connection has a host and a port, and the pre-script is optional. The app picks no free port: the script gets the connection's own port as `COOKAPPS_PORT`, is to listen at the connection's host and port, and MySQL is logged in to there. When something already answers at that host and port before the script is run, the connection fails and the script is not run. TLS is required for every host that is not this Mac, with a script or without one. A connection saved with a script and no host shows an empty host and the port 3306 in the edit pane, and cannot be opened or tested until a host and a port are saved. "接続をテスト" on a connection that is open in the app starts no script when the user, the script, the host and the port are the ones it was opened with: it logs in through the open connection's way, and the connection stays open.

D-8: `db_profile_save` of `cookapps-mcp` always takes `db_host` and `db_port`, with a script or without one, and a change of the user, the script, the host or the port deletes the saved password (#745). When the port is in use before the script is run, the error of `db_test` adds that a connection open in cookapps has to be closed before the test.

S-13, S-19, A-35: "ウォッチ" no longer lowers the Slack unread count of the side menu and the footer for a moment: the unread messages of a watched thread still count, as the next read showed (#746).

## v0.79.0

A-35: every screen has a low footer at the bottom of the window, with a bell at its right end that shows the unread threads of the inbox and the unread messages of the Slack list added up ("99+" from 100, no number for 0) (#725). The bell opens a pane from the right that lists those mails and Slack messages mixed, the newest first, each with the sender, the channel for Slack, the time, and the subject of a mail or one line of a message; a press on a row opens the thread on its screen (#726). The bell, the close button and a press outside the pane close it. While the pointer or the focus is on a row, the row shows buttons: "ゴミ箱へ移動" and "アーカイブ" for a mail, and "既読にする" and "ウォッチ" for a Slack message (#727). The row goes from the pane at once, and "元に戻す" of the notice brings a mail back.

M-9, S-17: the cards at the bottom right of the window for a new mail and a new Slack message are gone (#728). An unread mail or message is a row of its list and of the pane of the footer. The popup of an update stays.

D-1, D-2: the app no longer opens a port forward through AWS Systems Manager itself, and the fields of SSM (the AWS profile, the region and the bastion) are gone (#718). In their place a connection can have a pre-script ("事前スクリプト"), which runs before the login: the app gives it a free port as `COOKAPPS_PORT`, waits up to 2 minutes for something to listen on `127.0.0.1` at that port, and logs in to MySQL there. A port forward through Systems Manager is now a script that you write. When the script ends or is not ready in time, the error shows the last lines of its standard error. The script is stopped when the connection closes and when the app ends. A connection saved with the fields of SSM is read as one with no script.

D-1: the plus and "編集" open an edit pane in place of the work pane, instead of a dialog (#719). Its header holds "接続をテスト", "キャンセル" and "保存", and two tabs choose the way of the connection: "直接" (the host and the port) and "スクリプト経由" (the pre-script). An icon at the right end of the header opens the terminal pane of D-7 at the right of the edit pane, and while the edit pane of a saved connection is open, the connection saved from outside the app (by `cookapps-mcp`) is read into the fields that were not changed by hand (#720).

D-8: `cookapps-mcp` has three tools for the connections of the database screen, so that Claude Code can write a pre-script, save it and try it (#721). `db_profiles` lists the connections (never the password), `db_profile_save` saves one, and `db_test` tests a saved one as "接続をテスト" does. The two that save or run something are marked destructive, so that the client asks each time. A save that changes the user, the script, or the host and the port deletes the saved password; the password is typed in the app.

## v0.78.0

A-34: in the Orca editor, a right click with the Command key on a name in a Ruby file looks up its definition with ruby-lsp (#696, #700). The top row of the file pane has a third icon, "定義", after "ファイル" and "履歴", and the press switches the pane to it: one row for each place, with the file, the line and the folder, or, for a place outside the worktree, the gem, its version and the mark "gem". A row opens to the lines around the definition, and "タブで開く" opens the file in a tab of the work pane at that line; a file of a gem opens in a read only tab (#699, #700). A right click without the Command key is as it was.

A-34: the app starts ruby-lsp itself, in the way the worktree shows: with `docker compose exec` in the service that mounts the worktree when its folder has a compose file, else with `bundle exec ruby-lsp` on the host when `Gemfile.lock` lists `ruby-lsp`; a worktree of a saved environment is reached through this Mac's `ssh` (#697, #698). The part "言語サーバー" under the definitions shows the state of the server (索引中, 動作中 or 停止中) and holds the command, the path of the worktree where it runs, the service, the ssh host and "自動で起動", saved for each repository in `lsp-settings.json` of the config folder; "自動に戻す" brings back what was decided, and the restart button starts the server again with the new settings (#697, #701). With "自動で起動" on, the server starts when a Ruby file of the worktree is opened, and it stops when no tab of the worktree is open, when the worktree is gone from the Orca list, and when the app ends (#701). When the container of the service is not running, "コンテナを起動" starts it and then the server; the app never starts a container by itself (#701). Before each look-up, the Ruby files that changed on the disk are told to the server (#698).

## v0.77.0

T-8: a right click on a project in the side list of the Todo screen opens a menu with "移動", "アーカイブ" and "削除" (#707, #708). "アーカイブ" archives the project at once, and its tasks stay in Todoist. "削除" asks first, and then deletes the project with its sections and tasks for good. "移動" lists "一番上の階層" and the projects it may go under, and makes it the last sub-project of the one picked. A project can also be dragged onto another project, to become its last sub-project, or onto the heading "プロジェクト", to move to the top level (#709). The sub-projects go along in every case. "インボックス" and "今日" have no menu.

T-1: in a task's detail, the parent's description under the parent chip is always shown when the parent has one, cut at 3 lines; the parent's name no longer opens and folds it, and the "コピー" button is gone (#705). The text can still be selected and copied.

T-1: the month calendar of the due popover is larger, and today has a green ring, so it is told apart from the day picked (#710).

A-33: the chip with the name of the saved environment is on its project and SSH host rows only; the session rows under them have none (#711).

A-6: the label and the menu of the target at the bottom of the Orca list pane are gone, and the app has no place to change the target (#714). The target is the one saved in `orca-settings.json` (when the file does not exist yet, the first saved environment, else this machine). A read that fails still shows in the notice above the list.

## v0.76.0

A-33: while a saved server is the target of the Orca screen, the list holds the projects and sessions of this machine too, in one list with those of the saved server, and the rows of the saved server end with a chip of its name (#337).

## v0.75.2

A-8: a session row of the Orca list shows a badge with a robot and a number at its right end while subagents of the session are at work, the number of those at work (#693). A session row no longer takes its name from a JavaScript value that Claude Code put in the conversation, such as `{ a: { isAsync: true, … } }`, the result of a subagent started in the background.

## v0.75.1

M-10: the reply field of an open thread is no longer always at the bottom; the reply button at the right of the date of the latest message opens it (#687). It takes half of the height of the mail area, and the text scrolls inside it. "破棄" and a reply that went out close it.

M-10: the text of a reply is written in the rich editor of the Slack fields, with bold, italic, strikethrough, links, lists, quotes and code (#688). Cmd+Enter (Ctrl+Enter off macOS) sends it too. The mail goes out with an HTML part made from the text beside the plain text part (#686); a new mail (M-11) is still plain text.

S-6, S-21: an empty line in a Slack post or a reply could reach Slack as the text `<br />`; it is now an empty line, and so it is in a mail reply.

A-8: a session row of the Orca list could show a message that Claude Code put in the conversation, such as the result of a tool, instead of the conversation; it now shows the name of the conversation first, as Orca does, with the last answer after it as "{name} - {answer}" (#690).

## v0.75.0

D-3: the work pane of a database has two tabs, "テーブル" and "SQL" (#670). A row of the table list opens that table, as its row in the tree does, also with Enter (#671). A right click on a database row opens a menu with "新規クエリ", which opens the SQL tab of the database with an empty field, and "データベースを閉じる", which closes its tree and keeps the connection open (#670).

D-4: the footer of the records has the reload and the copy as icons with the range at the left, and at the right the first page, the previous page, a field for the page number (Enter opens that page), the number of pages from the estimated rows ("/ 約 15,062"), the next page and the last page (#667). The number of pages comes from the estimate, so the last page can be empty or leave rows after it.

D-4, D-5, D-6: the grids of the records, the structure and the SQL result have a vertical line between the columns, and dragging the line in the header changes the width of a column, kept until the app is closed (#669). The copy icon at the left of each footer copies the list that is shown, with its header, as tab-separated text that a spreadsheet takes as it is; the values are copied as they are shown (#668).

D-7: the header of the work pane has an icon that opens and closes a pane at its right, whose width is changed by dragging the divider (#673). Its plus opens a plain Orca terminal in the Orca worktree picked from a list (#674). Each terminal opened is a tab, pressed to switch to it and closed with its ×, which closes the terminal in Orca as the tabs of the Orca screen do (#675).

A-8: a session row of the Orca list could show the tags of a Claude Code conversation, such as `<event kind="repl-eval" …>`, as its text; it now shows the first line of the text inside the tags, and keeps a link or code that the user wrote between `<` and `>` (#682).

## v0.74.2

D-1: the menu of a connection on the database screen ("編集", "切断" while it is open, and "削除") opens with a right click on its row, where the pointer is; the button with three dots at the right of the row is gone (#664).

## v0.74.1

D-2: a connection through AWS Systems Manager could not be opened: looking for the bastion failed with "AWS の呼び出しに失敗しました: … ValidationException" (#661). The bastion is now asked for by its Name tag alone, and the app picks a node that is Online from the answer.

## v0.74.0

D-1: the side menu has a button for a new screen, "データベース", after Orca, with a drawn cylinder as its icon (#628, #629). The screen has a list of connections at the left, headed "接続" with a plus ("接続を追加"), and the work pane at the right. A row has a menu with "編集", "切断" (while the connection is open) and "削除", which asks first. The plus and "編集" open a popup with "接続名", "ユーザー名", "パスワード", the check box "SSM 経由で接続する" and, while it is checked, "AWS のプロファイル名", "リージョン" and "踏み台の名前", then "DB のホスト" and "ポート" (3306 for a new connection). A saved password is shown as "保存済み" and is never shown again; leave the field empty on an edit to keep it. The connections are saved in `database-profiles.json` in the config folder, and each password is in the OS keychain.

D-2: the popup has "接続をテスト", which logs in with what is typed, shows "MySQL {version}" or the reason it failed, and saves nothing (#630, #631). The server is MySQL 5.7, 8.0 or 8.4. TLS is used when the server offers it, and a connection over a network that does not go through SSM requires it; the certificate is not verified. A connection through AWS Systems Manager opens a port forward through the bastion found by its Name tag, with the AWS SDK and `session-manager-plugin`, and closes it after the test. The errors tell apart an AWS login that is gone, a bastion that is not found, a missing `session-manager-plugin`, a tunnel that is open while MySQL does not answer, and a login that MySQL refuses.

D-3: a press on a connection opens it, with its databases under it, and a press on a database shows its tables (a view is among them) and, in the work pane, their estimated rows, size and engine (#632). A dot at the right of a connection is green while it is open, orange while it opens and gray otherwise. "切断" closes the connection and its tunnel; so do an edit and a delete of it, and quitting the app.

D-4: a press on a table shows its records, 100 rows a page, with "前へ", "次へ" and "再読み込み", and the range with the estimated number of rows (#633). NULL, numbers and binary values are told apart (a binary value shows its size), and a text of more than 200 characters is cut at 200 (the rest is not kept).

D-5: the tab "構造" of a table lists its columns with their type, NULL, key, default and comment, and under them the number of columns, the engine and the character set (#634).

D-6: the tab "SQL" of a table has a field for one statement and "実行" (#635). The result is shown as a grid, up to its first 1,000 rows, with the number of rows and the time under it; a SELECT that runs for more than 30 seconds is stopped by MySQL, and a run that does not end in 35 seconds closes the connection. The errors of MySQL are shown in Japanese.

## v0.73.0

M-10: an open mail thread has a reply field fixed at the bottom, under the messages, so the thread can be read while the reply is written (#488). "返信" goes to the sender of the last message (to its Reply-To when it has one), and "全員に返信" also to the other people of its To, with its Cc in Cc; the account that reads the thread is left out. The recipients are chips, with × to take one off, and "Cc" and "Bcc" open a row each, where an address typed becomes a chip with Enter, with a comma or by leaving the field. The text is plain text. "送信" sends the reply from the account that received the thread, into the same thread, and the thread is read again with the sent mail in it; a failure shows its error and keeps what was written. "破棄" empties the field. What was written is dropped when the thread is left: no draft is saved.

M-2: the row of icons above the subject of an open mail is 48px high, with a line under it, and a line divides the AI summary from "Slack に貼る" (#488).

M-11: the header of the inbox has "作成", an icon with a pencil, that opens a screen for a new mail in the mail screen itself, not in a dialog (#489). It holds "差出人" (the account the mail goes from; a list to choose from when there are several accounts), "宛先" with "Cc" and "Bcc" as chips like the reply field's, "件名", the text (plain text) and "送信" in a band fixed at the bottom. A mail that went out shows "送信しました" and the inbox comes back; a failure shows its error and keeps what was written. "戻る" and "破棄" show the inbox again and drop what was written.

A reply and a new mail go out with Gmail's `users.messages.send`. The scope the app already asks for, `gmail.modify`, is enough for it, so no account has to log in again. The app saves nothing of a mail it sends. Files cannot be attached.

A-32: the settings have a tab "スキル", right of "Claude", that makes, changes and deletes skills: texts of instructions written once for the Claude calls of the "Slack に貼る" screen and of a Slack thread (#340). The skills are listed at the left, with "新しいスキル" under them, and the one pressed is edited at the right: "名前" (lower-case letters, digits and `-`, up to 64 characters; it cannot be changed once saved), "表示名", "使う画面", "説明" and "指示". "保存" writes the skill to `claude-plugin/skills/{name}/SKILL.md` in the config folder, and "削除" asks first and deletes it for good. No screen chooses a skill for a call yet.

A-3, A-28: the settings have a tab "ログ", the last one, that shows the app's log (#430). It is a table, the newest line first, of the time, the weight ("エラー", "警告" or "情報"), the place and the text. "すべて", "エラー" and "警告" filter the lines, "コピー" copies the lines shown, and "フォルダを開く" opens the folder that holds `app-log.jsonl`. The log is read each time the tab is shown. Nothing writes to the log yet, so the tab says "ログはありません". The settings now have ten tabs.

No change in what the app shows yet, as groundwork for coming features: an operation on a row or a tab of the Orca screen is sent to where that row is (this Mac or a saved environment), not to the target of the screen (#336); and the Claude calls of the "Slack に貼る" screen and of a Slack thread can run a skill, which is given to Claude Code alone, in a folder made for that call (#346).

## v0.72.1

The Dock badge counts Slack and Orca too (#619). It is now the sum of the unread mail, the Todo tasks whose due moment has come, the unread Slack messages and the Orca sessions that wait for the user, so it shows a number when only Slack or Orca has one. It was the sum of mail and Todo alone.

A-23: the band at the top of every screen is a little higher (44px, from 40px), and the icon buttons in it are larger (28px, with icons of 17px) (#617).

A-8: the close button of a tab on the Orca screen is larger (#618).

A-17: the menu of the right button on a tab of the Orca screen has line icons in place of the green dots, and on the tab of a file it has "パスのコピー" and "相対パスをコピー" too, as the file pane has (#650). A file tab that is alone in its pane has the menu with the two copies.

A-25: the headings "ローカル" and "リモート" of the list of branches on the Orca screen are easier to read: bold, on a band, with an icon and the number of branches (#652). The remote branches show the first 5, and the button "ほか n 件を表示" under them opens the rest; typing in the filter shows every match as before. The 5 are the remote branches picked from the list last, newest first (#653). The app remembers them in `orca-branch-recent.json` of its config folder, up to 5 for a repository. The list of the ref and of the existing branch of a new worktree (A-9) is the same.

The MCP server is built with rmcp 3.9.0 (#642), and the lint of the source runs with Biome 2.6.6 (#640). The tests of the screens run with WebdriverIO 10.2.0 (#641, #647, #648).

## v0.72.0

A-31: an HTML file in the file pane of the Orca screen opens in the default browser (#621, #622). The right button on a file whose name ends in `.html` has the item "ブラウザで開く". The app serves the files of the worktree from a small HTTP server that listens on this Mac alone (`127.0.0.1`), reading them through Orca, so the images and scripts beside the page show too, also for a worktree on a saved environment. The address holds a random token, and a path with a part that starts with `.` (`.env`, `.git/`) is not served.

## v0.71.3

M-2: a mail thread that was opened before is shown at once when it is opened again, without the note "読み込んでいます…" (#614). The app keeps the threads it has opened in memory (up to 64 MB, the oldest dropped first; nothing is written to a file, and they are gone when the app quits), asks Gmail again in the background, and draws the thread again only when the answer differs, for example when a reply has arrived. A thread that has not been opened yet is read as before.

The app is built with Rust 1.100.0 (#612).

## v0.71.2

S-1: the left pane of the "Slack に貼る" screen is now the original message at the top and, under it, a numbered list of things to do: where to post and what (#606). A thing to do goes to a channel or a thread, or to the thread of an earlier one, and posts a text written on its card or the original message. "投稿" ("N 件を投稿" for several) posts them from the top, and one that follows another is a reply to that post. A failure stops the rest, and what was posted is never posted twice. The screen stays open after a post, so more can be added. `@here`, `@channel` and `@everyone` written on a card notify the channel.

S-4, S-23: a request to Claude on that screen can write the things to do, for example a short message to a channel and then the mail in its thread, and can post them all when the request asks for it (#607). The app decides whether to post, for the whole list: every destination must be one the owner chose, one the request names, or the thread of an earlier post, and a text may hold only the links and mentions of the original message or of the request. A text that Claude wrote in the same answer is posted only when the request holds it; otherwise nothing is posted and the cards wait for "投稿".

S-23: a Slack link in the request is a destination, so pasting the link of a thread and asking to post there works (#608).

S-4: the heading of the right pane no longer says "Claude と校正" (#605).

A-8: the list of the Orca screen has no reload button (#609). The list is read again by itself, and whenever the screen is shown.

## v0.71.1

A-17: the divider between two panes of a split Orca work pane can be dragged, to the left and right in a split side by side and up and down in a split one above the other (#597). Only the two panes beside the divider change, and a pane never gets smaller than a tenth of the split. The sizes are remembered with the split of each project.

A-18, A-24, A-27: the file pane of the Orca screen follows what changes outside the app without waiting for the window's focus (#601). While the file pane is shown, about every 10 seconds the tree and the history are read again, and so are the files and the diffs that the panes show. A file with an edit that is not saved yet is left alone, and the cursor and the scroll of a file stay. Before, the tree was read only when the window got the focus back, and an open file only when it was closed and opened again.

Fixed: on a saved environment, the branch in the heading of the file pane stayed the old one after the branch was switched, in the app or in a terminal (#600). The list is now read again right after a switch and every 10 seconds.

Fixed: the menu of the right button that macOS draws (Cut, Copy, Paste and so on, in the editor and the other text fields) is in Japanese (#598).

## v0.71.0

A-30: the scratchpad works on an SSH host's row too (#588, #589, #590). 「スクラッチパッド」 of the plus makes a file for notes in `~/.local/share/cookapps/scratchpad/` on the host and opens it in the editor, where it is saved as any file. Orca does not serve the files of an SSH host, so the app runs this Mac's `ssh` command itself: the Host must be in `~/.ssh/config` of this Mac, and a key with a passphrase in ssh-agent. A host that Orca added by hand is reached with the user name and the port saved in Orca. Each call is one of six fixed commands, and a name or a text is sent on the standard input only.

A-30: while the row of an SSH host is selected with no tab, or with a scratchpad file's tab, the file pane lists the files of that folder (#590). A double press opens a file, and the menu of the right button has 「新規ファイル」, 「移動・名前の変更」 (a new name only: the folder holds no folder) and 「削除」, which asks first and deletes for good. The list is read again when the window gets the focus back and after the app's own changes. An SSH row that this Mac's Orca does not hold has no scratchpad.

S-12: a mention of a user in a Slack message is a link to the user's profile, `https://{workspace}.slack.com/team/{user ID}`, in the list, a channel's history and the thread, and in blocks and attachments (#594). Pressing it opens the default browser. A mention of a user group, `@here`, `@channel` and `@everyone`, and a mention inside code stay text: Slack documents no address that opens a user group.

## v0.70.0

A-29: the plus of the Orca work pane has a third item, 「スクラッチパッド」, that makes a file for notes in `.orca/scratchpad/` of the worktree and opens it in the editor (#582). A small field under the plus shows the folder and the name, `memo.md` at first; Enter or 「作って開く」 makes the file, and Escape or 「やめる」 closes the field. A name that is taken opens the file that is there, and nothing is overwritten. The item cannot be chosen while the selected row is an SSH host's.

A-18: in the file pane of the Orca screen, the menu of the right button on a folder starts with 「新規ファイル」 and 「新規フォルダー」 (#584). Choosing one opens the folder and shows a field for the name as its first row; Enter makes it, and Escape or a blank name cancels. A new file opens in the editor. The same two items are in the menu of the right button on the empty part of the tree, and make the entry at the top of the worktree. A name that is taken shows 「同じ名前があります」 and makes nothing.

A-18: the menu of the right button on a file or a folder ends with 「削除」, in red (#585). It asks first, 「{name} を完全に削除します。元に戻せません。」, and only 「削除」 deletes: the file, or the folder with everything in it, is deleted for good and does not go to the Trash. The editor tabs of the deleted files close without saving.

A-18: a file or a folder of the file pane can be moved and renamed (#586). Drag its row onto a folder, or onto the empty part of the tree for the top of the worktree; a closed folder opens when the pointer rests on it. Or choose 「移動・名前の変更」 in the menu of the right button: the row becomes a field with the path from the worktree, the name selected, and Enter moves the entry to the path typed, making the folders that are missing. Nothing is overwritten: a place that is taken shows 「同じ名前があります」. An open file keeps its tab and what was typed in it, under the new path.

A-18, A-27: the reload button of the file pane's heading is gone (#583). The files, or the history when it is shown, are read again when the window gets the focus back, and the files after the app's own create, delete and move.

## v0.69.0

A-23: on the Orca screen, the button that closes and opens the list of projects is at the left end of the list's header while the list is open, and at the left end of the tab strip of the pane at the left edge while it is closed, at the same x, so the button does not move sideways when it is pressed; the bell and the reload stay at the right of the header (#570). This takes back the place of v0.68.1 (#437).

S-11: in a post that shares another message, an attachment whose long text is folded no longer shows the whole text again under 「もっと表示する」; the folded text alone shows until the button is pressed (#572).

A-6, A-8: the bell of the Orca list and its working view (the Claude sessions grouped as waiting, working and done) are gone; the list pane shows only the projects (#577). The count and the blinking of the Orca icon in the side menu stay as before.

A-8: closing a Claude session or a terminal from its tab on the Orca screen works again when Orca answers that the terminal is stale: the app closes it once more without `--tab` (#575). A close that fails shows its message and keeps the tab, and the list is read again, so a tab that Orca no longer holds leaves at once.

T-1: the 「…」 button at the right of the header of a task's detail is a pencil with 「編集」, and opens the same menu (#578). On a subtask, the return arrow with 「親タスク」 in the parent's chip opens the parent, and the parent's name, when the parent has a description, opens that description in place under the chip, cut at its 3rd line with 「…」, with 「コピー」 to copy the whole text; pressed again, it folds.

A-28: the app keeps a log in `app-log.jsonl` in its settings folder, one line for each entry with its time, weight (error, warning or information), place and a short text of at most 500 characters; lines older than 30 days are dropped and the file stays at 1 MiB or under (#432). No screen writes to it or shows it yet. It never holds a token, a mail, a Slack message, a Todo or what a terminal printed, and a word shaped like a secret is masked.

No change in what the app shows yet, as groundwork for coming features: while a saved environment is the target, the Orca list also reads the lists of this Mac beside it, and each item knows where it is (#335); the skills, texts of instructions for the Claude calls of the screens, are saved and read in the settings folder (#339); the app connects to Notion through Notion's MCP server with OAuth and keeps the tokens in the keychain (#367); and a command sends a new mail or a reply with the Gmail API, with the scope the app already has (#487).

## v0.68.1

S-11: in a thread, a channel's history and the Slack list, the text of an attachment of 700 characters or more, or of 5 line breaks or more, is folded to its first 5 lines (up to 700 characters), as Slack does, and 「もっと表示する」 shows the whole text (#564).
S-11: in a post that shares another message, the link to that message in the text is drawn as a link labeled 「メッセージ」, not as its address, when the shared message's attachment unfolds it below; only an https address of Slack is labeled, and the address is the link's tooltip (#565).
A-23: on the Orca screen, the button that closes and opens the list of projects is always at the left end of the tab strip of the pane at the left edge, whether the list is open or closed; the header of the list keeps only the bell and the reload (#437).

## v0.68.0

S-26: in a thread and in a channel's history, a reaction of a custom emoji is drawn as the emoji's image, not as `:name:` (#559). An alias of a custom emoji draws the image it points to, and an alias of a standard emoji draws that emoji. An image that cannot be fetched leaves `:name:`. The text of a message keeps `:name:` for a custom emoji as before. This needs the User Token Scope `emoji:read`; a token without it draws `:name:` as before, and every other feature works.

S-25: the reactions under a message in a thread and in a channel's history are buttons (#560). Pressing a reaction you have not given adds it, and pressing one you gave takes it off; your own reactions have the accent color on their frame, and the count follows at once. A failure shows the reason in a toast and changes nothing. This needs the User Token Scope `reactions:write`; a token without it still shows the reactions, and a press says that the scope is missing.

S-25: the last button of a message's reactions, a smile with a plus, opens an emoji picker (#561). It has a search field, and lists the emoji you added recently in this run of the app, the workspace's custom emoji and the standard emoji, in that order; Enter picks the first one that matches. On a message with no reaction the button shows only while the pointer is on the message. The custom emoji need `emoji:read`; without it the picker offers the standard emoji alone.

## v0.67.1

S-5: the rows of the Slack list show the whole body, with no limit of 2 or 12 lines; so do the unread replies under a row and the rows of a channel's history (#541). A thread's row shows the icons of up to 5 people who replied before the reply count (「N 件の返信」, or 「返信 N 件」 in the watch), and the time of the newest reply after it, as 「最終返信 15:02」 (#542). A thread for which Slack names no repliers, or none of them can be named (a token without `users:read`, for example), shows the count alone.

Inside: the saving of the settings files goes through one function, the internal functions take the settings folder, the colors of the screen come from the color variables, and the checks before a push run the self-test of the push gate when its tools change (#543, #544, #546 to #554). Nothing of the app's behavior changes.

## v0.67.0

S-21, S-6: the field under a channel's history and the reply field of a thread are rich fields, as the editor of A-26 is (#456, #457). A toolbar at the top of the frame makes the selection bold, italic or struck through, a link, a numbered or bulleted list, a quote, code or a code block. The text button 「投稿する」 or 「返信する」 is gone: a round arrow at the right end of the frame, or Cmd+Enter, posts, and Enter is a line break. The text is posted as Markdown and turned into Slack's notation when it is sent; only a link to an http, https or mailto address stays a link, so a link cannot notify `@channel` or a person.

S-24, A-2: the Slack screen has a Claude pane on its right, in the unread list, the watch and a channel's history (#458, #459). Claude answers a request in short, and while a channel's history is shown, the recent messages of that channel are sent with the request. The pane has its own model and effort, 「Slack の相談」 (Sonnet and medium at first), so the settings now choose them for eight purposes. Claude cannot post and has no tool. While a thread is open, the thread's own Claude pane is shown instead.

S-24: when the request asks for the text of a post, the answer has a draft card under the reply (#460). In a channel's history, 「投稿欄に入れる」 on the card puts the draft into the post field of that channel, after any text already there, and posts nothing; the arrow of the field posts it. In the unread list and the watch the card shows the text alone.

A-27: the file pane of the Orca screen has two icons at the top, 「ファイル」 and 「履歴」 (#536, #537, #538). The history lists the commits of the worktree, the newest first, and reads more as the list is scrolled to its end. Pressing a commit shows the files it changed, with how each changed and the numbers of lines added and removed. A double press on a file opens its diff, the file at the parent on the left and at the commit on the right, in a tab like the diff of A-24.

## v0.66.0

A-26: a Markdown file opened in the editor of the Orca screen opens in a rich view, with its headings, lists, tables, code and task lists drawn as a document (#384, #381, #382). Two buttons at the right of the editor's heading switch between the source (`<>`) and the rich view (the pencil). The rich view can be edited, and it is saved automatically as typing in the source is: only the lines that changed are written into the file, so every other line, the front matter included, stays as it was. A file whose notation the rich view cannot keep opens in the source, and its rich view is read only.

S-1, S-4: the Slack compose screen has the preview of the post on the left and the conversation with Claude on the right (#341, #342, #343). Pressing the preview opens the field to edit it, and the button that posts is 「投稿」, at the bottom of the left pane. 「校正する」 is gone: Claude is asked by typing the request. An answer of Claude that changes the text goes into the preview at once, with the number of lines it changed and 「元に戻す」, and posts nothing. Asked, Claude can also choose the destination, from the one in the chip, the recent destinations and the joined channels; the names of those channels are sent to Claude with the request.

S-23: a request to Claude on the Slack compose screen can post the text, for example 「#sales-inquiry に要点だけ投稿して」 (#344). The app, not Claude, decides whether to post: the request itself holds 投稿, ポスト or post, the destination is the one the owner chose in the chip or the one channel the request names, and the text adds no link or mention it did not have. Otherwise nothing is posted, and 「投稿されませんでした」 is shown. A post returns to the mail, as 「投稿」 does.

## v0.65.2

M-2: the row of buttons above the subject of an open mail (the AI summary, Slack, Todo, Orca, trash and archive) sits at the right end of the body (#529).

## v0.65.1

S-19: in the Slack side menu, pressing a workspace's name folds it (#523, #524). A folded workspace hides its channels with nothing unread, and keeps the unread ones and the one whose history is shown. Press it again to open it. The folded workspaces are kept in `slack-side.json` and stay folded after a restart.

S-19, S-15: pressing a channel in the Slack side menu reads it, as 「既読にする」 of its heading in the unread list does, and opens its history (#525).

## v0.65.0

S-22: a message in a channel's history and in a thread shows its reactions under it, each emoji with its count (#468, #469). A custom emoji shows as its `:name:`. It is display only; reactions cannot be added or removed.

S-20: a reply that was also sent to the channel shows 「スレッドに返信済み:」 and the start of the message it replies to above its text, in a pale color, in the channel's history (#467). Pressing it opens the thread.

S-3, S-4, A-9: the field that asks Claude is the same part on the screen that edits the Todo summary prompt, on the Slack compose screen and in the pane that hands an item to Orca (#498, #499, #500). The send button is a round arrow, and the model and effort selects sit inside the frame of the field; the Slack compose screen now has the selects of the proofreading, and the pane of Orca those of the summary of a handoff. The field of the Orca pane starts one line high and grows with the text. The fields no longer show 「どう変えたいかを書く」, 「どう直したいかを書く」 or the keys that send; Cmd+Enter still sends.

S-5: the Slack list draws again only the rows that changed, so a row keeps its place and focus when the list is read again or a thread is closed (#416).

## v0.64.1

C-1, C-4: the calendar screen reads like the other screens (#515). The bar above the week is the tinted band of the Todo screen, with 「今日」, the arrows and the month, written as 「2026年11月」, from the left; the month opens a small month calendar under it, and a day pressed there shows its week. The panel has the same month calendar at its top, and each account is a row with the initial and color of its avatar in the sidebar and its address, with its calendars indented under it and folded by pressing the row.

## v0.64.0

C-4: the calendar screen has a panel, left of the week, to choose the calendars to show (#330, #331, #332). It lists every calendar of each account, under its address, in "マイカレンダー" (the calendars the account owns) and "他のカレンダー" (a person's calendar, holidays, rooms), each with a checkbox in the calendar's color. A change draws the week again at once and is saved in `calendar-selection.json`; nothing is written to Google, and a calendar never chosen follows its choice at Google, so the week is as before until the owner changes it. A button beside the heading folds the panel, and the week takes its width. The `list_events` tool of the MCP server reads the same calendars.

T-7: the right side of the Todo screen starts at its least width, 30% of the screen, no longer 40% (#513).

## v0.63.5

S-7, S-18, T-7: the field that asks Claude is one part on the Todo screen, in the pane of a Slack thread and in the pane of a Todo draft (#497). In each the model and effort selects sit inside the frame of the field, in a row under the text at the left of the round send button; in the Slack thread and the Todo draft they were under the frame. The field of the Slack thread no longer shows "Claude に頼みたいことを書く".

## v0.63.4

T-1: a row of the task list has three lines, so that it reads in half of the screen (#507): the name; the first line of the description, underlined when it is an address; and the due moment, the labels, the subtask count and, in the "today" list, the project at the right. The buttons of a row lie over its top right while the pointer is on it.

T-7: the right side of the Todo screen is between 30% and 45% of the screen, set by the divider (#507). It no longer keeps a least of 380px, which in a narrow window passed the upper bound and stopped the divider.

## v0.63.3

M-2, A-20: a mail body draws in Gmail's face (#494). An HTML body that names no font is in Arial, Helvetica, sans-serif at 13px; a font or size the mail names still wins. A text body is in the same sans-serif, no longer a monospace one, and takes the family and size chosen for the mail screen. The monospace family of the font settings no longer reaches a text body.

M-2: an http(s) URL written as text in an HTML body, outside a link, is a link too, and opens in the default browser as the other links do (#495).

M-2, A-23: the operations of an open mail are a row of icon buttons just above the subject, larger than before (34px): the AI summary, "Slack に貼る", "Todo にする", "Orca に渡す", then "ゴミ箱へ移動" and "アーカイブ" (#503). The row stays at the top while the messages scroll. The band at the top of the mail detail has only "戻る".

S-2, S-3, S-18: the page of a Todo draft made from a Slack message shows, at its top, the workspace and the first line of the linked message, cut with "…" where it does not fit, and "Slack で開く" at the right (#501). The pane on the right is headed "Claude", not "Claude と直す", and is 40% of the page at first; a divider sets it between 30% and 60%. The entry "プロンプトを編集" of the page is gone: the prompt of the summary is opened from "Todo の要約プロンプト" of the Claude tab of the settings only.

S-8, S-15: "既読に設定" at the right of a channel's heading in the unread Slack list is an icon button with two checks, named "既読にする" (#504). It does what it did.

## v0.63.2

A-23, T-7: the band at the top of every screen is one height, 40px (#482). It was 32px on the Orca screen, 70px on the Todo screen and set by its own padding on the other screens, so the lines under the bands did not meet where two screens or two panes sit side by side. The icon buttons in the bands are one size too (24px, with a 15px icon). With a larger font (A-20) a band grows to fit its text instead of cutting it.

## v0.63.1

A-9: the pane that hands a mail, a Slack thread or a Todo to Orca is a form from the top down, and what the user writes is handed over as it was written (#475, #476). Claude no longer summarises the instruction, and the buttons "要約する" and "直す", the conversation about the summary, the model and effort selects and the proposed worktree name are gone. The card is summarised by Claude when the user presses the arrow icon "Orca に渡す" at the bottom right of the instruction field (or Cmd+Enter): the summary goes into the quoted content, above its text, after the instruction and the paths of the files. The pane starts at 40% of the screen.

A-9: the worktree chip lists every worktree of the chosen project, the project's own folder first and "新規作成" last, each with its name and, under it, its branch, and a search field (#444). The session starts in the one picked.

A-9: "新規作成" shows a frame with the name, the ref the worktree starts from and its branch, a new one or an existing one (#445, #446). The ref is picked from the local and remote branches of the project, and the existing branch from the local and remote branches that are free to take. A name that git would refuse as a branch or a ref is refused with a message, and nothing is made.

A-9: after the hand-over the pane shows the terminal of the session in place of the history, with the repository, the branch and the state above it, a button that opens the session on the Orca screen, and a close icon (#477). Keys can be typed into it and files dropped on it. A session of this Mac is mirrored, as on the Orca screen, and one of a saved environment is shown too.

A-7, A-11: the history of an Orca session and the box that answered a question of Claude in it are retired (#478). A question is answered in the terminal of the session.

T-7, S-3: the right side of the Todo screen is always open, in two rows (#447). The first row has only the icons of Claude and "Orca に渡す" (the second can be pressed only while a task is open); under it are the heading and the controls of the one chosen, and its content. The headers of both sides are tinted. The icons for Claude and Orca in the header of the tasks and the ✳ that opened the prompt of the summary are gone: the prompt is opened from the Claude tab of the settings and from "プロンプトを編集" on the page of a draft.

A-12: the keys typed in a terminal of a saved environment are sent to that terminal also when it has just stopped being shown (another tab, another screen, a hidden window) (#429).

A-12, A-21, A-24: the app no longer reads at start-up the libraries that only the Orca screen uses (the terminal and the colors of the editor and the diff, about 755 KB); they are read the first time they are needed (#414).

## v0.63.0

A-25 (new): the branch in the heading of the Orca file pane is a button (#439, #440, #441). Pressing it opens a list of branches right under it, in two sections, local and remote, with the current branch checked and a branch checked out in another worktree faint and disabled; typing in its field narrows the list and searches the remote branches. Picking a branch switches the worktree to it (a remote branch makes the local branch that tracks it), and the file tree and the heading are read again while the open tabs stay. When Orca refuses (changes not committed, a merge in progress, an agent at work), its words are shown. It is not a button for a worktree of an SSH host.

## v0.62.0

A-24 (new): right-clicking a file in the Orca file pane shows "差分を表示", which opens a tab in the work pane with the differences between the file at HEAD and the file on the disk, uncommitted changes included (#462, #463). HEAD is on the left and the disk on the right, with the line numbers between them; a button switches to one column with the removed and added lines one above the other, and back. The text is colored by its language as in the editor, buttons move to the previous and next change, and the head shows the number of changes and a button to read the file again.

## v0.61.1

A-23: the traffic lights at the top left of the window are no longer cut by the edge of the window (#421). They are where macOS itself puts them, and the green icon column is 14px wider so that the three fit on it.

S-13: the button at the right of the Slack header that opens the channels kept off the list has the circle with a minus of the side menu's hide button, not an eye (#449).

## v0.61.0

S-19 (new): the Slack screen has a side menu at its left (#433). Two buttons, "未読メッセージ" (with the number of unread messages) and "ウォッチ", choose which list the body shows, and under them every workspace's joined channels are listed by name with the number of their unread messages. The hide button of a channel moved from the rows of the list to the menu: a circle with a minus, shown while the channel is hovered. The divider can be dragged to change its width.

S-15, S-8: the unread messages of the Slack list are grouped by channel, the newest 10 of each channel, oldest first under a separator for each day, and there is no limit over all the channels (#434). The heading of a channel has the number of its unread messages and "既読に設定", which moves the channel's read position to its newest unread message (also those not listed) and reads the unread replies of its threads. The header's "すべて既読にする", the check of a row and the "あと N 件" button are gone.

S-20 (new): pressing a channel of the side menu shows its newest 50 messages, oldest first, in place of the list (#435). Opening the history does not read the channel, a row with replies opens its thread, and a failed read shows the error with "再読み込み".

S-21 (new): the history of a channel has a field to post a message to that channel under the user's own name (#436). Cmd+Enter or the button posts, and what is written stays for each channel until the app quits.

## v0.60.1

M-1: the inbox reads all accounts at once, and the threads of each account without waiting for groups of ten, so it loads faster with several accounts (#411).

M-7: the automatic sync asks every account at once, so the new rows and the new mail cards of one account no longer wait for the others (#415).

A-6, A-9: the Orca screen reads the lists of this Mac together with the saved environments, and a hand-over to a new worktree no longer checks the environments and the worktree list a second time (#413).

A-8, A-11: the terminal of this Mac on the Orca screen, and the answers to Claude's questions in the history, are read and typed over Orca's own connection instead of starting Orca's command each second, which uses less CPU (#412).

## v0.60.0

A-23 (new): the window has no title bar, and every screen reaches the top edge of the window (#314). The close, minimize and zoom buttons of macOS sit on the top of the green icon column, whose icons start below them. The band at the top of each screen (the headers of the mail list, of a thread, of the Todo screen and of the Slack screens, the bar of the calendar, the heading of the settings, the header of the Orca list and the tab bars of the Orca work pane) moves the window when an empty place of it is dragged, and a double press zooms it, as the title bar did.

A-23: the list of projects of the Orca screen and of the Todo screen can be closed (#318, #322). The button at the left end of the list's header closes it, and the work pane or the task list takes its width; the button then moves to the left of the tab bar (Orca) or of the heading (Todo), and pressing it opens the list again. The bell and the reload of the Orca screen are hidden with the list, and Cmd+J opens a closed list first. The state is not saved: the app starts with the lists open.

A-16: the two items of the menu of the plus of the Orca work pane have an icon instead of a green dot (#377): Claude's for 「Claude を起動」 and a terminal's for 「ターミナルを開く」.

T-1: the chip of the parent task above the name of a subtask starts at the left edge of the task's checkbox, and the parent's round checkbox in it is a little smaller (#406).

## v0.59.1

A-9: the project menu of the 「Orca に渡す」 pane has a search field at its top (#405). What is typed narrows the projects to those whose name holds it, with case ignored. ↓ and ↑ move through the rows, Enter picks one, and Escape closes the menu. The menu fits the window and its rows scroll, so a long list of projects no longer runs past the screen.

## v0.59.0

T-7 (new): the Todo screen has a Claude pane at its right (#327, #328, #333, #334). The speech-bubble button of the header (「Claude に相談」) opens and closes it, in the list and in a task's detail, and it shares its place with the 「Orca に渡す」 pane: only one of the two is open. Ask in words, such as 「年末まで週 2 件ずつ」, and Claude answers with cards of proposed tasks, each with a name, a date and a project. Nothing is written to Todoist until 「追加」 is pressed on a card; the name, the date and the project can be changed on the card first, and 「却下」 closes it. Asking again sends the cards as they are now, so Claude can change its own proposals. The request, the conversation, today's date and the names of the Todoist projects are sent to Anthropic. The model and effort of this conversation are 「Todo の相談」 in the Claude tab of the settings (A-2). The add field of the Todo screen no longer shows an example.

A-9: the 「Orca に渡す」 pane hands a mail, a Slack thread or a Todo over only after an agreement with Claude (#394 to #399). Choose the destination (this Mac or a saved environment), the project and the worktree: the project's own folder, or 「新規作成」, which makes a new worktree under a name Claude proposes and you can change. Write the instruction and press 「要約する」: Claude answers with what is to be implemented, 「直す」 asks it to change the summary, and 「この内容で Orca に渡す」 starts a new session with the agreed summary and the original content as a quotation. The pane no longer lists the running sessions or sends to one, and the card no longer has 「送る内容を読む」; a further instruction to the session that was started is as before. The instruction, the content and the conversation are sent to Anthropic for the summary. Its model and effort are 「Orca に渡す要約」 in the Claude tab of the settings (A-2).

S-2, S-18: the Todo draft made from a Slack message opens as a page of the Todo screen instead of a modal (#400). The back button at the left of its header drops the draft, as the ✕ did, and the ✕ is gone.

## v0.58.3

A-13: the text of the Orca terminals is no wider than in Orca itself (#390). The terminals named the system's monospace font first, whose letters are wider than Menlo's, so a line was longer and each Japanese character had a wider gap after it. They now name the fonts in Orca's own order (SF Mono, then Menlo), so a Mac draws them with the same font as Orca.

## v0.58.2

A-20: the 「フォント」 tab of the settings has three more places (#385, #386, #387). 「アプリ全体」 chooses the family and the size of everything that has no place of its own (the settings screen, the side menu, the popups and the tooltips), and its family is also used by a screen whose own family is 「システム標準」. 「Orca 作業スペース（チャットとファイル）」 chooses them for the tab strip, the chat panes, the file pane and the heading of the editor of the Orca screen. 「等幅の文字」 chooses the family of the monospace text (code, the body of a plain-text mail, prompts and diffs); its size follows the screen it is in. Nothing looks different until a choice is made.

A-18: the editor of the Orca screen shows line numbers at the left of the text (#378). They take the font of the editor, follow the vertical scroll, and are not selected or copied.

## v0.58.1

S-5, S-6, S-11: a mention of a Slack user group (`<!subteam^…>`, or a `usergroup` element) is shown as `@handle` instead of `@不明` (#351, #352). The handle is read with `usergroups.list`, disabled groups included, once for each workspace and then every hour (five minutes after a failure), and is kept in memory only. To show the names, add the User Token Scope `usergroups:read` to the Slack app and enter the token again; without it the mention stays `@不明`, as before.

A-18: the file list of the Orca screen is faster (#361, #362, #363). Opening a folder no longer starts a check each time, the list is drawn first and the gray italics of the files git ignores follow it, and a folder that was read is not read again when it is opened again (a file added or removed on the disk shows after the reload button), and the reload button reads the folders side by side.

No change in what the app does: the tools used to develop it changed how the order of the issues and the nightly runs are decided (#173).

## v0.58.0

S-17 (new): a read of the Slack list that finds new unread messages shows a card for each at the bottom right, in the same stack as the cards for new mail (#349, #350). The card has the sender, the channel and the text, and the buttons 「既読にする」, 「ウォッチ」 and 「スレッドを開く」. Nothing is shown for the first read after the start, for a message already read or for a watched thread, and no OS notification is used.

S-18 (new): the modal of the Todo draft made from a Slack message has a Claude pane at its right (#329). Ask Claude to change the name or the description of the draft, read the change as a diff, and press 「適用」 to put it into the draft or 「却下」 to leave it as it is. The request is optional, and the Slack message itself is not sent to Claude.

A-10: a file of any kind, not only an image, can be pasted or dropped on an Orca terminal and on the 「Orca に渡す」 pane (#324). The file is put in `.orca/drops/` of the worktree under its own name (a taken name gets ` copy` added) and its path reaches Claude. A file up to 20 MiB is taken. The pane shows an image as a thumbnail and any other file by its name.

No change in what the app does: the sender and the 「To 自分」 of a mail are decided in Rust (#316, #319, #321).

## v0.57.1

S-2: the Todo draft made from a Slack message opens in a modal instead of a card above the list. The name and the description are on the left, and the project, the date and the labels on the right, as in the detail of a task. 「破棄」 is at the bottom left and the add button at the bottom right (#326).

A-22, A-18: the menu of a row in the file pane of the Orca screen shows an icon for each item instead of a green dot (#359).

No change in what the app shows yet, as groundwork for coming features: the sender's name and address of a mail row are split in Rust (#315), a reload of the Slack list tells which unread messages are new (#348), a file attached to Orca can be of any kind and keeps its name on the Rust side (#323), and a command lets Claude revise a Todo draft (#325).

## v0.57.0

A-22 (new): a file in the file pane of the Orca screen (A-18) can be downloaded to this Mac. Right-click the file, choose 「ダウンロード」 and pick the place in the save dialog (#317, #320). It works for a file of a saved environment too.

A-8: in the list of the Orca screen, the projects that have a session but are not working now come right under the working ones, above the projects with no session (#356).

M-1: the 「すべて既読にする」 button of the mail list has a little room under it (#307).

No change in what the app does: the rule that counts the unread replies of a Slack thread for the badge is now in one place (#312), and the tools used to develop the app test how the hand-over between nightly runs is read (#313).

## v0.56.1

M-9: a card of new mail goes as soon as its thread becomes read, whether it is marked read in the list or in the thread, or read on another device (#304).

The tools used to develop the app now check a file edited in the working copy of a branch, and the commits pushed from it, in that copy (#310, #311), and keep a log of how long each check took (#260).

## v0.56.0

A-21 (new): a file opened in the editor of the Orca screen (A-18) is colored by its language: comments, keywords, strings, names and the like each have their own color (#298). The language is taken from the file name (`Dockerfile`, `Makefile` and the like), the extension and the first line, the same way as Orca's own editor (#299). A long file is colored a moment after typing pauses.

The release now starts when the Release PR is merged, without waiting for a tag (#303). The tools used to develop the app also run their own tests before a push (#255).

## v0.55.3

No change to the app. Only the tools used to develop and release it changed (#292, #294, #295). From this version the version of the app is taken from the release tag when it is built, so a build made from the source without a tag reports 0.0.0.

## v0.55.2

M-1, M-6: the button 「すべて既読にする」 of the inbox moved from the header to the right end of a heading 「未読」 above the unread rows (#234). The heading shows the number of unread threads. It is not shown when there is none, so a button that cannot be pressed no longer stays on the screen.

U-1, U-2: while the app waits for a restart in auto mode, the check for updates goes on (#235). A version newer than the one already replaced is replaced the same way and the popup names it, and the same version is not downloaded again. After an update, the restart opens the new app only once the old one has ended, so the Dock shows one icon and not two (#270).

A-6: the list of Orca is 25% of the screen at first, not 30% (#272). A row of a Claude session whose prompt, task title, conversation name and last message are all empty takes the title of its terminal, so the title is no longer empty (#277). In the working view (the bell), the headings 「入力待ち」, 「作業中」 and 「完了」 open and close their groups when pressed (#276).

A-8: in the list of Orca, the working projects keep the order they entered the working group, so they no longer swap places as the work moves (#271). A project that begins to work goes to the front of them. The rows of the sessions under a project are indented one level. Any number of projects can be open at once, and at first every working project is open; a project opens again when a new session of it begins to work.

A-18: a right click on a row of the file pane opens a menu in Japanese with 「パスのコピー」 and 「相対パスをコピー」, and the browser's own menu no longer shows there (#269). With no tab open, the file pane shows the files of the main worktree of the project selected in the list, so the files can be seen without starting a terminal or Claude first (#268).

## v0.55.1

No change to the app. Only the tools used to develop it changed (#262).

## v0.55.0

A-20: the settings have a tab 「フォント」 where the family and the size of the text are chosen for each screen (#203). Mail, the calendar and Slack have one choice each; the project list and the work space of Todo and of Orca are chosen apart, and the terminals and the file editor of Orca have their own. A choice is drawn at once and saved in `font-settings.json`; nothing looks different until one is made, and the terminals can still follow the settings imported from Ghostty.

A-19: the list of Orca has a search field above it (#200). What is typed narrows the projects and the SSH hosts to the names that hold it, with the matching letters in bold. Cmd+J moves the focus to the field from anywhere on the Orca screen, Down and Up move along the rows, Enter selects the row, and Escape clears the field.

A-8: the list of Orca is an accordion (#157). A project with sessions has an arrow at the left of its row; the project selected is open, and below it is a row for each session. Pressing a row selects its tab, and pressing a tab moves the selection to its row.

A-18: while the file pane is shown, its button is in a row of its own above the heading, at the right end; while it is hidden, it is at the right end of the tab bar of the pane in the top right corner (#242).

## v0.54.5

No change to the app. Only the way it is built changed (#257).

## v0.54.4

No change to the app. Only the tools used to develop it changed (#251).

## v0.54.3

No change to the app. Only the way it is built and published changed (#248).

## v0.54.2

No change to the app's features. Debug builds keep less debug information, and two dependencies were updated: encoding_rs 0.8.44 (#230) and salsa20 0.11.0 (#229).

## v0.54.1

No change to the app. Only the tools used to develop it changed.

## v0.54.0

A-18 Orca files and editor (#120).
The Orca screen has a file pane on the right, opened and closed by a button at the right end of the tab bar. It shows the files of the worktree of the selected tab as a tree, under the heading 「{repo} ・ {branch}」 with a reload button; a folder is read when it is opened, and what git ignores is drawn in pale italics.
A double press on a file opens it in a tab of the work pane, next to the terminals. What is typed is saved by itself once the typing stops for the time set in the 「エディタ」 card of the Orca tab of the settings (1000 ms at first, 100 to 3000 ms). The heading shows 「保存待ち」「保存中」「保存しました」. A file that changed on the disk after it was opened is not overwritten, and the heading says so. Text files of up to 384 KiB in UTF-8 can be opened.

## v0.53.4

No change to the app. Only the tools used to develop it changed.

## v0.53.3

No change to the app. Only the tools used to develop it changed.

## v0.53.2

A terminal opened from the plus of the Orca work pane keeps its pane when Claude is started in it (#213). Before, the tab of that terminal was taken for a new one, so its pane closed and the split folded back. A terminal whose kind changes, from plain to Claude or back, now stays in the same pane at the same place, selected if it was, and its screen is kept.

## v0.53.1

The inbox shows its state above the rows: 「読み込んでいます…」 until the first load answers, 「受信トレイにスレッドはありません」 when there is no thread, and, when a load fails, one line with the error and the button 「再読み込み」, which is there only then (#139). The rows already drawn stay under the line, and the failure stays when another screen is shown, until a load succeeds.
In the Todo screen, Todoist's inbox comes first in the list on the left, above 「今日」, and is named 「インボックス」 (#196).

## v0.53.0

A-17: the Orca work pane splits into panes, side by side or one above the other, with no limit on their number (#191). The right-click menu of a tab has 「右に分割」 and 「下に分割」, and a tab dragged to the edge of another pane splits it there, or joins that pane when dropped on its tab bar or middle. Each pane has its own tabs and plus, and a pane left with no tab closes. The split is saved for each project in `orca-panes.json` and comes back when the project is opened again.

## v0.52.1

The plus of the Orca work pane sits right after the last tab, not at the right end of the tab bar (#190). When the tabs overflow, they scroll and the plus stays in the bar.

## v0.52.0

T-6: a subtask in the detail of a task moves as a row of the task list does (#125). On hover its row shows the grip and the buttons to move it to another project or out of its parent, and the grip drags it onto a project or under another subtask of the same detail.

A thread shows its detail at once when its row is pressed (#140): the subject and the sender, with 「読み込んでいます…」 where the body comes. Until the body arrives only the back button works, and a failure shows where the body would be.

## v0.51.0

A-16: the Orca work pane has a plus at the right end of its tab strip (#130). It opens a menu of 「Claude を起動」 and 「ターミナルを開く」, which start Claude or a plain terminal in the worktree of the project or SSH host selected on the left, and open its tab; with two worktrees or more, a dialog narrowed to them picks one. The 「新規」 button of the list pane is gone.

## v0.49.4

No change to the app. Only the tools used to develop it changed.

## v0.49.3

Text selected in an Orca terminal by a program that uses the mouse, such as Claude Code, can now be copied (#150). The terminal puts what the program sends with OSC 52 in the clipboard; when the clipboard refuses it, ⌘C or Edit > Copy puts it there. Option+drag selects text in the terminal itself while such a program runs.

## v0.49.2

No change to the app. Only the tools used to develop it changed.

## v0.49.1

A URL in an Orca terminal opens in the default browser on ⌘+click (#147). Only http and https URLs open; a click without ⌘ still selects text. The URL shows while the pointer is over it.

The due moments of Todo are now computed in one place, with no change on the screen (#141).

## v0.49.0

A-15 the Orca terminals can keep the light or the dark appearance (#128). The "ターミナルの配色" card of the Orca tab has a new "外観" row: "システムに合わせる" (the default, as before), "ライト" or "ダーク". With "ライト" or "ダーク" the terminals draw that appearance's theme whatever the system's appearance is.

An image can be attached again in an Orca terminal and in the "Orca に渡す" pane, by pasting or dropping it (#135).

## v0.48.0

A-14 the colors of the Orca terminals are chosen in the settings (#109). The new "ターミナルの配色" card of the Orca tab has a light and a dark row, each with a theme of Orca's built-in themes and its swatch, and the terminals follow the system's appearance. The first choice is taken from the themes picked in the Orca on this Mac. The chosen theme comes before the colors imported from Ghostty.

The Orca screen:

- The project list puts the projects at work first, each part newest first (#98).
- A tab no longer loses its terminal when Orca drops Claude's state for a moment (#103).
- A terminal of a saved server shown in cookapps and in Orca at once is no longer drawn broken (#106). A key typed in cookapps gives the pane's size to Orca again, and the size Orca sends is drawn.
- The "合わせる" and "固定" switch is gone; a terminal always fits the pane (#115).

A plain-text mail body no longer draws a full-width space as a dotted box (#114).

## v0.47.0

S-16 the Slack list follows Socket Mode events (#96). In the new "リアルタイム更新" card of the Slack tab of the settings, register an App-Level Token (`xapp-`, scope `connections:write`) for a workspace; it is kept in the keychain. The app then stays connected to Slack, and a message posted, replied, changed or deleted in a channel reaches the list and the badge within about a second. While every workspace is connected, the whole list is read again every 5 minutes instead of every 2. `docs/slack.md` has how to make the token.

## v0.46.1

A Todo's description longer than 10 lines is folded at the 10th line in the detail (#93). The last line fades out, and "… 続きを表示（残り n 行）" under it shows the whole text; "折りたたむ" folds it again. Pressing the text still starts editing.

## v0.46.0

A-13 the terminals of the Orca screen take their font, colors and keys from Ghostty's config (#90). The new Orca tab of the settings has "取り込む", which reads Ghostty's config files once: `font-family`, `font-size`, `font-thicken`, the colors and `palette`, `theme` (also `light:…,dark:…`, following the system's appearance) and the `keybind` entries that send a text. The entries it could not take are listed with the reason. Shift+Enter in a terminal now sends a newline that Claude Code takes without sending.

## v0.45.0

A-12 every tab of the Orca screen is the session's terminal, typed into directly (#89). For a saved server, the list and the terminals are drawn from what Orca streams, with colors and no rereads by the clock. The keys go only to the terminal they were typed in. "合わせる" gives the pane's size to Orca and "固定" keeps Orca's size with a horizontal scroll; the switch is at the bottom of the left pane. This machine's Orca cannot stream to the app, because its WebSocket takes only a paired device, so its terminals stay mirrored. "新規" at the top of the left pane picks a worktree and starts Claude in a terminal.

The history and the composer are no longer on the Orca screen. The history, the answers to Claude's questions and further instructions stay in the "Orca に渡す" pane of a mail, a Slack thread and a Todo. A-10 (images in the Orca composer) and the skill list of the composer are removed with it.

## v0.44.1

The Orca history no longer shows the tags that Claude Code puts around a long paste (#58). The pasted text and the rest of the message stay.

## v0.44.0

M-9 new mail found by the auto sync shows as a card at the bottom right of the window (#61). It has the sender and the subject, and trash, archive and "詳細を開く", which opens the thread even from another screen. At most 3 cards show, and each goes after 10 seconds unless the pointer is on it. The load at startup shows none, and no OS notification is used.

A session started with "起動する" on the Orca screen now opens in its tab once it appears in the list, and the next text goes to it with "送る" instead of starting another session (#74).

The Orca history shows a turn that starts with a skill name as `/{name} {args}` (#56).

## v0.43.0

A-11 a question of Claude in the Orca history can be answered there (#57). Pick the choices in its box and press "回答を送る"; nothing is sent before that, and the button waits until every question has a pick. The keys go to the session's terminal one at a time, each after the screen shows the question's form, so a key never lands in another dialog. When the screen does not match, nothing more is sent and the box says to go on in the terminal. It was checked with Claude Code 2.1.318 on this machine; a saved environment uses the same route and is not checked yet.

## v0.42.1

The Orca screen no longer opens terminals of its own (#78). "ターミナルを開く" of the plus menu, its dialog and the app's PTY are gone, because they were slow over SSH and the cause was not found. The plain terminals of Orca still show as tabs, and the SSH hosts stay in the list.

## v0.42.0

A-10 the message field of the Orca screen takes images, by a drop and by a paste (#55). They show as thumbnails above the field, and each can be taken off. On send, each image goes to `.orca/drops/` of the destination worktree, and its path goes in the text, so Claude reads it. PNG, JPEG, GIF and WebP up to 20 MiB; an SSH workspace takes none. Old files in `.orca/drops/` are not removed, as in Orca itself. Written against Orca 1.4.248. This machine's Orca was tried; a saved server was not tried, and neither was a real drag or paste on the screen.

## v0.41.2

The message field of the Orca screen no longer shows a placeholder (#53). Typing `/` still opens the skill list.

The skill list of the Orca screen no longer offers a skill that Claude Code does not let the user choose (`user-invocable: false` in its `SKILL.md`) (#54).

The README is a product page with screen photos, and the how-to moved to `docs/` (#67). The development rules are public (#69).

## v0.41.1

The history of an Orca session reads as a conversation (#52). It has a tinted ground and the agent's messages are white cards; the heading of a run of tools is small plain text that says only how many times tools ran, or that they are running.

The count on the Orca icon of the side menu is now the sessions that need you (#47): the ones that wait for input, and the ones that finished or stopped while the app ran, until you open them. A session that works is no longer counted; while one works the icon is yellow and fades slowly (#48).

The README starts with what the app is for and who it suits (#45).

## v0.41.0

A-9 the content of a mail, a Slack thread or a Todo goes to Orca from a pane beside it (#33). The pane shows the destinations (a new session in a chosen worktree, or a running session) and a card of what goes, which can be opened to read the exact text or removed. Nothing is sent until the instruction is written and the button pressed. After that the pane shows the session's history and takes more instructions, beside the mail, the thread or the Todo, and the Orca screen folds the handed content into one line too.

## v0.40.0

A-8 the Orca screen has terminals and a project list (#42). The left pane lists the projects and the SSH hosts, newest first, each with the state icon Orca uses and its number of sessions, and a bell switches to the working sessions, which show the tool an agent is running. The right pane switches the sessions of a project with tabs, which can be closed. `+` starts Claude or opens a terminal in a worktree of this machine or on an SSH host: a real PTY, so full-screen programs work, and the shells end with the app. A plain terminal of Orca is only mirrored, with no colors, because Orca does not stream its bytes over its socket. The label of the target moved to the bottom of the left pane. Written against Orca 1.4.248.

## v0.39.2

A Slack thread opened from the list opens at its newest message, and stays there while its images load (#32). Opening the same thread again keeps its position.

## v0.39.1

A session whose Orca tab was closed while Claude kept running can be posted to again (#39). A question the agent asks is shown in the history unfolded, with its choices and the answer (#40). A Markdown table in the history, a Todo description or a Todo comment has ruled cells (#36).

## v0.39.0

A-7 the Orca screen is now two panes (#31). A row of the list opens the history of its session on the right, with the box to post to it. The list's width can be dragged, each row shows the latest prompt, the state, the branch and the time, and "running" is now 作業中. Tool calls fold into one line that opens on a press. `+` switches the right pane to a new session, and its target is chosen from a menu with a filter. Only Claude sessions are listed, and the choice of agent is gone (A-6). A saved Orca server is read over an end-to-end encrypted WebSocket using Orca's pairing, with new updates as they come; this machine's Orca is read every 3 seconds. Written against Orca 1.4.248. Reading from a saved server was tested against known vectors and a local stand-in, not yet against a real server.

## v0.38.1

The skill list of the Orca screen opens with a saved server as the target (#28). The CLI refuses to read the skills of another machine, so the list is that of the machine the app runs on, and it needs Orca running there. A failed read is tried again at most once a minute.

## v0.38.0

A-6 a new Orca screen lists the agents running in Orca as waiting for input, running and done, and posts to them through the `orca` CLI: a further instruction to a selected session, or a new agent in a chosen worktree (#25). No conversation is kept. For a Claude destination, `/` at the start of the text opens a list of the installed skills. The target is this machine or a saved Orca server, kept in `orca-settings.json`. A saved Orca server was not tried.

## v0.37.0

S-15 a check beside a row of the Slack list reads the row without opening its thread (#22). A channel has one read position, so the older rows of the channel are read too and the newer ones stay unread.

## v0.36.0

The rows of the Slack list draw the blocks, attachments and styles of a message, so a bot's post reads as it does in the thread (#16); images are not fetched there. S-14 a thread with unread replies is listed in the unread section, with "未読の返信 N 件" opening and closing its replies under the row, and its replies count in the badge. Up to 20 threads are checked in one read with `conversations.replies`. Slack has no public API to write a thread's read position, so what was read here is kept in `slack-thread-seen.json` (IDs and timestamps only) and does not clear the thread in Slack. A real Slack workspace was not tried.

## v0.35.1

The due popover no longer loses what was typed (#15): a click elsewhere, or pressing "追加" on the Slack card, confirms the text as Enter does, and Escape still cancels it. A picked day uses the time typed in the field (`15:00`, `15時`, `15時30分`, with 午前 or 午後, alone or after a date, 今日, 明日 or 明後日). A click elsewhere does not clear a repeating task's due date.

## v0.35.0

S-13 the Slack list has the sections "未読" and "ウォッチ", and the read section is gone (#13): a message that is not watched leaves the list once it is read. A bookmark button keeps a thread until it is let go, with "新しい返信 N 件" on new replies; `slack-watched.json` holds IDs and timestamps only, and up to 20 threads are checked in one read. The Slack list and the inbox list have a fixed header with "すべて既読にする": pressed twice in Slack, where the read position cannot go back, and once in the inbox, for the unread threads in the list, with "元に戻す". A real Slack workspace was not tried.

## v0.34.0

The Claude pane of the Slack thread is no longer for proofreading only (#11): it helps with summaries, answers and reply drafts too, and works with an empty reply. It now also sends the thread's messages, with the text and links of their blocks and attachments, up to 10,000 characters, only when send is pressed; the privacy policy says so. A proposal has a copy button, send is an arrow icon, the key hints are gone on both sides, and the lines above the reply field and the request field stay level (S-6, S-7). The compose and prompt screens are unchanged, except that a proposal from an empty text no longer shows a blank removed line. A real thread was not tried.

## v0.33.0

S-12 the Slack thread draws Slack's own styles (#12): bold, italic, strike, inline code, code blocks and `>` quotes, in a message's text and in the mrkdwn texts of its blocks and attachments. A tag stays text, URLs stay links except inside a code, and a line starting with `>>>` stays text. The list and what is sent to Claude are unchanged. The contents of an attached `.md` file are not shown. A real Slack message was not tried.

## v0.32.0

S-11 the Slack thread draws the blocks and attachments of a message (#10): headers, sections, fields, context, dividers, attachment color bars, titles and fields. A button with a URL opens in the default browser, one without shows its name only, and select menus are left out. Images are fetched only when "画像を表示" is pressed on a message, from any public https server, with no Slack token, so that server sees the user's IP address. The list and what is sent to Claude are unchanged. A real Slack message was not tried.

## v0.31.1

The inbox list lost its heading and its manual reload button, and the Slack list its heading and its unread count (the count stays on the Slack button). A failed inbox load is now tried again by itself, after 60 seconds and then twice as long each time up to 5 minutes, and a login that ends while the list is not on screen reloads it at the next sync round. The update button moved out of the side menu into a popup at the bottom right (#9), with the same action as a button in the update tab of settings; "あとで" closes it for that version until the app quits, and a toast stacks above it. The popup was not tried with a real update.

## v0.31.0

S-10 the Slack list and thread show the standard emoji of `:tada:`-style codes (the crate `emojis`, then a table of Slack's names generated from iamcal/emoji-data, MIT, in `slack_emoji.rs`, with skin tones). A workspace's own emoji stay as `:name:`, and codes in URLs, links, mentions, code and right after an ASCII letter or digit are not converted. S-1 and S-2 are unchanged. A real Slack message was not tried.

## v0.30.0

S-8 the Slack list split by `last_read` (`conversations.info`, confirmed on channels with the owner's real tokens) into at most 20 unread (10 first, the rest behind a button) and 5 read, a badge on the Slack button (`20+` above 20), opening a row marks it read on Slack (`conversations.mark`, optional `channels:write` and `groups:write`, which Slack makes include channel management), and the list is now read on every screen while the window is visible. S-9 a channel kept off the list (`slack-hidden.json`, IDs only; a hover icon on the row, undo, and a card in the Slack settings tab), because Slack's mute cannot be read (`users.prefs.get` answers `missing_scope`, `needed=read`, a legacy scope no new app can have). The real hover look of the hide icon, a real `conversations.mark` and the real read with these tokens in the app were not tried.

## v0.29.0

S-5 a Slack screen with the latest 20 messages of the joined channels of all workspaces (no DMs, no read state; at most 40 channels read per workspace per read, kept in memory), S-6 its thread detail with attached image thumbnails and a reply, S-7 proofreading the reply with Claude (`claude_proofread_reply`, a fifth purpose `slackReply`, default Sonnet and high, with selects in the pane), A-5 the side menu shows a function's accounts under its icon by screen (Google under the calendar on mail and calendar, workspaces under Slack), and Slack user icons (`slack-edge.com`, `secure.gravatar.com`, through `fetch_images`). New optional scopes `users:read` and `files:read`; the token is sent for images only to `files.slack.com`. A real Slack workspace, a real token and whether `conversations.history` holds thread replies were not tried.

## v0.28.1

no change to the app.

## v0.28.0

T-4 labels in the Todo detail (chips, a picker, and creating one with `todoist_create_label`; the Sync API's `labels` are read and kept in the cache), T-5 the Todo button and the Dock badge count a task once its due moment has come, 00:00 for no time (the Dock is checked by a Rust task every 15 seconds against `upcoming`, so it follows the clock with the window hidden), and a checkbox on the parent chip of a subtask's detail. The real Dock timing, a real `POST /labels` and the first real focus of the picker field were not tried: WebDriver's click leaves the focus on the + button, so E2E does not check it on opening.

## v0.27.0

T-3 comments in the Todo detail: read (Markdown, with a file card that opens in the browser), add, and attach one file to a comment (`todoist_comments`, `todoist_upload` over raw IPC and multipart, `todoist_add_comment`; reqwest gets its `multipart` feature, which brings `mime_guess` and `unicase`). The sanitizer of descriptions and comments also drops label, for, class, data-*, svg and math. A real Todoist comment, a real upload and the real file panel were not tried.

## v0.26.1

the due date of a Todo reads zero-padded `11月30日` (`2027年04月01日` when it is not this year; today and the due field of the popover are unchanged), and the due column is 92px at least so that a date with a time keeps the columns in line.

## v0.26.0

S-2 the Slack summary reads the whole thread (`conversations.replies`, up to 20 pages): a thread over 10,000 characters keeps the first, the linked and the latest messages and has its middle summarised in up to 5 chunks with a 180-second budget, and the card says how many messages it leaves out and when the linked message was cut; body lines after the first are indented so a message cannot forge a heading. A real Slack thread and a real model were not tried.

## v0.25.0

A-4 the Claude calls can sign in with an Anthropic API key as well as the subscription (`claude -p` stays and gets the key in its environment; the key is in the keychain under `jp.mysis.cookapps.claude`, the method in `claude-auth.json`; only the row's radio switches, and switching to the key runs `claude auth logout`), the Claude tab split into three cards (connection, model and effort, prompt), the effort selects colored by value, a change of model switching to the documented effort (Haiku medium, Sonnet high, Opus medium), and Fable no longer offered. A real key and a real logout were not tried.

## v0.24.0

T-2 (see above) and A-3 settings in six tabs with the heading and the tabs fixed at the top (Google first; the update tab has a red dot too), A-2 per purpose (`claude-settings.json` holds the model and effort of the Slack summary, the mail summary, the prompt conversation and the proofreading; an old one-pair file is the start value of all four), and S-3 opened from a Claude icon in the Todo list heading, with the conversation's model and effort under the request field

## v0.23.0

T-2 in the Todo list, drag a row's grip onto another task's row to make it that task's subtask (`todoist_move_under`), and take a subtask out of its parent with the "親タスクから外す" row button or by dropping it on its own project (`todoist_move` with the same project ID; Todoist's documentation says the task becomes the last root task, but this was not tried against the real API with the same project). E2E ends the slide animations before a drag, because they do not run in the hidden window. This commit was not pushed by itself, so no `v0.23.0` tag or release exists; T-2 was released in v0.24.0

## v0.22.0

S-4 "Slack に貼る" became a screen of its own instead of a popover: the whole post is edited in a field (the note was removed), the destination is a chip that opens the picker and none is chosen by itself, "メールに戻る" returns to the mail detail with the draft kept per mail, and a right pane proofreads with Claude (`claude_proofread_slack`; a width from a third to a half, set with a divider); the conversation code moved to `ts/claude-chat.ts`, shared with S-3

## v0.21.1

a Slack Bot User OAuth Token (`xoxb-`) is refused when it is registered, and one already stored shows the same message in settings instead of "接続済み"

## v0.21.0

A-2 the Claude model and effort chosen in the Claude settings card (`claude-settings.json`; default sonnet and medium, used by the Slack summary, the mail summary and the prompt conversation; high and above get a 300-second limit, and waiting for a Claude slot is limited to 60 seconds), the instructions sent to the model written in Japanese (a saved `todo-prompt.json` stays as it was), and in the prompt conversation a multi-line field that grows upward to 6 lines (Enter is a line break, Cmd+Enter sends) and a two-press clear

## v0.20.3

the Todo detail's three-dot menu (copy the task link, copy the description, delete with two presses), no manual reload, the Todoist connection and unlink moved to a "Todoist" settings card (`todoist_connected`), the description can be selected without starting the editor (a press edits after 250ms) and has a copy icon on hover, and completed tasks are fetched until a load has reached Todoist (`doneStale`)

## v0.20.2

removed the "この送信者の画像を自動で表示しない" link and `forget_image_sender` (a remembered sender stays remembered; images still need Gmail's authentication)

## v0.20.1

the app icon changed from the blue envelope to green tiles (three squares and a circle on the accent green; `icon.svg` is the source, `npx tauri icon` makes the `.icns` and `.ico`, and `icon.png` is the 1024px image taken from the `.icns`, because the generator's `icon.png` is 512px)

## v0.20.0

C-2 the detail of a calendar event in a popover beside it (time, Meet join button and URL with copy, location, description, attendee count, calendar, own answer; fetched with the week and kept in `calendar-cache.json`) and C-3 the first day of the week chosen from Sunday to Saturday in a "カレンダー" settings card (`calendar-settings.json`); `linkify` no longer links `tauri.localhost`

## v0.19.0

S-3 edit the Todo summary prompt (a screen opened from the Claude card in settings or from the summary card, a fixed part and an editable body saved in `todo-prompt.json`, and a conversation with Claude that proposes line diffs); on the S-2 card the due chip opens the calendar popover and the project starts as Claude's recommendation, tagged 推奨; the Slack input is enclosed in a random boundary

## v0.18.1

while a task is being created, a spinner on all four paths (the add field, a placeholder row for a subtask, the Slack card, the mail row and thread button); a subtask detail shows its direct parent above the name and opens it; the due field of a detail clears with an × shown on hover (two presses for a repeating task); also the fixes that followed v0.18.0 (HTML mail to text keeps rows and cells apart, minor findings of the AI summary review)

## v0.18.0

M-8 AI summary in the mail detail (an icon sends the thread's subject and text, newest first up to 10,000 characters, to `claude -p` with no tools and no settings; the points are drawn as text on a card under the subject and kept in memory only, per thread and latest message)

## v0.17.1

the update check runs every 5 minutes instead of every 6 hours (skipped while the window is hidden, and run on return when the last check is older; a version whose background replacement failed is not downloaded again automatically)

## v0.17.0

S-2 shows the Claude summary on a card before the Todoist task is created (name, description, due date and project can be edited; "Add" creates it, "Discard" creates nothing; `todoist_summarize_slack` and `todoist_add_from_slack` are separate commands), and the summary prompt asks for a short bullet list of the key points and Japanese writing rules

## v0.16.4

a red dot on the settings button while a newer version is out (its tooltip names the version), next to the existing update button

## v0.16.3

the due field of a Todo shows a one-off due date as `2026-11-02 12:00` (built from the date and time; a repeating task keeps Todoist's text)

## v0.16.2

the Dock badge shows the inbox unread count plus the Todo count of overdue and today open tasks (the sum of the two sidebar counts; a failed Todo count fetch keeps the last count)

## v0.16.1

adding Google accounts moved from the side menu's + button to a "Google" card at the top of settings (each account with a status label and its unread count), and the bottom of the side menu ordered as accounts, Claude, settings (last)

## v0.16.0

U-2 update settings and the running version (an "Update" card in settings with the version, the status, "check now" and a manual/auto switch saved in `update-settings.json`; auto replaces the app in the background and the sidebar button then only restarts it; the default is auto)

## v0.15.0

U-1 auto update (tauri-plugin-updater; checks `latest.json` of GitHub Releases at start and every 6 hours, and the update button in the side menu replaces the app and restarts it; macOS on Apple Silicon only; the CI `release` job puts the signed `.app.tar.gz`, its `.sig` and `latest.json` in the Release)

## v0.14.8

the Claude avatar in the side menu sits just above settings, and the gap above the menu is smaller (its tooltip stays hidden while the popup is open)

## v0.14.7

renamed the app and project to cookapps (identifier jp.mysis.cookapps, cookapps-mcp, GitHub hidetsugu-miya/cookapps; every account needs a new login), moved the developer guide to AGENTS.md. The v0.14.7 tag CI did not run: GitHub starts no workflow when more than 3 tags are pushed at once.

## v0.14.6

animation for the Todo open/close toggle (from the tag message; no entry was written in the old file).

## v0.14.5

nesting of Todo projects and subtasks, a right pane for the detail (from the tag message; no entry was written in the old file)

## v0.14.4

in the calendar, events the owner answered "maybe" to are struck through and unanswered events are drawn with inverted colors (the `declined` of the event type became `response` (`ResponseStatus`); `declined` of MCP `list_events` stays)

## v0.14.3

fix for the Windows CI clippy (the argument of the E2E setup renamed `_app`)

## v0.14.2

E2E (WebdriverIO on real WKWebView and WebView2, commands mocked in e2e/fixtures.js), the frontend as TypeScript (`ts/` -> tsc -> `src/js`) in per-screen modules, Rust types in `ts/bindings/` by ts-rs, Biome lint, CI split into static, test, e2e and installer layers (failed in the Windows CI clippy; noticed after the push, fixed in v0.14.3)

## v0.14.1

confirmation before disconnecting Slack, a right pane when permission is missing (shows only the scopes the token lacks), `im:history` and `mpim:history` for DM and group DM added to the permission check and the guidance, missing_scope shows the names of the missing scopes

## v0.14.0

S-2 summarize a Slack message with Claude and add it to Todo (settings became one card per integration with the explanation moved to a ? hint; the Claude account is shown in the side menu)

## v0.13.6

unified the screen colors to mint green (colors are variables in `:root` of `src/style.css`; accent `#1e7b52`; priority, error, account and event colors and the inside of the mail body iframe are unchanged), fix for code frames disappearing when the mouse is over a description

## v0.13.5

the description in a Todo detail is shown in full as Markdown (marked and DOMPurify placed in `src/vendor/`), and pressing it edits it with "Cancel" and "Save" (leaving the field does not save)

## v0.13.4

at start and when the calendar opens, show the previous inbox, events and Todo first from JSON in the settings folder (`inbox-cache.json`, `calendar-cache.json`, `todoist-cache.json`), then redraw after the fetch

## v0.13.3

events side by side in the calendar show no time, and long titles are cut at 20 characters with "…" (the tooltip has the full text)

## v0.13.2

fix for the Windows CI clippy (an empty Session off macOS as a braced struct)

## v0.13.1

on macOS, external images behind "show images" are fetched with NSURLSession (the host's bot protection rejected reqwest), threads newest first (the latest is opened at the top), a lower detail toolbar (failed in the Windows CI clippy; noticed after the push, fixed in v0.13.2)

## v0.13.0

Windows support (Credential Manager, the config folder of `cookup-mcp`, Ctrl+Z, windows-latest in CI and the nsis installer artifact, OS-neutral wording; not checked on a real Windows machine)

## v0.12.1

show 2 hours before now at the top when the calendar opens (changed from 3 hours in v0.8.1)

## v0.12.0

choose the Slack destination when pasting (recent destinations, channel search, links), multiple workspaces (the registration of destinations was removed from settings)

## v0.11.0

S-1 paste a mail into Slack (register the Slack token and paste destinations on the settings screen)

## v0.10.22

plain-text mail bodies in a monospace font (HackGen Console NF, 13px; ui-monospace if missing)

## v0.10.21

calendar events in title-then-time order, title only for events under 45 minutes, no background color on today's column

## v0.10.20

Todo operations (move, complete, delete, name, description, priority, due date picked on the calendar) are applied to the screen first and sent to Todoist in the background (on failure refetch and restore; a refetch during a write is neither sent nor drawn)

## v0.10.19

drag the grab icon at the left end of a Todo row and drop it on a project in the left pane to move it (own implementation with pointer events; HTML5 drag and drop is not used because it collides with Tauri's file drop)

## v0.10.18

"Edit" (name in place), "Due" and "Project" buttons on Todo list row hover (the same popovers and menus as the detail chips)

## v0.10.17

in the Todo "Today" view, a task added with no date gets today as its due date (Quick Add, then an update with `due_string: today`)

## v0.10.16

undo the last trash or archive with Cmd+Z and the "Undo" notice (`untrash` / `unarchive`)

## v0.10.15

pick a day from a month calendar in the due-date chip of a Todo detail (repeating tasks have only the text field)

## v0.10.14

the mail detail screen is closer to Gmail (subject above the body, header with avatar, sender, recipients and date, no frame around the body, old messages folded into one line, a background color on the detail toolbar)

## v0.10.13

Todoist switched to Sync API incremental sync; the Todo count and the Todo screen refresh every 10 seconds and when the window is focused again

## v0.10.12

events of `list_events` get the calendar name (`calendar`), and of the same event seen in several accounts the one with a title is kept (calendars shared for free/busy only had empty titles such as "Block")

## v0.10.11

the hover buttons of a list row are archive, trash, Todo in that order

## v0.10.10

turn URLs in plain-text mail bodies into links (they open in the default browser)

## v0.10.9

wider side menu; the inbox button shows the unread count and the Todo button shows today's open count (fetched at start and every 5 minutes, also outside the Todo screen)

## v0.10.8

fix for body links not opening on the real machine (WKWebView) (sandbox gets allow-top-navigation-by-user-activation, and Rust `on_navigation` stops the navigation and sends it to the browser; the click interception of v0.10.6 and v0.10.7 had not worked in WebKit)

## v0.10.7

minor fixes to body links (show the destination URL at the lower left; relative links, area, mailto, empty href)

## v0.10.6

open links in the mail body in the default browser (`open_link`, http and https only)

## v0.10.5

fixes for minor review findings (the field of a row restored after a failure; the conditions, clearing, date re-attachment and in-memory holding of the cache saving)

## v0.10.4

when Todoist cannot be reached (for example scheduled maintenance), show the previous content saved in `todoist-cache.json` in the settings folder, with a notice

## v0.10.3

fix for all-day events showing `[object Object]0` in the calendar (overwritten by a same-named function in Todo)

## v0.10.2

split the inbox list into unread and read, with read under a "Read" heading

## v0.10.1

mark read when a mail is opened, fit the body frame to the body, show embedded images and a "show images" button (remembered per sender), fix for a flaky test in CI

## v0.10.0

T-1 Todoist (Todo screen, make a Todo from a mail)

## v0.9.0

A-1 Claude integration (MCP server `cookup-mcp`)

## v0.8.10

own tooltip for icon-only buttons (read from `aria-label`)

## v0.8.9

`.app` build and placement in `/Applications` (`scripts/install-app.sh`)

## v0.8.8

account removal (from the popup; revoke the Google permission, delete from keychain, accounts.json and cache)

## v0.8.7

removed the limit where one failed calendar hid all of an account's events

## v0.8.6

unread count in the Dock badge (Rust `set_badge`; 0 clears it)

## v0.8.5

account info popup from the side menu avatar (email address, status and re-login, unread count)

## v0.8.4

placeholder app icon

## v0.8.3

parallel calendar fetches and an in-memory cache of weeks and the calendar list

## v0.8.2

the Medium and Low items of the audit (retry on rate limits, token expiry during a fetch, replace-write of accounts.json, ID validation, pinning the Rust version, CI permissions, a test of the keychain name)

## v0.8.1

show 3 hours before now at the top when the calendar opens

## v0.8.0

C-1 calendar

## v0.7.3

log failures to standard error, and delete the migration from a single account (the tag commit still has version 0.7.2; it was noticed after the push, so the tag was not redone)

## v0.7.2

set a CSP and load no external images and the like

## v0.7.1

fix for one account's failure hiding the whole list

## v0.7.0

M-7 auto sync

## v0.6.6

fix for removed rows coming back after consecutive operations

## v0.6.5

fix for the row trash button that could not be pressed

## v0.6.4

archive and trash remove the row at once and run in the background

## v0.6.3

the hover check mark changed from mark-read to archive

## v0.6.2

mark-read and trash buttons on row hover

## v0.6.1

unread dot and checkbox shown only on hover

## v0.6.0

M-6 mark read

## v0.5.0

M-5 multiple accounts

## v0.4.4

wider window and a one-step smaller font

## v0.4.3

fix for the list looking empty after an archive

## v0.4.2

garbled text fix

## v0.4.1

layout fix

## v0.4.0

M-4 archive

## v0.3.0

M-3 delete

## v0.2.0

M-2 read

## v0.1.0

authentication and M-1 list (with README and LICENSE)
