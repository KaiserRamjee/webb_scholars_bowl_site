// Scholars Bowl Practice.
// QUESTIONS comes from questions.js (built by build_questions.py) and
// firebaseConfig from firebase-config.js.

// Days until a card comes back after "Got it", by box. Box 0 means it was missed last time.
const INTERVALS = [0, 3, 7, 21, 60, 120];
const FIRST_TRY_BOX = 2; // a new card you already know skips the short intervals
const MASTERED_BOX = 3;
const RECENT_GAP = 8; // a card can't come back until this many others have been shown
const WORD_DELAY_MS = 300; // buzzer mode reading speed
const SYNC_DELAY_MS = 8000;
const TYPE_NAMES = { T: "Toss-up", B: "Bonus", TB: "Toss-up / Bonus" };
const GUEST_KEY = "sb.progress.guest";

const $ = (id) => document.getElementById(id);

const categoryCounts = new Map();
for (const q of QUESTIONS) categoryCounts.set(q.c, (categoryCounts.get(q.c) || 0) + 1);
const CATEGORIES = [...categoryCounts].sort((a, b) => b[1] - a[1]);

let user = null;
let progress = {}; // question id -> [box, day it is due, times right, times wrong]
const settings = Object.assign({ deck: "all", type: "all", cats: [], buzzer: false }, readStore("sb.settings", {}));
settings.cats = settings.cats.filter((name) => categoryCounts.has(name));

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

function saveProgress() {
  changes += 1;
  writeStore(progressKey(), progress);
  scheduleSync();
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
  if (settings.type !== "all" && !q.t.includes(settings.type)) return false;
  if (settings.cats.length && !settings.cats.includes(q.c)) return false;
  return true;
}

function isDue(q, day) {
  return Boolean(progress[q.id]) && progress[q.id][1] <= day;
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Reviews that are due come first (missed ones before the rest), then new questions.
function pickNext() {
  const deck = QUESTIONS.filter(inDeck);
  const gap = Math.min(RECENT_GAP, deck.length - 1);
  const blocked = gap > 0 ? recent.slice(-gap) : [];
  const open = deck.filter((q) => !blocked.includes(q.id));
  const day = today();

  const due = open.filter((q) => isDue(q, day));
  if (due.length) {
    const lowestBox = Math.min(...due.map((q) => progress[q.id][0]));
    return pickRandom(due.filter((q) => progress[q.id][0] === lowestBox));
  }
  const fresh = open.filter((q) => !progress[q.id]);
  if (fresh.length) return pickRandom(fresh);
  return cramming ? pickRandom(open) : undefined;
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
  if (settings.buzzer) {
    startReading();
  } else {
    $("card-question").textContent = current.q;
    setStage("thinking");
  }
}

function showEmpty() {
  const size = QUESTIONS.filter(inDeck).length;
  $("card").hidden = true;
  $("empty").hidden = false;
  $("cram").hidden = size === 0;
  if (size) {
    $("empty-text").textContent = "You're caught up on this deck. Its questions come back for review later.";
  } else if (settings.deck === "missed") {
    $("empty-text").textContent = "Nothing here yet. Questions you miss show up in this deck.";
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
function startReading() {
  const words = current.q.split(" ");
  let shown = 0;
  $("card-question").textContent = "";
  setStage("reading");
  readTimer = setInterval(() => {
    shown += 1;
    $("card-question").textContent = words.slice(0, shown).join(" ");
    if (shown >= words.length) {
      stopReading();
      setStage("thinking");
    }
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
  progress[current.id] = [box, today() + INTERVALS[box], right, wrong];

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
  $("type").value = settings.type;
  $("buzzer").checked = settings.buzzer;
  for (const [name, count] of CATEGORIES) {
    const box = el("input");
    box.type = "checkbox";
    box.value = name;
    box.checked = settings.cats.includes(name);
    const label = el("label", "check");
    label.append(box, name, el("span", "count", count));
    $("cat-list").append(label);
  }
  renderCategorySummary();
}

function renderCategorySummary() {
  const chosen = settings.cats;
  $("cat-summary").textContent =
    chosen.length === 0 ? "All categories" : chosen.length === 1 ? chosen[0] : `${chosen.length} categories`;
}

function onFilterChange() {
  settings.deck = $("deck").value;
  settings.type = $("type").value;
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

function renderStats() {
  const day = today();
  const byCategory = new Map(CATEGORIES.map(([name, total]) => [name, { total, seen: 0, right: 0, wrong: 0 }]));
  const all = { seen: 0, right: 0, wrong: 0, mastered: 0, due: 0 };
  for (const q of QUESTIONS) {
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
    tile(all.seen.toLocaleString(), `of ${QUESTIONS.length.toLocaleString()} questions seen`),
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
  progress = readStore(progressKey(), {});
  if (firstTimeOnThisDevice) {
    adoptGuestProgress();
    writeStore(progressKey(), progress);
  }
  if (user) syncNow();
  else setSyncStatus("Sign in to keep your progress on every device.");

  nextCard();
  if (!$("view-stats").hidden) renderStats();
}

// Answers given on this device before signing in can be moved into the account.
function adoptGuestProgress() {
  const guest = readStore(GUEST_KEY, {});
  const count = Object.keys(guest).length;
  if (!count) return;
  if (!confirm(`Add the ${count} questions answered on this device before signing in to your account?`)) return;
  progress = mergeProgress(progress, guest);
  localStorage.removeItem(GUEST_KEY);
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
    const merged = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!user || user.uid !== uid) throw new Error("signed out during sync");
      // Stored as one JSON string: a map with a field per question would
      // pass Firestore's limit of 40,000 index entries per document.
      const cloudText = (snap.exists && snap.data().progress) || "{}";
      const result = mergeProgress(JSON.parse(cloudText), progress);
      const resultText = JSON.stringify(result);
      if (resultText !== cloudText) {
        tx.set(ref, { progress: resultText, updated: firebase.firestore.FieldValue.serverTimestamp() });
      }
      return result;
    });
    if (user && user.uid === uid) {
      progress = mergeProgress(merged, progress);
      writeStore(progressKey(), progress);
      setSyncStatus("Progress saved to your account.");
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
  $("cram").addEventListener("click", () => {
    cramming = true;
    nextCard();
  });
  $("sign-in").addEventListener("click", signIn);
  $("sign-out").addEventListener("click", signOut);

  $("filters").addEventListener("change", onFilterChange);
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
  progress = readStore(GUEST_KEY, {});
  nextCard();
}
