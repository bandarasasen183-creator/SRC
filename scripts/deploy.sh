#!/usr/bin/env bash
#
# One-shot deploy for the SRC site.
#
#   bash scripts/deploy.sh
#
# Safe to re-run. It checks before it changes anything, runs the test suite
# before shipping, and will not deploy the Cloud Functions until the email
# secret exists (a function deployed without its key just fails at runtime).

set -euo pipefail

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m%s\033[0m\n' "$*"; }
err()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

cd "$(dirname "$0")/.."

# ---- 1. tooling -------------------------------------------------------------

step "Checking tooling"

if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed. Get it from https://nodejs.org (LTS)."
  exit 1
fi
green "node $(node --version)"

FIREBASE="npx --yes firebase-tools@latest"
if command -v firebase >/dev/null 2>&1; then
  FIREBASE="firebase"
fi
green "firebase CLI ready"

# ---- 2. sign in -------------------------------------------------------------

step "Checking Firebase sign-in"

if $FIREBASE login:list 2>&1 | grep -q "No authorized accounts"; then
  warn "Not signed in. A browser window will open."
  $FIREBASE login
else
  green "Signed in as: $($FIREBASE login:list 2>/dev/null | grep -oE '[^ ]+@[^ ]+' | head -1)"
fi

# ---- 3. pick the project ----------------------------------------------------

step "Selecting the Firebase project"

CURRENT=""
if [ -f .firebaserc ]; then
  # .firebaserc has no file extension, so it must be read and parsed as JSON —
  # require() would treat it as JavaScript and silently yield nothing.
  CURRENT=$(node -e "
    const fs=require('fs');
    try { console.log(JSON.parse(fs.readFileSync('.firebaserc','utf8')).projects.default || ''); }
    catch (e) { console.log(''); }
  ")
fi

if [ -z "$CURRENT" ] || [ "$CURRENT" = "demo-src" ]; then
  if [ "$CURRENT" = "demo-src" ]; then
    warn "'demo-src' is the local emulator placeholder, not a real project."
  fi
  echo "Your Firebase projects:"
  $FIREBASE projects:list || true
  echo
  warn "Copy an ID from the 'Project ID' column above — not the display name."
  echo

  # Re-prompt on a bad ID rather than dying, so a typo doesn't mean starting
  # the whole script again.
  PROJECT_ID=""
  for attempt in 1 2 3; do
    read -rp "Project ID to deploy to: " ENTERED
    ENTERED="$(printf '%s' "$ENTERED" | tr -d '[:space:]')"

    if [ -z "$ENTERED" ]; then
      err "Nothing entered."
    elif $FIREBASE use --add "$ENTERED" >/dev/null 2>&1 || $FIREBASE use "$ENTERED" >/dev/null 2>&1; then
      PROJECT_ID="$ENTERED"
      break
    else
      err "'$ENTERED' isn't a project you can access."
      echo "   Check the spelling against the Project ID column above."
      echo "   No SRC project in that list? Create one at"
      echo "   https://console.firebase.google.com, then re-run this script."
    fi
    [ "$attempt" -lt 3 ] && echo
  done

  if [ -z "$PROJECT_ID" ]; then
    err "Giving up after 3 attempts. Nothing was deployed."
    exit 1
  fi
else
  PROJECT_ID="$CURRENT"
fi
green "Deploying to: $PROJECT_ID"
SITE_URL="https://${PROJECT_ID}.web.app"

# ---- 4. dependencies --------------------------------------------------------

step "Installing dependencies"
[ -d node_modules ] || npm install
(cd functions && [ -d node_modules ] || npm install)
green "dependencies ready"

# ---- 5. test before shipping ------------------------------------------------

step "Running tests before deploying"
if npm run test:unit --silent && npm run test:rules --silent; then
  green "tests passed"
else
  err "Tests failed. Not deploying."
  exit 1
fi

# ---- 6. rules + hosting -----------------------------------------------------

step "Deploying security rules and the website"
$FIREBASE deploy --only firestore:rules,hosting --project "$PROJECT_ID"
green "Site is live: $SITE_URL"

# ---- 7. functions (only if the secret exists) -------------------------------

step "Checking the email provider API key"

if $FIREBASE functions:secrets:access EMAIL_API_KEY --project "$PROJECT_ID" >/dev/null 2>&1; then
  green "EMAIL_API_KEY is set"

  if [ ! -f functions/.env ]; then
    warn "functions/.env is missing — creating it with defaults."
    cat > functions/.env <<EOF
EMAIL_PROVIDER=resend
SENDER_EMAIL=src@src.recallschool.com
SENDER_NAME=SRC
APP_URL=${SITE_URL}
EOF
    green "wrote functions/.env"
  fi

  step "Deploying Cloud Functions"
  $FIREBASE deploy --only functions --project "$PROJECT_ID"
  green "functions deployed"
else
  warn "EMAIL_API_KEY is not set, so the email functions were NOT deployed."
  echo
  echo "  The site works fine without them — students just won't get emails."
  echo "  To enable email:"
  echo "    1. Create an API key at https://resend.com (free)"
  echo "    2. $FIREBASE functions:secrets:set EMAIL_API_KEY --project $PROJECT_ID"
  echo "       (paste at the prompt — don't put the key in a shell command)"
  echo "    3. Verify src.recallschool.com in the Resend dashboard, or sends"
  echo "       from that address will be rejected. See README section 3."
  echo "    4. re-run this script"
fi

# ---- 8. what's left ---------------------------------------------------------

step "Done"
echo
green "  $SITE_URL"
echo
echo "Still to do by hand (see README):"
echo
echo "  1. Make yourself the first teacher — Firebase Console > Firestore:"
echo "     collection 'roster', document ID = your school email (lowercase),"
echo "     fields:  email = <same address>   role = teacher"
echo "     Until you do this, nobody can sign in, including you."
echo
echo "  2. Console > Authentication > Sign-in method:"
echo "     enable Email/Password, and inside it enable 'Email link (passwordless)'."
echo
echo "  3. Console > Authentication > Settings > Authorized domains:"
echo "     confirm ${PROJECT_ID}.web.app is listed."
echo
echo "  4. Set a budget alert — Cloud Console > Billing > Budgets & alerts,"
echo "     \$5, alert at 50/90/100%. Blaze has no hard spending cap."
echo
echo "  5. Before inviting a cohort, email ONE address first and check where"
echo "     it lands. README section 7."
echo
echo "  6. Resend free tier is 100 emails/DAY. Bulk-inviting 50 students uses"
echo "     half of that in one go. Invite and announce on different days."
echo
