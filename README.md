# Overdue Street Light Finder

A small web tool for the NYC DOT Manhattan street lighting manager. It reads a 311 export of "Street Light Out" requests, flags every open request that is past the 10-day response target, and lists them oldest first so the weekly review starts with the requests that are stuck.

**Live site:** _add your Vercel link here_

## What it does
- Loads a 311 CSV export (or the built-in sample of 194 requests).
- Applies one rule: an open request older than 10 days (adjustable) is **Overdue**; one within 3 days of the target is **Due soon**.
- Shows a priority list, oldest first, with a review note for each request (for example "Waiting on Con Edison"). Notes are saved in the browser only.
- Compares the old way (a list sorted by date) with the priority list: how many rows a person must read to see every overdue request.
- Sets aside rows with data problems (invalid dates, closed before created, duplicates) instead of guessing.
- Downloads the current list as a CSV file.

## How to use it
1. Open the live site.
2. Click **Try the sample data**, or **Choose CSV file** to load your own 311 export. The file needs the columns Unique Key, Created Date, Closed Date and Status.
3. Check the rule (days) and the "as of" date.
4. Review the Overdue tab, add a note per request, and click **Download this list (CSV)**.

## How to run it locally
No installation is needed. Download the files and open `index.html` in a browser. (The sample-data button needs the site to be served, for example on Vercel; uploading your own CSV works either way.)

## Files
| File | What it is |
|---|---|
| `index.html` | The page layout |
| `style.css` | Colors, spacing and phone layout |
| `app.js` | Reads the CSV, checks data, applies the 10-day rule, sorts, saves notes, exports |
| `data/sample-311-street-light-out-manhattan.csv` | 194 public 311 records (every 3rd request, July 1 to August 30, 2026), reduced to 6 columns |

## Data and privacy
Source: NYC Open Data, 311 Service Requests (DOT, Street Light Out, Manhattan). Public data, no names or addresses. Uploaded files are processed in the browser and are never sent to a server. Review notes are stored only in the user's browser (localStorage).

## Tools used
Built with help from Claude (Anthropic) as an AI coding assistant. Plain HTML, CSS and JavaScript, no libraries. Hosted on GitHub and Vercel (free tiers).

## Known limits
- "Closed" in 311 means the case was closed administratively. It does not prove the light was fixed.
- The 311 data does not say why a request is stuck; the review note is how a person records that.
- Review notes live in one browser. They are not shared between people or devices unless the list is downloaded.
- The tool flags and sorts. It does not assign crews or contact Con Edison.
