# Developer assistant

The developer assistant manages Linear issue threads while you make decisions and review work.
Each configured repository has a persistent assistant conversation and at most one active issue.
Each issue runs in three threads on one worktree:

- **Worker** implements the issue, opens the pull request and merges it once review approves.
- **Code review** reviews the worker's commits. The two trade rounds directly until the reviewer
  approves a commit.
- **E2E** tests the merged change on staging with a browser and takes screenshots.

The assistant picks issues, writes each worker's brief, checks the staging deployment and starts
the e2e run. It hears from the threads only when the change is merged, when someone needs you,
when a thread stops without handing off, and when e2e reports. Different repositories can run at
the same time.

An issue that passes e2e releases the repository for its next issue immediately. Your review can
happen later, from Linear or T3. Production releases remain outside this workflow.

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
an existing assistant, pause it, finish or skip its active issue, and choose **Revise setup** from
its project menu.

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
- Verification commands and cleanup are documented. One worker per project can reuse a project's
  development port and database, but concurrently running projects still need separate ports and
  resources. Workers should stop the servers and background processes they start before delivery.
- The saved staging targets identify the actual deployment workflows/services, and the assistant
  has the access needed to exercise the affected staging behavior.

The saved approval mode applies to both the coordinator and coding workers after setup. With
approvals required, permission requests wait for you in their original threads. Full access allows
unattended commands within the provider's configured permissions. Use models and providers with
working T3 MCP tool access.

Mobile provides queue controls, the assistant conversation, decisions, and reviews for projects
configured on web or desktop. All clients use the same server-owned state; closing a client does
not stop the assistant. The T3 server and its provider runtimes must remain running.

## Verify staging

A custom script is optional. Setup can use a GitHub Actions deployment workflow or Railway staging
services. The T3 server needs the corresponding authenticated `gh` or `railway` CLI. T3 checks the
latest workflow run or active service deployment and verifies that its commit contains the worker's
changes on the integration branch. The assistant selects the targets affected by each issue; when
it does not select targets, all configured targets must pass.

Deployment success alone does not prove a feature works. The e2e thread follows the saved project
instructions to check each acceptance criterion on staging, including migration, background worker,
and browser checks where relevant. It reports passed, partial (with the checks it left for you), or
failed, along with its evidence and any coverage limits. Staging access, test accounts, different staging/production data
providers, and components without staging coverage should be discussed during setup. A workflow
that skips deployment for some paths needs a documented delivery procedure for those changes.

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
deployments keep the issue active. A passing or partial e2e result moves it to staging review and
archives its three threads.

## Work with your assistant

Start the queue and open its conversation to give priorities or discuss a blocker. The assistant
reads eligible issues and their comments before starting a worker in a separate worktree. All three
threads use the configured coding model and keep the issue link. Existing Linear settings control the
initial move to In Progress. Avoid starting manual or separately delegated work on issues the
assistant already owns; the assistant checks existing threads when claiming an issue.

Product questions appear under **Needs you** and remain linked to the asking thread. You
can answer in the inbox, or tell the assistant in its conversation and it passes your answer to
the thread that asked. When a thread has one pending product question, a reply in that original
thread also resolves it. Answer native provider questions and permission requests in their thread.
The assistant does not approve those requests for you.

In the sidebar, each assistant thread is labeled with what it does (Assistant, Worker, Code review,
E2E test), and a thread waiting on your answer shows **Question**. The count on the sidebar's
Developer assistant button is the number of items holding a project until you act.

**Pause** stops the coordinator and prevents further automatic turns; a coding turn already running
can finish. **Interrupt all work**, in the project menu, also requests interruption of the coding
worker and closes its tracked T3 terminals. Work and queued follow-ups are preserved for a later
Start. A provider's background processes may need cleanup through that project's normal procedure.

Failures retain ownership of the issue. Each round of review changes counts as a worker turn, and
so does each fix the assistant sends. When review still asks for changes at the limit, or an e2e
run fails, the issue goes back to the assistant. **Allow more rounds** grants more worker turns; **Skip issue** cancels queued work and
releases the repository while preserving the thread and branch for inspection. Skipping does not
revert a merge, deployment, database migration, or Linear state. After 15 external progress checks
without completion, the assistant pauses so you can inspect the blocker and Start again.

State and queued messages survive a server restart. The assistant rechecks retained work before
continuing. If the provider was interrupted or failed, the project may be stopped; Start resumes
its coordinator without creating a second worker for the same active issue.

## Review delivered work

The review card contains the change summary, the e2e report and any checks left for you, the staging
URL, and the verified commit. Staging can contain later issues by the time you review; the recorded commit identifies
what was verified for that delivery.

**Accept** records your review and applies the configured Linear acceptance state. **Request changes**
records feedback for the assistant to schedule after the current worker finishes. It creates a
fresh linked worker from the current integration branch, leaving the original thread and deployment
history intact. It does not roll back later work. Archived worker threads retain their branches and
worktrees; remove those through the normal thread and worktree cleanup when you no longer need them.

T3 comments on the Linear issue as the connected account at each phase: when the reviewed change
is merged, when staging is deployed, and with the e2e result. The e2e comment is the one to decide
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
