---
name: linear-work
description: Work a Linear ticket end to end from a T3 Code thread that is linked to it. Use when a thread was started from a Linear issue, when a message names an issue such as DEL-123 and asks you to work on it, when you were delegated an issue in Linear, or when a message quotes a ticket in a linear-issue block. Covers reading the ticket, deciding whether to ask or start, what to post to Linear and when, follow-ups, the branch, and the pull request.
---

# Working a Linear ticket

You are in a thread that T3 Code linked to one Linear issue. The harness already
made the branch or worktree and, usually, moved the issue to In Progress. Your job
is the ticket, and only the ticket.

Linear tools live on the `t3-code` MCP server, with the same names as Linear's own
MCP server: `get_issue`, `list_comments`, `list_issue_statuses`, `list_my_issues`,
`save_comment`, `save_issue`, `create_issue`, plus `upload_image` for screenshots.
Every one of them defaults to the linked issue when you leave the id out. If the tools are missing, the ticket was
quoted in the message inside a `linear-issue` fenced block. Work from that block,
and put anything you would have posted to Linear in your reply instead.

Use those tools, not Linear's own MCP server. If tools named `mcp__linear-server__*`
are also present, they authenticate as the person who set them up, so anything you
post through them arrives under their name. The `t3-code` tools post as the app when
you were delegated the issue in Linear, and route through the user's approvals when
you are working their thread. Both are wrong to bypass.

## 1. Read everything before you touch anything

1. `get_issue` with no arguments. Then `list_comments`. The composer preview or the
   quoted block may be truncated; the tools are not.
2. The parent, if there is one, and any sub-issues. `get_issue` takes their
   identifiers.
3. The code the ticket points at. Open the files, run the app if the ticket
   describes behaviour, reproduce a bug before fixing it.
4. If you have already worked this ticket (a comment of yours is on it, or the
   thread has history), read only what is newer than your last comment. Do not
   redo the reading or the plan.

## 2. Say what done looks like

Your first reply restates the done-when in one to three lines that someone could
check by clicking in the product, not by reading a diff. If the ticket has a
"Done when" section, use it. If it does not, write one from the description and
comments. This is the sentence the rest of the work is measured against, so get
it right before anything else.

## 3. Ask and stop, or start

A product decision is one the ticket's author would want to make: what the user
sees, which of two behaviours wins, whether something is in scope, anything that
changes the done-when. When one is missing, ask and stop. Do not start coding on
a guess and hope to fix it later.

- Someone is at the keyboard (you are in an interactive thread): ask in your
  reply. One message, every question numbered, each with the option you would
  pick if forced. Then stop and wait.
- Nobody is (you were delegated the issue and the thread was started for you):
  `save_comment` the same numbered questions on the issue, then stop.

An implementation decision is yours. Pick, note it in one line, and move on.
Ambiguity about the code is not a reason to ask; ambiguity about the product is.

When nothing is missing, say so in a line and start.

## 4. One plan comment, then report the result

Before the first code change, post one short plan comment with `save_comment`:
the intended approach and anything you decided in step 3. Use `linear-comment`
for its wording and format. Skip the comment only when the ticket already carries the plan
and you are following it unchanged.

After that, save the next unsolicited update for the pull request or completed
research deliverable. Answer new questions and report blockers when needed.
No routine progress notes, no "still working", no restating the plan. The thread
is where you narrate; the issue is where decisions and results go.

Writes to Linear may first show the user an approval card in T3 Code. If a write
is declined, do not retry it. Ask what they want instead.

## 5. Stay inside the ticket

Anything you find that the ticket did not ask for gets its own issue with
`create_issue`, which files a sub-issue of the linked issue by default. Write it
with the `linear-task` opening template. Then leave it alone. A ticket that
grows while you work it is the most common way a small change never ships.

Two exceptions. Fix it in place if the done-when cannot be met without it, and
say so in the PR. And if a follow-up is a one-line change that you would be
embarrassed to file, fix it and mention it.

## 6. Branch and pull request

- Keep the branch the harness gave you. Do not rename it, do not switch, do not
  rebase onto something else unless the repository's own instructions say to.
- Commit the way the repository's guidelines say. Do not push or open a pull
  request unless the ticket, the user, or the repository instructions ask for it.
- When you do open one, the description carries the identifier as a magic word
  so Linear links it and moves the issue on its own: `Fixes DEL-123` for the
  whole ticket, `Part of DEL-123` for a slice. Open it as a draft if any
  question from step 3 is still unanswered or any done-when item is unmet.

## 7. Close out

When the pull request is up, use `save_comment` with `linear-comment` to report
what was completed, link the PR, and note relevant validation or remaining limits.
When the change is visible, show it: save the screenshot in the workspace, pass its
path to `upload_image`, and put the markdown it returns in the comment. One image of
the state that changed beats a paragraph describing it.
For research or other work without a PR, report the findings and link the
deliverable when the requested work is complete. Do not use the issue-description
template for either update.

Leave status changes to the linked PR automation unless the user explicitly requests a
manual change. Report implemented, merged, and released accurately. Change planning
metadata when the user or ticket asks for it, rather than inventing ownership or scheduling.

`save_issue` can set assignee, project, milestone, cycle, estimate, labels, priority, and
dueDate. Omitted fields stay unchanged; null clears nullable fields and an empty label
array removes all labels. Setting labels replaces the complete set. Changing the project
clears the old milestone unless a replacement is supplied. Resolve milestones within the
project and cycles within the team; use IDs when names are ambiguous.

Use `list_issues` for work across assignees. Find resources with `list_projects`,
`list_milestones`, `list_cycles`, `list_issue_labels`, `list_users`, and `list_teams`;
follow pagination when more results are available. Use `save_project`, `save_milestone`,
and `save_issue_label` to create or edit those resources when requested. `update_cycle`
edits an existing cycle; Linear schedules new cycles automatically. These tools use the
same posting identity and approval flow as issue updates.

## 8. When blocked

Post the exact error, in a code block, with the command that produced it, and
stop. In the thread if someone is there, with `save_comment` if you were
delegated. Do not work around a failing test, a missing credential, or a broken
build by narrowing the ticket. Someone else decides that.

## Writing to Linear

Use `linear-comment` for every comment and reply delivered to Linear, including
plans, questions, blockers, research findings, and completion updates. Use
`linear-task` only when creating or editing an issue description. Follow
`linear-comment`'s posting-identity rules: manual threads describe outcomes without
personal attribution; delegated runs speak as the Linear agent/app. Leave updates unsigned
unless the user explicitly requests an authorship disclosure.
