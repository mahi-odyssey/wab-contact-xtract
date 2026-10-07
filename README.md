# WhatsApp customer export

One-time, read-only export of your WhatsApp Business customers (phone, name, which ad they came from),
then a local database to check new customers against.

Runs inside the WhatsApp Web tab you already have open. There's no new login, no linked device, and no server.

```
browser/probe.js   test script: shows what fields your WhatsApp Web exposes (run first)
browser/export.js  full export → downloads wa_contacts_*.csv and .json
customers.py       SQLite customer DB: import / check / add / export / stats  (Python 3, no installs)
```

## 1. Test (2 minutes)

1. Open https://web.whatsapp.com in your logged-in browser and wait until chats have loaded.
2. Press F12 → **Console**. Chrome may ask you to type `allow pasting` first.
3. Open `browser/probe.js`, set `ONLY` to the number of a customer you **know** came from an ad
   (e.g. `'8801712345678'`), paste the whole file into the console, and press Enter.
4. Check the output:
   - `modules:` lines should all say `true`.
   - The table should list fields like `ctwaContext...sourceUrl`, `sourceId`, `ctwaClid`. This is the ad data.

If any module says `false` or no ad fields show for a known ad chat, **stop and share the console output**.
WhatsApp renames its internal code from time to time and the scripts may need adjusting.

## 2. Export

1. Paste `browser/export.js` into the same console. It loads each chat back to its first message,
   where the ad info is attached, and then downloads `wa_contacts_<date>_<range>.csv` + `.json`.
2. Lots of chats (over ~1,000)? Run in batches so the tab doesn't run out of memory: set `LIMIT = 500`, run,
   reload the page, then set `OFFSET = 500`, and so on.
3. To stop early and still get a file: `window.__waExportStop = true`.
4. Keep the phone online and connected. Older history is fetched from it, the same way scrolling up in a chat does.

The final console line summarises the run: how many contacts came from ads, how many have hidden numbers, and how many chats
didn't reach their first message (raise `MAX_PAGES_PER_CHAT` and re-run if that number is high).

### CSV columns

| column | meaning |
|---|---|
| `phone` | international number, digits only. Empty when the customer's number is hidden |
| `lid` | WhatsApp privacy ID. The only identifier when the number is hidden |
| `push_name` / `saved_name` | name the customer set / name you saved them as |
| `verified_name`, `is_business` | set when the customer is a WhatsApp Business account |
| `first_msg_at`, `last_msg_at` | first message loaded / last activity (UTC) |
| `history_complete` | 1 = reached the very first message, so `from_ad = 0` is reliable |
| `from_ad`, `ad_title`, `ad_body`, `ad_url`, `ad_id`, `ad_source_type` | Click-to-WhatsApp ad they replied to |
| `ctwa_clid` | Meta click ID (for Conversions API attribution) |
| `ad_raw` | full ad object as JSON, in case a field you need isn't split out |

To get the ad or campaign name, match `ad_id` against the **Ad ID** column in Ads Manager (Reports → add "Ad ID").

## 3. Customer database

```bash
python3 customers.py import ~/Downloads/wa_contacts_*.csv   # re-importing is safe, duplicates merge
python3 customers.py stats                                  # totals + top ads
python3 customers.py check 8801712345678                    # prints EXISTS/NEW; exit code 0 = exists, 1 = new
python3 customers.py add --phone 8801712345678 --name Rahim --ad-id 1202...   # only inserts if new
python3 customers.py export customers.csv
```

Customers are matched by phone, or by LID when the number is hidden. Always use international format
(`8801…`, not `01…`). `check` and `add` exit codes make them easy to call from another system or script.

## Limits

- **Hidden numbers can't be recovered.** You get the LID and name only.
- **No ad info** for customers who messaged you directly, chats you deleted, or history your phone no longer has.
- Facebook profiles aren't linked to WhatsApp chats. The ad ID is the closest link to Facebook.
