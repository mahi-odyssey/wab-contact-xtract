#!/usr/bin/env python3
"""Customer database built from the WhatsApp Web export (stdlib only).

  python3 customers.py import exports/*.csv        load one or more export CSVs
  python3 customers.py check 8801712345678         is this phone (or LID) already a customer?
  python3 customers.py add --phone 8801712345678 --name Rahim [--ad-id ...]
                                                   insert only if new (exit code 1 if it exists)
  python3 customers.py export customers.csv        dump the whole table
  python3 customers.py stats

A customer is matched by phone number, or by LID (WhatsApp privacy ID) when the
number is hidden. Phones must be in international format; non-digits are stripped.
"""

import argparse
import csv
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).with_name("customers.db")

FIELDS = [
    "phone", "lid", "push_name", "saved_name", "verified_name", "is_business",
    "first_msg_at", "from_ad", "ad_title", "ad_url", "ad_id", "ad_source_type",
    "ctwa_clid", "conversion_source", "source",
]

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY,
    {", ".join(f"{f} TEXT" for f in FIELDS)},
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_phone ON customers(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customers_lid ON customers(lid) WHERE lid IS NOT NULL;
"""


def connect():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def digits(value):
    d = "".join(ch for ch in str(value or "") if ch.isdigit())
    return d[2:] if d.startswith("00") else d


def clean(row):
    out = {f: (str(row.get(f) or "").strip() or None) for f in FIELDS}
    out["phone"] = digits(out["phone"]) or None
    out["lid"] = digits(out["lid"]) or None
    return out


def find(db, phone=None, lid=None):
    phone, lid = digits(phone) or None, digits(lid) or None
    if phone:
        hit = db.execute("SELECT * FROM customers WHERE phone = ?", (phone,)).fetchone()
        if hit:
            return hit
    if lid:
        return db.execute("SELECT * FROM customers WHERE lid = ?", (lid,)).fetchone()
    return None


def upsert(db, row):
    """Insert a new customer, or fill blank fields of an existing one. Returns 'new' / 'merged' / 'skipped'."""
    row = clean(row)
    if not row["phone"] and not row["lid"]:
        return "skipped"
    existing = find(db, row["phone"], row["lid"])
    if existing is None:
        cols = [f for f in FIELDS if row[f] is not None]
        db.execute(
            f"INSERT INTO customers ({', '.join(cols)}, created_at) VALUES ({', '.join('?' * len(cols))}, ?)",
            [row[c] for c in cols] + [datetime.now(timezone.utc).isoformat()],
        )
        return "new"
    updates = {f: row[f] for f in FIELDS if row[f] is not None and existing[f] in (None, "", "0")}
    if row["first_msg_at"] and existing["first_msg_at"] and row["first_msg_at"] < existing["first_msg_at"]:
        updates["first_msg_at"] = row["first_msg_at"]
    if "lid" in updates and find(db, lid=updates["lid"]):
        del updates["lid"]  # that LID already belongs to another row; leave both as-is
    if updates:
        db.execute(
            f"UPDATE customers SET {', '.join(f'{k} = ?' for k in updates)} WHERE id = ?",
            [*updates.values(), existing["id"]],
        )
    return "merged"


def cmd_import(args):
    db = connect()
    counts = {"new": 0, "merged": 0, "skipped": 0}
    for path in args.files:
        with open(path, newline="", encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                row.setdefault("source", "whatsapp_export")
                counts[upsert(db, row)] += 1
    db.commit()
    print(f"imported: {counts['new']} new, {counts['merged']} already known (merged), {counts['skipped']} without phone/LID")


def cmd_check(args):
    ident = "".join(args.id)
    hit = find(connect(), phone=ident, lid=ident)
    if hit:
        print(f"EXISTS  id={hit['id']} phone={hit['phone'] or '-'} name={hit['push_name'] or hit['saved_name'] or '-'} "
              f"ad={hit['ad_title'] or '-'}")
        return 0
    print("NEW")
    return 1


def cmd_add(args):
    db = connect()
    if find(db, args.phone, args.lid):
        print("EXISTS — not added")
        return 1
    result = upsert(db, {
        "phone": args.phone, "lid": args.lid, "push_name": args.name,
        "first_msg_at": datetime.now(timezone.utc).isoformat(),
        "from_ad": "1" if (args.ad_id or args.ctwa_clid) else "0",
        "ad_id": args.ad_id, "ad_title": args.ad_title, "ctwa_clid": args.ctwa_clid,
        "source": args.source,
    })
    db.commit()
    print("ADDED" if result == "new" else "SKIPPED — need --phone or --lid")
    return 0 if result == "new" else 2


def cmd_export(args):
    rows = connect().execute("SELECT * FROM customers ORDER BY id").fetchall()
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(rows[0].keys() if rows else ["id", *FIELDS, "created_at"])
        w.writerows(tuple(r) for r in rows)
    print(f"wrote {len(rows)} customers to {args.out}")


def cmd_stats(_args):
    db = connect()
    q = lambda sql: db.execute(sql).fetchone()[0]
    total = q("SELECT COUNT(*) FROM customers")
    from_ads = q("SELECT COUNT(*) FROM customers WHERE from_ad = '1'")
    hidden = q("SELECT COUNT(*) FROM customers WHERE phone IS NULL")
    print(f"customers:      {total}")
    print(f"from ads:       {from_ads}")
    print(f"hidden number:  {hidden}")
    print("top ads:")
    for r in db.execute("""SELECT COALESCE(ad_title, ad_id) AS ad, COUNT(*) AS n FROM customers
                           WHERE from_ad = '1' GROUP BY ad ORDER BY n DESC LIMIT 10"""):
        print(f"  {r['n']:>6}  {r['ad'] or '(untitled ad)'}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("import"); s.add_argument("files", nargs="+"); s.set_defaults(fn=cmd_import)
    s = sub.add_parser("check"); s.add_argument("id", nargs="+", help="phone number or LID (spaces allowed)"); s.set_defaults(fn=cmd_check)
    s = sub.add_parser("add")
    s.add_argument("--phone"); s.add_argument("--lid"); s.add_argument("--name")
    s.add_argument("--ad-id"); s.add_argument("--ad-title"); s.add_argument("--ctwa-clid")
    s.add_argument("--source", default="manual")
    s.set_defaults(fn=cmd_add)
    s = sub.add_parser("export"); s.add_argument("out"); s.set_defaults(fn=cmd_export)
    s = sub.add_parser("stats"); s.set_defaults(fn=cmd_stats)

    args = p.parse_args()
    sys.exit(args.fn(args) or 0)


if __name__ == "__main__":
    main()
