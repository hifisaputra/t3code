# Developer assistant

The developer assistant works through a repository's Linear issues while you make decisions and
review work. Each configured repository runs an issue loop that works as many issues at once as you
choose on **Start**: one by default, six at most. Every issue goes to its own team of threads on its
own worktree, fresh from the integration branch:

- **Team leader** reads the issue and decides whether the team takes it, asks you first, or
  declines it. Once taken, it writes the worker's brief, checks the staging deployment, starts the
  e2e run, and decides what happens when something fails.
- **Worker** implements the issue, opens the pull request and merges it once the change is approved
  and has passed its checks.
- **Code review** reviews the worker's commits. The two trade rounds directly until the reviewer
  approves a commit.
- **E2E** tests the change with a browser and takes screenshots, either in the team's worktree
  before the merge or on staging after it. You choose which during setup.

A delivered issue closes its team and frees its place for the next issue immediately. Your review
can happen later, from Linear or T3. Different repositories can run at the same time.

The **assistant conversation** is yours. It does not run issues; ask it what the loop is doing, to
put an issue next, to redirect an issue in progress, or to release to production.

## Set up a project

Connect Linear and enable **Agent access** in **Settings → Integrations → Linear**. Add your
application's repository as a T3 project on the environment that will run the agents.

On the web, open **Developer assistant** from the sidebar or command palette and choose
**Add project**. Select the repository, Linear project, issue scope, and the assistant and coding
models. “Assigned to me” means the account connected to Linear on that T3 server.

Choose **Start setup conversation**. The assistant inspects the repository's instructions,
deployment workflows, staging services, databases, and verification requirements. It uses existing
provider access on the server and asks you for missing details in the thread. The **During setup**
permission chooses whether the setup conversation runs with full access (the default) or asks before
each command. Either way, setup does not authorize repository changes or deployments. Do not paste
credentials into chat; configure access through the provider's normal login or secret settings.

When the proposal is ready, choose **Review and save** in the bar above the setup conversation, or
from **Needs you** on the assistant board. Discuss corrections in the thread; the assistant can
revise its proposal. **Save setup** configures the project and leaves its queue stopped. Choose
**Start** when you want it to process issues. You can leave and resume a setup conversation across
reloads. **Cancel setup** keeps the conversation in history without applying its proposal. To revise
an existing assistant, pause it and choose **Revise setup** from its project menu. An issue in
progress can stay; while it does, the base branch and Linear project cannot change, and the new
setup applies to the threads started after you save.

The integration branch usually is `develop`. It takes priority over Linear repository mappings.
This version expects an `origin` remote and merge commits or fast-forward merges; squash and rebase
merges cannot pass its commit ancestry check.

Before starting, prepare the application:

- The integration branch exists on `origin`, and changes to it deploy automatically to staging.
- The agent can authenticate with your repository host and inspect CI and deployment status.
- Worktree setup installs dependencies and supplies development credentials. T3 runs your existing
  project setup script when preparing a worker's worktree.
- Development, staging, and production databases are separate. A Git worktree does not isolate
  Postgres or Supabase databases, D1 bindings, queues, or other external resources. Define where
  migrations run and how they reach staging. Avoid migrations that break the version still serving
  traffic during a rollout.
- Verification commands and cleanup are documented. Teams running at the same time each need their
  own development ports, databases and other shared resources; the instructions say how to derive
  them from the team's number, which every thread is told. Workers should stop the servers and
  background processes they start before delivery.
- If the e2e check runs in the team's worktree, the instructions say how to run the application from
  a worktree and how to sign in to it there.
- The saved staging targets identify the actual deployment workflows/services, and the assistant
  has the access needed to exercise the affected staging behavior.

The saved approval mode applies to the assistant and every team thread after setup. With
approvals required, permission requests wait for you in their original threads. Full access allows
unattended commands within the provider's configured permissions. Use models and providers with
working T3 MCP tool access.

Mobile provides loop controls, dispatch, the assistant conversation, decisions, and reviews for projects
configured on web or desktop. All clients use the same server-owned state; closing a client does
not stop the assistant. The T3 server and its provider runtimes must remain running.

## Verify staging

A custom script is optional. Setup can use a GitHub Actions deployment workflow or Railway staging
services. The T3 server needs the corresponding authenticated `gh` or `railway` CLI. T3 checks the
latest workflow run or active service deployment and verifies that its commit contains the worker's
changes on the integration branch. The assistant selects the targets affected by each issue; when
it does not select targets, all configured targets must pass.

Deployment success alone does not prove a feature works, so an e2e thread exercises the change.
Setup chooses where it runs. On staging, it runs after the merge and its result delivers the issue.
In the team's worktree, it runs before the merge, on the commit code review approved, and the issue
is delivered once that merge reaches staging and staging is verified. Either way the thread follows
the saved project instructions to check each acceptance criterion, including migration, background
worker, and browser checks where relevant. It reports passed, partial (with the checks it left for
you), or failed, along with its evidence and any coverage limits. Staging access, test accounts,
different staging/production data providers, and components without staging coverage should be
discussed during setup. A workflow that skips deployment for some paths needs a documented delivery
procedure for those changes.

For other hosting or an existing project check, setup can propose a custom command such as
`node scripts/check-staging.mjs`. Review the exact command before saving; saving authorizes T3 to
run it at the project root on the server, with a 90-second timeout. The script must already exist
and check the hosting provider and staging health. It must exit nonzero while pending or failed.

On success, print only a JSON object to stdout:

```json
{ "revision": "0123456789abcdef0123456789abcdef01234567", "url": "https://staging.example.com" }
```

`revision` is the full Git commit actually serving staging, obtained from the deployment provider
or a trusted version endpoint in that deployment. `url` is the HTTP or HTTPS address you can review.
Do not return the latest local Git commit merely because it exists. Send diagnostics to stderr.

The command receives `T3_ASSISTANT_WORKER_REVISION` and `T3_ASSISTANT_BASE_BRANCH` as environment
variables. For custom checks, your script translates the hosting platform's successful deployment
into this common result. T3 does not provision hosting or databases.

T3 then fetches `origin` and verifies both that the deployed commit contains the commit code review
approved and that the deployed commit belongs to the configured integration branch. Uncommitted
work, commits made after the approval, unresolved questions, active turns, failed checks, and stale
deployments keep the issue active. An issue moves to staging review once its e2e result passed, or
passed with checks for you, and staging carries the change; T3 then archives the team's threads.

## Work with your assistant

**Start** runs the loop, and first asks how it should run: whether it picks issues from Linear
itself, whose issues it may take, and how many issues to work at once. Each issue at once is another
team on another worktree, so keep the number to what your project instructions can hold apart. It
takes, in order: issues you dispatched, issues you sent back for changes, then eligible issues by
Linear priority. The team leader and the assistant use the assistant model; the worker, code review
and e2e threads use the coding model. All of them keep the issue link. Existing Linear settings
control the move to In Progress, which happens when the team leader takes the issue. The loop skips
issues that another thread is already working on.

When a team leader declines an issue, T3 posts its reason on the issue, and the loop leaves it until
someone changes it: an edit to the description, labels, priority or state, or a new comment. T3's own
comments do not count. If team leaders decline three issues in a row, the loop pauses so you can look
at them; **Start** continues. Declined issues appear in the board's history with their reasons.

To give a specific issue to a team, choose **Dispatch** on the project card, **Dispatch team** on the
issue's page under Issues, or ask the assistant in its conversation. Add a note for the team leader
if you like. A dispatched issue goes next, ahead of the loop's own picks, and its team leader takes it
or asks you rather than declining it. Assignment does not matter: you chose it. Dispatched issues
wait under **Up next** while every team is busy, and you can take them out again.

Product questions appear under **Needs you** and remain linked to the asking thread. You
can answer in the inbox, or tell the assistant in its conversation and it passes your answer to
the thread that asked. When a thread has one pending product question, a reply in that original
thread also resolves it. Answer native provider questions and permission requests in their thread.
The assistant does not approve those requests for you.

In the sidebar, each assistant thread is labeled with what it does (Assistant, Team leader, Worker,
Code review, E2E test), and a thread waiting on your answer shows **Question**. The count on the sidebar's
Developer assistant button is the number of items holding a project until you act.

**Pause** stops the loop from taking issues from Linear. The teams at work finish their issues, and
issues you dispatch still run, so a paused project is also how you hand out issues yourself.
**Interrupt all work**, in the project menu, stops everything: it interrupts every team mid-turn and
closes their tracked T3 terminals. Work and queued follow-ups are kept; **Start**, or **Resume teams,
loop paused** from the same menu, picks them back up. A provider's background processes may need
cleanup through that project's normal procedure.

Failures retain ownership of the issue. Each round of review changes counts as a worker turn, and
so does each fix the team leader sends. When review still asks for changes at the limit, or an e2e
run fails, the issue goes back to its team leader. A team leader that twice ends its turn without a
next step blocks the issue for you. **Allow more rounds** grants more worker turns; **Skip issue** cancels queued work and
releases the repository while preserving the thread and branch for inspection. Skipping does not
revert a merge, deployment, database migration, or Linear state. After 15 external progress checks
without completion, the assistant stops so you can inspect the blocker and Start again.

State and queued messages survive a server restart. If a provider was interrupted or failed, the
issue may be blocked; Start tells its team leader to pick the work back up, without creating a second
team for the same issue.

## Release to production

Production releases happen only when you ask the assistant in its conversation. It lists what would
ship, including any issue you have not accepted yet, and asks before going ahead. It then follows the
release process in your project instructions and repository docs and reports what shipped. Describe
that process during setup; until the instructions allow it, the assistant does not release.

## Review delivered work

The review card contains the change summary, the e2e report and any checks left for you, the staging
URL, and the verified commit. Staging can contain later issues by the time you review; the recorded commit identifies
what was verified for that delivery.

**Accept** records your review and applies the configured Linear acceptance state. **Request changes**
records feedback, and the loop gives the issue to a new team as soon as one is free. The new
team starts from the current integration branch, leaving the original threads and deployment history
intact. It does not roll back later work. When a team finishes or declines, T3 archives its threads and
removes its worktree unless it holds uncommitted changes; the branch stays.

T3 comments on the Linear issue as the connected account at each phase: when the reviewed change
is merged, when staging is verified, and with the e2e result. The e2e comment is the one to decide
from. It opens with a verdict (ready to accept, or which checks to do yourself on staging), then
covers what changed, each acceptance check with its result, the screenshots, and links to staging,
the pull request, and the verified commit.

You can decide in Linear. Moving the issue to a completed state accepts it. Moving it anywhere other
than the review state asks for changes, and your comments since the e2e result become the feedback.
T3 picks the move up within a minute. Canceling the issue skips it.

The Linear review and acceptance state names must exist on the issue's team. Leave a name empty to
keep its current state. A Linear update failure is shown on the task without discarding successful
delivery. Check your Linear Git integration's PR automations if they would mark issues Done before
you finish staging review.
