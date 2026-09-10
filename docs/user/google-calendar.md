# Google Calendar

Schedule Linear issues as calendar work blocks, then start or resume their T3 threads from your agenda.

## Connect

Open **Settings → Integrations → Google Calendar**, click **Connect**, then **Continue to Google**. Allow calendar access in your browser. Return to T3 and click **Refresh** after Google confirms the connection.

Each environment has one Google connection, shared by its authorized clients. Connecting or disconnecting requires permission to manage environment access. Disconnect removes the credentials stored in T3; it leaves calendar events intact. You can also revoke the app's access in your Google account.

## Plan an issue

Open an issue in **Issues**, then choose **Schedule / Link calendar event**. Select a calendar, date, start time, and duration. Click **Schedule** to create a busy event with the issue's title and Linear link. Schedule another time to split the issue across several sessions.

To use an appointment you already created, find it on the selected day and choose **Link to [issue]**. Linking preserves the event's title, description, guests, and time. **Unlink issue** removes the issue connection without deleting the event.

## Plan your week

Open **Issues → Plan** to see a Monday–Sunday calendar. The column beside it lists today's linked work blocks, then your filtered Linear issues. Hours outside your working hours are shaded.

Open **Calendars** to choose which calendars appear in the week and which of those are checked for conflicts. Your scheduling calendar is always shown. The gear opens **Planning preferences**: the length of a new block and your working hours. T3 remembers these choices on this device for each environment.

Drag an issue onto a time, or click the issue to open the scheduling form in the side column. Set the date, start time, length, and the calendar the block saves to, or click a time in the week to move the proposal there. Save it to Google Calendar when the dashed preview is where you want it. Drag a T3 work block to move it, or drag its bottom handle to change its end time; clicking the block opens the same form. Calendar changes are saved only when you confirm.

Busy events on the calendars checked for conflicts produce overlap warnings, but you can still save. Events marked Free in Google remain visible without blocking time. Hidden calendars are never checked; these checks do not guarantee availability. Issue rows count linked blocks in the displayed week and calendars. Google changes refresh every minute while the calendar is visible and when you return to T3. **Refresh** retries immediately and preserves your unsaved proposal. To remove a block or link an existing appointment, use the agenda or issue detail scheduling controls.

## Find time for an issue

While scheduling a new block in **Issues → Plan**, the form lists **Suggested times**: up to six free slots in the displayed week that fit the block's length, starting from now. Pick one to place the proposal, adjust it if needed, then save. Suggestions also appear after choosing **Plan another session** for unfinished work.

Open **Planning preferences** (the gear beside the calendar picker) to set working days, start and end times, breaks around busy events, and a daily focus limit. Defaults are Monday–Friday, 09:00–17:00, 15-minute breaks, and four hours of focus time. The focus limit counts busy linked issue blocks on calendars checked for conflicts, including earlier blocks that day. These preferences are saved on this device for each environment and can be reset.

Suggestions use the shown calendars that are checked for conflicts and wait for complete reads. Free events do not block slots; busy all-day events do. Hidden or unchecked calendars are not consulted, and Google availability can change before saving. If nothing fits, try another week, a shorter block, or wider working hours. Suggestions cover one session at a time; repeat to split work across sessions.

## Follow today’s work

In **Issues → Plan**, the **Today** section at the top of the side column shows current and upcoming linked work blocks across your shown calendars, even while browsing a different week. Start or resume the issue’s thread from a block.

Open **Ended** when you need more time. **Plan another session** proposes a new block in your scheduling calendar; adjust the date, time, and length, then save. It leaves the original event intact and never completes the Linear issue. Dismiss a reminder for this visit, or restore dismissed reminders. Known completed or canceled issues in the current issue list are omitted; other ended blocks ask whether more work is needed.

## Work from your agenda

Open **Issues → Agenda**. Choose a calendar and date; **Today** returns to the current date. Linked events offer **Start working** or **Resume thread**. Starting work follows your existing Linear thread and status preferences. Scheduling itself never changes an issue's status or deadline.

Use **Reschedule** to change a T3-created block's date, time, or duration. **Unschedule** removes that block from Google Calendar, leaving its issue and thread intact. For meetings created outside T3, use **Open in Google** to change or delete them.

The agenda reads Google Calendar when opened, every minute while visible, and when you return to T3 or regain connectivity. It shows the last successful refresh time and any errors; use **Refresh** to retry. Automatic refresh preserves scheduling edits. This is periodic refresh, not real-time push synchronization. Times use your device's timezone, shown above the agenda. All-day and recurring events are displayed; editing or linking them is not supported in this release. The agenda shows one calendar at a time and remembers your selection on this device for each environment.

## Set up a self-hosted server

The server operator must configure a Google OAuth **Web application** client before Connect is available:

1. Enable the Google Calendar API in a Google Cloud project and configure its OAuth consent screen. For a testing app, add your Google account as a test user.
2. Create an OAuth client of type **Web application**. Register the exact callback URL of your T3 server, for example `https://t3.example.com/oauth/google-calendar/callback`.
3. Open **Settings → Integrations → Google Calendar**. Under **Google OAuth application**, enter the client ID, client secret, and callback URL, then select **Save**.
4. Select **Connect**, continue to Google, and allow access. Return to Settings and select **Refresh**.

The client secret stays in the server secret store. Leave its field blank to keep the saved secret, or use **Remove secret** to disable the configuration. Changes apply without restarting the server. Changing the client ID requires reconnecting Google.

If you previously configured `T3CODE_GOOGLE_CLIENT_ID`, `T3CODE_GOOGLE_CLIENT_SECRET`, and `T3CODE_GOOGLE_REDIRECT_URI`, copy their values into these settings and reconnect once. Those environment variables are no longer used.

Use an HTTPS callback reachable from the browser where you sign in. A localhost callback is suitable only when that browser can reach the server on localhost. For a remote or relay client, the callback must still route to the owning server's `/oauth/google-calendar/callback` endpoint; it must not point to the hosted client. Forward this path through your reverse proxy.

The integration requests calendar-list read access and calendar-event read/write access. Access and refresh tokens stay in the server secret store. Google testing-mode grants may expire and require reconnecting. Follow Google's [web-server OAuth setup guide](https://developers.google.com/identity/protocols/oauth2/web-server) for consent-screen configuration and redirect requirements.
