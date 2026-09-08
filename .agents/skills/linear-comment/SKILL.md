---
name: linear-comment
description: Write or revise a Linear issue comment or reply, including a plan, clarification, blocker, research finding, or completion update. Use for comments posted with save_comment and replies delivered to Linear. Does not format issue descriptions; use linear-task for those.
---

# Linear comments

A comment continues a conversation. Read the issue and relevant recent comments,
then answer the latest request or report what changed since the last update.
Assume the reader can see the description above it.

## Choose the content for the occasion

- Reply: answer the question first, with just enough explanation to support it.
- Plan: state the intended approach and any decision needed. Use a short list
  only when there are distinct steps. Do not repeat the ticket's scope or criteria.
- Blocker: say what failed, what it prevents, and what is needed to continue.
  Include the relevant error or command when it helps resolve the problem.
- Research: lead with the finding or recommendation, then evidence, limitations,
  and the next decision. Link sources or artifacts. Use a comparison table when
  it helps; do not force research into a product-release template.
- Completion: say what was completed and where to review it. Include relevant
  validation, remaining limits, and a PR or artifact link when available.
  Distinguish implemented, tested, merged, and released using the actual state.
- Implementation notes moved out of a description: preserve the details being
  moved and explain their context. A descriptive heading is useful here.

## Shape and voice

Default to one to three short paragraphs. Use bullets for parallel findings or
multiple questions. Longer research or technical evidence can take more space
when the reader needs it; there is no fixed word count or mandatory template.

Do not copy the description's sections such as "What clients see today", "Why it
matters", "Done when", or "What a user now sees" into ordinary comments. Do not
add empty headings, a mandatory bold takeaway, or a full ticket recap. Headings
are optional for substantial reports, not a requirement for each reply.

Write plainly and specifically. Include technical details when they support a
finding or help someone act. Avoid ceremonial opening lines, repeated status
updates, and unsupported claims that work is finished. No em dashes.

For example, a hypothetical research reply could be:

> The crawler covers the page checks we tested, but replacing SE Ranking still
> depends on rank tracking and backlink data. Those two capabilities remain
> unverified. The linked comparison records the test results and gaps.
>
> I recommend a pilot for page auditing before deciding on a full replacement.

## Posting

This skill controls writing, not permission or posting frequency. Follow the
user's request and the active workflow for whether and when to post. Draft only
when asked for a draft. Do not rewrite the description or change issue metadata
as a side effect of replying. Use the existing issue/thread context when posting
with `save_comment`; do not post an identical update twice.
