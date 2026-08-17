# SRC — Student Representative Council site

Announcements, comments, embedded forms and an events calendar with sign-ups for the SRC. Firebase only:
Hosting + Auth + Firestore + Cloud Functions. No AI, no second platform, no custom domain
for the site itself.

**Everything below marked "YOU DO THIS" needs your Firebase / Brevo / Cloudflare login.
I have no credentials for any of them, so those steps are yours.**

---

## 1. What's here

```
public/            the website (static, no build step)
  index.html
  app.css          the green theme, light + dark
  js/              app modules
  vendor/          Firebase SDK, bundled locally (committed)
functions/         Cloud Functions: announcement email + invitations
firestore.rules    security rules
tests/             rules tests, unit tests, browser end-to-end test
src/               entry point for the vendored SDK bundle
```

The frontend is plain ES modules — no framework, no build. `firebase deploy` uploads
`public/` as-is.

The Firebase SDK is **bundled into `public/vendor/firebase.js`** rather than loaded from
gstatic.com. School networks sometimes block or throttle third-party CDNs, and this keeps
everything on your one origin. It's 168 KB gzipped and cached after the first load. Rebuild
it only if you change `src/firebase-entry.js`:

```bash
npm run build:vendor
```

There is **no config file to fill in.** Firebase Hosting serves your project's web config at
`/__/firebase/init.json`, and the app reads it from there at startup.

---

## 2. Deploy it — YOU DO THIS

**Quickest path — one command:**

```bash
bash scripts/deploy.sh
```

It checks your tooling, signs you in, asks which project, runs the tests, deploys rules +
hosting, deploys the functions only if the Brevo key is set, and prints what's left to do.
Safe to re-run.

<details>
<summary>Or do it by hand</summary>

```bash
npm install
cd functions && npm install && cd ..

npm install -g firebase-tools
firebase login
firebase use --add            # pick your Firebase project, alias it "default"

firebase deploy --only firestore:rules,hosting
```

</details>

That gets the site live at `https://<your-project>.web.app` with the rules enforced.
Functions need the Brevo key first — see §4.

### Make yourself the first teacher — YOU DO THIS

Roles are stored on the roster, and **nobody can sign in until a teacher has added them**.
That's a chicken-and-egg problem for the very first account, so bootstrap it by hand:

1. Firebase Console → **Firestore Database** → **Start collection** → id `roster`
2. **Document ID**: your school email, lowercase, e.g. `ms.jones@education.nsw.gov.au`
3. Add two fields, both strings:
   - `email` = the same address
   - `role` = `teacher`
4. Save. Now go to the site, sign in with that address, and you're a teacher.

**Why this can't be abused:** writing that document requires access to the Firebase Console,
which means you already own the project. There is no in-app path to create the first teacher,
no secret URL, and no "first user becomes admin" rule — that pattern is exactly how these
things get taken over. Every teacher after the first is added by an existing teacher through
the admin panel, and the rules verify the role against the roster document, which students
cannot read or write.

---

## 2b. Import the old Classroom posts — ONE COMMAND

```
npm run import
```

That reads two files, signs you in, and writes both:

* `docs/classroom-import.json` — the Classroom stream, 12 posts and 18 comments
* `docs/classroom-events.json` — the 10 dated things mentioned in those posts,
  as real calendar events (`--no-events` skips them)

It asks how you want to sign in and nothing else. No project ID, no pasting, no
clicking.

It offers two ways to sign in:

1. **Email me a sign-in link** — no password needed. It sends a link, you
   **copy** it out of your inbox (right-click the button → *Copy Link Address*)
   and paste it into the terminal. Copy it rather than opening it: opening it in
   a browser uses the code up.
2. **Password** — if you have set one under your name → *Set or change a
   password*.

Useful flags:

| flag | what it does |
| --- | --- |
| `--dry-run` | lists what would be imported, writes nothing |
| `--file <path>` | import a different JSON file |
| `--project <id>` | override the project (defaults to `.firebaserc`) |
| `--link` | skip the menu and go straight to the email-link route |

Things it guarantees, all covered by `npm run test:import`:

* **Nobody is emailed.** Every post is written with notifications off. Twelve
  posts would otherwise be twelve mailouts to the whole roster, which is most of
  Resend's 100/day in one command.
* **Safe to run twice.** Each post gets an id derived from its date and title,
  and existing ids are skipped. A second run says "already there" 12 times.
* **It signs in as you, not as a service account.** A service-account key is a
  JSON file that grants full project access and bypasses every security rule.
  This uses your normal teacher login and the ordinary client SDK, so the rules
  check every write exactly as they do from the website. A student running it is
  refused, and that is tested.
* **It validates before asking for your password**, so a broken file costs you
  nothing.

The comments come in as a labelled read-only archive under each post, not as
real comments. They cannot be real comments: the rules require every comment to
carry its author's own account and the name on their own profile, and the people
who wrote these have no account here. Faking that would break the one promise
the comment system makes.

## 3. Email provider — Resend (your call), with one real limit

You supplied a Resend key, so the code ships configured for **Resend**. Switching providers is
a one-line config change (`EMAIL_PROVIDER`), not a code change — which matters, because of this:

| Provider | Per month | **Per day** | At 50 students |
|---|---|---|---|
| **Resend** (configured) | 3,000 | **100** | **2 announcements/day** |
| Brevo (supported, not active) | ~9,000 | 300 | 6 announcements/day |

**The daily cap is the binding constraint, not the monthly one.** 50 students × 1 announcement
= 50 emails, so you get two mailouts a day. Three fails.

The one that will actually catch you out: **bulk-inviting 50 students spends 50 of your 100
emails for that day.** If you invite the cohort and post an announcement the same afternoon,
you're at exactly 100. Invite in the morning, post the next day. Or split the invites across
two days.

Resend's free tier also gives you **1 domain and 1 API key**, which is enough here.

Sources: [Resend quotas & limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits),
[Resend free tier](https://resend.com/blog/new-free-tier),
[batch endpoint](https://resend.com/docs/api-reference/emails/send-batch-emails).

### How the code handles it

- **Batch endpoint.** All 50 students go out in **one API request** (Resend batches up to 100
  per call, and one call counts as one request against the rate limit). Verified by test.
- **Batch-failure fallback.** If a batch is rejected as a unit — one malformed address can do
  that — the chunk is automatically retried **one at a time**, so a single typo costs only that
  student their email instead of all 50 theirs. Verified by test.
- **Daily quota is reported, not swallowed.** A 429 mentioning the daily quota is flagged
  distinctly from a per-second rate limit, and the teacher who posted sees
  *"Hit the email provider's daily limit. Students can still read this in the app."* on their
  own announcement. They are never left guessing whether it went out.

### If you outgrow 100/day

Sign up at brevo.com, then:

```bash
firebase functions:secrets:set EMAIL_API_KEY      # paste the Brevo key
echo "EMAIL_PROVIDER=brevo" >> functions/.env
firebase deploy --only functions
```

Both transports are implemented and tested. Nothing else changes.

### Verify your sending domain — YOU DO THIS

1. Resend dashboard → **Domains → Add Domain** → `src.recallschool.com`
   (the subdomain, **not** `recallschool.com` — see §5).
2. Resend gives you DKIM/SPF records. Add them in Cloudflare (§5).
3. Wait for the domain to show **Verified**.

Until that domain is verified, sends from `src@src.recallschool.com` will be **rejected**.
Resend only lets you send from `onboarding@resend.dev` (to your own address) before then, which
is fine for a first smoke test but nothing more.

---

## 4. Wire up the functions — YOU DO THIS

```bash
# The API key. Stored in Secret Manager, injected at runtime, never in client code.
# Paste it at the prompt — do NOT put it in a file or a shell command,
# where it ends up in your shell history.
firebase functions:secrets:set EMAIL_API_KEY

# Non-secret settings. Put these in functions/.env
cat > functions/.env <<'EOF'
EMAIL_PROVIDER=resend
SENDER_EMAIL=src@src.recallschool.com
SENDER_NAME=SRC
APP_URL=https://your-project.web.app
EOF

firebase deploy --only functions
```

Then in **Firebase Console → Authentication → Settings → Authorized domains**, confirm
`your-project.web.app` is listed (it is by default). Sign-in links won't work otherwise.

Also **Authentication → Sign-in method** → enable **Email/Password**, and inside it enable
**Email link (passwordless sign-in)**. Both are needed: the passwordless link is the default,
and the password toggle is what lets staff optionally set one.

---

## 5. DNS on `src.recallschool.com` — YOU DO THIS

All records go on the **subdomain**, never the root. Reputation is scoped largely to the exact
sending subdomain, so if SRC mail ever picks up a bad reputation, `recallschool.com` and your
other project are insulated. This is standard practice and costs nothing.

In Cloudflare, on the `recallschool.com` zone, add what Brevo gives you. Set all of these to
**DNS only (grey cloud)** — proxying breaks mail records.

| Type | Name | Value |
|---|---|---|
| TXT | `send.src` | `v=spf1 include:amazonses.com ~all` (Resend gives you the exact value) |
| TXT | `resend._domainkey.src` | (the DKIM value Resend shows you) |
| TXT | `_dmarc.src` | `v=DMARC1; p=none; rua=mailto:you@recallschool.com; pct=100` |
| MX | `send.src` | `feedback-smtp.<region>.amazonses.com` priority 10 (Resend gives you this) |

### ⚠️ The SPF gotcha — this one bites people

**A domain may have only ONE `v=spf1` TXT record per name.** Two is a hard failure — worse than
having none. Resend puts its SPF on the `send.src` subdomain, so it won't collide with anything
you already have on `src`. But if you later add a second sender on the *same* name, you must
*merge* the includes into one record:

```
v=spf1 include:amazonses.com include:_spf.firebasemail.com ~all
```

Not two separate records. Check with `dig +short TXT src.recallschool.com` — you should see
exactly one string starting `v=spf1`.

### On DMARC

Start at `p=none`. It monitors without rejecting anything, so a misconfiguration can't silently
black-hole mail to students. Once you've watched the reports for a couple of weeks and see
Resend passing SPF+DKIM with alignment, tighten to `p=quarantine`. Don't start at `p=reject` —
if alignment is wrong you'll lose every message with no warning.

---

## 6. Making both emails come from the same sender

**As built, they already mostly do.** This matters, so here's the exact picture:

| Email | Sent by | From address |
|---|---|---|
| **Invitation** (teacher adds a student) | Cloud Function → Resend | `src@src.recallschool.com` ✅ |
| **Announcement notification** | Cloud Function → Resend | `src@src.recallschool.com` ✅ |
| **Self-serve sign-in link** (student types their email on the login page) | Firebase Auth | `noreply@<project>.firebaseapp.com` ❌ |

I deliberately route **invitations through Resend** rather than through Firebase Auth. The
Cloud Function generates the sign-in link with the Admin SDK
(`generateSignInWithEmailLink`) and delivers it itself. That means the invitation — which is
how almost every student will first arrive — already comes from your domain, with your SPF and
DKIM, with no waiting on Firebase's domain verification.

Only the third row is left on Firebase's default sender, and it only fires when someone types
their address into the login box themselves.

### Closing that last gap — YOU DO THIS (optional)

Firebase Console → **Authentication → Templates** → edit icon → **customise domain**, enter
`src.recallschool.com`, add the TXT and CNAME records it gives you, wait for verification (up
to 24 hours), then **Apply custom domain**.

**On whether this needs a paid plan — I could not verify this properly and I'm not going to
guess.** The Firebase docs site is blocked from the environment I built this in. My
understanding is that it's a standard Firebase Auth feature, *not* gated behind the Identity
Platform upgrade, and available on Spark — but treat that as unconfirmed. You're on Blaze
anyway, so the Spark question is likely moot for you. **The console will tell you immediately:**
if it needs an upgrade, it shows an upgrade prompt instead of the domain field. Thirty seconds
to check, and it costs nothing to find out.

If it does want money, leave it on the default sender. It's the least important of the three
emails, and the invitation path already comes from your domain.

⚠️ If you do set this up, **remember the SPF merge above** — Firebase will want its own
`include:`, and you must fold it into the single existing SPF record rather than adding a
second one.

---

## 7. Deliverability — be realistic about this

Every student is on `@education.nsw.gov.au`, and NSW DoE mail filtering is aggressive with
unknown senders. **Nobody can guarantee inbox placement.** SPF, DKIM and DMARC are the biggest
lever and they're covered above. Here's the rest.

### Test on ONE address before you invite a cohort

Do not import 50 students and hope. In order:

1. **Add yourself only.** Admin → Add students → your own address → Add to roster with
   "Email them a sign-in link" on. Check it arrives, and check *where* — inbox or junk.
2. **Add one friendly student**, ideally one sitting next to you so you can watch their phone.
   Confirm they get it, and ask them to check junk if not.
3. **Post one test announcement** with notify on. Confirm both of you get "SRC update — …".
4. **Check the Resend dashboard** (Emails). It shows delivered / bounced / complained per
   message. This is your ground truth — the app only knows whether Resend *accepted* the
   message, not whether the school *delivered* it.
5. Only then invite everyone.

If step 1 or 2 lands in junk, that's your signal to do the IT request below **before** rolling
out — a whole cohort marking you as junk is much harder to recover from.

### Keep bounces near zero

Bounces from typo'd dead addresses are what destroy sender reputation. Mitigations built in:

- The chip input shows you the full resolved address before you commit it, and flags anything
  malformed in red rather than saving it.
- Addresses are trimmed and lowercased, so `John.Smith ` and `john.smith` are one person.
- Duplicates are dropped silently.
- The function records per-address failures to `mailLog` and stamps `lastSendError` on the
  roster row, so a bad address is visible instead of silently retried forever.
- 4xx responses are never retried.

Still: check the roster for anyone stuck on "Not yet" after a week. That's usually a typo.

### The IT allowlist request — this is the only real guarantee

Inside a school mail system, an allowlist entry beats every other measure. Send this:

> **To:** school IT / NSW DoE ICT support
> **Subject:** Allowlist request — SRC student notification emails
>
> Hi,
>
> The Student Representative Council runs a site for announcements and forms at
> `https://<your-project>.web.app`. It sends students notification and sign-in emails.
>
> Could you please allowlist the following sender so these reach student inboxes rather than
> junk:
>
> - **Sending address:** `src@src.recallschool.com`
> - **Sending domain:** `src.recallschool.com`
> - **Sending service:** Resend (sends via Amazon SES infrastructure)
> - **SPF:** `v=spf1 include:amazonses.com ~all` on `send.src.recallschool.com`
> - **DKIM:** configured and passing on `src.recallschool.com`
> - **DMARC:** published at `_dmarc.src.recallschool.com`
>
> Typical volume: about 50 recipients per announcement, a few times a week.
>
> Happy to provide message headers from a test send if that helps.
>
> Thanks,
> [your name], SRC

Send the test to yourself first so you can attach real headers if they ask.

### Email is never the only channel

By design: every announcement, form and deadline is fully visible the moment a student opens
the site. The email links back into the app and says so explicitly. Nothing depends on
delivery. If the mail never arrives, the site still works — students just have to remember to
look.

---

## 8. Security

### What the rules enforce

- **Signed out: nothing is readable.** Not announcements, not the roster, nothing.
- **Roster-gated access.** A profile can only be created if the address is already on the
  roster. An uninvited address gets a "request access" screen instead.
- **Students cannot read other students' form responses.** `get` and `list` are split, so a
  student can fetch their own response document and cannot list the collection. (Merging them
  into one `read` rule is the classic bug here — during a `list`, `resource` isn't bound, so a
  document-level uid check constrains nothing.)
- **Students cannot read the roster** (it's every student's email address) **or list users.**
- **Students cannot post announcements or build forms.**
- **Roles cannot be self-assigned.** `role` is excluded from the self-update allowlist, and at
  creation time it must equal the role on the roster document — which students can't write.
- **Comments carry a real identity.** `authorUid` must be your uid and `authorName` must match
  your profile name, both checked server-side.
- **`mailLog` is not client-writable at all**, so nobody can fake or suppress send bookkeeping.
- Unknown collections are denied by default.

### The tests actually attempt the attacks

`tests/rules.test.js` — **48 tests, all passing.** Most are `assertFails`: they perform the
forbidden read/write as a student and require Firestore to reject it.

```bash
npm run test:rules
```

```
# tests 48
# pass 48
# fail 0
```

**I also verified the tests have teeth**, because a security test suite that passes against
broken rules is worse than no suite. I deliberately broke the rules twice and confirmed the
suite caught it:

| Mutation | Result |
|---|---|
| `responses` list changed from `isTeacher()` to `isMember()` | 1 test failed — *student CANNOT list the responses collection* |
| `role` added to the self-update allowlist | **4** tests failed |

The second is worth noting: adding `role` didn't just break one test. Once the student
self-promotes to teacher, they can then edit *other students' profiles* too — so the
"student cannot edit another student profile" test fell over as a knock-on effect. That's the
real escalation chain, demonstrated rather than asserted.

The browser end-to-end test independently confirms the same denials from a **real signed-in
student session** in Chromium, not just from the test harness:

```
PASS  student list of form responses is denied in the browser
PASS  student list of roster is denied in the browser
PASS  student list of users is denied in the browser
PASS  second student cannot see the first student's answer in the UI
```

### Other hardening

- Announcement bodies use a **restricted markdown subset**, escaped first and then formatted —
  there's no path from typed text to injected HTML, and no `contenteditable`.
- Links are restricted to `http(s)`; `javascript:` and `data:` URLs are dropped.
- CSV export prefixes cells starting with `= + - @` to prevent spreadsheet formula injection
  from student-typed answers.
- The Resend key lives in Secret Manager and is only ever sent as a request header from the
  server. A unit test asserts it never appears in a message body.
- `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff` on all responses.

---

## 9. Cost — what could bill you, honestly

You're on Blaze, which has **no hard spending cap**. You asked me to flag anything that could
plausibly generate cost. Here's the complete list.

**One correction to your assumption.** Firestore's free allowance is reckoned **per day**
(50,000 reads/day, which is where the ~1.5M/month figure comes from), and opening the feed
costs roughly one read per announcement shown, not one read total.

Worst case: 50 students × 10 opens/day × ~50 reads = **25,000 reads/day**, or about **half**
the daily free allowance. Realistically it'll be a third of that. So you're comfortably inside
it — but it's roughly 2× under, not 100× under. Worth knowing which number is actually the
tight one, because it's reads, not function calls or auth users.

The feed is hard-limited to 50 announcements for exactly this reason. If the feed ever needs
to grow past that, add pagination rather than raising the limit.

### The things I deliberately bounded

| Risk | Guard |
|---|---|
| **Runaway function retries** — the classic Blaze horror story | `retry: false` on the Firestore trigger. A failed mailout is recorded to `mailLog`, never retried by the platform. |
| **A function that re-triggers itself** | The trigger fires on **create** only, and writes its bookkeeping to a **separate** `mailLog` collection. It does write `notifiedAt` back to the announcement, but that's an *update*, and updates don't fire an onCreate trigger. No loop is possible. |
| **Instance fan-out under load** | `maxInstances: 3` on the trigger, `2` on the callable, plus a global cap. |
| **Unbounded per-send retries** | Max 2 attempts. 4xx is never retried at all. A batch failure falls back to individual sends once, not repeatedly. |
| **Unbounded listeners** | One feed listener, `limit(50)`. Comment listeners attach only to the thread you expand and detach when you collapse it. No listener-per-card. |
| **Unbounded recipient lists** | Hard cap of 400 per mailout; anything beyond is logged, not silently dropped. |
| **A teacher pasting 10,000 addresses** | UI caps a single add at 300; the callable rejects more than 400. |
| **Runaway reads from rules** | Rules use `get()` on the profile doc, which *is* billed as a read. At this scale it's negligible, but it's not free — worth knowing it exists. |

### Set a budget alert anyway — YOU DO THIS

Guards in code are not a spending cap. Do this today, it takes two minutes:

**Google Cloud Console → Billing → Budgets & alerts → Create budget** → scope to this project
→ amount **$5** → alert at 50%, 90%, 100%.

It won't stop spending — nothing on Blaze will — but you'll get an email long before anything
matters. At your scale, if that alert ever fires, something is wrong and you should look.

---

## 10. Running it locally

```bash
npm install
npm run emul          # auth + firestore + hosting on :5000
```

The app auto-detects localhost and connects to the emulators. Sign-in links don't get emailed
locally — grab them from the Emulator UI at http://127.0.0.1:4000/auth, or from
`http://127.0.0.1:9099/emulator/v1/projects/demo-src/oobCodes`.

### Tests

```bash
npm test              # unit tests + rules tests
npm run test:e2e      # browser end-to-end (needs `npm run emul` running)
```

| Suite | Count | What it covers |
|---|---|---|
| `tests/rules.test.js` | 64 | Security rules, adversarially (incl. events + sign-ups) |
| `tests/emails.test.js` | 19 | Address normalising and paste parsing |
| `tests/functions.test.js` | 24 | Email templates, batching, retry caps, idempotency |
| `tests/e2e.mjs` | 46 | Real browser, real magic-link sign-in, full flows incl. calendar |

**178 tests, all passing.**

---

## 11. What I did NOT do

**I did not deploy it, and there is no live URL.** I had no Firebase credentials — the only
Google token in my environment returned 401. Everything is deploy-ready and tested against the
emulator suite, but §2 is genuinely yours to run. It should take about ten minutes.

**I could not send a single real email, and I could not validate your Resend key.**
`api.resend.com` is blocked by the network egress proxy in the environment I built this in, so
even a read-only key check returned nothing. The integration is unit-tested against a mocked
Resend API — batch endpoint, 100-per-call chunking, batch-failure fallback, retry caps, daily
quota detection, header placement — and the functions load cleanly. But **the first real send
will be yours**, which is exactly why §7 says test on one address first.

**I could not verify the Firebase Auth custom-domain plan requirement** — the docs page is
blocked from my environment. See §6; the console answers it in thirty seconds.

**Not built** (out of scope, tell me if you want any):

- Push notifications — email + in-app only.
- File uploads / attachments on announcements or forms — no Storage.
- Editing a form after responses exist is possible but will orphan answers to deleted fields;
  the CSV just won't have a column for them. Fine for now, worth knowing.
- Comment threading/replies — flat list only.
- Anything AI. As specified, there are zero model calls anywhere in this codebase.
