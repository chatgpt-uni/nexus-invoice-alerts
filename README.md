# NEXUS — Invoice Alerts (Univariety Client Success Operations)

NEXUS sends advance invoice alerts and reminders to Account Managers, tracks invoice status and overdue payments, and keeps one shared record for the team.

**How it is built**
- **Netlify** shows the screens (the `site` folder). There is no build step.
- **Supabase** (project "Nexus - Invoice Alert") holds the logins and all NEXUS data. The data is readable only by signed-in, active NEXUS users.
- **Two Supabase server functions:**
  - `nexus-mail` passes email requests to the Google Apps Script. It holds the script's address and secret.
  - `nexus-admin` lets the super admin add and manage users.
- **The Google Apps Script** (NEXUS Email Service) sends the Gmail messages. It is unchanged from the single-file version.

**What is in this repository**
| Path | What it is |
|---|---|
| `site/index.html` | The NEXUS dashboard |
| `site/cloud.js` | Connects the dashboard to Supabase: sign-in, loading, saving, live updates |
| `site/config.js` | Your Supabase Project URL and public (anon / publishable) key |
| `site/vendor/` | Supabase browser library and SheetJS (used to read the Order Book Excel) |
| `supabase/schema.sql` | Database tables and access rules. Run once in the SQL Editor |
| `supabase/functions/nexus-mail/index.ts` | Email server function |
| `supabase/functions/nexus-admin/index.ts` | User-management server function |
| `netlify.toml` | Netlify settings and security headers |

**What is never in this repository:** client or invoice data, passwords, the Apps Script secret, the service-role key. The starting data file `NEXUS_base_data.json` is loaded once from inside NEXUS and then lives only in Supabase.

---

# Deployment guide (one time, about 45 minutes)

Do the steps in this order. Each step says where to click.

## Step 0 — Before you start: take a final backup of the single-file version
1. Open **NEXUS_Prototype_V1.6.html** in the browser you have been using.
2. Go to **Settings → Backup & restore → Download backup**. Keep the file (`NEXUS_backup_….json`).
3. From this point, don't make changes in the single-file version. Anything done there after the backup won't move across.

## Step 1 — Supabase: copy two values
1. Open supabase.com and the project **Nexus - Invoice Alert**.
2. Go to **Project Settings → API** (on newer screens: **API Keys** and **Data API**).
3. Copy the **Project URL**, which looks like `https://xxxxxxxx.supabase.co`.
4. Copy the **anon public** key. If you only see new-style keys, copy the **publishable** key (`sb_publishable_…`).
   - **Never** use the `service_role` or **secret** key anywhere in this guide.

## Step 2 — Supabase: create your login
1. Go to **Authentication → Users → Add user → Create new user**.
2. Email: `siddharth.gupta@univariety.com`. Choose a strong password (at least 8 characters).
3. Tick **Auto Confirm User**, then click **Create user**.

## Step 3 — Supabase: turn off public sign-up
1. Go to **Authentication → Sign In / Providers**. On some screens it is under **Settings**.
2. Turn **off** "Allow new users to sign up" and click **Save**.
3. This means only the super admin can create logins, from inside NEXUS.

## Step 4 — Supabase: create the database
1. Go to **SQL Editor → New query**.
2. Paste the whole of `supabase/schema.sql` and click **Run**.
3. The result at the bottom must show one row: `siddharth.gupta@univariety.com | Siddharth | super | true`.
   - If it shows no rows, Step 2 wasn't done. Do Step 2, then run the script again. Running it twice is safe.

## Step 5 — Supabase: add the two server functions
Supabase calls these Edge Functions. For each of the two functions:
1. Go to **Edge Functions → Deploy a new function → Via Editor**.
2. Function name: **`nexus-mail`**, exactly as written.
3. Delete the sample code. Paste the whole of `supabase/functions/nexus-mail/index.ts`. Click **Deploy function**.
4. Repeat for **`nexus-admin`**, pasting `supabase/functions/nexus-admin/index.ts`.
5. Leave "Verify JWT" (or "Enforce JWT verification") **on**, which is the default.

## Step 6 — Supabase: add the Gmail script details as secrets
1. Go to **Edge Functions → Secrets** and add two secrets.

| Name | Value |
|---|---|
| `NEXUS_SCRIPT_URL` | The Apps Script **Web App URL**, ending in `/exec`. It's the same one you pasted into the single-file NEXUS. |
| `NEXUS_SCRIPT_SECRET` | The script secret. In the Apps Script editor, run **showSettings** and copy the secret from the log. |

2. Nothing changes in the Apps Script itself. Emails still come from the account that deployed it (Siddharth's, until nexus@univariety.com is set up). The script stays in **TEST mode** until you run `goLive()` in it.

## Step 7 — GitHub: create the repository
1. Sign in to GitHub as **chatgpt-uni** and click **New repository**.
2. Name it `nexus-invoice-alerts`. Choose **Private**. Leave "Add a README" unticked, then click **Create repository**.
3. Before uploading, open `site/config.js` in a text editor. Paste the Project URL and key from Step 1 between the quotes, and save.
4. On the new repository page, click **uploading an existing file**. Drag in everything from this folder: `site`, `supabase`, `netlify.toml`, `README.md`, `.gitignore`. Click **Commit changes**.
   - `.gitignore` is a hidden file, so it may not show when dragging. That's fine; nothing secret is in the folder.

## Step 8 — Netlify: publish the site
1. In Netlify, choose team **Univariety ChatGPT's team**.
2. Click **Add new site / Add new project → Import an existing project → GitHub**. Allow access to `chatgpt-uni/nexus-invoice-alerts`, then select it.
3. The build settings fill in from `netlify.toml`: publish directory `site`, no build command. Click **Deploy**.
4. Go to **Site configuration → Change site name** and enter, for example, `nexus-univariety`.
5. Your address will be **https://nexus-univariety.netlify.app**.

## Step 9 — Supabase: tell it the website address
1. Go to **Authentication → URL Configuration**.
2. Set **Site URL** to your Netlify address from Step 8, then click **Save**.

## Step 10 — First sign-in and loading your data
1. Open the Netlify address and sign in as `siddharth.gupta@univariety.com` with the Step 2 password.
2. You'll see **Set up NEXUS**. Choose **NEXUS_base_data.json**, which was sent to you separately and is not in GitHub. Click **Load starting data**.
3. Go to **Settings → Email connection → Check connection**. It should say **✓ Connected**, sending as your account, in **TEST** mode.
4. Go to **Settings → Backup & restore → Restore from backup**. Choose the backup file from Step 0 and click **Restore**.
5. Check a few things you know: statuses, emails sent in the Email Log, People, and Reminders. They should match the single-file version.

## Step 11 — Add Oindrilla and others
1. Go to **Settings → Users & roles → Add user**. Enter her name and email, choose **Admin** (or **Member** for others), and set a temporary password.
2. Give her the temporary password yourself. NEXUS doesn't email it. She must choose her own password the first time she signs in.

## Step 12 — Final checks
- [ ] Sign out, then sign in again: the data is still there.
- [ ] Open the site on your phone: the same data shows.
- [ ] Oindrilla signs in on her laptop. She changes a status on a test invoice, and you see it within about 20 seconds without refreshing. Then change it back.
- [ ] Send one alert from **Due now**. A **[TEST]** email arrives at the test recipient, and it shows in the Email Log.
- [ ] Open the Netlify address in a private window without signing in. You only see the sign-in screen.
- [ ] Delete `NEXUS_base_data.json` from Downloads or Desktop and keep one copy somewhere safe. It contains commercial data.

---

# Day-to-day

**Making changes later.** Claude prepares updated files, and you replace them in GitHub: open the file → pencil (Edit) or **Add file → Upload files** → **Commit**. Netlify publishes the new version in about a minute.
- If a change needs the database, you get a small SQL file. Run it in the SQL Editor **before** committing the code.
- If a server function changes, paste the new code in **Edge Functions → (function) → Code → Deploy**.

**Undoing a bad update.** In Netlify, go to **Deploys**, pick the previous deploy and click **Publish deploy**. It takes seconds. Data isn't affected.

**Backups.** Data lives in Supabase. Still download a backup from **Settings → Backup & restore** every week or two, and keep it somewhere safe.
- Supabase's own daily backups depend on your Supabase plan, so check yours.
- Only the super admin can restore a backup, because restoring replaces the data for everyone.

**When nexus@univariety.com exists.** Deploy the Apps Script from that account (same steps as before). Then update the two secrets from Step 6. No code changes are needed.

**Sign-in problems.** The super admin resets passwords in **Settings → Users & roles**. If Siddharth forgets his own password, reset it in Supabase: **Authentication → Users → … → Send password recovery**, or set a new one there.

**How saving works.**
- Every change saves automatically within a second. The top bar shows **Saved**, **Saving…** or **Not saved — retrying**.
- Changes by other people appear within about 20 seconds, and straight away when you return to the tab.
- If two people change the very same item at the same moment, the later save wins.
