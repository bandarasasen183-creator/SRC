// Bulk-import existing announcements (e.g. a Google Classroom stream) so the
// site launches with real content instead of an empty feed.
//
// TWO THINGS THIS DELIBERATELY GUARANTEES
//
// 1. It never emails anybody. Every imported post is written with
//    notify: false, so the Cloud Function records "skipped" and sends nothing.
//    Importing a dozen historical posts would otherwise fire a dozen mailouts
//    to the whole roster and burn the provider's daily allowance in one click.
//
// 2. It writes oldest first. The feed orders by createdAt, and createdAt is a
//    server timestamp that cannot be backdated from a client, so import order
//    IS display order. Reversing it would show the archive upside down.
//
// Imported posts keep the original author's name for accuracy and carry
// importedFrom, so the feed can say where they came from. Without that label a
// post would appear to have been written in this app by someone who has never
// signed into it.

/** Refuse absurd payloads rather than writing thousands of documents. */
const MAX_POSTS = 100;

/**
 * Imported comments ride along on the announcement document rather than
 * becoming real comments, and this is deliberate.
 *
 * The rules require every comment to carry the author's OWN uid and the name
 * on their OWN profile — that is the "nobody posts under a fake name"
 * guarantee. Importing Bella's comment as a real comment would mean either
 * attributing it to whoever ran the import, or punching a hole in that rule so
 * a teacher can post as any student. Neither is acceptable for an archive.
 *
 * So they are stored as plain data and shown as a clearly-labelled read-only
 * archive under the post. Nobody can reply to them, and nobody can mistake
 * them for someone using this app.
 *
 * Capped because a Firestore document is limited to 1MB and this array shares
 * that budget with the post body.
 */
const MAX_COMMENTS = 60;
const MAX_COMMENT_LEN = 2000;

/**
 * Validate and normalise a pasted payload.
 * Returns { posts, errors } — never throws, so bad input is reportable.
 */
export function parseImport(text) {
  const errors = [];
  let raw;

  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { posts: [], errors: [`That is not valid JSON: ${e.message}`] };
  }

  if (!Array.isArray(raw)) {
    return { posts: [], errors: ['Expected a JSON array of posts, like [ { "title": … } ].'] };
  }
  if (raw.length > MAX_POSTS) {
    return { posts: [], errors: [`${raw.length} posts is more than the ${MAX_POSTS} limit.`] };
  }

  const posts = [];
  raw.forEach((p, i) => {
    const at = `Post ${i + 1}`;
    if (!p || typeof p !== 'object') { errors.push(`${at}: not an object.`); return; }

    const title = String(p.title ?? '').trim();
    const body = String(p.body ?? '');
    const date = String(p.date ?? '').trim();

    if (!title) { errors.push(`${at}: needs a title.`); return; }
    if (title.length > 200) { errors.push(`${at}: title is over 200 characters.`); return; }
    if (body.length > 20000) { errors.push(`${at}: body is over 20,000 characters.`); return; }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`${at}: date must look like 2026-08-13.`);
      return;
    }

    const rawComments = p.comments;
    if (rawComments !== undefined && !Array.isArray(rawComments)) {
      errors.push(`${at}: comments must be an array.`);
      return;
    }
    const list = Array.isArray(rawComments) ? rawComments : [];
    if (list.length > MAX_COMMENTS) {
      errors.push(`${at}: ${list.length} comments is more than the ${MAX_COMMENTS} limit.`);
      return;
    }

    const comments = [];
    let commentError = false;
    list.forEach((c, ci) => {
      const where = `${at}, comment ${ci + 1}`;
      if (!c || typeof c !== 'object') { errors.push(`${where}: not an object.`); commentError = true; return; }

      const cBody = String(c.body ?? '').trim();
      const cAuthor = String(c.authorName ?? '').trim();
      const cDate = String(c.date ?? '').trim();

      if (!cBody) { errors.push(`${where}: has no text.`); commentError = true; return; }
      if (cBody.length > MAX_COMMENT_LEN) {
        errors.push(`${where}: over ${MAX_COMMENT_LEN} characters.`);
        commentError = true;
        return;
      }
      if (!cAuthor) { errors.push(`${where}: has no author.`); commentError = true; return; }
      if (cDate && !/^\d{4}-\d{2}-\d{2}$/.test(cDate)) {
        errors.push(`${where}: date must look like 2026-08-13.`);
        commentError = true;
        return;
      }
      comments.push({ authorName: cAuthor, body: cBody, date: cDate });
    });
    if (commentError) return;

    posts.push({
      title,
      body,
      date,
      authorName: String(p.authorName ?? '').trim(),
      pinned: p.pinned === true,
      commentsOpen: p.commentsOpen !== false,
      comments,
    });
  });

  // All or nothing. Importing 7 of 9 posts leaves someone working out which two
  // are missing and re-importing without duplicating the rest — worse than
  // refusing outright. It also means a caller cannot use posts without having
  // dealt with errors first.
  if (errors.length) return { posts: [], errors };

  // Oldest first. Undated posts keep their given order, after the dated ones.
  posts.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

  return { posts, errors };
}


/* =============================================================================
   Events
   ========================================================================== */

const MAX_EVENTS = 100;

/**
 * Validate a list of calendar events.
 *
 * Mirrors the limits in firestore.rules deliberately: title 200, description
 * 5000, an ISO date. Catching an over-long title here produces "Event 4: title
 * is over 200 characters" instead of a permission-denied from the server that
 * names nothing.
 *
 * All-or-nothing, like parseImport, and for the same reason.
 */
export function parseEventImport(text) {
  const errors = [];
  let raw;

  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { events: [], errors: [`That is not valid JSON: ${e.message}`] };
  }
  if (!Array.isArray(raw)) {
    return { events: [], errors: ['Expected a JSON array of events.'] };
  }
  if (raw.length > MAX_EVENTS) {
    return { events: [], errors: [`${raw.length} events is more than the ${MAX_EVENTS} limit.`] };
  }

  const events = [];
  raw.forEach((e, i) => {
    const at = `Event ${i + 1}`;
    if (!e || typeof e !== 'object') { errors.push(`${at}: not an object.`); return; }

    const title = String(e.title ?? '').trim();
    const date = String(e.date ?? '').trim();
    const description = String(e.description ?? '');
    const location = String(e.location ?? '').trim();
    const startTime = String(e.startTime ?? '').trim();
    const endTime = String(e.endTime ?? '').trim();

    if (!title) { errors.push(`${at}: needs a title.`); return; }
    if (title.length > 200) { errors.push(`${at}: title is over 200 characters.`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`${at}: date must look like 2026-09-10.`);
      return;
    }
    if (description.length > 5000) { errors.push(`${at}: description is over 5,000 characters.`); return; }
    if (location.length > 120) { errors.push(`${at}: location is over 120 characters.`); return; }
    for (const [label, t] of [['startTime', startTime], ['endTime', endTime]]) {
      if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
        errors.push(`${at}: ${label} must look like 09:00.`);
        return;
      }
    }
    if (startTime && endTime && endTime < startTime) {
      errors.push(`${at}: ends before it starts.`);
      return;
    }

    // null and undefined both mean "no target". Rejecting an explicit null
    // would fail a hand-edited file for no real reason.
    //
    // Everything else must already BE a number. Coercing with Number() turned
    // `true` into a target of 1 and `[]` into 0 — a wrong value read as a
    // plausible one, which is worse than an error.
    const rawNeeded = e.needed;
    let needed = 0;
    if (rawNeeded !== undefined && rawNeeded !== null) {
      if (typeof rawNeeded !== 'number' || !Number.isInteger(rawNeeded)
          || rawNeeded < 0 || rawNeeded > 999) {
        errors.push(`${at}: "needed" must be a whole number from 0 to 999.`);
        return;
      }
      needed = rawNeeded;
    }

    events.push({
      title, date, description, location, startTime, endTime,
      signupOpen: e.signupOpen === true,
      needed,
      // Off unless explicitly asked for. Showing who signed up is a privacy
      // decision, and the safe default is the private one.
      attendeesVisible: e.attendeesVisible === true,
    });
  });

  if (errors.length) return { events: [], errors };

  events.sort((a, b) => (a.date === b.date
    ? (a.startTime || '99').localeCompare(b.startTime || '99')
    : a.date.localeCompare(b.date)));

  return { events, errors };
}
