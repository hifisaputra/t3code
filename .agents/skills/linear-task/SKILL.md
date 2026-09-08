---
name: linear-task
description: Write or rewrite a Linear issue description so a non-engineer can read it. Use when creating a ticket or follow-up issue, or when asked to revise the description or summarize shipped behavior in it. For comments, replies, and completion updates posted as comments, use linear-comment instead.
---

# Linear task descriptions

A Linear description is read by a PM in a list view, on a phone, between meetings. Write for that reader.

These templates apply only to the issue description. Use `linear-comment` for
comments, including closing updates. A request to reply or report results does
not itself call for rewriting the description.

## The one rule

**Everything in the description must be checkable by opening the app. Everything checkable only by opening the repo goes in a comment.**

Nothing gets deleted. It moves.

## Process

1. Read the issue with `get_issue`. The truncated preview from `list_issues` is not enough.
2. Find the buried lede. It is almost always already written, just not first. Usually a limit, a caveat, or a number.
3. If the description contains engineering detail that needs moving, preserve it in an implementation-notes comment using `save_comment` and the `linear-comment` skill. Do this **first**, so nothing is lost if the next step fails. Skip this when there is nothing to move.
4. Replace the description with `save_issue`.
5. Report what moved and flag any judgement call you made.

## Length

Cap the description at 350 words. If it genuinely needs more, it is two tickets.

## Template: updating a description after completion

```
[One line: what is different now. Say whether it is released, on a branch,
or behind a flag. "Done" on the board reads as "shipped" and often is not.]

**[The one fact that would cause a bad demo or a wrong decision if missed.]**

## What a user now sees

* [3 to 5 bullets, each visible in the product]
* [Mark anything that only works on a demo or test account]

## Known issue

[What is broken, and whether it is ours to fix]

## Follow-ups

* [DEL-x](url): one line on what it unblocks
```

## Template: opening a task

```
[One line: what someone will be able to do that they cannot today.]

**[If there is a cheapest-first move or a spike that should happen before
anyone builds, say it here, not at the bottom.]**

## What clients see today

[The current behaviour, including why any stopgap is deliberate]

## Why it matters

[What it unblocks, or what breaks without it. Two or three lines.]

## Done when

* [Criteria verifiable by clicking, not by reading a diff]

## Open question for PM

[Any product decision you need. Give it its own heading. Never bury a
decision inside an implementation step.]
```

## What moves to the comment

- Commit hashes, branch names, PR numbers. The git integration already links these.
- File paths, function names, config keys.
- CI results. `tsc` clean and tests passing is CI's job to report, not the ticket's.
- Rejected alternatives and the argument for each. That is code review material.
- Merge conflict resolutions, dependency ordering, migration steps.

## Translation table

| Instead of                                            | Write                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Branch `feat/x`, tip `27dbb0ec`                       | _(delete, the git integration links it)_                                    |
| `tsc` clean, layering guard passes                    | _(delete)_                                                                  |
| `trafficByCheck` takes the account's own `checkDates` | A live client's screen cannot show demo data by accident                    |
| `RIVALS` became a parameter rather than a constant    | The panel already accepts competitors, so it works the day we have a source |
| both come out of `visibilityAt`                       | The chart and the headline figure can never disagree                        |
| ~4,000 lines added under that exclusion               | The new code is not linted or tested                                        |
| Ships spec `docs/specs/237-x/spec.md`                 | [What the client or user gets]                                              |

## Writing rules

- **Bold exactly one thing.** The fact that would cause a bad demo or a wrong decision. Put it in the first two paragraphs.
- **Numbers beat adjectives.** "$5.20 to $2.32 per article, down 55%" not "significantly cheaper".
- **Name the guarantee, not the mechanism.** A shared function name means nothing to a PM. The promise it enforces means everything.
- **Do not argue.** Give the decision. The reasoning goes in the comment.
- **Apply the `unslop` skill as well.** Unslop fixes voice. This skill fixes audience and length. They are different problems and you need both. Note that unslop forbids em dashes, and long Claude-written tickets tend to be full of them.

## Linear specifics

- The tool names are the same whether they come from Linear's own MCP server or from T3 Code's `t3-code` server. In a T3 Code thread linked to an issue, every tool defaults to that issue when the id is left out.
- Bold that wraps a code span gets split by Linear's editor. Keep backticks outside bold.
- Link issues as `[DEL-123](full url)`. Linear normalises the rest.
- Do not change status, labels, estimate or milestone unless asked.
- If someone else created the issue, their opening paragraph is theirs. Replacing it is fine, but say so in your report so they can restore it.

## The pattern to expect

The strongest sentence in a long ticket is usually already in it, sitting in section six. Most of this work is promotion, not invention. Look for what got written last and should have been written first.
