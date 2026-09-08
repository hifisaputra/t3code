# Linear

T3 Code connects to your Linear workspace with a personal API key that your server holds. Every
client connected to that server uses the same connection, whether you are on web, desktop, mobile,
or joining from another machine. The key stays on the server and is never sent to a client.

## Connect your workspace

1. In Linear, open **Settings → Security & access → Personal API keys** and create a key. Copy it
   before you close the dialog, since Linear shows it once.
2. In T3 Code, open **Settings → Integrations → Linear**, paste the key, and save.

The Connection row then reads **Connected as \<your name\> in \<your workspace\>**. If it does not,
see Troubleshooting below.

## Start a thread from an issue

Open the Linear issue dialog from the new-thread menu, from the command palette, or with the
`thread.startFromIssue` keybinding you set in **Settings → Keybindings**. Paste an issue
identifier such as `DEL-123`, or the issue URL from your browser. If you would rather browse,
the box lists the issues assigned to you as you type, narrowed by identifier or title. The issue
opens below with its state, labels, and full description, so you can read the brief before
starting.

Under the issue, check what the thread will get: the project it runs in, whether it gets a fresh
git worktree or uses the checkout you already have open, the branch — the issue's own, or the one
the checkout is already on — and the model. A worktree
keeps the checkout you are using free. The model starts as the project's default and can be
changed for this thread alone. Add a note if the ticket leaves something out; it is sent with the
first message.

**Start thread** does the rest in one step: the branch is checked out, the thread is created, and
the agent begins. There is no draft to press Enter in. The agent reads the ticket and its comments
through its Linear tools, restates what done looks like, and then either starts or asks you the
question the brief left open. When agent access is off, the ticket text itself is sent in the
first message instead, since the agent has no way to read it.

By default the branch is the one Linear suggests for the issue, such as `tomo/del-123-fix-login`;
see Branch names below to follow your repository's own convention instead. Either way the branch
carries the issue identifier, so Linear links the pull request to the issue by itself and moves the
issue through In Review and Done as the pull request progresses. You do not have to paste the
identifier anywhere.

If the work belongs on the branch you are already on — a fix to a branch in review, or a second
issue on the same feature — switch the branch row to **Current branch**. The thread then starts
where the checkout already is: nothing is created and nothing is checked out. A worktree is not
offered for it, since a worktree needs a branch of its own. The pull request will not carry the
issue identifier either, so link it from the issue in Linear if you want the two connected.

The issue also moves to the first started state on its team, usually **In Progress**. Turn that
off with **Move issue to In Progress when a thread starts** in **Settings → Integrations →
Linear**. An issue that is already started, completed, canceled, or marked duplicate is left alone.

A linked thread shows the issue identifier next to its pull request: in the sidebar, in the chat
header, and in the thread list and thread actions on mobile. Select it to open the issue in Linear.

Starting a thread from an issue is a web and desktop action. Mobile shows the link and opens the
issue, but does not start threads from issues.

### Unlink an issue

Choose **Unlink issue** in the thread menu, beside the action that unlinks a pull request. The
thread keeps its branch and its work; only the link is removed. The issue is not moved back.

### Map teams and projects to repositories

Go to **Settings → Integrations → Linear → Repositories** and add a row for each Linear team or
project, pointing it at the project folder that work belongs in. Give a row a base branch if issue
branches there should be cut from something other than the repository's default branch.

A row for a Linear project wins over a row for its team, so one repository can own a whole team
while another owns a single project inside it.

Without a row, an issue starts in the project you are currently in. Either way the dialog shows
which repository it is about to use, and you can pick a different one before you start.

### Map issues to a repository with `t3.json`

A repository can declare which Linear work belongs to it, in the `t3.json` file at its root:

```json
{
  "linear": {
    "teams": ["DEL"],
    "projects": ["a1b2c3d4-0000-0000-0000-000000000000"],
    "baseBranch": "develop"
  }
}
```

- `baseBranch` is the branch issue branches are cut from. Without it, T3 Code uses the remote's
  default branch.
- `teams` and `projects` record which Linear teams and projects belong to this repository.

Only `baseBranch` changes behavior today. `teams` and `projects` are read but not yet used, and
are there for issues delegated to T3 Code from inside Linear.

Because `t3.json` is checked in, everyone who clones the repository gets the same mapping. This is
the fallback for repositories that ship their own mapping; the Repositories setting above is the
one T3 Code reads first.

## Branch names

By default a thread starts on the branch Linear suggests, such as `tomo/del-123-fix-login`. If
your repository follows its own convention instead, set **Settings → Integrations → Linear →
Branch names** to **Repository convention**. Branches are then named `feat/del-123-fix-login`,
with the prefix chosen per issue.

**Prefixes** is the comma-separated list you are offered, such as `feat, fix, bug, chore`. The
first one is the default. **Label prefixes** picks a different one automatically: give it a Linear
label and the prefix issues carrying that label should use, for example the label `Bug` and the
prefix `fix`. An issue matching no rule gets the first prefix.

Whichever style you use, the issue dialog shows the branch before you start, and under the
repository convention you can change the prefix or type the whole branch name yourself.

The branch has to keep the issue identifier, such as `del-123`, and the dialog will not start a
thread without it. Finding the identifier in the branch name is how Linear links the pull request
to the issue and moves the issue through In Review and Done as the pull request progresses. The
exception is **Current branch**, which asks for no branch at all and gives up that automatic link.

## See your issues

The **Issues** button in the sidebar opens a page of the open issues assigned to you. **Open
issues** in the command palette does the same. Both appear once a server has a Linear key saved.

Narrow the list by state, team, project, or cycle. The page remembers the filters you left it
with, so the button brings you back to the same view. Select an issue to read it in full,
description and comments included.

**Start thread** on an issue opens the same dialog, with the issue already picked. An issue that
already has a thread offers **Open thread** instead.

## Let agents work on issues

Turn on **Let agents read and update Linear issues** in **Settings → Integrations → Linear**. The
setting belongs to the server, not to one project, so it applies to every project on that server.

Once it is on, the next turn in a thread that is linked to an issue gets Linear tools in its
`t3-code` MCP server. Threads already running pick the tools up on their next message. Every tool
defaults to the thread's linked issue, so an agent does not need an identifier to work on the issue
you started from. Pass one, such as `DEL-123`, to reach a different issue.

The tools are:

- `get_issue` reads an issue: title, description, state, labels, assignee, and links.
- `list_comments` reads the comment thread on an issue.
- `list_issue_statuses` lists the workflow states a team can move an issue to.
- `list_my_issues` lists the open issues assigned to you.
- `save_comment` posts a comment on an issue.
- `save_issue` edits an issue's title, description, state, or labels.
- `create_issue` files a new issue. It files a sub-issue of the linked issue unless the agent is
  told to file it somewhere else.

Agents cannot assign or delegate an issue, cannot delete one, and cannot change estimates or
projects. Those stay with you.

Writes wait for you. **Ask before agents write to Linear** sits in the same settings group and is
on by default. Every comment, edit, or new issue an agent wants to make shows up as an approval in
the thread's composer, summarised in one line. **Review** opens the whole change — the comment or
description as Linear will render it, and every field the write would set — and you can approve or
decline from there without going back to the row. **Approve** applies it, **Decline** tells the
agent you refused, and **Allow for this session** stops asking for the rest of that agent session.
Reads never ask.

If nobody answers within about ten minutes the change is not made and the agent is told to ask
again. Agents also have their own tool timeouts, often about a minute, so an agent can give up
waiting before that. Turn the setting off if you would rather agents write to Linear without
asking.

Every read and write goes through the key you saved, so changes land in Linear as the connected
user. Comments and edits an agent makes look like yours in Linear's history, and a thread started
from an issue is told to post unsigned — no footer naming the agent or T3 Code, since an agent
that has just read a ticket's comments otherwise picks up the habit of signing. Whether the rest
of your team is told an agent wrote it is your call: say so in the issue or the comment.

The key itself never leaves the server. Agents call the tools, the server calls Linear.

Agent browser access is a separate setting, with its own toggle. Turning one on does not turn on
the other.

### Give agents a runbook

The `linear-work` skill is the runbook for working a ticket: read everything before deciding
anything, restate what done looks like, ask and stop when a product decision is missing, post one
plan comment and then report the pull request or completed research, file follow-ups as sub-issues, and never
set an issue to Done. When it is installed for a provider, the kickoff message mentions it as
`$linear-work` so the agent follows it from the first turn.

The repository includes `linear-work`, `linear-task`, `linear-comment`, and `unslop` under
[`.agents/skills`](../../.agents/skills). `linear-task` formats issue descriptions;
`linear-comment` handles conversational replies and findings. `unslop` supplies writing guidance.
Claude Code can also access these through the repository's `.claude/skills` symlink.

To use them in other projects, copy all four skill directories into `~/.claude/skills/` for
Claude Code or `~/.codex/skills/` for Codex on the machine running the agent. Without the runbook,
the kickoff spells out the first steps inline.

## Replace or remove the key

Use the same **Settings → Integrations → Linear** row. Paste a new key and save to replace the
current one, or clear the field and save to disconnect. Removing the key stops all Linear access
for every client on that server.

Replacing the key in T3 Code does not revoke the old one. Delete it in Linear if you no longer
want it to work.

## Troubleshooting

- **Linear rejected the API key:** the key is wrong, has been revoked in Linear, or belongs to a
  different workspace than the one you expect. Create a new key and save it again.
- **Rate limited:** Linear is throttling requests. Wait until the time shown, then check again.
- **Connection error:** the message names the network problem the server hit while reaching
  Linear. Fix connectivity on the machine running the server, then choose **Check again**.
- **Agents say the Linear tools are missing:** the toggle is off, no key is saved, or the thread
  started before the toggle was turned on. Turn it on and send another message.
- **An agent says its Linear change was declined or timed out:** the change needed an approval you
  did not give. Look for the approval card in the thread's composer and answer it, or turn off
  **Ask before agents write to Linear** if you do not want to be asked at all.

The status you see belongs to the server your client is connected to. If you are working against a
remote environment, the Connection row shows that remote server's Linear connection, not one you
set up locally. Connect each server you want to use with Linear.

## Privacy

The key is stored on the server alongside your other credentials. Settings and logs show it
redacted, and it is never sent to any client. Clients ask the server for Linear data, and the
server makes the calls.

## Delegate work from Linear

Inbound delegation lets teammates mention T3 Code or delegate an issue to it in
Linear. Your always-on T3 environment creates a worktree, starts the configured
provider, and sends questions and results back to Linear. Everyone with access
to the allowed Linear teams can direct work using this environment's repositories
and provider credentials.

Set this up in the web or desktop client under **Settings → Integrations → Linear**:

1. Make the environment reachable over HTTPS through T3 Connect. Enter its public
   URL in the delegation settings.
2. In Linear, create an OAuth application named **T3 Code**. Use the OAuth callback
   and webhook URLs shown in T3 Settings, and enable **Agent session events**.
3. Save the app client ID, client secret, and webhook signing secret in T3. Select
   **Connect**, open the authorization page, and install as a Linear workspace
   admin. Return to T3 and refresh the connection.
4. Choose a delegation model and allowed team keys. An empty team list allows all
   teams the app can access. Set repository mappings, or declare `linear.teams`
   and optionally `linear.projects` and `linear.baseBranch` in each repository's
   `t3.json`. Ambiguous repositories produce a question in Linear.
5. Enable inbound delegation. Permission prompts are relayed to Linear by default.
   Enable **Run without permission prompts** only when you want full access for
   unattended commands. The separate **Confirm agent writes** setting still
   controls approvals for changes made through T3's Linear tools.

Delegate an issue or mention the app in an issue comment. Follow its thread link
to inspect the run in T3, including from mobile. Reply to questions in Linear;
permission requests accept `approve` or `deny`. When several questions arrive
together, answer one per line using the question identifiers shown.

Use **Stop delegation** in the T3 thread header, or send `stop delegation` in the
Linear session, to interrupt work and stop forwarding replies for that session.
Disabling inbound delegation prevents new incoming requests; existing runs may
finish. Disconnecting disables delegation and removes this environment's saved
app tokens. To uninstall the app from the workspace, remove it in Linear too.
