// Scholars Bowl Practice.
// QUESTIONS comes from questions.js (built by build_questions.py) and
// firebaseConfig from firebase-config.js.

// Days until a card comes back after "Got it", by box. Box 0 means it was missed last time.
const INTERVALS = [0, 3, 7, 21, 60, 120];
const FIRST_TRY_BOX = 2; // a new card you already know skips the short intervals
const MASTERED_BOX = 3;
const RECENT_GAP = 8; // no card repeats until this many others have been shown
const MISSED_GAP = 50; // a missed card waits until this many more questions have been answered
const WORD_DELAY_MS = 300; // buzzer mode reading speed
const SYNC_DELAY_MS = 8000;
const TYPE_NAMES = { T: "Toss-up", B: "Bonus", TB: "Toss-up / Bonus" };
const GUEST_KEY = "sb.progress.guest";
const GUEST_STARS_KEY = "sb.stars.guest";
const REPORT_EMAIL = "kaiserramjee@gmail.com"; // where "Report a problem" emails go

const $ = (id) => document.getElementById(id);

const PLURAL_TYPE_NAMES = { T: "toss-ups", B: "bonuses" };

// Toss-ups and bonuses are practiced separately. A question asked both ways is in both.
function hasType(q, type) {
  return q.t.includes(type);
}

// For each type: category -> how many questions of that type it has.
const categoryCounts = { T: new Map(), B: new Map() };
for (const q of QUESTIONS) {
  for (const type of q.t) categoryCounts[type].set(q.c, (categoryCounts[type].get(q.c) || 0) + 1);
}
const categorySize = (name) => (categoryCounts.T.get(name) || 0) + (categoryCounts.B.get(name) || 0);
const CATEGORIES = [...new Set(QUESTIONS.map((q) => q.c))].sort((a, b) => categorySize(b) - categorySize(a));

let user = null;
// question id -> [box, day it is due, times right, times wrong, answer count when last missed]
let progress = {};
let answered = 0; // total answers recorded in progress; missed cards wait on this
// question id -> [1 starred or 0 unstarred, time it changed]. Unstars are kept so syncing can't bring a star back.
let stars = {};
const settings = Object.assign({ deck: "all", type: "T", cats: [], buzzer: false }, readStore("sb.settings", {}));
if (!(settings.type in PLURAL_TYPE_NAMES)) settings.type = "T"; // older saves allowed "all"
settings.cats = settings.cats.filter((name) => CATEGORIES.includes(name));

let current = null;
let stage = "thinking"; // "reading" -> "thinking" -> "answer"
let readTimer = null;
let cramming = false; // keep going after the deck has nothing due
const recent = [];
const session = { right: 0, wrong: 0 };

// ---------- Storage on this device ----------

function readStore(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is full or blocked; the app still works for this visit.
  }
}

function progressKey() {
  return user ? "sb.progress." + user.uid : GUEST_KEY;
}

function starsKey() {
  return user ? "sb.stars." + user.uid : GUEST_STARS_KEY;
}

function loadLocal() {
  progress = readStore(progressKey(), {});
  stars = readStore(starsKey(), {});
  countAnswered();
}

function countAnswered() {
  answered = 0;
  for (const id in progress) answered += attempts(progress[id]);
}

function saveProgress() {
  changes += 1;
  writeStore(progressKey(), progress);
  scheduleSync();
}

function saveStars() {
  changes += 1;
  writeStore(starsKey(), stars);
  scheduleSync();
}

// ---------- Stars ----------

function isStarred(id) {
  return Boolean(stars[id]) && stars[id][0] === 1;
}

function toggleStar() {
  if (!current) return;
  stars[current.id] = [isStarred(current.id) ? 0 : 1, Date.now()];
  saveStars();
  renderStar();
  renderStatus();
}

function renderStar() {
  const on = Boolean(current) && isStarred(current.id);
  $("star").setAttribute("aria-pressed", on);
  $("star").textContent = on ? "★ Starred" : "☆ Star";
}

// For each question keep whichever side changed its star most recently.
function mergeStars(base, other) {
  const merged = { ...base };
  for (const id in other) {
    if (!merged[id] || other[id][1] > merged[id][1]) merged[id] = other[id];
  }
  return merged;
}

// ---------- Picking the next card ----------

function today() {
  const now = new Date();
  return Math.floor((now.getTime() - now.getTimezoneOffset() * 60000) / 86400000);
}

function inDeck(q) {
  const p = progress[q.id];
  if (settings.deck === "repeats" && q.n < 2) return false;
  if (settings.deck === "missed" && !(p && p[3] > 0 && p[0] < MASTERED_BOX)) return false;
  if (settings.deck === "starred" && !isStarred(q.id)) return false;
  if (!hasType(q, settings.type)) return false;
  if (settings.cats.length && !settings.cats.includes(q.c)) return false;
  return true;
}

function isDue(q, day) {
  return Boolean(progress[q.id]) && progress[q.id][1] <= day;
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// A missed card sits out until enough other questions have been answered, so getting it
// right next time isn't just remembering it from a minute ago. Small decks wait less.
function missedGap(deck) {
  return Math.max(0, Math.min(MISSED_GAP, deck.length - 1));
}

function isWaiting(q, gap) {
  const p = progress[q.id];
  return Boolean(p) && p[0] === 0 && p[4] !== undefined && answered < p[4] + gap;
}

// Reviews that are due come first (missed ones before the rest), then new questions.
// The Starred deck never runs out: once nothing is due it keeps going through the stars.
function pickNext() {
  const deck = QUESTIONS.filter(inDeck);
  const gap = Math.min(RECENT_GAP, deck.length - 1);
  const blocked = gap > 0 ? recent.slice(-gap) : [];
  const waitGap = missedGap(deck);
  const open = deck.filter((q) => !blocked.includes(q.id) && !isWaiting(q, waitGap));
  const day = today();

  const due = open.filter((q) => isDue(q, day));
  if (due.length) {
    const lowestBox = Math.min(...due.map((q) => progress[q.id][0]));
    return pickRandom(due.filter((q) => progress[q.id][0] === lowestBox));
  }
  const fresh = open.filter((q) => !progress[q.id]);
  if (fresh.length) return pickRandom(fresh);
  return cramming || settings.deck === "starred" ? pickRandom(open) : undefined;
}

function nextCard() {
  stopReading();
  current = pickNext() || null;
  if (current) showCard();
  else showEmpty();
  renderStatus();
}

// ---------- The card ----------

function showCard() {
  $("empty").hidden = true;
  $("card").hidden = false;
  $("card-meta").replaceChildren(`${current.c} · ${TYPE_NAMES[current.t]}`);
  if (current.n > 1) {
    const badge = el("span", "badge", `Asked ${current.n} times`);
    badge.title = `Season${current.s.length > 1 ? "s" : ""} ${current.s.join(", ")}`;
    $("card-meta").append(badge);
  }
  if (current.p) $("card-meta").append(el("span", "badge", "Had a picture on the show"));
  $("card-answer-text").textContent = current.a;
  $("card-id").textContent = current.id;
  $("report").href = reportLink(current);
  renderStar();
  if (buzzerOn()) {
    startReading();
  } else {
    $("card-question").textContent = current.q;
    setStage("thinking");
  }
}

// Opens an email with the id and the question already filled in.
function reportLink(q) {
  const subject = `Question ${q.id} has a problem`;
  const body = `Question ID: ${q.id}\nQuestion: ${q.q}\nAnswer: ${q.a}\n\nWhat's wrong:\n`;
  return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function showEmpty() {
  const deck = QUESTIONS.filter(inDeck);
  const size = deck.length;
  const gap = missedGap(deck);
  const waiting = deck.filter((q) => isWaiting(q, gap)).length;
  $("card").hidden = true;
  $("empty").hidden = false;
  $("cram").hidden = size === 0;
  if (waiting) {
    $("empty-text").textContent =
      `You're caught up for now. ${waiting.toLocaleString()} missed question${waiting === 1 ? "" : "s"} ` +
      `will come back after you answer some others.`;
  } else if (size) {
    $("empty-text").textContent = "You're caught up on this deck. Its questions come back for review later.";
  } else if (settings.deck === "missed") {
    $("empty-text").textContent = "Nothing here yet. Questions you miss show up in this deck.";
  } else if (settings.deck === "starred") {
    $("empty-text").textContent = "No starred questions yet. Press Star on a question (or the S key) to save it here.";
  } else {
    $("empty-text").textContent = "No questions match these filters.";
  }
}

function setStage(next) {
  stage = next;
  $("reveal").hidden = stage === "answer";
  $("reveal").textContent = stage === "reading" ? "Buzz" : "Show answer";
  $("card-answer").hidden = stage !== "answer";
  $("missed").hidden = stage !== "answer";
  $("got").hidden = stage !== "answer";
}

// Buzzer mode: the question appears one word at a time until you buzz.
// Only toss-ups are buzzed on, so bonuses are always shown whole.
function buzzerOn() {
  return settings.buzzer && settings.type === "T";
}

function startReading() {
  const words = current.q.split(" ");
  let shown = 0;
  $("card-question").textContent = "";
  setStage("reading");
  readTimer = setInterval(() => {
    shown += 1;
    $("card-question").textContent = words.slice(0, shown).join(" ");
    // When the whole question is read you still have to buzz, like in a match.
    if (shown >= words.length) stopReading();
  }, WORD_DELAY_MS);
}

function stopReading() {
  clearInterval(readTimer);
  readTimer = null;
}

function primaryAction() {
  if (!current) return;
  if (stage === "reading") {
    stopReading();
    setStage("thinking");
  } else if (stage === "thinking") {
    $("card-question").textContent = current.q;
    setStage("answer");
  }
}

function grade(correct) {
  if (!current || stage !== "answer") return;
  const old = progress[current.id];
  let box = 0;
  if (correct) box = old ? Math.min(old[0] + 1, INTERVALS.length - 1) : FIRST_TRY_BOX;
  const right = (old ? old[2] : 0) + (correct ? 1 : 0);
  const wrong = (old ? old[3] : 0) + (correct ? 0 : 1);
  answered += 1;
  const entry = [box, today() + INTERVALS[box], right, wrong];
  if (!correct) entry.push(answered);
  progress[current.id] = entry;

  session[correct ? "right" : "wrong"] += 1;
  recent.push(current.id);
  if (recent.length > RECENT_GAP) recent.shift();
  saveProgress();
  nextCard();
}

function renderStatus() {
  const day = today();
  const deck = QUESTIONS.filter(inDeck);
  const due = deck.filter((q) => isDue(q, day)).length;
  const fresh = deck.filter((q) => !progress[q.id]).length;
  $("deck-status").textContent =
    `${due.toLocaleString()} to review · ${fresh.toLocaleString()} new · ${deck.length.toLocaleString()} in this deck`;
  const answered = session.right + session.wrong;
  $("session").textContent = answered ? `This session: ${session.right} of ${answered} right` : "";
}

// ---------- Filters ----------

function buildFilters() {
  $("deck").value = settings.deck;
  $("buzzer").checked = settings.buzzer;
  $("mode").querySelector(`input[value="${settings.type}"]`).checked = true;
  for (const name of CATEGORIES) {
    const box = el("input");
    box.type = "checkbox";
    box.value = name;
    box.checked = settings.cats.includes(name);
    const label = el("label", "check");
    label.append(box, name, el("span", "count"));
    $("cat-list").append(label);
  }
  renderCategorySummary();
  renderForType();
}

// Category counts and the buzzer option depend on whether it's toss-ups or bonuses.
function renderForType() {
  const counts = categoryCounts[settings.type];
  for (const box of $("cat-list").querySelectorAll("input")) {
    const count = counts.get(box.value) || 0;
    box.parentElement.querySelector(".count").textContent = count.toLocaleString();
    box.parentElement.hidden = count === 0;
  }
  $("buzzer-option").hidden = settings.type !== "T";
}

function onModeChange() {
  settings.type = $("mode").querySelector("input:checked").value;
  writeStore("sb.settings", settings);
  renderForType();
  cramming = false;
  recent.length = 0;
  nextCard();
  if (!$("view-stats").hidden) renderStats();
}

function renderCategorySummary() {
  const chosen = settings.cats;
  $("cat-summary").textContent =
    chosen.length === 0 ? "All categories" : chosen.length === 1 ? chosen[0] : `${chosen.length} categories`;
}

function onFilterChange() {
  settings.deck = $("deck").value;
  settings.buzzer = $("buzzer").checked;
  settings.cats = [...$("cat-list").querySelectorAll("input:checked")].map((box) => box.value);
  writeStore("sb.settings", settings);
  renderCategorySummary();
  cramming = false;
  nextCard();
}

// ---------- Stats ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function percent(right, wrong) {
  return right + wrong ? Math.round((100 * right) / (right + wrong)) + "%" : "–";
}

function tile(value, label) {
  const node = el("div", "tile");
  node.append(el("div", "tile-value", value), el("div", "tile-label", label));
  return node;
}

function categoryRow(name, c) {
  const fill = el("div", "meter-fill");
  fill.style.width = (100 * c.seen) / c.total + "%";
  const meter = el("div", "meter");
  meter.append(fill);
  const seen = el("div", "seen");
  seen.append(meter, el("span", "meter-label", `${c.seen} / ${c.total}`));
  const seenCell = el("td");
  seenCell.append(seen);

  const row = el("tr");
  row.title = `${name}: ${c.seen} of ${c.total} seen, ${c.right} right, ${c.wrong} wrong`;
  row.append(el("td", "", name), seenCell, el("td", "num", percent(c.right, c.wrong)));
  return row;
}

// Stats are for the type picked in the Toss-ups / Bonuses switch.
function renderStats() {
  const day = today();
  const questions = QUESTIONS.filter((q) => hasType(q, settings.type));
  const totals = [...categoryCounts[settings.type]].sort((a, b) => b[1] - a[1]);
  const byCategory = new Map(totals.map(([name, total]) => [name, { total, seen: 0, right: 0, wrong: 0 }]));
  const all = { seen: 0, right: 0, wrong: 0, mastered: 0, due: 0 };
  for (const q of questions) {
    const p = progress[q.id];
    if (!p) continue;
    const c = byCategory.get(q.c);
    c.seen += 1;
    c.right += p[2];
    c.wrong += p[3];
    all.seen += 1;
    all.right += p[2];
    all.wrong += p[3];
    if (p[0] >= MASTERED_BOX) all.mastered += 1;
    if (p[1] <= day) all.due += 1;
  }
  $("tiles").replaceChildren(
    tile(all.seen.toLocaleString(), `of ${questions.length.toLocaleString()} ${PLURAL_TYPE_NAMES[settings.type]} seen`),
    tile(percent(all.right, all.wrong), "accuracy"),
    tile(all.mastered.toLocaleString(), "mastered"),
    tile(all.due.toLocaleString(), "due for review"),
  );
  $("cat-rows").replaceChildren(...[...byCategory].map(([name, c]) => categoryRow(name, c)));
}

function showView(name) {
  $("view-study").hidden = name !== "study";
  $("view-stats").hidden = name !== "stats";
  $("tab-study").setAttribute("aria-pressed", name === "study");
  $("tab-stats").setAttribute("aria-pressed", name === "stats");
  if (name === "stats") renderStats();
}

// ---------- Accounts and syncing ----------
// Progress always lives in localStorage. When someone is signed in it is also
// merged with their document in Firestore, so it follows them between devices.

let db = null;
let syncTimer = null;
let syncing = false;
let changes = 0; // goes up with every answer, so a sync can tell if it finished out of date

function setSyncStatus(text) {
  $("sync-status").textContent = text;
}

function attempts(entry) {
  return entry[2] + entry[3];
}

// For each question keep whichever side has more answers recorded.
function mergeProgress(base, other) {
  const merged = { ...base };
  for (const id in other) {
    const a = merged[id];
    const b = other[id];
    if (!a || attempts(b) > attempts(a) || (attempts(b) === attempts(a) && b[1] > a[1])) merged[id] = b;
  }
  return merged;
}

function startAccounts() {
  if (typeof firebase === "undefined" || !firebaseConfig.apiKey) {
    setSyncStatus("Progress is saved on this device.");
    return false;
  }
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  firebase.auth().onAuthStateChanged(onAuthChanged);
  return true;
}

function onAuthChanged(newUser) {
  user = newUser;
  $("sign-in").hidden = Boolean(user);
  $("sign-out").hidden = !user;
  $("account-name").textContent = user ? user.displayName || user.email : "";

  const firstTimeOnThisDevice = user && readStore(progressKey(), null) === null;
  loadLocal();
  if (firstTimeOnThisDevice) {
    adoptGuestProgress();
    writeStore(progressKey(), progress);
    writeStore(starsKey(), stars);
  }
  if (user) syncNow();
  else setSyncStatus("Sign in to keep your progress on every device.");

  nextCard();
  if (!$("view-stats").hidden) renderStats();
}

// Answers given on this device before signing in can be moved into the account.
function adoptGuestProgress() {
  const guest = readStore(GUEST_KEY, {});
  const guestStars = readStore(GUEST_STARS_KEY, {});
  const count = Object.keys(guest).length;
  const starCount = Object.values(guestStars).filter((s) => s[0] === 1).length;
  if (!count && !starCount) return;
  const parts = [];
  if (count) parts.push(`the ${count} questions answered`);
  if (starCount) parts.push(`the ${starCount} questions starred`);
  if (!confirm(`Add ${parts.join(" and ")} on this device before signing in to your account?`)) return;
  progress = mergeProgress(progress, guest);
  stars = mergeStars(stars, guestStars);
  countAnswered();
  localStorage.removeItem(GUEST_KEY);
  localStorage.removeItem(GUEST_STARS_KEY);
}

function scheduleSync() {
  if (!user || !db || syncTimer) return;
  syncTimer = setTimeout(syncNow, SYNC_DELAY_MS);
}

async function syncNow() {
  clearTimeout(syncTimer);
  syncTimer = null;
  if (!user || !db || syncing) return;
  syncing = true;
  const uid = user.uid;
  const startedAt = changes;
  setSyncStatus("Saving…");
  try {
    const ref = db.collection("users").doc(uid);
    const [merged, mergedStars] = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!user || user.uid !== uid) throw new Error("signed out during sync");
      // Stored as JSON strings: a map with a field per question would
      // pass Firestore's limit of 40,000 index entries per document.
      const data = snap.exists ? snap.data() : {};
      const cloudText = data.progress || "{}";
      const cloudStarsText = data.stars || "{}";
      const result = mergeProgress(JSON.parse(cloudText), progress);
      const starsResult = mergeStars(JSON.parse(cloudStarsText), stars);
      const resultText = JSON.stringify(result);
      const starsText = JSON.stringify(starsResult);
      if (resultText !== cloudText || starsText !== cloudStarsText) {
        tx.set(ref, {
          progress: resultText,
          stars: starsText,
          updated: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
      return [result, starsResult];
    });
    if (user && user.uid === uid) {
      progress = mergeProgress(merged, progress);
      stars = mergeStars(mergedStars, stars);
      countAnswered();
      writeStore(progressKey(), progress);
      writeStore(starsKey(), stars);
      setSyncStatus("Progress saved to your account.");
      if (current) renderStar();
      renderStatus();
      if (!$("view-stats").hidden) renderStats();
    }
  } catch (err) {
    console.error(err);
    if (user) setSyncStatus("Saved on this device. It will sync to your account when the connection is back.");
  }
  syncing = false;
  if (changes !== startedAt) scheduleSync();
}

function signIn() {
  firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch((err) => {
    const closedByUser = err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request";
    if (!closedByUser) alert("Sign-in didn't work: " + err.message);
  });
}

function signOut() {
  syncNow().finally(() => firebase.auth().signOut());
}

// ---------- Events ----------

// After a mouse or touch interaction, drop focus so Space goes to the card
// instead of re-triggering the control that was just used.
let pointerUsed = false;

function dropFocus() {
  if (pointerUsed) document.activeElement.blur();
}

function bindEvents() {
  $("tab-study").addEventListener("click", () => showView("study"));
  $("tab-stats").addEventListener("click", () => showView("stats"));
  $("reveal").addEventListener("click", primaryAction);
  $("missed").addEventListener("click", () => grade(false));
  $("got").addEventListener("click", () => grade(true));
  $("star").addEventListener("click", toggleStar);
  $("cram").addEventListener("click", () => {
    cramming = true;
    nextCard();
  });
  $("sign-in").addEventListener("click", signIn);
  $("sign-out").addEventListener("click", signOut);

  $("filters").addEventListener("change", onFilterChange);
  $("mode").addEventListener("change", onModeChange);
  $("cat-clear").addEventListener("click", () => {
    for (const box of $("cat-list").querySelectorAll("input:checked")) box.checked = false;
    onFilterChange();
  });

  document.addEventListener("pointerdown", () => {
    pointerUsed = true;
  });
  document.addEventListener("change", dropFocus);
  document.addEventListener("click", (e) => {
    if (e.target.closest("button")) dropFocus();
    if (!$("cat-menu").contains(e.target)) $("cat-menu").open = false;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab") pointerUsed = false;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || $("view-study").hidden) return;
    if (e.target.closest("button, select, input, summary")) return;
    if (e.key === " ") {
      e.preventDefault();
      primaryAction();
    } else if (e.key === "1" || e.key === "ArrowLeft") {
      grade(false);
    } else if (e.key === "2" || e.key === "ArrowRight") {
      grade(true);
    } else if (e.key === "s" || e.key === "S") {
      toggleStar();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && syncTimer) syncNow();
  });
  window.addEventListener("online", syncNow);
}

buildFilters();
bindEvents();
if (!startAccounts()) {
  loadLocal();
  nextCard();
}
