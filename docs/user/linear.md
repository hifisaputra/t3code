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
identifier such as `DEL-123`, or the issue URL from your browser. The dialog resolves it and shows
the title and current state. If you would rather browse, **My issues** below the input lists the
issues assigned to you.

Choose **Worktree** to work in a fresh git worktree, or **Local** to work in the checkout you
already have open. Worktree keeps the checkout you are using free.

The dialog also shows the branch the thread will start on. By default that is the branch Linear
suggests for the issue, such as `tomo/del-123-fix-login`; see Branch names below to follow your
repository's own convention instead. Either way the branch carries the issue identifier, so Linear
links the pull request to the issue by itself and moves the issue through In Review and Done as
the pull request progresses. You do not have to paste the identifier anywhere.

The composer opens with the ticket already in it: identifier, title, URL, description, and
comments, with a blank line for your own instruction.

The issue also moves to the first started state on its team, usually **In Progress**. Turn that
off with **Move issue to In Progress when a thread starts** in **Settings → Integrations →
Linear**. An issue that is already started, completed, or canceled is left alone.

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
to the issue and moves the issue through In Review and Done as the pull request progresses.

## See your issues

The **Issues** button in the sidebar opens a page of the open issues assigned to you. **Open
issues** in the command palette does the same. Both appear once a server has a Linear key saved.

Narrow the list by state, team, project, or cycle. The page remembers the filters you left it
with, so the button brings you back to the same view. Select an issue to read it in full,
description and comments included.

**Start thread** on an issue runs the flow described above, with the same worktree and branch
choices. An issue that already has a thread offers **Open thread** instead.

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

The status you see belongs to the server your client is connected to. If you are working against a
remote environment, the Connection row shows that remote server's Linear connection, not one you
set up locally. Connect each server you want to use with Linear.

## Privacy

The key is stored on the server alongside your other credentials. Settings and logs show it
redacted, and it is never sent to any client. Clients ask the server for Linear data, and the
server makes the calls.
