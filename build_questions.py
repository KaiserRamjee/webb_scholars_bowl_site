"""Build questions.js for the website from the master sheet CSVs.

Run it from this folder whenever a sheet or corrections.csv changes:

    python build_questions.py

Toss-ups come from TOSSUP_FILE and bonuses from BONUS_FILE (the old full
sheet, which is also used to spot retyped copies; see known_copies).

Steps: read the sheets, merge rows that are the same question (even when
worded a little differently), then apply corrections.csv.

Question wording is shown exactly as it is in the sheet. The show repeats
questions word for word and players train on when to buzz, so nothing here
may reword, tidy or complete a question. corrections.csv is only for accuracy
problems: wrong answers, and questions that cannot be answered as scraped.
"""
import csv
import difflib
import hashlib
import itertools
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).parent
TOSSUP_FILE = HERE / "The Master Sheet - Randomized Toss-ups.csv"
BONUS_FILE = HERE / "Copy of The Master Sheet - THE MASTER SHEET unedited.csv"
FIXES_FILE = HERE / "corrections.csv"
OUT_FILE = HERE / "questions.js"

# Sheet category -> category shown on the site. Anything not listed keeps its
# own name. This merges spelling variants and folds the tiny categories
# (fewer than ten questions) into the closest big one.
CATEGORY_MAP = {
    "Arts": "Art",
    "Visual Arts": "Art",
    "Mathematics": "Math",
    "Calculus": "Math",
    "calculus": "Math",
    "Trigonometry": "Math",
    "Pre-Calculus": "Precalculus",
    "Grammar": "English",
    "Language": "Foreign Language",
    "language": "Foreign Language",
    "board Games": "Games",
    "U. S. History": "U.S. History",
    "Visual / History": "History",
    "World Affairs": "Government",
    "Anatomy": "Biology",
    "Visual / Science": "Science",
    "Meteorology": "Science",
    "Oceanography": "Science",
    "Engineering": "Technology",
    "Film": "Film, TV & Theater",
    "Television": "Film, TV & Theater",
    "Animation": "Film, TV & Theater",
    "Theater": "Film, TV & Theater",
    "Musical Theater": "Film, TV & Theater",
    "Tennessee": "Miscellaneous",
    "Tennessee Things": "Miscellaneous",
}

# Words too common to help tell two questions apart.
COMMON_WORDS = set(
    "a an the of in on at to for is was are were be and or what which who whom whose that this "
    "these those it its as by with from name give how many much does do did has have had".split()
)

ANSWER_FILLER = {"a", "an", "the", "of", "and", "or", "in"}

# What the sheet's game column says when nobody knows which game a row is from.
UNKNOWN_GAME = "No idea"

# Scrape leftovers. These are ignored when deciding whether two rows are the
# same question, but the site always shows the sheet's wording untouched.
SCREEN_PROMPT = re.compile(r"^(?:DB\s+|(?:take a )?look at (?:the |your )?screens?(?:,? please)?[.,:]?\s*)", re.I)
MID_CAPITAL = re.compile(
    r"(?<=[a-z,] )(?:Is|And|That|In|To|The|Of|For|Or|By|On|With|Was|Are|Has|Into|Over|From|Which|What)(?= [a-z])"
)
PICTURE_HINT = re.compile(
    r"shown here|pictured|seen here|depicted here|highlighted|this (?:image|picture|photo|flag|map|musical symbol)", re.I
)
SCRAPE_NOTE = re.compile(r"\s*\((?:announced|accepted in transcript|for the captioned \w+)\)", re.I)


def clean(text):
    """Collapse runs of whitespace (the sheet has stray spaces and newlines)."""
    return " ".join(text.split())


def drop_echo(match):
    """ "formerly Formerly known" -> "formerly known" (but keep "first First Lady")."""
    first, second = match.groups()
    return first if first == second.lower() and first != "first" else match.group(0)


def text_for_matching(question):
    """The question without scrape leftovers. Only used to compare rows, never shown."""
    question = SCREEN_PROMPT.sub("", question)
    question = re.sub(r" -([A-Z])(?=[a-z])", lambda m: " " + m.group(1).lower(), question)  # "segmented -Into four"
    question = re.sub(r"\b([a-z]+) ([A-Z][a-z]+)\b", drop_echo, question)
    question = MID_CAPITAL.sub(lambda m: m.group(0).lower(), question)  # "the core Is made up"
    return re.sub(r"(^|\) )Now, (\w)", lambda m: m.group(1) + m.group(2).upper(), question)


def match_key(text):
    """Lowercase letters and digits only, so punctuation and capitals don't matter."""
    # NFKC turns characters like ² and ₃ into plain digits so they aren't lost.
    text = unicodedata.normalize("NFKC", text)
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def answer_words(answer):
    """The important words of an answer, so "the Hudson River" can match "Hudson"."""
    text = re.sub(r"\(part \d\)|\b\d\)", " ", answer.lower())
    words = match_key(text).split()
    # Drop filler unless that leaves nothing ("In" is the symbol for indium).
    words = [w for w in words if w not in ANSWER_FILLER] or words
    return frozenset(w[:-1] if len(w) > 3 and w.endswith("s") else w for w in words)


def make_row(kind, category, question, answer, game, season, block=1):
    """One sheet row ready for matching, or None if the question or answer is blank."""
    question, answer, category = clean(question), clean(answer), clean(category)
    if not question or not answer:
        return None
    key = match_key(text_for_matching(question))
    return {
        "type": kind,
        "category": CATEGORY_MAP.get(category, category),
        "question": question,
        "answer": answer,
        "season": season.strip(),
        "game": game.strip(),
        "block": block,
        "key": key,
        "words": set(key.split()) - COMMON_WORDS,
        "numbers": set(re.findall(r"\d+", key)),
        "answer_words": answer_words(SCRAPE_NOTE.sub("", answer)),
    }


def load_old_sheet():
    """Every usable row of the old full sheet (BONUS_FILE), in sheet order."""
    rows = []
    blocks = Counter()  # how many separate stretches of the sheet each game has had so far
    previous_game = None
    with open(BONUS_FILE, encoding="utf-8-sig", newline="") as f:
        for kind, category, question, answer, game, season in csv.reader(f):
            if (season.strip(), game.strip()) != previous_game:
                previous_game = (season.strip(), game.strip())
                blocks[previous_game] += 1
            kind = "T" if kind.strip() == "Toss-up" else "B"
            row = make_row(kind, category, question, answer, game, season, blocks[previous_game])
            if row:
                rows.append(row)
    return rows


def load_tossups():
    """Every usable row of the toss-up sheet. Its row order is shuffled and doesn't matter.

    Columns: type, category, question, answer, round, season, random.
    Every row in this file is a toss-up, whatever its first column says.
    """
    with open(TOSSUP_FILE, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        next(reader)  # header row
        rows = [make_row("T", *line[1:6]) for line in reader if len(line) >= 6]
    return [row for row in rows if row]


def retyped(original, copy):
    """True when a later row of the same game repeats an earlier one.

    Being in the same game makes a coincidence unlikely, so this is looser
    than same_question: a matching answer or broadly similar wording is enough.
    """
    a, b = original["answer_words"], copy["answer_words"]
    if a and b and (a <= b or b <= a):
        return True
    return difflib.SequenceMatcher(None, original["key"], copy["key"]).ratio() >= 0.6


def drop_second_passes(rows):
    """Drop rows that retype a question from an earlier stretch of the same game.

    Games 12 to 24 of season 40 are in the sheet twice: the full game, then
    much further down a shorter, reworded copy of some of its questions. Those
    copies are not real repeats, so only the first version is kept.
    """
    first_pass = defaultdict(list)
    for row in rows:
        if row["block"] == 1:
            first_pass[row["season"], row["game"]].append(row)
    kept = []
    for row in rows:
        originals = first_pass[row["season"], row["game"]]
        is_copy = row["block"] > 1 and row["game"] != UNKNOWN_GAME and any(retyped(o, row) for o in originals)
        if not is_copy:
            kept.append(row)
    return kept


def copy_id(row):
    return (row["type"], row["key"], row["season"], row["game"])


def known_copies(old_rows, kept_rows):
    """How many times each (type, question, season, game) is a retyped copy.

    Spotting a copy needs sheet order, which the shuffled toss-up sheet doesn't
    have, so the copies are found in the old sheet and then removed from the
    toss-up sheet too.
    """
    return Counter(map(copy_id, old_rows)) - Counter(map(copy_id, kept_rows))


def without_copies(rows, copies):
    copies = copies.copy()
    kept = []
    for row in rows:
        if copies[copy_id(row)]:
            copies[copy_id(row)] -= 1
        else:
            kept.append(row)
    return kept


def sort_key(row):
    """Oldest season and game first, so "the first row" doesn't depend on row order."""
    def number(text):
        try:
            return float(text)
        except ValueError:
            return float("inf")  # "No idea" goes last
    return (number(row["season"]), number(row["game"]), row["type"], row["key"], row["question"], row["answer"])


def read_rows():
    """The rows the question bank is built from: toss-ups from the new sheet, bonuses from the old one."""
    old_rows = load_old_sheet()
    old_kept = drop_second_passes(old_rows)
    bonuses = [row for row in old_kept if row["type"] == "B"]
    tossups = without_copies(load_tossups(), known_copies(old_rows, old_kept))
    return sorted(tossups + bonuses, key=sort_key)


def times_asked(rows):
    """How many games a question came up in. Rows from the same game of the
    same season are one asking; rows with no game recorded count separately."""
    games = {(r["season"], r["game"]) for r in rows if r["game"] != UNKNOWN_GAME}
    return len(games) + sum(r["game"] == UNKNOWN_GAME for r in rows)


def subject_swapped(only_a, only_b):
    """True for questions that differ by one swapped subject, not by wording.

    "In which state is Yosemite National Park?" and "In which state is Sequoia
    National Park?" have the same answer but are different questions. Words
    that are just forms of each other ("route" / "routes") don't count.
    """
    if not only_a or not only_b or len(only_a) > 2 or len(only_b) > 2:
        return False
    return not any(difflib.SequenceMatcher(None, x, y).ratio() >= 0.6 for x in only_a for y in only_b)


def same_question(a, b):
    """True when two differently worded rows are really the same question."""
    if a["numbers"] != b["numbers"] or not a["words"] or not b["words"]:
        return False
    if not a["answer_words"] or not b["answer_words"]:
        return False
    overlap = len(a["words"] & b["words"]) / len(a["words"] | b["words"])
    if overlap < 0.45:
        return False
    likeness = difflib.SequenceMatcher(None, a["key"], b["key"]).ratio()
    if likeness >= 0.8 and subject_swapped(a["words"] - b["words"], b["words"] - a["words"]):
        return False
    if a["answer_words"] == b["answer_words"]:
        return overlap >= 0.5 or likeness >= 0.8
    if a["answer_words"] <= b["answer_words"] or b["answer_words"] <= a["answer_words"]:
        return likeness >= 0.85
    return False


def candidate_pairs(rows):
    """Pairs of rows that share one of their rarest words.

    Comparing every row with every other row would be about 32 million
    comparisons, so only rows with an unusual word in common get compared.
    """
    frequency = Counter(w for row in rows for w in row["words"])
    rows_with_word = defaultdict(list)
    for i, row in enumerate(rows):
        for w in sorted(row["words"], key=lambda w: (frequency[w], w))[:4]:
            rows_with_word[w].append(i)
    pairs = set()
    for ids in rows_with_word.values():
        if len(ids) <= 60:
            pairs.update(itertools.combinations(ids, 2))
    return pairs


def group_repeats(rows):
    """Split the rows into groups that are all the same question."""
    # Exact matches first, then join groups whose first rows are near matches.
    exact = defaultdict(list)
    for row in rows:
        exact[row["key"]].append(row)
    groups = list(exact.values())
    firsts = [group[0] for group in groups]

    parent = list(range(len(groups)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j in candidate_pairs(firsts):
        if root(i) != root(j) and same_question(firsts[i], firsts[j]):
            parent[max(root(i), root(j))] = min(root(i), root(j))

    merged = defaultdict(list)
    for i, group in enumerate(groups):
        merged[root(i)].extend(group)
    return list(merged.values())


def question_id(rows):
    """The id comes from the text of the first row, so it stays the same when
    rows are added or reordered and saved progress still lines up."""
    return hashlib.sha1(rows[0]["key"].encode()).hexdigest()[:10]


def is_unfinished(question):
    """True when the scrape lost part of the question."""
    ends_properly = question.rstrip("\"”’')").endswith(("?", ".", "!", ":"))
    return "…" in question or "..." in question or not ends_properly


def build():
    questions = []
    for rows in group_repeats(read_rows()):
        # Show the earliest wording that isn't cut off. A repeated question is
        # often typed with slightly different answers ("Heel" / "the heel"),
        # so keep the most common answer, earliest on a tie.
        shown = min(rows, key=lambda r: is_unfinished(r["question"]))
        answer_counts = Counter(r["answer_words"] for r in rows)
        best = max(rows, key=lambda r: answer_counts[r["answer_words"]])
        question = {
            "id": question_id(rows),
            "t": "".join(sorted({r["type"] for r in rows}, reverse=True)),
            "c": rows[0]["category"],
            "q": shown["question"],
            "a": best["answer"],
            "n": times_asked(rows),
            "s": sorted({r["season"] for r in rows}),
        }
        if PICTURE_HINT.search(shown["question"]):
            question["p"] = 1  # the show put a picture on screen for this one
        questions.append(question)

    assert len({q["id"] for q in questions}) == len(questions), "two questions got the same id"
    return apply_corrections(questions)


def apply_corrections(questions):
    """corrections.csv holds hand-checked fixes: id, drop, question, answer, note.

    A filled-in question or answer replaces the one from the sheet, and
    drop = yes removes the question from the site.
    """
    if not FIXES_FILE.exists():
        return questions
    with open(FIXES_FILE, encoding="utf-8-sig", newline="") as f:
        fixes = {row["id"]: row for row in csv.DictReader(f)}
    unknown = set(fixes) - {q["id"] for q in questions}
    if unknown:
        print(f"Warning: {len(unknown)} ids in corrections.csv match no question: {sorted(unknown)}")

    kept = []
    for q in questions:
        fix = fixes.get(q["id"])
        if fix and fix["drop"].strip():
            continue
        if fix:
            q["q"] = fix["question"].strip() or q["q"]
            q["a"] = fix["answer"].strip() or q["a"]
        kept.append(q)
    return kept


def main():
    questions = build()
    lines = ",\n".join(json.dumps(q, ensure_ascii=False, separators=(",", ":")) for q in questions)
    OUT_FILE.write_text(
        "// Generated by build_questions.py. Edit the sheet or the script, not this file.\n"
        f"const QUESTIONS = [\n{lines}\n];\n",
        encoding="utf-8",
    )
    repeated = sum(q["n"] > 1 for q in questions)
    categories = len({q["c"] for q in questions})
    kinds = Counter(t for q in questions for t in q["t"])
    print(f"Wrote {len(questions)} questions in {categories} categories to {OUT_FILE.name}")
    print(f"{kinds['T']} are toss-ups and {kinds['B']} are bonuses (a question can be both)")
    print(f"{repeated} of them were asked more than once")


if __name__ == "__main__":
    main()
