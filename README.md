# lazada-restock-bot

Watches Lazada products and, the moment one is back in stock, goes straight to checkout via Buy Now.
By default it stops on the checkout page so you place the order yourself; with `--place-order` it
clicks through to the order confirmation too.

It drives a real Google Chrome window with its own profile, so you log in to Lazada once and it
stays logged in.

> Unofficial. Not affiliated with or endorsed by Lazada. Automating purchases may go against
> Lazada's terms of use and can get an account challenged or restricted. Use it at your own risk.

## Requirements

- Node.js 18.17 or newer
- Google Chrome, installed normally (tested on macOS)

## Setup

```sh
npm install
```

Put the products you want in `products.yaml` as `name: link`. A link is a product page URL ending
in `-i<item>-s<sku>.html`; pick the variant you want on the page first, so the URL has its SKU.

```yaml
bundle: https://www.lazada.sg/products/pdp-i13858018841-s124858765958.html
```

The first run opens Chrome. If you are not logged in, log in there; watching starts once you are
back on the product page.

## Usage

```sh
node watch.mjs <product> [<product> ...] [options]
```

A product is a name from `products.yaml` or a product URL. Several products are watched at once,
each in its own tab: `node watch.mjs bundle etb` (or `bundle+etb`).

| Option | What it does |
| --- | --- |
| `--interval N` | Seconds between stock checks in each tab (default 1), varied a little each time, and each minute a little quicker or slower overall. |
| `--window S-E` | Only check from second S to second E of each minute (default `59-20`, for restocks on the minute). Each minute it opens within a second after S and closes somewhere in the last 40% of the range, so it isn't the same every minute. `--window all` checks all the time. |
| `--qty N` | How many to buy (default 1). |
| `--check` | Print each product's current stock state once and exit. |
| `--simulate-order` | On checkout, find Place Order and click it exactly as `--place-order` would, but stop the click before the page sees it. Nothing is ordered. |
| `--place-order` | On checkout, click Place Order (and the payment page's Pay button) until the order shows as placed. **This spends money.** |

Examples:

```sh
node watch.mjs bundle --check                      # is it in stock right now?
node watch.mjs bundle etb                          # watch two products around each minute mark
node watch.mjs test --qty 6 --simulate-order       # dry run of the whole path on an in-stock item
node watch.mjs bundle --qty 2 --place-order        # buy 2 the moment it restocks
```

To try the whole path without buying, point it at any cheap in-stock product with
`--simulate-order`: it goes to checkout, finds and clicks Place Order with the click stopped, and
logs the total, quantity and any warning on the page.

## How it works

- **Stock checks** make the same product-data request the product page itself makes, through the
  page's own request client, so there is no page reload. A check takes about 0.15-0.4 s.
- **Buy Now** posts the page's own Buy Now form directly, which reaches checkout about 1 s after
  stock is found. If that fails, it clicks the Buy Now button instead.
- **Place Order** (`--place-order`) clicks the button as soon as it is on screen, about 0.1-0.2 s
  after checkout shows, then follows the payment pages. It never types anything: if a page asks for
  a security or one-time code, shows a warning, or doesn't move on, it stops and notifies you to
  finish. It never clicks twice on the same page.
- **CAPTCHAs** are left to you. When one shows, every tab pauses, you get a notification, and
  watching resumes once you have solved it. Each CAPTCHA doubles the time between checks for the next
  60 checks and makes the normal pace 1.5x slower for the rest of the run; two within 5 minutes pause
  checking for 10 minutes. One on the very first page load is waited out before watching starts and
  doesn't count.
- While watching there is idle mouse movement, scrolling and the odd click on an empty spot in the
  tab in front, and the tabs take turns checking.

## Chrome

The script starts Chrome with its own profile in `.chrome-profile/` and a debugging port on
`127.0.0.1:9333`, then attaches to it. Stopping the script (Ctrl+C) leaves Chrome open with its
tabs, and the next run attaches to it again without reloading anything, which also avoids the
CAPTCHA the site tends to show on a fresh browser's first page load. Quit Chrome yourself when you
are done; while it is open, other programs on your computer can control it through that port.

`.chrome-profile/` holds your logged-in Lazada session. It is git-ignored; never share it.

## Logs

Each run writes its log lines to `logs/<start time>.log`, one file per run.

On reaching checkout, the log also records Lazada's answer: whether the order loaded and any
notice on it (such as a stock change), or the error code and message and the text the page shows.
It does the same each time you reload the checkout page.

## License

[MIT](LICENSE)
