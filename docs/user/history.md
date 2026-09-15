# History

History answers "what did I work on, and how long did it take" for one project. It groups every turn
that project's threads have run into calendar days, so you can review a week of work or find the
thread you were in on Tuesday.

Open it from the icon in the sidebar footer, or search for "Open history" in the command palette.
Opening it from a conversation starts on that conversation's project. The picker beside the title
switches projects, and the period control covers the last 7, 30, or 90 days.

Each day lists the threads that ran turns that day, when the first and last of them ran, and how many
turns each thread took. A thread that is still running says so. An archived thread is still listed,
because history reports what happened rather than what is current. Each thread also carries its
lifetime figures, so a day that reads "40m" can tell you it is part of "5h 20m over 96 turns".

**Active time** is agent working time. For each turn, T3 Code measures the span from when the agent
started to when it finished, then adds those spans up. Reading the answer, writing the next prompt,
and waiting on a permission decision do not count, so a day with eight hours at the keyboard usually
reports far less than eight hours of active time. A turn that is still running counts up to the
moment you opened the page.

T3 Code buckets days in your device's time zone, and a session that runs past midnight appears on
both days. History reads each project from its own environment, so a project reports the work done on
the machine that hosts it.
