"""List repeated questions whose wording differs between rows of the sheet.

Run it from this folder:

    python find_different_wordings.py

It writes different_wordings.csv with one row per question. Each distinct
wording has its own column (wording_1, wording_2, ...) next to the seasons
that use it (seasons_1, seasons_2, ...).

    small  the same sentence with a few words changed, added or dropped
    large  the sentence was restructured (a key word sits in a different
           place) or mostly reworded

Things that sound the same when read aloud are not counted as differences:
punctuation, capitals, "U.S." / "US", "five" / "5", "Dr." / "Doctor".
Text that only one version has at the very start or end (a cut-off question,
"Take a look at screens", host chatter, an added second part) is described in
the note column and is not counted as rewording.
"""
import csv
import difflib
import itertools
import re
from collections import Counter

from build_questions import COMMON_WORDS, HERE, group_repeats, match_key, question_id, read_rows

OUT_FILE = HERE / "different_wordings.csv"
SEASONS = ["40", "41", "42", "42.1"]

# A pair of wordings is "large" when a key word sits MOVE_DISTANCE lined-up
# words (or MOVE_SHARE of the question, if that is less) away from where the
# other version has it, or when more than MAX_SMALL_CHANGES words differ and
# less than MIN_SMALL_SIMILARITY of the words line up in the same order.
MOVE_DISTANCE = 4
MOVE_SHARE = 1 / 3
MAX_SMALL_CHANGES = 3
MIN_SMALL_SIMILARITY = 0.75

PART_MARKER = re.compile(r"\(part \d\)|\b\d\)", re.I)
SPOKEN_FORMS = {
    "dr": "doctor", "jr": "junior", "sr": "senior", "st": "saint", "mt": "mount",
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
    "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13", "fourteen": "14",
    "fifteen": "15", "sixteen": "16", "seventeen": "17", "eighteen": "18", "nineteen": "19", "twenty": "20",
    "thirty": "30", "forty": "40", "fifty": "50", "sixty": "60", "seventy": "70", "eighty": "80", "ninety": "90",
}


def words(question):
    """The question as the words a listener would hear."""
    result = []
    letters = ""
    for word in match_key(PART_MARKER.sub(" ", question)).split() + [""]:
        if len(word) == 1 and word.isalpha():
            letters += word  # "u s" -> "us", "b c" -> "bc"
            continue
        if letters and letters != "s":  # a lone "s" is the end of a possessive
            result.append(letters)
        letters = ""
        if word:
            word = re.sub(r"^(\d+)(?:st|nd|rd|th)$", r"\1", word)  # "21st" -> "21"
            result.append(SPOKEN_FORMS.get(word, word))
    return tuple(result)


def opcodes(a, b):
    return difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()


def join_split_words(a, b):
    """Make "non rectangular" and "nonrectangular" count as the same word."""
    new_a, new_b = [], []
    for tag, i1, i2, j1, j2 in opcodes(a, b):
        left, right = a[i1:i2], b[j1:j2]
        if tag == "replace" and "".join(left) == "".join(right):
            left = right = ("".join(left),)
        new_a.extend(left)
        new_b.extend(right)
    return tuple(new_a), tuple(new_b)


def stem(word):
    """ "Catholics" and "Catholic" count as the same word when looking for moves."""
    plural = len(word) > 3 and word.endswith("s") and not word.endswith(("ss", "us", "is"))
    return word[:-1] if plural else word


def moved_words(a, b, steps):
    """Key words that both versions use, but in clearly different places.

    A word's place is counted in lined-up words before it, so "What is the
    official currency in Egypt?" and "What is Egypt's official currency?"
    have Egypt two lined-up words apart.
    """
    lined_up = 0
    left_over_a, left_over_b = [], []
    for tag, i1, i2, j1, j2 in steps:
        if tag == "equal":
            lined_up += i2 - i1
        else:
            left_over_a += [(word, lined_up) for word in a[i1:i2]]
            left_over_b += [(word, lined_up) for word in b[j1:j2]]
    far = max(2, min(MOVE_DISTANCE, lined_up * MOVE_SHARE))
    moved = set()
    for word, place in left_over_a:
        gaps = [abs(other_place - place) for other, other_place in left_over_b if stem(other) == stem(word)]
        if gaps and min(gaps) >= far and stem(word) not in COMMON_WORDS:
            moved.add(word)
    return sorted(moved)


def compare(a, b):
    """Compare two word lists.

    Returns (words changed, similarity from 0 to 1, key words that moved,
    notes about extra text at the start or end).
    """
    a, b = join_split_words(a, b)
    steps = opcodes(a, b)
    matched = sum(i2 - i1 for tag, i1, i2, _, _ in steps if tag == "equal")
    moved = moved_words(a, b, steps)

    length_a, length_b = len(a), len(b)
    notes = []
    # Words only one version has at the very start or end are extra text, not
    # rewording, so they are left out of the comparison and noted instead.
    for (tag, i1, i2, j1, j2), where in ((steps[0], "start"), (steps[-1], "end")):
        extra = a[i1:i2] if tag == "delete" else b[j1:j2] if tag == "insert" else ()
        if extra and not {stem(w) for w in extra} & {stem(w) for w in moved}:
            length_a -= i2 - i1
            length_b -= j2 - j1
            notes.append(f"one version has {len(extra)} extra word{'s' if len(extra) > 1 else ''} at the {where}")
    changed = max(length_a, length_b) - matched
    similarity = 2 * matched / (length_a + length_b) if length_a + length_b else 1.0
    return changed, similarity, moved, notes


def describe(rows):
    """Compare every pair of distinct wordings among one question's rows."""
    wordings = list(dict.fromkeys(words(r["question"]) for r in rows))
    results = [compare(a, b) for a, b in itertools.combinations(wordings, 2)]
    if not any(changed or notes for changed, _, _, notes in results):
        return None  # every row uses the same words
    is_large = any(
        moved or (changed > MAX_SMALL_CHANGES and similarity < MIN_SMALL_SIMILARITY)
        for changed, similarity, moved, _ in results
    )
    all_moved = sorted({w for _, _, moved, _ in results for w in moved})
    notes = list(dict.fromkeys(note for _, _, _, notes in results for note in notes))
    if all_moved:
        notes.insert(0, "in a different place: " + ", ".join(all_moved))
    return {
        "difference": "large" if is_large else "small",
        "similarity_percent": round(100 * min(similarity for _, similarity, _, _ in results)),
        "note": "; ".join(notes),
    }


def distinct_wordings(rows):
    """Each distinct wording of a question with the seasons that use it.

    Returns (text exactly as typed in the sheet, seasons such as "40, 42")
    pairs in sheet order. Rows that differ only in punctuation or capitals
    are one wording.
    """
    texts, seasons = {}, {}
    for row in rows:
        wording = words(row["question"])
        texts.setdefault(wording, row["question"])
        seasons.setdefault(wording, [])
        if row["season"] not in seasons[wording]:
            seasons[wording].append(row["season"])
    return [(texts[wording], ", ".join(seasons[wording])) for wording in texts]


def main():
    groups = [rows for rows in group_repeats(read_rows()) if len(rows) > 1]
    found = []
    most_wordings = 0
    for rows in groups:
        result = describe(rows)
        if result is None:
            continue
        result.update({
            "category": rows[0]["category"],
            "answer": rows[0]["answer"],
            "seasons": ", ".join(s for s in SEASONS if any(r["season"] == s for r in rows)),
            "site_id": question_id(rows),
        })
        wordings = distinct_wordings(rows)
        most_wordings = max(most_wordings, len(wordings))
        for number, (text, seasons) in enumerate(wordings, start=1):
            result[f"wording_{number}"] = text
            result[f"seasons_{number}"] = seasons
        found.append(result)

    found.sort(key=lambda r: (r["difference"] != "large", r["similarity_percent"]))
    columns = ["difference", "similarity_percent", "note", "category", "answer", "seasons"]
    for number in range(1, most_wordings + 1):
        columns += [f"wording_{number}", f"seasons_{number}"]
    columns.append("site_id")
    # Every wording gets its own cell and every piece of text is quoted, so a
    # comma or quote mark inside a question can't be mistaken for a column
    # break. utf-8-sig makes Excel show accented letters correctly.
    with open(OUT_FILE, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns, restval="", quoting=csv.QUOTE_NONNUMERIC)
        writer.writeheader()
        writer.writerows(found)

    counts = Counter(r["difference"] for r in found)
    print(f"{len(groups)} questions appear more than once in the sheet")
    print(f"{len(groups) - len(found)} use the same words every time")
    print(f"{len(found)} are worded differently: {counts['small']} small, {counts['large']} large")
    print(f"Wrote {OUT_FILE.name}")


if __name__ == "__main__":
    main()
