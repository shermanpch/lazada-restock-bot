#!/usr/bin/env node
// Watches one or more products and, the moment a SKU is back in stock, goes straight to checkout
// via Buy Now. It stops on the checkout page for you to place the order, unless --place-order.
//
// Usage:
//   node watch.mjs <product> [<product> ...] [--interval 1] [--window 59-20 | all] [--qty 1]
//                  [--simulate-order | --place-order] [--check]
//
//   A product is a name from products.yaml (next to this script), or a product URL. Names can also
//   be joined with "+": "node watch.mjs bundle etb" and "node watch.mjs bundle+etb" are the same.
//   Each product gets its own tab in the same Chrome window, and all are watched at once.
//
//   --interval N      seconds between stock checks in each tab, varied like a person's (mostly
//                     0.7-1.4x, sometimes about half or double), and each minute brisker or
//                     lazier (0.75-1.35x). Default 1.
//                     Decimals allowed; 0 means back to back (a check takes ~0.2-0.7 s).
//   --window S-E      only check from second S of each minute to second E, wrapping past :00, so
//                     59-30 checks from 12:59:59 to 1:00:30, then 1:00:59 to 1:01:30, and so on.
//                     Each minute the window is narrowed a little at random: it opens within a
//                     second after S and closes somewhere in the last 40% of the range.
//                     Default 59-20; "all" checks all the time.
//   --qty N           how many to buy. Default 1.
//   --simulate-order  on checkout, find the Place Order button and click it exactly as
//                     --place-order would, but stop the click before the page sees it (and block
//                     the order request too), then log what was found: total, quantity, warnings.
//   --place-order     on checkout, click Place Order and then the payment page's Pay button, until
//                     the order shows as placed. This spends money. It never types anything: if a
//                     page asks for a security or one-time code, or anything looks off, it stops
//                     and you finish the order yourself.
//   --check           print the current stock state of each product once and exit.
//
// Each run also writes its log lines to logs/<start time>.log, one file per run.
//
// Every CAPTCHA makes the normal pace 1.5x slower, and each one is followed
// by a temporary 2x backoff that eases off after 60 clean checks. Two CAPTCHAs within 5 min pause
// all checks for 10 min. The tabs share one login, so a CAPTCHA in any tab pauses and slows them all.
// A CAPTCHA on the first page load is waited out before watching starts and doesn't count.
//
// To look like one person rather than a script, the tabs take turns checking, and while watching
// there is idle mouse movement, scrolling and the odd click on an empty spot in one tab at a time.
// It all stops while a CAPTCHA is up and in a tab once it heads to checkout.
//
// Runs real Chrome with its own profile in ./.chrome-profile, so log in once in the window it opens.
// Chrome stays open when the script stops (Ctrl+C), and the next run attaches to it and reuses its
// tabs without reloading them. Quit Chrome yourself when you are done.

import { chromium } from "playwright";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import YAML from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTS_FILE = path.join(scriptDir, "products.yaml");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const check = args.includes("--check");
const intervalIdx = args.indexOf("--interval");
const intervalSec = intervalIdx >= 0 ? Number(args[intervalIdx + 1]) : 1;
const windowIdx = args.indexOf("--window");
const qtyIdx = args.indexOf("--qty");
const qty = qtyIdx >= 0 ? Number(args[qtyIdx + 1]) : 1;
const simulateOrder = args.includes("--simulate-order");
const placeOrderFlag = args.includes("--place-order");
const windowArg = windowIdx >= 0 ? args[windowIdx + 1] : "59-20";
const useWindow = windowArg !== "all";
const [, winStart, winEnd] = (
  windowArg?.match(/^(\d{1,2})-(\d{1,2})$/) ?? []
).map(Number);
// Two CAPTCHAs within this window trigger a cooldown with no checks.
const CHALLENGE_WINDOW_MS = 5 * 60000;
const COOLDOWN_MS = 10 * 60000;

// Product URLs end in "-i<itemId>-s<skuId>.html"; both go into the Buy Now request.
const PRODUCT_RE = /-i(\d+)-s(\d+)\.html/;
const isProductUrl = (u) =>
  typeof u === "string" &&
  URL.canParse(u) &&
  new URL(u).pathname.startsWith("/products/") &&
  PRODUCT_RE.test(u);
const badWindow =
  useWindow && !(winStart <= 59 && winEnd <= 59 && winStart !== winEnd);

// Every argument that isn't a flag or a flag's value is a product: a URL, or one or more
// "+"-joined names from products.yaml.
const flagValues = new Set(
  [intervalIdx, windowIdx, qtyIdx].filter((i) => i >= 0).map((i) => i + 1),
);
const productArgs = args
  .filter((a, i) => !a.startsWith("--") && !flagValues.has(i))
  .flatMap((a) => (a.startsWith("http") ? [a] : a.split("+").filter(Boolean)));

function readProductsFile() {
  let doc;
  try {
    doc = YAML.parse(readFileSync(PRODUCTS_FILE, "utf8")) ?? {};
  } catch (e) {
    fail(`Could not read ${PRODUCTS_FILE}: ${e.message.split("\n")[0]}`);
  }
  if (typeof doc !== "object" || Array.isArray(doc))
    fail(`${PRODUCTS_FILE} should be "name: link" lines`);
  return doc;
}

// { name, url } per product; name is null for a URL given on the command line. The same URL twice
// (by name or not) is watched once.
const named = productArgs.some((p) => !p.startsWith("http"))
  ? readProductsFile()
  : {};
const products = [
  ...new Map(
    productArgs.map((p) => {
      if (p.startsWith("http")) return [p, { name: null, url: p }];
      if (!Object.hasOwn(named, p))
        fail(
          `"${p}" is not in products.yaml. Names there: ${Object.keys(named).join(", ") || "none"}`,
        );
      const url = named[p];
      if (!isProductUrl(url))
        fail(
          `products.yaml: "${p}" needs a product link ending in -i<item>-s<sku>.html${url ? ` (it has ${url})` : ""}`,
        );
      return [url, { name: p, url }];
    }),
  ).values(),
];

if (
  !products.length ||
  !products.every((p) => isProductUrl(p.url)) ||
  !(intervalSec >= 0) ||
  !(Number.isInteger(qty) && qty >= 1) ||
  badWindow
) {
  fail(
    "Usage: node watch.mjs <name from products.yaml | product url ending in -i<item>-s<sku>.html> [...] [--interval 1] [--window 59-20 | all] [--qty 1] [--simulate-order | --place-order] [--check]",
  );
}

const profileDir = path.join(scriptDir, ".chrome-profile");
const CAPTCHA_SELECTOR =
  '#baxia-dialog-content, .baxia-dialog, iframe[src*="punish"]';
// spm the real Buy Now button appends to the checkout URL.
const BUY_NOW_SPM = "spm=a2o42.pdp_revamp.main_page.bottom_bar_main_button";

// Each run also writes its log lines to its own file, logs/<local start time>.log, e.g.
// logs/2026-10-09_22-15-03.log; earlier runs' files are left as they are.
const runLog = path.join(
  scriptDir,
  "logs",
  `${new Date().toLocaleString("sv-SE").replace(" ", "_").replaceAll(":", "-")}.log`,
);
mkdirSync(path.dirname(runLog), { recursive: true });
const log = (...m) => {
  const time = new Date().toLocaleTimeString();
  console.log(time, ...m);
  appendFileSync(
    runLog,
    [time, ...m.map((x) => (typeof x === "string" ? x : inspect(x)))].join(" ") + "\n",
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// macOS notification + sound; elsewhere just the terminal bell. Callbacks swallow errors so a
// missing command can't crash the watcher at the moment it matters.
function notify(message) {
  process.stdout.write("\x07");
  if (process.platform !== "darwin") return;
  execFile(
    "osascript",
    ["-e", `display notification "${message}" with title "Restock watcher"`],
    () => {},
  );
  for (let i = 0; i < 3; i++)
    setTimeout(
      () => execFile("afplay", ["/System/Library/Sounds/Glass.aiff"], () => {}),
      i * 700,
    );
}

// One watched product. Checkout and login are sibling subdomains of the product page's site.
// With more than one product, log lines and notifications are tagged with the product's name from
// products.yaml, or its position on the command line for a plain URL: [bundle], [2], ...
const targets = products.map(({ name, url }, i) => {
  const [, itemId, skuId] = url.match(PRODUCT_RE);
  const site = new URL(url).hostname.replace(/^(www|m)\./, "");
  const tag = products.length > 1 ? `[${name ?? i + 1}]` : "";
  return {
    url,
    itemId,
    skuId,
    site,
    checkoutHost: `checkout.${site}`,
    loginUrl: `https://member.${site}/user/login?redirect=${encodeURIComponent(url)}`,
    log: (...m) => (tag ? log(tag, ...m) : log(...m)),
    notify: (m) => notify(tag ? `${tag} ${m}` : m),
    page: null,
    stock: null,
    watching: true,
    mouse: null,
  };
});

// Each minute's --window is a fresh random slice of S-E, shared by all tabs, so checks don't
// start and stop on the same second every minute. It opens within the first second after S (so
// 59-20 always covers :00) and closes anywhere in the last 40% of the range.
// Seconds-in-minute is the same in UTC and local time, so Date.now() works directly.
const winLen = ((winEnd - winStart + 60) % 60) * 1000;
let win = null;

// The window for the first occurrence of S-E that hasn't ended by `after`, as absolute times.
function pickWindow(after) {
  let open = after - (after % 60000) + winStart * 1000 - 60000;
  while (open + winLen <= after) open += 60000;
  return {
    start: open + rand(0, Math.min(1000, winLen * 0.4)),
    end: open + winLen - rand(0, winLen * 0.4),
    rangeEnd: open + winLen,
  };
}

// ms until the next --window opens, or 0 while inside one (or with --window all).
function msUntilWindow() {
  if (!useWindow) return 0;
  const now = Date.now();
  // Once a window closes, move on to the next minute's, never reopen this one.
  while (!win || now >= win.end)
    win = pickWindow(win ? Math.max(now, win.rangeEnd) : now);
  return Math.max(0, win.start - now);
}

// --- Human-like idle activity ---
// One simulated person idling on the watcher tabs: mostly moving the mouse, sometimes scrolling,
// now and then clicking an empty spot, with pauses like someone reading. It runs beside the stock
// checks so it never slows them, works in one tab at a time (switching now and then), and keeps
// still while a CAPTCHA is up so it can't get in the way of you solving it.

const rand = (min, max) => min + Math.random() * (max - min);
// A tab can be acted on while it is still being watched, no CAPTCHA is up, and it is open.
const canAct = (t) => t.watching && !pace.hold && !t.page.isClosed();

// Skipped when clicking: controls, images (product gallery, review photos), the reviews section and
// the site's overlay widget. Click handlers added by the page's JS don't show as attributes, but
// clickable things set cursor: pointer, which children inherit, so that is checked too.
const UNSAFE_SELECTOR =
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [onclick], form, iframe, canvas, img, picture, video, svg, [style*="background-image"], [class*="review"], [class*="gallery"], .J_MIDDLEWARE_FRAME_WIDGET';

// A random viewport point (60 px in from the edges) that is safe to click, or null. With `at`,
// checks that point instead and returns it if still safe.
const safeSpot = (page, at = null) =>
  page.evaluate(
    ({ sel, at }) => {
      const safe = (x, y) => {
        const el = document.elementFromPoint(x, y);
        return !!el && !el.closest(sel) && getComputedStyle(el).cursor !== "pointer";
      };
      if (at) return safe(at.x, at.y) ? at : null;
      for (let i = 0; i < 10; i++) {
        const x = Math.floor(Math.random() * (innerWidth - 120)) + 60;
        const y = Math.floor(Math.random() * (innerHeight - 120)) + 60;
        if (safe(x, y)) return { x, y };
      }
      return null;
    },
    { sel: UNSAFE_SELECTOR, at },
  );

// Moves the mouse to `to` (default: a random safe spot) along a curved path that speeds up then
// slows down, as a hand does, instead of jumping there. Returns where it stopped, or null if it
// was cut short. The mouse starts at the top-left corner, where Playwright puts it.
async function humanMove(t, to = null) {
  to ??= await safeSpot(t.page);
  if (!to) return null;
  const from = t.mouse ?? { x: 0, y: 0 };
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  // Two control points pushed off the straight line, so the path bows a little.
  const bow = () => (Math.random() - 0.5) * Math.min(dist, 300) * 0.4;
  const along = (f) => ({
    x: from.x + (to.x - from.x) * f + bow(),
    y: from.y + (to.y - from.y) * f + bow(),
  });
  const c1 = along(0.3),
    c2 = along(0.7);
  // Longer moves take longer, but not proportionally: about 0.3-0.9 s across a screen.
  const ms = rand(150, 300) + dist * rand(0.2, 0.5);
  const steps = Math.max(6, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    if (!canAct(t)) return null;
    const s = i / steps;
    const e = s < 0.5 ? 2 * s * s : 1 - (2 - 2 * s) ** 2 / 2; // ease in-out
    const u = 1 - e;
    const point = (k) =>
      u ** 3 * from[k] + 3 * u * u * e * c1[k] + 3 * u * e * e * c2[k] + e ** 3 * to[k];
    t.mouse = { x: Math.max(0, point("x")), y: Math.max(0, point("y")) };
    await t.page.mouse.move(t.mouse.x, t.mouse.y);
    await sleep(rand(6, 12)); // plus the move itself, about one event per frame
  }
  return to;
}

// A trackpad-style flick: a burst of wheel events that starts strong and dies away like momentum
// scrolling. Heads down the page more often near the top and back up more often near the bottom.
async function humanScroll(t) {
  if (!t.mouse) await humanMove(t);
  const { y, max } = await t.page.evaluate(() => ({
    y: scrollY,
    max: document.scrollingElement.scrollHeight - innerHeight,
  }));
  if (max <= 0) return;
  const down =
    y <= 0 ||
    (y < max && Math.random() < Math.min(0.85, Math.max(0.15, 1 - y / max)));
  const decay = rand(0.82, 0.9);
  // The deltas shrink geometrically, so the total distance is the first delta / (1 - decay).
  let delta = rand(150, 600) * (1 - decay);
  while (delta >= 1) {
    if (!canAct(t)) return;
    await t.page.mouse.wheel(0, Math.round(down ? delta : -delta));
    await sleep(rand(14, 20));
    delta *= decay;
  }
}

// Moves to a random empty spot, pauses, and clicks with a short press. The spot is checked again on
// arrival, since the page may have scrolled or shifted under the mouse on the way.
async function humanClick(t) {
  const to = await humanMove(t);
  if (!to) return;
  await sleep(rand(80, 300));
  if (!canAct(t) || !(await safeSpot(t.page, to))) return;
  await t.page.mouse.click(to.x, to.y, { delay: rand(50, 130) });
}

// Runs until no tab is being watched any more.
async function fidget() {
  let t = null;
  for (;;) {
    const live = targets.filter((o) => o.watching && !o.page.isClosed());
    if (!live.length) return;
    if (!live.includes(t) || Math.random() < 0.1)
      t = live[Math.floor(Math.random() * live.length)];
    // Mostly short gaps, sometimes a long one, like stopping to read.
    await sleep(Math.random() < 0.15 ? rand(8000, 25000) : rand(700, 3500));
    if (pace.hold) {
      await pace.hold.catch(() => {});
      continue;
    }
    // Also keep still while a CAPTCHA is on screen that no stock check has run into yet. Only the
    // tab in front is acted on, as only that one is in view; another is picked next time.
    if (
      !canAct(t) ||
      (await captchaShown(t.page)) ||
      !(await t.page
        .evaluate(() => document.visibilityState === "visible")
        .catch(() => false))
    ) {
      t = null;
      continue;
    }
    const r = Math.random();
    try {
      if (r < 0.3) await humanMove(t);
      else if (r < 0.5)
        // Small drift near where the mouse already is.
        await humanMove(t, t.mouse && {
          x: Math.max(0, t.mouse.x + rand(-40, 40)),
          y: Math.max(0, t.mouse.y + rand(-40, 40)),
        });
      else if (r < 0.85) await humanScroll(t);
      else await humanClick(t);
    } catch {
      // The page navigated (reload, checkout) or the tab closed mid-action; just carry on.
    }
  }
}

async function load(t) {
  const t0 = Date.now();
  // A navigation can get aborted (e.g. by a redirect or a restored tab); retry a couple of times.
  for (let attempt = 1; ; attempt++) {
    try {
      await t.page.goto(t.url, { waitUntil: "domcontentloaded" });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      t.log(`Page load failed (${e.message.split("\n")[0]}); retrying`);
      await sleep(1000);
    }
  }
  const htmlMs = Date.now() - t0;
  await t.page
    .waitForFunction(() => window.Mtop?.default?.request, null, {
      timeout: 15000,
    })
    .catch(() => {});
  return { htmlMs, readyMs: Date.now() - t0 };
}

// load() for use mid-watch: never gives up, so a network drop pauses the watch instead of ending it.
// Only a closed tab ends it.
async function reload(t) {
  for (;;) {
    try {
      return await load(t);
    } catch (e) {
      if (t.page.isClosed()) throw e;
      t.log(
        `Could not load the product page (${e.message.split("\n")[0]}); trying again in 10 s`,
      );
      await sleep(10000);
    }
  }
}

// Makes the same stock call the product page makes after loading
// (params built exactly as the page's fetchData does),
// through the page's own request client, so there is no reload. ~250-400 ms.
function checkStock(t) {
  return t.page
    .evaluate(
      ({ url, skuId }) => {
        if (!window.Mtop?.default?.request)
          return { ok: false, ret: ["NO_CLIENT"] };
        const u = new URL(url);
        const cookieParams = document.cookie.split("; ").reduce((obj, item) => {
          const [k, v] = item.split("=");
          obj[k] = v;
          return obj;
        }, {});
        const t0 = performance.now();
        const call = new Promise((resolve) =>
          window.Mtop.default.request(
            {
              data: {
                deviceType: "pc",
                path: u.href,
                uri: (u.pathname.match(/\/([\w-]+)\.html/) || [])[1] || "",
                headerParams: JSON.stringify({
                  "user-agent": navigator.userAgent,
                }),
                cookieParams: JSON.stringify(cookieParams),
                requestParams: JSON.stringify(
                  Object.fromEntries(u.searchParams),
                ),
              },
              type: "POST",
              v: "1.0",
              needLogin: false,
              api: "mtop.global.detail.web.getDetailInfo",
            },
            (res) => {
              try {
                const mod = JSON.parse(res.data.module);
                const sku = mod.skuInfos?.[skuId];
                const buyNow = sku?.operations?.find(
                  (o) => o.type === "buyNow",
                );
                const maxQty = sku?.quantity?.limit?.max;
                resolve({
                  ok: true,
                  ms: Math.round(performance.now() - t0),
                  loggedIn: !!mod.user?.login,
                  title: mod.product?.title,
                  options: (sku?.operations || []).map(
                    (o) => o.text + (o.disable ? " (disabled)" : ""),
                  ),
                  maxQty,
                  buyNowUrl: buyNow?.url,
                  inStock: !!buyNow && !buyNow.disable && maxQty !== 0,
                });
              } catch {
                resolve({ ok: false, ret: res?.ret || ["BAD_RESPONSE"] });
              }
            },
            (err) => resolve({ ok: false, ret: err?.ret || ["UNKNOWN"] }),
          ),
        );
        const timeout = new Promise((resolve) =>
          setTimeout(() => resolve({ ok: false, ret: ["TIMEOUT"] }), 10000),
        );
        return Promise.race([call, timeout]);
      },
      { url: t.url, skuId: t.skuId },
    )
    .catch(() => ({ ok: false, ret: ["NO_CLIENT"] }));
}

const isChallenge = (ret) => ret.some((r) => /RGV587|USER_VALIDATE/.test(r));
const captchaShown = (page) =>
  page
    .evaluate(
      (sel) =>
        !!document.querySelector(sel) || location.pathname.includes("punish"),
      CAPTCHA_SELECTOR,
    )
    .catch(() => false);

async function waitOutCaptcha(t) {
  t.notify("The site is showing a CAPTCHA - solve it in the window");
  t.log(
    "The site challenged the stock check. If a slider shows in this tab, solve it; watching resumes after.",
  );
  await t.page.bringToFront().catch(() => {});
  await sleep(1500);
  if (!(await captchaShown(t.page))) {
    // Nothing on screen for our call; reload so the page's own request can surface the slider.
    await reload(t);
    await sleep(2000);
  }
  while (await captchaShown(t.page)) await sleep(1000);
}

// Pace is shared by all tabs: they use one login from one IP, so the site sees their checks as one
// stream. base is the normal pace; current is the pace right now (higher while backing off).
// hold is set while a CAPTCHA (and any cooldown after it) is being waited out; no tab checks then.
const pace = {
  base: intervalSec,
  current: intervalSec,
  cleanChecks: 0,
  recentChallenges: [],
  hold: null,
};

// The gap between checks in a tab: centred on the pace but uneven like a person's, mostly
// 0.7-1.4x and now and then about half or double (a log-normal spread instead of an even one).
function humanGap(paceSec) {
  const gauss =
    Math.sqrt(-2 * Math.log(1 - Math.random())) *
    Math.cos(2 * Math.PI * Math.random());
  return (
    paceSec *
    1000 *
    paceDrift() *
    Math.min(2.5, Math.max(0.4, Math.exp(0.35 * gauss)))
  );
}

// A person isn't equally brisk all the time: each --window (or, with --window all, every 40-80 s)
// gets its own pace of 0.75-1.35x, so some minutes are quick and some lazy.
let drift = { factor: 1, until: 0, win: undefined };
function paceDrift() {
  const now = Date.now();
  if (useWindow ? drift.win !== win : now >= drift.until)
    drift = { factor: rand(0.75, 1.35), until: now + rand(40000, 80000), win };
  return drift.factor;
}

// Tabs take turns, as one person refreshing several tabs would: no two checks start within
// 0.2-0.4 s of each other, even when all tabs wake together (start of a --window, end of a hold).
let lastCheckAt = 0;
async function takeTurn() {
  let wait;
  while ((wait = lastCheckAt + rand(200, 400) - Date.now()) > 0)
    await sleep(wait);
  lastCheckAt = Date.now();
}

// A tab challenged while another tab is already waiting one out joins that wait; if its own page
// still shows a slider afterwards, its next check fails and it starts a wait of its own.
function handleChallenge(t) {
  pace.hold ??= (async () => {
    pace.base = Math.min(Math.max(pace.base * 1.5, 0.3), 30);
    await waitOutCaptcha(t);
    // Repeated CAPTCHAs mean the site has flagged this browser for now: further checks only earn more
    // sliders and extend the flag, so stop checking for a while instead of pushing on.
    const now = Date.now();
    pace.recentChallenges = pace.recentChallenges
      .filter((c) => now - c < CHALLENGE_WINDOW_MS)
      .concat(now);
    if (pace.recentChallenges.length >= 2) {
      notify("Repeated CAPTCHAs - pausing checks for 10 min");
      log(
        `${pace.recentChallenges.length} CAPTCHAs within 5 min: the site has flagged this browser for now. Pausing checks for ${COOLDOWN_MS / 60000} min.`,
      );
      await sleep(COOLDOWN_MS);
      pace.recentChallenges = [];
      log("Cooldown over; resuming");
    }
    pace.current = Math.min(Math.max(pace.base * 2, 1), 30);
    pace.cleanChecks = 0;
    log(
      `Backing off to every ~${pace.current}s for 60 clean checks, then every ~${pace.base}s`,
    );
  })().finally(() => {
    pace.hold = null;
  });
  return pace.hold;
}

// Submits the page's Buy Now form directly: a POST of buyParams to checkout, the same request the
// Buy Now button sends. The form's own buyParams has quantity 0 while sold out, so set it here.
// Returns { responseMs, shownMs } on reaching checkout, or null.
async function buyNow(t, buyNowUrl) {
  if (!buyNowUrl) throw new Error("the stock check returned no Buy Now URL");
  const { page } = t;
  const t0 = Date.now();
  const action =
    buyNowUrl + (buyNowUrl.includes("?") ? "&" : "?") + BUY_NOW_SPM;
  const items = [
    { itemId: t.itemId, skuId: t.skuId, quantity: qty, attributes: null },
  ];
  // Resolves when the first document off the product page commits, i.e. the server has answered,
  // so a submit that bounces elsewhere (cart, login) falls back right away instead of after a timeout.
  const navigated = page
    .waitForEvent("framenavigated", {
      predicate: (f) =>
        f === page.mainFrame() && !f.url().includes("/products/"),
      timeout: 10000,
    })
    .then(
      () => Date.now() - t0,
      () => null,
    );
  await page.evaluate(
    ({ action, items }) => {
      let input = document.querySelector('form input[name="buyParams"]');
      if (!input) {
        const form = document.createElement("form");
        form.method = "post";
        input = document.createElement("input");
        input.type = "hidden";
        input.name = "buyParams";
        form.append(input);
        document.body.append(form);
      }
      input.value = JSON.stringify({ items });
      input.form.action = action;
      setTimeout(() => input.form.submit(), 0);
    },
    { action, items },
  );
  const responseMs = await navigated;
  if (responseMs === null || new URL(page.url()).hostname !== t.checkoutHost)
    return null;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  return { responseMs, shownMs: Date.now() - t0 };
}

async function clickBuyNowButton(t) {
  await load(t);
  await t.page
    .getByRole("button", { name: "Buy Now", exact: true })
    .first()
    .click({ timeout: 10000 });
  return t.page
    .waitForURL((u) => u.hostname === t.checkoutHost, { timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
}

// Chrome runs as its own process with a debugging port, and the script attaches to it. Stopping or
// restarting the script leaves Chrome open with its tabs, so a new run picks up where the last one
// left off instead of opening a fresh browser (whose first page load the site usually challenges).
// The first run, or one after you quit Chrome, starts it. The port is only reachable from this Mac.
const CDP_PORT = 9333;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const CHROME_PATH = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
}[process.platform] ?? "google-chrome";
const chromeUp = () =>
  fetch(`${CDP_URL}/json/version`).then(
    (r) => r.ok,
    () => false,
  );

if (!(await chromeUp())) {
  log("Starting Chrome");
  spawn(
    CHROME_PATH,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      // The same cookie storage Playwright used to launch this profile with, so the login saved
      // in it still reads back; without these Chrome can't decrypt it and you'd be logged out.
      "--use-mock-keychain",
      "--password-store=basic",
      // Without automation flags navigator.webdriver is false and there is no "controlled by
      // automated test software" bar, as in everyday Chrome.
      "--disable-blink-features=AutomationControlled",
      // Keep background tabs running at full speed: Chrome otherwise slows their timers to once a
      // minute, which would stall the checks in every tab but the front one.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=IntensiveWakeUpThrottling",
      // Open on a blank tab, which the first product then reuses.
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  ).unref();
  for (let i = 0; !(await chromeUp()); i++) {
    if (i >= 30)
      fail(
        `Chrome did not open its debugging port. If a Chrome window using ${profileDir} is already open (e.g. from an older version of this script), quit it and run again.`,
      );
    await sleep(500);
  }
} else {
  log("Attaching to the Chrome already open");
  // On a Mac, closing the last window leaves Chrome running with none, and attaching then fails
  // ("Browser context management is not supported"). Open a blank window first.
  const open = await fetch(`${CDP_URL}/json/list`).then((r) => r.json());
  if (!open.some((t) => t.type === "page"))
    await fetch(`${CDP_URL}/json/new?about:blank`, { method: "PUT" });
}
const browser = await chromium.connectOverCDP(CDP_URL);
const context = browser.contexts()[0];
// Reuse a tab already on a product's page (left by the last run), else a blank tab, else a new one.
const productTab = (t) =>
  context
    .pages()
    .find((p) => p.url().includes(`-i${t.itemId}-s${t.skuId}`) && !targets.some((o) => o.page === p));
const blankTab = () =>
  context
    .pages()
    .find((p) => /^(about:blank|chrome:\/\/new-?tab)/.test(p.url()) && !targets.some((o) => o.page === p));
for (const t of targets) t.page = productTab(t) ?? null;
for (const t of targets) t.page ??= blankTab() ?? (await context.newPage());
let quitting = false;
// Disconnects and leaves Chrome open; quit Chrome yourself when you are done.
async function quit() {
  quitting = true;
  process.exit(0);
}
process.on("SIGINT", quit);
// Closing a watcher's tab stops watching that product; closing the last one or quitting Chrome ends
// the script cleanly instead of with a stack trace.
browser.on("disconnected", () => {
  if (quitting) return;
  log("Chrome closed; stopping.");
  process.exit(0);
});
for (const t of targets) {
  t.page.on("close", () => {
    if (quitting) return;
    if (targets.every((o) => o.page.isClosed())) {
      log("All watcher tabs closed; stopping.");
      process.exit(0);
    }
    t.log("Tab closed; no longer watching this product.");
  });
}

// If the session expires mid-watch, Buy Now would bounce to the login page at restock time. Open the
// login page in another tab so you can log back in while the watcher tabs keep going. All tabs share
// the login, so there is one login tab per site; it holds a promise so two tabs can't both open one.
const loginTabs = new Map();
async function followLogin(t, loggedIn) {
  const tab = loginTabs.get(t.site);
  if (!loggedIn && !tab) {
    t.notify("Logged out - log in again in the new tab");
    t.log(
      "Logged out. Log in again in the new tab; watching continues in the others.",
    );
    const opening = context.newPage();
    loginTabs.set(t.site, opening);
    await (await opening).goto(t.loginUrl).catch(() => {});
  } else if (loggedIn && tab) {
    t.log("Logged in again");
    loginTabs.delete(t.site);
    await (await tab).close().catch(() => {});
  }
}

// Start-up runs one tab at a time, so a login needed by the first tab covers the rest.
for (const t of targets) {
  // A tab reused from the last run that is still on the product page needs no new page load.
  const reused = await t.page
    .evaluate(() => !!window.Mtop?.default?.request)
    .catch(() => false);
  const ready = reused ? null : await load(t);
  t.stock = await checkStock(t);
  // The site often puts a CAPTCHA over the first page load, holding up the first check. Wait for it
  // here, so it isn't treated as a challenge mid-watch (which would slow the pace).
  if (await captchaShown(t.page)) {
    t.notify("Solve the CAPTCHA in the window to start watching");
    t.log(
      "The site is showing a CAPTCHA. Solve it in this tab; watching starts after.",
    );
    await t.page.bringToFront().catch(() => {});
    while (await captchaShown(t.page)) await sleep(1000);
    t.stock = await checkStock(t);
  }
  t.log(
    `Startup: ${ready ? `product page ready in ${ready.readyMs} ms (HTML ${ready.htmlMs} ms)` : "reusing the open product page"}, first stock check ${t.stock.ms ?? "-"} ms`,
  );
  if (check) {
    t.log(t.stock);
    continue;
  }
  if (t.stock.ok && !t.stock.loggedIn) {
    t.log(
      "Not logged in. Log in in this tab. Watching starts when you are back on a product page",
    );
    t.log(
      "(if the site does not send you back, open the product link again in this tab).",
    );
    await t.page.goto(t.loginUrl);
    await t.page.waitForURL(
      (u) => u.hostname.endsWith(t.site) && u.pathname.startsWith("/products/"),
      { timeout: 0 },
    );
    await reload(t);
    t.stock = await checkStock(t);
  }
}
if (check) await quit();

async function watch(t) {
  const { page } = t;
  let { stock } = t;
  let checks = 0;
  let lastSummary = "";
  let lastLog = 0;
  let checkStarted = Date.now();
  t.log(`Watching: ${stock.title ?? t.url} (sku ${t.skuId})`);

  while (!(stock.ok && stock.inStock)) {
    if (stock.ok) {
      // Log changes, plus a heartbeat every 10 s so it's visibly alive.
      const summary = `Not available (${stock.options.join(", ") || "no options"}, maxQty=${stock.maxQty})`;
      if (summary !== lastSummary || Date.now() - lastLog >= 10000) {
        t.log(
          `${summary} [${checks} checks, pace ~${pace.current}s, last ${stock.ms} ms]`,
        );
        lastLog = Date.now();
      }
      lastSummary = summary;
      await followLogin(t, stock.loggedIn);
    } else if (isChallenge(stock.ret) || (await captchaShown(page))) {
      await handleChallenge(t);
    } else if (stock.ret[0] === "NO_CLIENT") {
      t.log("Product page is not loaded; reloading it");
      await reload(t);
    } else {
      t.log(`Stock check failed (${stock.ret.join(", ")}); retrying`);
    }

    // Pace from the start of the previous check, so --interval is the time between checks,
    // not the gap after one finishes.
    await sleep(
      Math.max(0, humanGap(pace.current) - (Date.now() - checkStarted)),
    );
    // Hold off while any tab is waiting out a CAPTCHA, or outside the --window.
    while (pace.hold || msUntilWindow() > 0) {
      await pace.hold;
      await sleep(msUntilWindow());
    }
    await takeTurn();
    checkStarted = Date.now();
    stock = await checkStock(t);
    checks++;
    // After a CAPTCHA backoff, return to the normal pace once checks run clean again.
    pace.cleanChecks = stock.ok ? pace.cleanChecks + 1 : 0;
    if (pace.current > pace.base && pace.cleanChecks >= 60) {
      pace.current = pace.base;
      pace.cleanChecks = 0;
      log(`No challenges for 60 checks; back to every ~${pace.current}s`);
    }
  }

  // Stop the idle activity in this tab so nothing moves or clicks on the way to checkout.
  t.watching = false;
  t.log(`IN STOCK (maxQty=${stock.maxQty}). Going to checkout via Buy Now`);
  const t0 = Date.now();
  // Any error here must not end the script: fall through to clicking the button instead.
  const direct = await buyNow(t, stock.buyNowUrl).catch((e) => {
    t.log(`Direct Buy Now failed: ${e.message.split("\n")[0]}`);
    return null;
  });
  let reached = !!direct;
  if (direct) {
    t.log(
      `Checkout server responded after ${direct.responseMs} ms; checkout page shown after ${direct.shownMs} ms`,
    );
  } else {
    t.log(
      `Direct Buy Now did not reach checkout (now on ${page.url().split("?")[0]}); falling back to clicking the Buy Now button`,
    );
    reached = await clickBuyNowButton(t).catch(() => false);
  }
  await page.bringToFront();
  t.notify(
    reached
      ? "In stock! On checkout - place your order"
      : "In stock! Buy Now did not reach checkout - check the window",
  );
  t.log(
    reached
      ? `On checkout ${Date.now() - t0} ms after detecting stock. Review and place the order in this tab.`
      : "Could not reach checkout automatically. Check this tab.",
  );
  if (reached && placeOrderFlag) await placeOrder(t);
  else if (reached && simulateOrder) await simulatePlaceOrder(t);
  t.log(
    "Chrome stays open if you stop this script, so you can finish paying either way.",
  );
}

// Buttons that move an order forward on the checkout and payment pages.
const ORDER_BUTTON =
  "^\\s*(place order( now)?|pay now|confirm (order|payment)|proceed to pay(ment)?)\\s*$";
// Text that shows the order went through, e.g. "Thank you for your purchase!".
const ORDER_PLACED =
  "thank you for your (purchase|order)|order (has been )?(placed|confirmed|received)|payment (was )?successful|successfully paid";

// Waits up to `timeout` ms for an order button and describes it, or returns null. With
// `afterClick`, an order confirmation counts too and returns { placed: true }. The button found is
// tagged data-watch-order so it can be clicked by that.
function findOrderButton(page, timeout = 15000, afterClick = false) {
  return page
    .waitForFunction(
      ({ buttonSrc, placedSrc, afterClick }) => {
        if (!document.body) return null;
        // Only checked after a click: the checkout page's own scripts mention these words.
        if (afterClick && new RegExp(placedSrc, "i").test(document.body.innerText))
          return { placed: true };
        // This runs every frame while the page renders, so it finds the label through XPath on
        // text nodes, which (unlike innerText) doesn't make Chrome lay the page out.
        const up = "translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')";
        const hits = document.evaluate(
          `//body//*[not(self::script or self::style)]/text()[contains(${up}, 'PLACE ORDER') or contains(${up}, 'PAY NOW') or contains(${up}, 'CONFIRM') or contains(${up}, 'PROCEED TO PAY')]`,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        const re = new RegExp(buttonSrc, "i");
        let label = null;
        for (let i = 0; i < hits.snapshotLength && !label; i++) {
          const el = hits.snapshotItem(i).parentElement;
          if (re.test(el.textContent)) label = el;
        }
        if (!label) return null;
        const button = label.closest('button, a, [role="button"]') ?? label;
        document
          .querySelectorAll("[data-watch-order]")
          .forEach((e) => e.removeAttribute("data-watch-order"));
        button.setAttribute("data-watch-order", "1");
        const visible = (e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden";
        };
        const cs = getComputedStyle(button);
        const text = document.body.innerText;
        return {
          placed: false,
          label: label.textContent.trim(),
          tag: button.tagName.toLowerCase(),
          visible: visible(button),
          disabled:
            !!button.disabled ||
            button.getAttribute("aria-disabled") === "true" ||
            cs.pointerEvents === "none" ||
            /disabled/i.test(button.className),
          total: (text.match(/Total:?\s*(\S+)/) || [])[1],
          qty: (text.match(/Qty:\s*\d+/g) || []).join(", "),
          warnings:
            text.match(
              /[^\n]*(insufficient|minimum purchase|out of stock|not available|exceed)[^\n]*/gi,
            ) || [],
          // Empty fields asking for a card security code or one-time code: those are for you.
          needsInput: [...document.querySelectorAll("input")]
            .filter(
              (i) =>
                visible(i) &&
                !i.value &&
                /cvv|cvc|security|otp|one.?time|verification/i.test(
                  `${i.name} ${i.id} ${i.placeholder} ${i.getAttribute("aria-label") ?? ""}`,
                ),
            )
            .map((i) => i.placeholder || i.name || i.id),
        };
      },
      { buttonSrc: ORDER_BUTTON, placedSrc: ORDER_PLACED, afterClick },
      { timeout },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
}

const describe = (b) =>
  `"${b.label}" (${b.tag}, ${b.visible ? "visible" : "hidden"}, ${b.disabled ? "disabled" : "enabled"}). Total ${b.total ?? "?"}, ${b.qty || "qty not shown"}`;

// Clicks the tagged order button straight away at its centre. Playwright's usual click first waits
// for the button to hold still and checks nothing covers it, which took 80-370 ms on checkout
// while the page finished loading; findOrderButton has already checked it is visible and enabled.
// The page can still shift while it loads, so the centre is taken only once the button is the
// thing actually there, checked again each frame for up to ~0.5 s, and clicked straight after.
async function fastClick(page) {
  for (let i = 0; i < 30; i++) {
    const at = await page.evaluate(() => {
      const button = document.querySelector('[data-watch-order="1"]');
      if (!button) return null;
      let r = button.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
        button.scrollIntoView({ block: "center" });
        r = button.getBoundingClientRect();
      }
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return button.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    });
    if (at) return page.mouse.click(at.x, at.y);
    await sleep(16);
  }
  throw new Error("the order button never settled under the mouse");
}

// --simulate-order: does exactly what --place-order does on checkout - finds the Place Order button
// and clicks it the same way - but the click is stopped before the page sees it, and the order
// request is blocked as well in case anything gets through, so nothing is ordered.
async function simulatePlaceOrder(t) {
  const { page } = t;
  const t0 = Date.now();
  const b = await findOrderButton(page);
  if (!b) {
    t.log("SIMULATED ORDER: no Place Order button found on the checkout page within 15 s.");
    return;
  }
  const foundMs = Date.now() - t0;
  t.log(`SIMULATED ORDER: found ${describe(b)} ${foundMs} ms after the checkout page showed.`);
  for (const w of b.warnings) t.log(`SIMULATED ORDER: page warning: ${w.trim()}`);
  if (!b.visible || b.disabled || b.warnings.length) {
    t.log("SIMULATED ORDER: not ready - a real click would likely fail. Not clicked.");
    return;
  }
  const blocked = [];
  await page.route(/\/placeOrder/, (route) => {
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.evaluate(() => {
    window.__watchSimClick = null;
    addEventListener(
      "click",
      (e) => {
        window.__watchSimClick = {
          onButton: !!e.target.closest('[data-watch-order="1"]'),
          what: (e.target.textContent || "").trim().slice(0, 40),
        };
        e.stopImmediatePropagation();
        e.preventDefault();
      },
      { capture: true, once: true },
    );
  });
  await fastClick(page);
  const hit = await page.evaluate(() => window.__watchSimClick);
  t.log(
    hit?.onButton
      ? `SIMULATED ORDER: the click landed on the button ${Date.now() - t0} ms after the checkout page showed (stopped before the page saw it).`
      : `SIMULATED ORDER: the click MISSED the button (landed on "${hit?.what ?? "nothing"}").`,
  );
  await sleep(1500);
  t.log(
    blocked.length
      ? "SIMULATED ORDER: an order request got through to the network layer and was blocked. Nothing was ordered."
      : "SIMULATED ORDER: no order request was sent. Nothing was ordered.",
  );
}

// --place-order: clicks through checkout and payment (Place Order, then Pay Now and the like) until
// the order shows as placed. It never types anything, and hands over to you when a page asks for a
// security or one-time code, shows a warning, has no order button, or doesn't move on after a
// click. It never clicks twice on the same page, so a slow page can't cause a second order.
// Returns true once the order shows as placed.
async function placeOrder(t) {
  const { page } = t;
  const t0 = Date.now();
  const clickedOn = new Set();
  const handOver = (why) => {
    t.log(`ORDER: ${why} Finish the order yourself in this tab.`);
    t.notify("Finish the order in the window");
    return false;
  };
  for (let step = 1; ; step++) {
    const url = page.url().split("?")[0];
    // After a click, payment can take several seconds (the card check) before the result shows.
    const b = await findOrderButton(page, step === 1 ? 15000 : 30000, step > 1);
    if (b?.placed) {
      t.log(`ORDER PLACED (${Date.now() - t0} ms after reaching checkout).`);
      t.notify("Order placed!");
      return true;
    }
    if (step > 4) return handOver("still no order confirmation after 4 clicks.");
    if (!b) return handOver(`no order or pay button or confirmation on ${url}.`);
    t.log(`ORDER step ${step} on ${url}: found ${describe(b)} (${Date.now() - t0} ms).`);
    if (b.warnings.length)
      return handOver(`the page warns: ${b.warnings.map((w) => w.trim()).join(" | ")}.`);
    if (!b.visible || b.disabled) return handOver("the button is not clickable.");
    if (b.needsInput.length)
      return handOver(`the page asks for: ${b.needsInput.join(", ")}.`);
    if (clickedOn.has(url))
      return handOver("already clicked on this page; not clicking again, to avoid a second order.");
    clickedOn.add(url);

    const before = page.url();
    const moved = page
      .waitForURL((u) => u.href !== before, { timeout: 20000 })
      .then(
        () => true,
        () => false,
      );
    // The page answers a click with a request to its own server (or a new page). If neither comes
    // within 3 s, the fast click missed, and a normal click is tried once while the button is
    // still there and enabled.
    const reacted = () =>
      Promise.race([
        page.waitForRequest(
          (r) => r.method() === "POST" && new URL(r.url()).hostname.endsWith(t.site),
          { timeout: 3000 },
        ),
        page.waitForURL((u) => u.href !== before, { timeout: 3000 }),
      ]).then(
        () => true,
        () => false,
      );
    const reaction = reacted();
    await fastClick(page);
    t.log(`ORDER: clicked "${b.label}" (${Date.now() - t0} ms after reaching checkout).`);
    if (!(await reaction)) {
      const again = await findOrderButton(page, 1000);
      if (!again || again.placed || again.disabled)
        return handOver("the click got no response, and the button has changed; not clicking again.");
      t.log("ORDER: no response to the click within 3 s; clicking once more the normal way.");
      await page.locator('[data-watch-order="1"]').first().click({ timeout: 5000 });
    }
    if (!(await moved))
      return handOver("the page did not move on within 20 s of the click.");
    t.log(`ORDER: now on ${page.url().split("?")[0]} (${Date.now() - t0} ms).`);
  }
}

// Keeps a connection to each checkout server open, so the Buy Now at restock doesn't first spend
// ~100-250 ms looking it up and connecting (the stock checks go to a different server, so nothing
// else keeps it open, and Chrome drops idle connections after a few minutes). One tiny request
// about once a minute is enough. Runs until no tab is being watched.
async function keepCheckoutWarm() {
  for (;;) {
    const live = targets.filter((o) => o.watching && !o.page.isClosed());
    if (!live.length) return;
    for (const host of new Set(live.map((o) => o.checkoutHost)))
      await live
        .find((o) => o.checkoutHost === host)
        .page.evaluate(
          (host) =>
            fetch(`https://${host}/`, {
              method: "HEAD",
              mode: "no-cors",
              credentials: "include",
              cache: "no-store",
            }).catch(() => {}),
          host,
        )
        .catch(() => {});
    await sleep(rand(40000, 70000));
  }
}

const pad = (s) => String(s).padStart(2, "0");
log(
  `Checking every ~${pace.base}s in each of ${targets.length} tab(s)` +
    (useWindow
      ? `, only within :${pad(winStart)} to :${pad(winEnd)} of each minute (varied each minute)`
      : ""),
);
fidget();
keepCheckoutWarm();
// A tab closed mid-watch ends its watcher with an error; that just means it stopped.
await Promise.all(
  targets.map((t) =>
    watch(t).catch((e) => {
      if (!t.page.isClosed()) throw e;
    }),
  ),
);
await new Promise(() => {});
