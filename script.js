"use strict";

/* ========================================================================
 * Configuration
 * ===================================================================== */
const SHEET_ID = "1FQ28rDCyRW0TiNxrm3rgD8ai2KGUsXAjPieQmI1kKKg";
const XLSX_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}` +
  "/export?format=xlsx";
const EVENTS_URL =
  "https://docs.google.com/spreadsheets/d/e/" +
  "2PACX-1vQILY1iDrb0KsT4w0IvfoWV6g3rsoCgFyjT4ZEzXspYqRjUUQpQ2DaXyK38HbZYFiSDJxAfYZ_9q8SX" +
  "/pub?output=xlsx";
const XLSX_LIBRARY =
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
const PRICE_URL =
  "https://api.coingecko.com/api/v3/coins/zcash/market_chart" +
  "?vs_currency=usd&days=90";

/* Maya liquidity */
const MAYA_ADDRESS = "maya14n4r0uwpp96435llrum2mevsevk5ph0lq0rjem";
const MAYA_POOL = "ZEC.ZEC";
const MIDGARD = "https://midgard.mayachain.info/v2";
const ASSET_DECIMALS = 1e8;
const CACAO_DECIMALS = 1e10; // If CACAO amounts look 100x off, change this.
const MAYA_KEY = "zcg-maya-v2";
const MAYA_TTL = 6 * 60 * 60 * 1000;
const ENTRY_ZEC = 2580.34; // Initial LP deposit: worth exactly $100,000
const ENTRY_USD = 100000;

const EVENTS_KEY = "zcg-events-v1";
const CACHE_TTL = 60 * 60 * 1000;
const PRICE_KEY = "zcg-price-v3";
const DAY = 86400000;
const DAILY_INFLOW_ZEC = 144;
const MINI_COUNT = 5;
const CACHE_KEY = "zcg-dashboard-v10";
const MIN_MONTH = "2021-01"; // no data before this
const recipientView = { range: "all", size: "all" };
const chartRanges = { payout: "12m", approval: "12m" };
const statusLabels = {
  completed: "Completed",
  "in-progress": "In progress",
  waiting: "In review",
  discussion: "Discussion required",
  rejected: "Declined",
};

const sheets = {
  dashboard: "ZCG Dashboard",
  grants: "ZCG Grants",
  tracking: "ZCG All Grants Tracking",
  funds: "ZCG Funds Distribution",
  liquidity: "ZCG Liquidity",
  stipends: "ZCG 2026 Stipend",
  contractors: "ZCG IC Payouts",
  discbudget: "ZCG 2026 Disc. Budget",
};

const SECURITY_SHEET = new RegExp(
  sheets.discbudget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "i"
);
const SECURITY_TEXT = /audit|security|bounty|pentest|vulnerab/i;
const NOTES_TEXT = /meeting notes/i;
const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/* ========================================================================
 * State & helpers
 * ===================================================================== */
let data = null;
let events = null;
let refreshing = null;
let eventsPromise = null;
let libraryPromise = null;
let activePage = "dashboard";
let modalRequest = 0;
let mayaLoading = false;
let pricePromise = null;
const charts = new Map();
const tableStates = new Map();
const renderedPages = new Set();
const recipientSort = { key: "total", dir: -1 };

const $ = (id) => document.getElementById(id);
const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char],
  );
const number = (value) =>
  Number.parseFloat(String(value ?? "").replace(/[$,%\s,]/g, "")) || 0;
const usd = (value) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
const zec = (value) =>
  `${Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })} ZEC`;
const norm = (value) =>
  String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function date(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(+value) ? null : value;
  if (typeof value === "number") {
    const parsed = window.XLSX?.SSF.parse_date_code(value);
    return parsed
      ? new Date(
          parsed.y,
          parsed.m - 1,
          parsed.d,
          parsed.H || 0,
          parsed.M || 0,
          parsed.S || 0,
        )
      : null;
  }
  const result = new Date(value);
  return Number.isNaN(+result) ? null : result;
}

const iso = (value) => date(value)?.toISOString() || null;
const fmtDate = (value) => date(value)?.toLocaleDateString() || "—";
const monthKey = (value) => {
  const d = date(value);
  return d
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    : "";
};

/* Returns every dated Disc. Budget payment. `match` marks the rows that
 * look like security spending (bounties, audits) for the Security page. */
function parseBudgetSheet(workbook) {
  console.group("🔍 Debug: Disc. Budget & Security Audit");
  console.log("All workbook sheet names:", workbook.SheetNames);
  console.log("Using SECURITY_SHEET regex:", SECURITY_SHEET);

  const name = workbook.SheetNames.find((n) => SECURITY_SHEET.test(n));
  if (!name) {
    console.warn("❌ Disc. budget sheet NOT found matching regex! Available tabs:", workbook.SheetNames);
    console.groupEnd();
    return [];
  }
  console.log("✅ Matched Disc. budget sheet:", name);

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
    header: 1,
    raw: true,
    blankrows: true,
    defval: "",
  });
  console.log(`Loaded ${rows.length} total raw rows from sheet.`);

  const headerIndex = rows.findIndex((row) => {
    const cells = row.map(norm);
    return (
      cells.some((c) => /^date|^paid/.test(c)) &&
      cells.some((c) => /usd/.test(c)) &&
      cells.some((c) => /recipient|payee|contractor|name/.test(c))
    );
  });

  if (headerIndex < 0) {
    console.warn("❌ Header row not recognized! Inspecting first 10 rows:", rows.slice(0, 10));
    console.groupEnd();
    return [];
  }

  const headers = rows[headerIndex].map(norm);
  console.log(`✅ Header detected at row index ${headerIndex}:`, headers);

  const find = (pattern, exclude) =>
    headers.findIndex((h) => pattern.test(h) && !(exclude && exclude.test(h)));

  const c = {
    date: find(/^date|^paid/),
    recipient: find(/recipient|payee|contractor|^name/),
    desc: find(/description|purpose|item|memo|notes?|project|title/),
    rate: find(/zec\s*\/\s*usd|rate|price/),
    usd: find(/usd/, /\/|rate|price/),
    zec: find(/^zec/, /\/|rate|price|usd/),
  };

  console.log("Column index mapping:", c);

  const out = [];
  let skippedNoDate = 0;
  let skippedNoUsd = 0;

  rows.slice(headerIndex + 1).forEach((row, i) => {
    // Skip empty lines
    if (!row.some((cell) => cell !== "" && cell != null)) return;

    const text = row.join(" ");
    const description = String((c.desc >= 0 ? row[c.desc] : "") || text).trim();
    const zecAmount = c.zec >= 0 ? number(row[c.zec]) : 0;
    const rate = c.rate >= 0 ? number(row[c.rate]) : 0;
    const parsedDate = c.date >= 0 ? iso(row[c.date]) : null;
    const rawUsd = c.usd >= 0 ? number(row[c.usd]) : 0;
    const computedUsd = rawUsd || zecAmount * rate;
    const matchesSecurity = SECURITY_TEXT.test(text);

    // If it mentions bounty/security, log it immediately so you can see its values!
    if (/bount|audit|secur/i.test(text)) {
      console.log(`🎯 Found security candidate row #${i + headerIndex + 1}:`, {
        rawDate: row[c.date],
        parsedDate,
        description,
        recipient: row[c.recipient],
        usd: computedUsd,
        matchesSecurityText: matchesSecurity,
        fullRow: row,
      });
    }

    if (!parsedDate) {
      if (matchesSecurity) console.warn("⚠️ Security candidate dropped: missing or unparseable Date!", row);
      skippedNoDate++;
      return;
    }

    if (computedUsd <= 0) {
      if (matchesSecurity) console.warn("⚠️ Security candidate dropped: USD amount <= 0!", row);
      skippedNoUsd++;
      return;
    }

    out.push({
      type: securityType(text),
      project: description,
      recipient: c.recipient >= 0 ? String(row[c.recipient] ?? "").trim() : "",
      date: parsedDate,
      usd: computedUsd,
      zec: zecAmount,
      rate,
      match: matchesSecurity,
    });
  });

  const securityMatches = out.filter((r) => r.match);
  console.log(`Summary: ${out.length} valid dated rows, ${securityMatches.length} flagged as security.`);
  console.log("Matched security rows:", securityMatches);
  if (skippedNoDate) console.log(`Skipped ${skippedNoDate} rows missing dates.`);
  if (skippedNoUsd) console.log(`Skipped ${skippedNoUsd} rows with 0 or missing USD.`);
  console.groupEnd();

  return out;
}

function safeURL(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function readCache(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ timestamp: Date.now(), value }),
    );
  } catch {
    // Dashboard still works when storage is blocked or full.
  }
}

function debounce(fn, delay = 160) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = XLSX_LIBRARY;
    script.onload = () => resolve(window.XLSX);
    script.onerror = () => {
      script.remove();
      libraryPromise = null;
      reject(new Error("Could not load spreadsheet reader."));
    };
    document.head.append(script);
  });
  return libraryPromise;
}

function yearStart() {
  return new Date(new Date().getFullYear(), 0, 1);
}

function ytdRows(rows) {
  const start = yearStart();
  const now = new Date();
  return rows.filter((row) => {
    const d = date(row.date);
    return d && d >= start && d <= now;
  });
}

/* ========================================================================
 * Spreadsheet parsing
 * ===================================================================== */
function decision(value) {
  const text = norm(value);
  if (/reject|declin/.test(text)) return "rejected";
  if (/withdraw|cancel|filter/.test(text)) return "excluded";
  if (/discuss/.test(text)) return "discussion";
  if (/approved/.test(text)) return "approved";
  return "unknown";
}

function objects(rows, headerIndex = 0) {
  const headers = (rows[headerIndex] || []).map((value) =>
    String(value ?? "").trim(),
  );
  return rows
    .slice(headerIndex + 1)
    .filter((row) => row.some((cell) => cell !== "" && cell != null))
    .map((row) =>
      Object.fromEntries(
        headers
          .map((header, index) => [header, row[index]])
          .filter(([header]) => header),
      ),
    );
}

function securityType(text) {
  if (/bount/i.test(text)) return "Bounty";
  if (/audit|pentest/i.test(text)) return "Audit";
  return "Security";
}

/* Returns every dated Disc. Budget payment. `match` marks the rows that
 * look like security spending (bounties, audits) for the Security page. */
function parseBudgetSheet(workbook) {
  const name = workbook.SheetNames.find((n) => SECURITY_SHEET.test(n));
  if (!name) {
    console.warn("Disc. budget sheet not found. Tabs:", workbook.SheetNames);
    return [];
  }
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
    header: 1,
    raw: true,
    blankrows: true,
    defval: "",
  });
  const headerIndex = rows.findIndex((row) => {
    const cells = row.map(norm);
    return (
      cells.some((c) => /^date|^paid/.test(c)) &&
      cells.some((c) => /usd/.test(c)) &&
      cells.some((c) => /recipient|payee|contractor|name/.test(c))
    );
  });
  if (headerIndex < 0) {
    console.warn("Disc. budget header not found in", name, rows.slice(0, 6));
    return [];
  }
  const headers = rows[headerIndex].map(norm);
  const find = (pattern, exclude) =>
    headers.findIndex((h) => pattern.test(h) && !(exclude && exclude.test(h)));
  const c = {
    date: find(/^date|^paid/),
    recipient: find(/recipient|payee|contractor|^name/),
    desc: find(/description|purpose|item|memo|notes?|project|title/),
    rate: find(/zec\s*\/\s*usd|rate|price/),
  };
  c.usd = find(/usd/, /\/|rate|price/);
  c.zec = find(/^zec/, /\/|rate|price|usd/);

  const out = rows
    .slice(headerIndex + 1)
    .map((row) => {
      const text = row.join(" ");
      const description = String(
        (c.desc >= 0 ? row[c.desc] : "") || text,
      ).trim();
      const zecAmount = c.zec >= 0 ? number(row[c.zec]) : 0;
      const rate = c.rate >= 0 ? number(row[c.rate]) : 0;
      return {
        type: securityType(text),
        project: description,
        recipient: c.recipient >= 0 ? String(row[c.recipient] ?? "").trim() : "",
        date: c.date >= 0 ? iso(row[c.date]) : null,
        usd: (c.usd >= 0 ? number(row[c.usd]) : 0) || zecAmount * rate,
        zec: zecAmount,
        rate,
        match: SECURITY_TEXT.test(text),
      };
    })
    .filter((row) => row.date && row.usd > 0);
  console.info(
    `Disc. budget: ${out.length} dated rows, ${out.filter((r) => r.match).length} security rows`,
  );
  return out;
}

function buildData(workbook) {
  const raw = {};
  for (const [key, name] of Object.entries(sheets)) {
    const sheet = workbook.Sheets[name];
    raw[key] = sheet
      ? XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          raw: true,
          blankrows: true,
          defval: "",
        })
      : [];
  }

  if (!raw.dashboard.length || !raw.grants.length) {
    throw new Error("Required dashboard or grants sheet is missing.");
  }

  const grantRows = objects(raw.grants);
  const trackingHeaders = (raw.tracking[0] || []).map(norm);
  const forumIndex = trackingHeaders.findIndex(
    (header) => header.includes("forum") && header.includes("link"),
  );
  const metadata = new Map();
  const approvals = [];

  for (const row of raw.tracking.slice(1)) {
    const project = String(row[1] || "").trim();
    if (!project) continue;
    const status = decision(row[5]);
    const key = norm(project);
    const previous = metadata.get(key);
    const submitted = iso(row[0]);

    metadata.set(key, {
      submitted:
        previous?.submitted && submitted
          ? previous.submitted < submitted
            ? previous.submitted
            : submitted
          : previous?.submitted || submitted,
      decision: status,
      forum: safeURL(row[forumIndex]) || previous?.forum || null,
    });

    const approved = iso(row[6]);
    if (status === "approved" && approved) {
      approvals.push({
        project,
        grantee: String(row[2] || "").trim(),
        date: approved,
      });
    }
  }

  const grantMap = new Map();
  const payouts = [];
  const totals = {};

  for (const row of grantRows) {
    const project = String(row.Project || "").trim();
    const grantee = String(
      row.Grantee ||
        row["Applicant(s)"] ||
        row.Applicant ||
        row.Recipient ||
        "",
    ).trim();
    if (!project || !grantee) continue;
    const key = JSON.stringify([project, grantee]);
    const meta = metadata.get(norm(project)) || {};
    if (!grantMap.has(key)) {
      grantMap.set(key, {
        id: key,
        project,
        grantee,
        submitted: meta.submitted || null,
        decision:
          meta.decision && meta.decision !== "unknown"
            ? meta.decision
            : "approved",
        forum: meta.forum || null,
        category: "",
        milestones: [],
        total: 0,
        paid: 0,
        lastPaid: null,
      });
    }
    const grant = grantMap.get(key);
    const categoryKey = Object.keys(row).find((header) =>
      norm(header).startsWith("category"),
    );
    grant.category ||= String(row[categoryKey] || "").trim();
    const amount = number(row["Amount (USD)"]);
    const paid = iso(row["Paid Out"]);
    grant.total += amount;
    totals[norm(project)] = (totals[norm(project)] || 0) + amount;
    grant.milestones.push({
      amount,
      paid,
      due: iso(row["Milestone Due Date"]),
      estimate: iso(row.Estimate),
    });
    if (paid) {
      grant.paid += amount;
      if (!grant.lastPaid || paid > grant.lastPaid) grant.lastPaid = paid;
      payouts.push({
        date: paid,
        amount,
        kind: "grant",
        name: grantee,
        project,
      });
    }
  }

  for (const row of raw.tracking.slice(1)) {
    const status = decision(row[5]);
    if (!["rejected", "discussion"].includes(status)) continue;
    const project = String(row[1] || "").trim();
    const grantee = String(row[2] || "").trim();
    if (!project || !grantee) continue;
    const key = JSON.stringify([project, grantee]);
    if (grantMap.has(key)) continue;
    const meta = metadata.get(norm(project)) || {};
    grantMap.set(key, {
      id: key,
      project,
      grantee,
      submitted: meta.submitted || iso(row[0]),
      decision: status,
      forum: meta.forum || null,
      category: "",
      milestones: [],
      total: 0,
      paid: 0,
      lastPaid: null,
    });
  }

  const grants = [...grantMap.values()]
    .filter((grant) => grant.decision !== "excluded")
    .map((grant) => {
      const done = grant.milestones.filter((item) => item.paid).length;
      return {
        ...grant,
        done,
        status:
          done && done === grant.milestones.length
            ? "completed"
            : done
              ? "in-progress"
              : "waiting",
        search: norm(`${grant.project} ${grant.grantee} ${grant.category}`),
      };
    });

  const contractors = objects(raw.contractors)
    .filter((row) => row.Project || row["Independent Contractor (IC)"])
    .map((row) => ({
      project: String(row.Project || ""),
      recipient: String(row["Independent Contractor (IC)"] || ""),
      date: iso(row["Paid Out"]),
      usd: number(row["Amount (USD)"]),
      zec: number(row["ZEC Disbursed"]),
      rate: number(row["ZEC/USD"]),
    }));

  const stipends = objects(raw.stipends)
    .filter((row) => date(row.Date))
    .map((row) => ({
      date: iso(row.Date),
      recipient: String(
        row.Member ||
          row.Name ||
          row.Recipient ||
          row["Committee Member"] ||
          "",
      ),
      usd: number(row["USD Amount"]),
      zec: number(row["ZEC Amount"] || row.ZEC),
      rate: 0,
    }));

  for (const row of contractors) {
    if (row.date) {
      payouts.push({
        date: row.date,
        amount: row.usd,
        kind: "other",
        name: row.recipient,
        project: row.project,
      });
    }
  }
  for (const row of stipends) {
    payouts.push({
      date: row.date,
      amount: row.usd,
      kind: "other",
      name: row.recipient,
      project: "Stipend",
    });
  }

  const budgetRows = parseBudgetSheet(workbook);

  /* Every Disc. Budget payment counts as spending (not only security). */
  for (const row of budgetRows) {
    payouts.push({
      date: row.date,
      amount: row.usd,
      kind: "other",
      name: row.recipient,
      project: row.project || "Discretionary budget",
    });
  }

  const security = [
    ...contractors
      .filter(
        (row) =>
          SECURITY_TEXT.test(`${row.project} ${row.recipient}`) &&
          !NOTES_TEXT.test(row.project),
      )
      .map((row) => ({
        ...row,
        type: securityType(`${row.project} ${row.recipient}`),
      })),
    ...budgetRows.filter((row) => row.match),
  ].map(({ match, ...row }) => row);

  const categories = {};
  for (const row of raw.funds.slice(2)) {
    const label = String(row[14] || "").trim();
    const amount = number(row[15]);
    if (label && norm(label) !== "total" && amount > 0) {
      categories[label] = (categories[label] || 0) + amount;
    }
  }

  const headerIndex = raw.funds.findIndex((row) => {
    const text = norm(row.join(" "));
    return text.includes("recipient") && text.includes("paid out");
  });
  const recipientTotals = new Map();
  if (headerIndex >= 0) {
    for (const row of objects(raw.funds, headerIndex)) {
      const keys = Object.keys(row);
      const recipientKey = keys.find((key) => /recipient/i.test(key));
      const paidKey = keys.find((key) => /paid\s*out/i.test(key));
      const futureKey = keys.find((key) => /future\s*milestones/i.test(key));
      const name = String(row[recipientKey] || "").trim();
      if (!name || /\btotal\b/i.test(name)) continue;
      const current = recipientTotals.get(name) || { paid: 0, future: 0 };
      current.paid += number(row[paidKey]);
      current.future += number(row[futureKey]);
      recipientTotals.set(name, current);
    }
  }
  const recipients = [...recipientTotals]
    .map(([name, v]) => ({ name, ...v, total: v.paid + v.future }))
    .filter((row) => row.total > 0);

  const get = (label) =>
    raw.dashboard.find((row) => norm(row[0]).includes(norm(label)))?.[1];

  return {
    fetched: new Date().toISOString(),
    sourceTime: iso(get("Block time (UTC)")),
    treasury: {
      price: number(get("ZECUSD price")),
      zec: number(get("Current ZEC balance")),
      usd: number(get("Current USD balance")),
      liabilities: Math.abs(number(get("Future grant liabilities"))),
    },
    grants,
    approvals,
    totals,
    payouts,
    categories,
    recipients,
    contractors,
    stipends,
    security,
    liquidity: raw.liquidity,
  };
}

/* ========================================================================
 * Events sheet (separate published spreadsheet)
 * ===================================================================== */
function parseEventDate(text) {
  const match = String(text).match(/([A-Za-z]{3,})\.?\s*(\d{1,2})?(?!\d)/);
  if (!match) return null;
  const month = MONTH_NAMES.indexOf(match[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const year =
    Number(String(text).match(/\b(20\d{2})\b/)?.[1]) ||
    new Date().getFullYear();
  return new Date(year, month, Number(match[2]) || 1).toISOString();
}

function eventType(text) {
  const t = norm(text);
  if (!t || t === "-" || /^no\b/.test(t)) return "Other";
  const found = [
    ["Grant", t.indexOf("grant")],
    ["Sponsorship", t.indexOf("sponsor")],
    ["Reimbursement", t.indexOf("reimburs")],
  ]
    .filter(([, index]) => index >= 0)
    .sort((a, b) => a[1] - b[1]);
  return found.length ? found[0][0] : "Other";
}

function parseEvents(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    blankrows: true,
    defval: "",
  });
  const headerIndex = rows.findIndex((row) =>
    norm(row.join(" ")).includes("event name"),
  );
  if (headerIndex < 0) return [];
  const out = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = String(row[1] || "").trim();
    const first = norm(row[0]);
    if (!name || /^total|count/.test(first)) continue;
    const r = range.s.r + i;
    const dateCell = sheet[XLSX.utils.encode_cell({ r, c: 0 })];
    const nameCell = sheet[XLSX.utils.encode_cell({ r, c: 1 })];
    const typeText = String(row[5] || "").trim();
    const rawDate = row[0];
    const start =
      typeof rawDate === "number" ? iso(rawDate) : parseEventDate(rawDate);
    const status = norm(row[3]);
    out.push({
      date: start,
      dateLabel: String(dateCell?.w || rawDate || "").trim(),
      name,
      url: safeURL(nameCell?.l?.Target),
      location: String(row[2] || "").trim(),
      status: /done/.test(status)
        ? "done"
        : /soon/.test(status)
          ? "soon"
          : "upcoming",
      usd: number(row[4]),
      zec: 0,
      typeText,
      type: eventType(typeText),
    });
  }
  return out;
}

async function loadEvents() {
  if (eventsPromise) return eventsPromise;
  eventsPromise = (async () => {
    try {
      const [, response] = await Promise.all([
        loadXLSX(),
        fetch(EVENTS_URL, { cache: "no-store" }),
      ]);
      if (!response.ok) {
        throw new Error(`Events request failed (${response.status}).`);
      }
      const workbook = XLSX.read(await response.arrayBuffer(), {
        type: "array",
      });
      const parsed = parseEvents(workbook);
      if (!parsed.length) throw new Error("No events found in the sheet.");
      events = parsed;
      writeCache(EVENTS_KEY, parsed);
      renderedPages.delete("events");
      if (activePage === "events") renderActivePage();
    } catch (error) {
      console.error(error);
      if (!events && activePage === "events") {
        $("eventsContent").innerHTML = `<div class="card">
          Could not load events. ${escapeHTML(error.message)}</div>`;
      }
    } finally {
      eventsPromise = null;
    }
  })();
  return eventsPromise;
}

/* ========================================================================
 * Data lifecycle: show cache immediately; refresh stale data once.
 * ===================================================================== */
async function refreshData() {
  if (refreshing) return refreshing;
  $("refreshButton").disabled = true;
  $("dataStatus").textContent = data
    ? "Showing cached data · Checking for updates…"
    : "Downloading spreadsheet…";
  loadEvents();

  refreshing = (async () => {
    try {
      const [, response] = await Promise.all([
        loadXLSX(),
        fetch(XLSX_URL, { cache: "no-store" }),
      ]);
      if (!response.ok) {
        throw new Error(`Spreadsheet request failed (${response.status}).`);
      }
      const workbook = XLSX.read(await response.arrayBuffer(), {
        type: "array",
      });
      data = buildData(workbook);
      writeCache(CACHE_KEY, data);
      renderedPages.clear();
      renderActivePage();
      updateStatus();
      openGrantFromHash();
    } catch (error) {
      console.error(error);
      $("dataStatus").textContent = data
        ? `Update failed · Showing saved data from ${fmtDate(data.fetched)}.`
        : `${error.message} Use Refresh to try again.`;
      if (!data) {
        document.querySelectorAll(".skeleton-card").forEach((element) => {
          element.classList.remove("skeleton-card");
          element.textContent = "Data unavailable. Please retry.";
        });
      }
    } finally {
      refreshing = null;
      $("refreshButton").disabled = false;
    }
  })();
  return refreshing;
}

function updateStatus() {
  if (!data) return;
  const source = data.sourceTime
    ? `Source timestamp: ${date(data.sourceTime).toLocaleString()} · `
    : "";
  $("dataStatus").textContent =
    source + `Downloaded: ${date(data.fetched).toLocaleString()}`;
}

/* ========================================================================
 * Dates, comparisons, and monthly series
 * ===================================================================== */
function sumBetween(records, start, end) {
  return records.reduce((sum, record) => {
    const d = date(record.date);
    return d && d >= start && d < end ? sum + record.amount : sum;
  }, 0);
}

function countBetween(records, start, end) {
  return records.filter((record) => {
    const d = date(record.date);
    return d && d >= start && d < end;
  }).length;
}

function months(count = 12) {
  const now = new Date();
  return Array.from({ length: count }, (_, index) =>
    monthKey(new Date(now.getFullYear(), now.getMonth() - count + index + 1)),
  );
}

function monthly(records, keys, value = "amount") {
  const totals = new Map(keys.map((key) => [key, 0]));
  for (const record of records) {
    const key = monthKey(record.date);
    if (totals.has(key)) {
      totals.set(key, totals.get(key) + (value ? record[value] || 0 : 1));
    }
  }
  return keys.map((key) => totals.get(key));
}

function changeBadge(current, previous, label) {
  if (!previous) {
    return `<span class="badge">${current ? "New activity" : "No change"}
      · nothing in ${escapeHTML(label)}</span>`;
  }
  const percent = ((current - previous) / previous) * 100;
  return `<span class="badge">${percent >= 0 ? "▲" : "▼"}
    ${Math.abs(percent).toFixed(0)}% ${percent >= 0 ? "more" : "less"}
    than ${escapeHTML(label)}</span>`;
}

function bar(parts) {
  const total = parts.reduce((sum, item) => sum + Math.max(item.value, 0), 0);
  return `<div class="segment-bar" aria-hidden="true">
    ${parts
      .map(
        (item) => `<span class="${item.className}" style="width:${
          total ? (Math.max(item.value, 0) / total) * 100 : 0
        }%"></span>`,
      )
      .join("")}
  </div>`;
}

const stat = (label, value) =>
  `<div class="stat-row"><span>${label}</span><strong>${value}</strong></div>`;

function nextMilestone(grant) {
  return grant.milestones
    .filter((item) => !item.paid)
    .sort((a, b) => {
      const da = date(a.estimate || a.due);
      const db = date(b.estimate || b.due);
      return (da ? +da : Infinity) - (db ? +db : Infinity);
    })[0];
}

function isOverdue(item) {
  if (!item || item.paid) return false;
  const due = date(item.estimate || item.due);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due && due < today;
}

/* ========================================================================
 * Navigation: native hash history
 * ===================================================================== */
const legacyRoutes = { auditpayments: "security", payments: "dashboard" };

const pageTitles = {
  dashboard: "Overview",
  grants: "Grants",
  security: "Security",
  events: "Events",
  stipends: "Stipends",
  notetaker: "Notetaker",
  liquidity: "Liquidity",
};

const pageTargets = {
  grants: "grantsContainer",
  security: "securityContent",
  stipends: "stipendsContent",
  notetaker: "notetakerContent",
  liquidity: "liquidityContent",
  events: "eventsContent",
};

function route() {
  const [rawPage, query = ""] = location.hash.slice(1).split("?");
  const page = legacyRoutes[rawPage] || rawPage;
  activePage = $(page)?.classList.contains("page") ? page : "dashboard";
  document.querySelectorAll(".page").forEach((element) => {
    element.hidden = element.id !== activePage;
  });
  document.querySelectorAll("[data-page]").forEach((element) => {
    if (element.dataset.page === activePage) {
      element.setAttribute("aria-current", "page");
    } else {
      element.removeAttribute("aria-current");
    }
  });
  document.title = `${pageTitles[activePage]} · Zcash Community Grants`;

  if (activePage === "grants") {
    const params = new URLSearchParams(query);
    for (const [name, id] of [
      ["status", "grantStatus"],
      ["budget", "grantBudget"],
      ["sort", "grantSort"],
    ]) {
      const value = params.get(name);
      if (value && [...$(id).options].some((o) => o.value === value)) {
        $(id).value = value;
      }
    }
  }
  syncDropdowns();
  if ($("grantDialog").open && !new URLSearchParams(query).has("grant")) {
    modalRequest++;
    $("grantDialog").close();
  }
  renderActivePage();
  openGrantFromHash();
}

function renderActivePage() {
  /* Events come from their own sheet and do not need the main data. */
  if (activePage === "events") {
    if (renderedPages.has("events")) {
      for (const chart of charts.values()) chart.resize();
    } else if (events) {
      renderTable("events");
      renderedPages.add("events");
    } else {
      $("eventsContent").innerHTML = '<div class="card skeleton-card"></div>';
    }
    return;
  }
  if (!data) {
    const target = $(pageTargets[activePage] || "");
    if (target) target.innerHTML = '<div class="card skeleton-card"></div>';
    if (activePage === "liquidity") renderLiquidity();
    return;
  }
  if (activePage === "grants") {
    renderGrants();
    return;
  }
  if (renderedPages.has(activePage)) {
    for (const chart of charts.values()) chart.resize();
    return;
  }
  const renderers = {
    dashboard: renderOverview,
    security: renderSecurity,
    stipends: () => renderTable("stipends"),
    notetaker: () => renderTable("notetaker"),
    liquidity: renderLiquidity,
  };
  renderers[activePage]?.();
  renderedPages.add(activePage);
}

/* ========================================================================
 * Overview
 * ===================================================================== */
function monthLabel(key, long = false) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(
    undefined,
    long ? { month: "long", year: "numeric" } : { month: "short" },
  );
}

function miniChartHTML(id, title, keys, note) {
  return `<div class="spark-title">${title}
      <span class="muted">· ${monthLabel(keys[0], true)} – ${monthLabel(keys.at(-1), true)}</span></div>
    <div class="mini-chart"><canvas id="${id}"></canvas></div>
    <p class="spark-caption">${note}</p>`;
}

function drawMiniChart(id, keys, values, label, money = true) {
  const colors = chartColors();
  const last = keys.length - 1;
  makeChart(id, {
    type: "bar",
    data: {
      labels: keys.map((k) => monthLabel(k)),
      datasets: [
        {
          label,
          data: values,
          backgroundColor: values.map((_, i) =>
            i === last ? colors.gray : colors.amber,
          ),
          borderRadius: 3,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) =>
              monthLabel(keys[items[0].dataIndex], true) +
              (items[0].dataIndex === last ? " (so far)" : ""),
            label: (c) => `${label}: ${money ? usd(c.raw) : c.raw}`,
          },
        },
      },
      scales: {
        x: { ticks: { autoSkip: false, maxRotation: 0, font: { size: 9 } } },
        y: { display: false },
      },
    },
  });
}

function renderOverview() {
  const now = new Date();
  const end = new Date(+now + 1);
  const start30 = new Date(+now - 30 * DAY);
  const previous30 = new Date(+now - 60 * DAY);
  const start12 = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const grantPayoutRecords = data.payouts.filter((p) => p.kind === "grant");
  const currentPayouts = sumBetween(data.payouts, start30, end);
  const previousPayouts = sumBetween(data.payouts, previous30, start30);
  const grantPayouts = sumBetween(grantPayoutRecords, start30, end);
  const grantCount = countBetween(grantPayoutRecords, start30, end);
  const burn = sumBetween(data.payouts, start12, end) / 12;
  const t = data.treasury;
  const zecValue = t.zec * t.price;
  const treasury = zecValue + t.usd;
  const income = DAILY_INFLOW_ZEC * 30 * t.price;
  const free = treasury - t.liabilities;
  const committed = treasury > 0 ? (t.liabilities / treasury) * 100 : 0;
  const approved = data.grants.filter((g) => g.decision === "approved");
  const complete = approved.filter((g) => g.status === "completed").length;
  const active = approved.filter((g) => g.status === "in-progress").length;
  const review = approved.length - complete - active;
  const overdueGrants = approved.filter((g) => g.milestones.some(isOverdue)).length;
  const yStart = yearStart();
  const previousYearStart = new Date(now.getFullYear() - 1, 0, 1);
  const previousYearEnd = new Date(
    now.getFullYear() - 1, now.getMonth(), now.getDate(),
    now.getHours(), now.getMinutes(),
  );
  const currentApprovals = data.approvals.filter(
    (a) => date(a.date) >= yStart && date(a.date) <= now,
  );
  const previousApprovals = data.approvals.filter(
    (a) => date(a.date) >= previousYearStart && date(a.date) <= previousYearEnd,
  );
  const approvedBudget = currentApprovals.reduce(
    (sum, a) => sum + (data.totals[norm(a.project)] || 0), 0,
  );
  const ytdPaid = sumBetween(data.payouts, yStart, end);
  const keys = months();

  $("overviewMetrics").innerHTML = `
    <article class="card treasury-card">
      <div class="metric-label">Total treasury value</div>
      <div class="metric-value">${usd(treasury)}</div>
      <p class="metric-subtitle">ZEC at ${usd(t.price)} + USD stables</p>
      ${bar([
        { value: zecValue, className: "bar-yellow" },
        { value: t.usd, className: "bar-blue" },
      ])}
      ${stat(zec(t.zec), usd(zecValue))}
      ${stat("USD stables", usd(t.usd))}
      <div class="divider"></div>
      ${stat("Committed to grants", `${usd(t.liabilities)} · ${committed.toFixed(0)}%`)}
      ${bar([
        { value: t.liabilities, className: "bar-green" },
        { value: Math.max(free, 0), className: "bar-muted" },
      ])}
      ${stat("Uncommitted treasury", usd(free))}
      ${stat("Gross spending coverage", burn > 0 ? `~${(treasury / burn).toFixed(1)} months` : "—")}
      <p class="spark-caption">
        Coverage uses ${usd(burn)}/month trailing average; excludes income.
      </p>
    </article>

    <article class="card">
      <div class="metric-label">Payouts · last 30 days</div>
      <div class="metric-value">${usd(currentPayouts)}</div>
      ${changeBadge(currentPayouts, previousPayouts, `the previous 30 days (${usd(previousPayouts)})`)}
      ${stat("Grant milestones", `${usd(grantPayouts)} · ${grantCount} paid`)}
      ${stat("Contractors, stipends & discretionary", usd(currentPayouts - grantPayouts))}
      ${stat("Avg grant payout", usd(grantCount ? grantPayouts / grantCount : 0))}
      <div class="divider"></div>
      ${stat("Est. protocol income", usd(income))}
      ${stat("Est. net flow", usd(income - currentPayouts))}
      ${stat("All payouts this year", usd(ytdPaid))}
      ${miniChartHTML(
        "miniPayouts", "Total payouts per month", keys,
        `Hover a bar for the exact amount. Gray = current month so far.
         Income = ${DAILY_INFLOW_ZEC} ZEC/day × 30 at current price.`,
      )}
    </article>

    <article class="card">
      <div class="metric-label">Approved grants · all time</div>
      <div class="metric-value">${approved.length}</div>
      <p class="metric-subtitle">
        ${complete} completed · ${active} active · ${review} in review
      </p>
      ${bar([
        { value: complete, className: "bar-green" },
        { value: active, className: "bar-yellow" },
        { value: review, className: "bar-muted" },
      ])}
      ${stat("Approved this year", currentApprovals.length)}
      ${changeBadge(
        currentApprovals.length, previousApprovals.length,
        `the same period last year (${previousApprovals.length})`,
      )}
      ${stat("Matched approved budget YTD", usd(approvedBudget))}
      ${stat("Grants with overdue milestones", overdueGrants)}
      ${miniChartHTML(
        "miniApprovals", "Grants approved per month", keys,
        "Hover a bar for the count. Gray = current month so far.",
      )}
    </article>`;

  drawMiniChart("miniPayouts", keys, monthly(data.payouts, keys), "Paid out");
  drawMiniChart("miniApprovals", keys, monthly(data.approvals, keys, null), "Approved", false);
  renderOverviewCharts();
  renderPriceChart();
  renderRecipients();
}

/* ========================================================================
 * Charts (colors come from CSS variables, so dark mode works)
 * ===================================================================== */
function chartColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(name).trim();
  return {
    text: get("--muted"),
    grid: get("--grid"),
    amber: get("--amber"),
    gray: get("--gray"),
    ink: get("--ink"),
  };
}

function makeChart(id, config) {
  if (!window.Chart || !$(id)) return;
  charts.get(id)?.destroy();
  const colors = chartColors();
  const options = config.options || {};
  const base = {
    x: {
      grid: { display: false },
      ticks: { color: colors.text, maxRotation: 0 },
    },
    y: {
      beginAtZero: true,
      grid: { color: colors.grid },
      ticks: { color: colors.text },
    },
  };
  const scales = { ...base };
  for (const [name, value] of Object.entries(options.scales || {})) {
    scales[name] = base[name] ? { ...base[name], ...value } : value;
  }
  const chart = new Chart($(id), {
    ...config,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      color: colors.text,
      interaction: { mode: "index", intersect: false },
      ...options,
      plugins: {
        legend: {
          labels: { color: colors.text, boxWidth: 10, boxHeight: 10 },
        },
        ...options.plugins,
      },
      scales: config.type === "doughnut" ? undefined : scales,
    },
  });
  charts.set(id, chart);
}

function chartMonthKeys(records, range) {
  const current = monthKey(new Date());
  if (range === "12m") return months();
  const earliest = records
    .map((item) => monthKey(item.date))
    .filter(Boolean)
    .sort()[0];
  let first = range === "ytd" ? `${new Date().getFullYear()}-01` : earliest;
  if (!first) return months();
  if (first < MIN_MONTH) first = MIN_MONTH;
  const [year, month] = first.split("-").map(Number);
  const keys = [];
  const cursor = new Date(year, month - 1, 1);
  while (monthKey(cursor) <= current && keys.length < 240) {
    keys.push(monthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return keys;
}

function renderOverviewCharts() {
  const colors = chartColors();
  const usdAxis = { ticks: { color: colors.text, callback: (v) => usd(v) } };
  const countAxis = {
    position: "right",
    beginAtZero: true,
    grid: { drawOnChartArea: false },
    ticks: { color: colors.text, precision: 0 },
  };

  const grants = data.payouts.filter((item) => item.kind === "grant");
  const payoutKeys = chartMonthKeys(grants, chartRanges.payout);
  makeChart("payoutChart", {
    type: "bar",
    data: {
      labels: payoutKeys,
      datasets: [
        {
          label: "Paid (USD)",
          data: monthly(grants, payoutKeys),
          backgroundColor: colors.amber,
          borderRadius: 4,
        },
        {
          type: "line",
          label: "Milestones paid",
          data: monthly(grants, payoutKeys, null),
          borderColor: colors.ink,
          backgroundColor: colors.ink,
          yAxisID: "count",
          tension: 0.25,
          pointRadius: 2,
        },
      ],
    },
    options: { scales: { y: usdAxis, count: countAxis } },
  });

  const approvalKeys = chartMonthKeys(data.approvals, chartRanges.approval);
  const budgetRecords = data.approvals.map((item) => ({
    ...item,
    amount: data.totals[norm(item.project)] || 0,
  }));
  makeChart("approvalChart", {
    type: "bar",
    data: {
      labels: approvalKeys,
      datasets: [
        {
          label: "Matched budget (USD)",
          data: monthly(budgetRecords, approvalKeys),
          backgroundColor: colors.amber,
          borderRadius: 4,
        },
        {
          type: "line",
          label: "Approved grants",
          data: monthly(data.approvals, approvalKeys, null),
          borderColor: colors.ink,
          backgroundColor: colors.ink,
          yAxisID: "count",
          tension: 0.25,
          pointRadius: 2,
        },
      ],
    },
    options: { scales: { y: usdAxis, count: countAxis } },
  });

  const entries = Object.entries(data.categories).sort((a, b) => b[1] - a[1]);
  const palette = [
    "#f4b728",
    "#e79032",
    "#c66c36",
    "#926c41",
    "#648bb9",
    "#22805c",
    "#b19b63",
    "#b789a5",
    "#7d7c92",
    "#d1ae7c",
  ];
  makeChart("categoryChart", {
    type: "doughnut",
    data: {
      labels: entries.map(([name]) => name),
      datasets: [
        {
          data: entries.map(([, value]) => value),
          backgroundColor: entries.map((_, i) => palette[i % palette.length]),
          borderWidth: 0,
          spacing: 3,
        },
      ],
    },
    options: {
      cutout: "68%",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (c) => `${c.label}: ${usd(c.raw)}` },
        },
      },
    },
  });
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  $("categoryLegend").innerHTML = entries
    .map(
      ([name, value], index) => `
      <div class="category-item">
        <span class="dot" style="background:${palette[index % palette.length]}"></span>
        <span>${escapeHTML(name)}</span>
        <strong>${usd(value)} · ${total ? ((value / total) * 100).toFixed(1) : 0}%</strong>
      </div>`,
    )
    .join("");
}

async function renderPriceChart() {
  try {
    const cached = readCache(PRICE_KEY);
    let prices = cached?.value;
    if (!Array.isArray(prices) || Date.now() - cached.timestamp > DAY) {
      try {
        pricePromise ||= fetch(PRICE_URL)
          .then((response) => {
            if (!response.ok) throw new Error("Price API unavailable.");
            return response.json();
          })
          .then((result) => {
            if (!result.prices?.length) throw new Error("No price data.");
            writeCache(PRICE_KEY, result.prices);
            return result.prices;
          })
          .finally(() => {
            pricePromise = null;
          });
        prices = await pricePromise;
      } catch (error) {
        if (!Array.isArray(prices)) throw error; // fall back to stale cache
      }
    }
    const daily = new Map();
    for (const [timestamp, value] of prices) {
      daily.set(new Date(timestamp).toISOString().slice(0, 10), value);
    }
    const points = [...daily.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    const colors = chartColors();
    makeChart("priceChart", {
      type: "line",
      data: {
        labels: points.map(([day]) => day),
        datasets: [
          {
            label: "ZEC/USD",
            data: points.map(([, value]) => value),
            borderColor: colors.amber,
            backgroundColor: "rgba(244, 183, 40, 0.12)",
            fill: true,
            tension: 0.2,
            pointRadius: 0,
          },
        ],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxTicksLimit: 6 } },
          y: { beginAtZero: false },
        },
      },
    });
    const first = points[0][1];
    const last = points.at(-1)[1];
    const percent = first ? ((last - first) / first) * 100 : 0;
    $("priceChange").textContent =
      `${percent >= 0 ? "▲" : "▼"} ${Math.abs(percent).toFixed(1)}% · 90d`;
    $("priceCaption").textContent = "Daily USD prices · CoinGecko";
  } catch {
    $("priceCaption").textContent =
      "Price history unavailable. CoinGecko may be rate-limiting requests.";
  }
}

/* ========================================================================
 * Recipients table (overview)
 * ===================================================================== */
const RECIPIENT_RANGES = [
  ["3m", "3 months"], ["1y", "1 year"], ["2y", "2 years"],
  ["5y", "5 years"], ["all", "All time"],
];
const RECIPIENT_SIZES = [
  ["all", "Any size"], ["small", "Under $50k"],
  ["medium", "$50k–$250k"], ["large", "Over $250k"],
];

function rangeStart(range) {
  const n = new Date();
  const back = { "3m": [0, 3], "1y": [1, 0], "2y": [2, 0], "5y": [5, 0] }[range];
  return back
    ? new Date(n.getFullYear() - back[0], n.getMonth() - back[1], n.getDate())
    : null;
}

function recipientRows() {
  const start = rangeStart(recipientView.range);
  if (!start) return data.recipients.map((r) => ({ ...r }));
  const map = new Map();
  const entry = (name) => {
    if (!map.has(name)) map.set(name, { name, paid: 0, future: 0 });
    return map.get(name);
  };
  const now = new Date();
  for (const p of data.payouts) {
    const d = date(p.date);
    if (d && d >= start && d <= now) entry(p.name || "Unknown").paid += p.amount;
  }
  for (const g of data.grants) {
    if (g.decision !== "approved") continue;
    for (const m of g.milestones) if (!m.paid) entry(g.grantee).future += m.amount;
  }
  return [...map.values()]
    .map((r) => ({ ...r, total: r.paid + r.future }))
    .filter((r) => r.total > 0);
}

function renderRecipients() {
  const { key, dir } = recipientSort;
  const sizeOk = (total) =>
    recipientView.size === "all" ||
    (recipientView.size === "small" && total < 50000) ||
    (recipientView.size === "medium" && total >= 50000 && total <= 250000) ||
    (recipientView.size === "large" && total > 250000);
  const rows = recipientRows()
    .filter((r) => sizeOk(r.total))
    .sort((a, b) =>
      key === "name" ? a.name.localeCompare(b.name) * dir : (a[key] - b[key]) * dir,
    );
  const totalPaid = rows.reduce((s, r) => s + r.paid, 0);
  const totalFuture = rows.reduce((s, r) => s + r.future, 0);
  const group = (label, attr, options, current) => `
    <div><span class="control-label">${label}</span>
      <div class="segmented" role="group" aria-label="${label}">
        ${options.map(([v, text]) => `<button type="button" class="button" data-${attr}="${v}"
          aria-pressed="${v === current}">${text}</button>`).join("")}
      </div></div>`;
  const head = [
    ["name", "Recipient"], ["paid", "Paid out"],
    ["future", "Future milestones"], ["total", "Total"],
  ].map(([k, label]) => {
    const selected = k === key;
    return `<th scope="col" class="${k === "name" ? "" : "number"}"
      aria-sort="${selected ? (dir > 0 ? "ascending" : "descending") : "none"}">
      <button data-recipient-sort="${k}">${label}${selected ? (dir > 0 ? " ↑" : " ↓") : ""}</button></th>`;
  }).join("");

  $("recipientsContent").innerHTML = `
    <article class="card">
      <div class="control-bar">
        ${group("Period", "recipient-range", RECIPIENT_RANGES, recipientView.range)}
        ${group("Recipient size", "recipient-size", RECIPIENT_SIZES, recipientView.size)}
      </div>
      <div class="table-summary">
        <div><strong>${usd(totalPaid)}</strong><span>Paid out</span></div>
        <div><strong>${usd(totalFuture)}</strong><span>Future milestones</span></div>
        <div><strong>${rows.length}</strong><span>Recipients</span></div>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr>${head}</tr></thead>
          <tbody>${rows.length ? rows.map((r) => `<tr>
            <td>${escapeHTML(r.name)}</td>
            <td class="number">${usd(r.paid)}</td>
            <td class="number">${usd(r.future)}</td>
            <td class="number"><strong>${usd(r.total)}</strong></td></tr>`).join("")
            : '<tr><td colspan="4" class="empty">No recipients match.</td></tr>'}</tbody>
        </table>
      </div>
      <p class="spark-caption" style="margin-top:14px">
        Size filters use each recipient's total in the selected period.
        "All time" uses the Funds Distribution sheet. Shorter periods are summed
        from dated grant, contractor, stipend and discretionary budget payouts.
        Future milestones are not time-limited.
      </p>
    </article>`;
}

/* ========================================================================
 * Grants page
 * ===================================================================== */
function renderGrantsMini() {
  const findGrant = (a) =>
    data.grants.find((g) => g.project === a.project && g.grantee === a.grantee);
  const link = (g, text) =>
    g
      ? `<a href="#grants?grant=${encodeURIComponent(g.id)}">${escapeHTML(text)}</a>`
      : escapeHTML(text);

  const latest = [...data.approvals]
    .sort((a, b) => +date(b.date) - +date(a.date))
    .slice(0, MINI_COUNT)
    .map(
      (a) => `<li><div><strong>${link(findGrant(a), a.project)}</strong>
        <small>${escapeHTML(a.grantee)} · ${fmtDate(a.date)}</small></div>
        <span class="amount">${usd(data.totals[norm(a.project)] || 0)}</span></li>`,
    );

  const recent = data.payouts
    .filter((p) => p.kind === "grant")
    .sort((a, b) => +date(b.date) - +date(a.date))
    .slice(0, MINI_COUNT)
    .map(
      (p) => `<li><div><strong>${escapeHTML(p.project)}</strong>
        <small>${escapeHTML(p.name)} · ${fmtDate(p.date)}</small></div>
        <span class="amount">${usd(p.amount)}</span></li>`,
    );

  /* Last 30 days stats */
  const now = new Date();
  const end = new Date(+now + 1);
  const start30 = new Date(+now - 30 * DAY);
  const grantPayouts = data.payouts.filter((p) => p.kind === "grant");
  const approvals30 = data.approvals.filter((a) => {
    const d = date(a.date);
    return d && d >= start30 && d < end;
  });
  const allocated = approvals30.reduce(
    (sum, a) => sum + (data.totals[norm(a.project)] || 0),
    0,
  );
  const paid30 = sumBetween(grantPayouts, start30, end);
  const milestones30 = countBetween(grantPayouts, start30, end);

  const card = (title, items) => `<article class="card mini-card">
    <h2>${title}</h2>
    <ul class="mini-list">${items.join("") || '<li class="muted">No data</li>'}</ul>
  </article>`;
  const statsCard = `<article class="card mini-card">
    <h2>Last 30 days</h2>
    <div class="metric-value">${usd(paid30)}</div>
    <p class="metric-subtitle">paid out for grants</p>
    ${stat("Grants approved", approvals30.length)}
    ${stat("Milestones paid", milestones30)}
    ${stat("Funding allocated to new grants", usd(allocated))}
    ${stat("Avg milestone payout", usd(milestones30 ? paid30 / milestones30 : 0))}
  </article>`;

  $("grantsMini").innerHTML =
    card("Latest approvals", latest) +
    card("Recent payouts", recent) +
    statsCard;
}

function renderGrants() {
  renderGrantsMini();

  const category = $("grantCategory").value;
  const categories = [...new Set(data.grants.map((g) => g.category))]
    .filter(Boolean)
    .sort();
  $("grantCategory").innerHTML =
    '<option value="all">All categories</option>' +
    categories
      .map(
        (value) =>
          `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`,
      )
      .join("");
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const requestedCategory = params.get("category") || category;
  if (categories.includes(requestedCategory)) {
    $("grantCategory").value = requestedCategory;
  }

  const query = norm($("grantSearch").value);
  const status = $("grantStatus").value;
  const budget = $("grantBudget").value;
  const selectedCategory = $("grantCategory").value;
  const sort = $("grantSort").value;

  const filtered = data.grants.filter((grant) => {
    const approved = grant.decision === "approved";
    if (["discussion", "rejected"].includes(status)) {
      if (grant.decision !== status) return false;
    } else {
      if (!approved) return false;
      if (status === "overdue" && !grant.milestones.some(isOverdue)) {
        return false;
      }
      if (!["all", "overdue"].includes(status) && grant.status !== status) {
        return false;
      }
    }
    if (query && !grant.search.includes(query)) return false;
    if (budget === "small" && grant.total >= 50000) return false;
    if (budget === "medium" && (grant.total < 50000 || grant.total > 200000)) {
      return false;
    }
    if (budget === "large" && grant.total <= 200000) return false;
    return selectedCategory === "all" || grant.category === selectedCategory;
  });

  filtered.sort((a, b) => {
    if (sort === "biggest") return b.total - a.total;
    if (sort === "smallest") return a.total - b.total;
    const da = +(date(a.lastPaid || a.submitted) || 0);
    const db = +(date(b.lastPaid || b.submitted) || 0);
    return sort === "oldest" ? da - db : db - da;
  });

  $("grantCount").textContent =
    `${filtered.length} shown · ${data.grants.length} total tracked records`;
    $("grantsContainer").innerHTML = filtered.length
    ? filtered
        .map((grant) => {
          const paidPercent = grant.total
            ? Math.min(100, Math.max(0, (grant.paid / grant.total) * 100))
            : 0;

          // 100% = complete green, >= 75% = medium green, default = yellow
          const ringClass =
            paidPercent >= 100
              ? "ring-complete"
              : paidPercent >= 75
                ? "ring-mid"
                : "";

          const next = nextMilestone(grant);
          const due = next?.estimate || next?.due;
          const label =
            grant.decision === "approved"
              ? grant.status.replace("-", " ")
              : grant.decision;
          return `
          <button class="card grant-card" data-grant="${escapeHTML(grant.id)}">
            <h3>${escapeHTML(grant.project)}</h3>
            <div class="grant-grantee">${escapeHTML(grant.grantee)}</div>
            <div class="grant-tags">
              <span class="badge yellow">${escapeHTML(label)}</span>
              ${
                grant.category
                  ? `<span class="badge">${escapeHTML(grant.category)}</span>`
                  : ""
              }
            </div>
            <div class="grant-finance">
              <div>
                <strong>${
                  grant.decision === "approved" ? usd(grant.total) : "Proposal"
                }</strong>
                <span class="metric-subtitle">${
                  grant.decision === "approved"
                    ? `${usd(grant.paid)} paid · ${grant.done}/${grant.milestones.length} milestones`
                    : "Approved budget not available"
                }</span>
              </div>
              <div class="ring ${ringClass}" style="--progress:${paidPercent}%">
                <span>${paidPercent.toFixed(0)}%</span>
              </div>
            </div>
            <div class="grant-next ${isOverdue(next) ? "overdue" : ""}">
              ${
                next
                  ? `${isOverdue(next) ? "Overdue" : "Next milestone"}:
                    ${usd(next.amount)} · ${due ? fmtDate(due) : "Date TBA"}`
                  : grant.status === "completed"
                    ? "All milestones paid"
                    : "No milestone schedule available"
              }
            </div>
          </button>`;
        })
        .join("")
    : '<div class="card empty">No grants match these filters.</div>';
  syncDropdowns();
}

function updateGrantURL() {
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  for (const [name, id, defaultValue] of [
    ["status", "grantStatus", "all"],
    ["budget", "grantBudget", "all"],
    ["category", "grantCategory", "all"],
    ["sort", "grantSort", "newest"],
  ]) {
    if ($(id).value === defaultValue) params.delete(name);
    else params.set(name, $(id).value);
  }
  const text = params.toString();
  history.replaceState(null, "", `#grants${text ? `?${text}` : ""}`);
}

/* ========================================================================
 * Grant dialog (native <dialog> handles focus containment)
 * ===================================================================== */
function openGrantFromHash() {
  if (!data || activePage !== "grants") return;
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const id = params.get("grant");
  const grant = data.grants.find((item) => item.id === id);
  if (grant && $("grantDialog").dataset.grant !== id) showGrant(grant);
}

async function showGrant(grant) {
  const request = ++modalRequest;
  const dialog = $("grantDialog");
  dialog.dataset.grant = grant.id;
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  params.set("grant", grant.id);
  history.replaceState(null, "", `#grants?${params}`);

  const remaining = Math.max(grant.total - grant.paid, 0);
  const segments = grant.milestones.map((milestone) => ({
    value: milestone.amount,
    className: milestone.paid ? "bar-green" : "bar-yellow",
  }));
  $("dialogBody").innerHTML = `
    <h2 id="dialogTitle" class="dialog-title">${escapeHTML(grant.project)}</h2>
    <p class="muted">${escapeHTML(grant.grantee)}</p>
    <div class="dialog-actions">
      <button class="button primary" id="shareGrant">Copy grant link</button>
      ${
        grant.forum
          ? `<a class="button" href="${escapeHTML(grant.forum)}"
              target="_blank" rel="noopener noreferrer">Forum ↗</a>`
          : ""
      }
      <span id="githubLink"></span>
    </div>
    <div class="grant-tags">
      <span class="badge yellow">${escapeHTML(
        grant.decision === "approved" ? grant.status : grant.decision,
      )}</span>
      ${
        grant.category
          ? `<span class="badge">${escapeHTML(grant.category)}</span>`
          : ""
      }
      <span class="badge">Opened ${fmtDate(grant.submitted)}</span>
    </div>
    <div class="detail-grid">
      ${[
        ["Approved budget", grant.total ? usd(grant.total) : "—"],
        ["Paid", usd(grant.paid)],
        ["Remaining", usd(remaining)],
        ["Milestones", `${grant.done}/${grant.milestones.length}`],
      ]
        .map(
          ([label, value]) => `
        <div class="detail-tile">
          <span class="metric-label">${label}</span>
          <strong>${value}</strong>
        </div>`,
        )
        .join("")}
    </div>
    ${bar(segments)}
    <p class="spark-caption">
      Dark = paid · Amber = outstanding · segment size represents USD value
    </p>
    <div class="divider"></div>
    <h3>Project summary</h3>
    <p class="summary-text" id="githubSummary">Finding GitHub application…</p>
    <div class="divider"></div>
    <h3>Milestone timeline</h3>
    <ol class="timeline">
      ${
        grant.milestones.length
          ? grant.milestones
              .map(
                (milestone, index) => `
              <li>
                <span class="timeline-marker">${milestone.paid ? "✓" : index + 1}</span>
                <div>
                  <div class="timeline-meta">
                    <strong>${usd(milestone.amount)}</strong>
                    <span class="badge ${
                      milestone.paid
                        ? "green"
                        : isOverdue(milestone)
                          ? "red"
                          : "yellow"
                    }">${
                      milestone.paid
                        ? "Paid"
                        : isOverdue(milestone)
                          ? "Overdue"
                          : "Outstanding"
                    }</span>
                  </div>
                  <p class="metric-subtitle">${
                    milestone.paid
                      ? `Paid ${fmtDate(milestone.paid)}`
                      : milestone.estimate
                        ? `Estimated ${fmtDate(milestone.estimate)}`
                        : milestone.due
                          ? `Due ${fmtDate(milestone.due)}`
                          : "Date to be confirmed"
                  }</p>
                </div>
              </li>`,
              )
              .join("")
          : '<li class="muted">No milestones recorded.</li>'
      }
    </ol>`;
  if (!dialog.open) dialog.showModal();
  $("shareGrant").onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("shareGrant").textContent = "Link copied";
    } catch {
      $("shareGrant").textContent = "Copy this page’s URL from your browser";
    }
  };

  try {
    const key = `zcg-github-v2:${grant.project}`;
    const cached = readCache(key);
    let issue = cached?.value;
    if (!cached || Date.now() - cached.timestamp > 3 * DAY) {
      const query =
        `"${grant.project}" ` +
        "repo:ZcashCommunityGrants/zcashcommunitygrants is:issue";
      const response = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(query)}`,
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (!response.ok) throw new Error("GitHub unavailable");
      const result = await response.json();
      const title = norm(grant.project);
      issue =
        result.items?.find(
          (item) =>
            norm(item.title) === title ||
            norm(item.title) === `grant application - ${title}`,
        ) || null;
      writeCache(key, issue);
    }
    if (request !== modalRequest || !dialog.open) return;
    if (!issue) {
      $("githubSummary").textContent =
        "No exact matching GitHub application found.";
      return;
    }
    const link = safeURL(issue.html_url);
    if (link) {
      $("githubLink").innerHTML = `<a class="button" href="${escapeHTML(link)}"
        target="_blank" rel="noopener noreferrer">GitHub ↗</a>`;
    }
    $("githubSummary").textContent =
      extractSummary(issue.body || "") ||
      "Open the GitHub application for full project details.";
  } catch {
    if (request === modalRequest && dialog.open) {
      $("githubSummary").textContent =
        "GitHub details unavailable. Its API may be rate-limited.";
    }
  }
}

function extractSummary(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) =>
    /^(?:#{1,6}\s*|\*\*\s*)(?:project summary|description)/i.test(line.trim()),
  );
  if (start < 0) return "";
  const output = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s|^\*\*[^*]+\*\*\s*$/.test(line.trim())) break;
    output.push(line);
  }
  const text = output.join("\n").replace(/[#*`]/g, "").trim();
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

function clearModalURL() {
  modalRequest++;
  $("grantDialog").dataset.grant = "";
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  if (!params.has("grant")) return;
  params.delete("grant");
  const text = params.toString();
  history.replaceState(null, "", `#grants${text ? `?${text}` : ""}`);
}

/* ========================================================================
 * Security page: chart on the existing canvas + searchable table
 * ===================================================================== */
function renderSecurity() {
  const rows = data.security.filter((r) => r.date);
  const colors = chartColors();
  const keys = months(12);
  const types = [
    ["Audit", "Audits", colors.ink],
    ["Bounty", "Bounties", colors.amber],
    ["Security", "Other security", colors.gray],
  ];
  const datasets = types
    .map(([type, label, color]) => ({
      label,
      backgroundColor: color,
      borderRadius: 4,
      data: monthly(
        rows.filter((r) => r.type === type),
        keys,
        "usd",
      ),
    }))
    .filter((d) => d.data.some(Boolean));

  makeChart("securityChart", {
    type: "bar",
    data: { labels: keys, datasets },
    options: {
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          ticks: { color: colors.text, callback: (v) => usd(v) },
        },
      },
      plugins: {
        tooltip: {
          callbacks: { label: (c) => `${c.dataset.label}: ${usd(c.raw)}` },
        },
      },
    },
  });
  renderTable("security");
}

/* ========================================================================
 * Shared pages: stipends / notetaker / events (top stats + chart + table)
 * ===================================================================== */
const NUMERIC_FORMATS = ["usd", "zec", "rate"];
const DATE_FORMATS = ["date", "datelabel"];

function tableConfig(type) {
  const isNotes = (row) => NOTES_TEXT.test(row.project);
  if (type === "stipends") {
    return {
      target: "stipendsContent",
      rows: data.stipends,
      hasZec: true,
      tiles: true,
      columns: [
        ["date", "Date", "date"],
        ["recipient", "Member / recipient", "text"],
        ["usd", "USD value", "usd"],
        ["zec", "ZEC units", "zec"],
      ],
    };
  }
  if (type === "notetaker") {
    return {
      target: "notetakerContent",
      rows: data.contractors.filter(isNotes),
      hasZec: true,
      tiles: true,
      columns: [
        ["date", "Paid date", "date"],
        ["recipient", "Recipient", "text"],
        ["usd", "USD value", "usd"],
        ["zec", "ZEC units", "zec"],
        ["rate", "ZEC/USD", "rate"],
      ],
    };
  }
  if (type === "events") {
    return {
      target: "eventsContent",
      rows: events || [],
      hasZec: false,
      tiles: false,
      columns: [
        ["date", "Dates", "datelabel"],
        ["name", "Event", "link"],
        ["location", "Location", "text"],
        ["status", "Status", "badge"],
        ["typeText", "Funding type", "text"],
        ["usd", "Total cost", "usd"],
      ],
    };
  }
  return {
    target: "securityContent",
    rows: data.security,
    hasZec: true,
    tiles: true,
    columns: [
      ["date", "Paid date", "date"],
      ["type", "Type", "text"],
      ["project", "Project", "text"],
      ["recipient", "Recipient", "text"],
      ["usd", "USD value", "usd"],
      ["zec", "ZEC units", "zec"],
    ],
  };
}

function chartCard(type, title, caption) {
  return `<article class="card" style="margin-bottom:16px">
    <div class="card-heading"><div>
      <h2>${title}</h2><p>${caption}</p>
    </div></div>
    <div class="chart-wrap"><canvas id="${type}Chart"></canvas></div>
  </article>`;
}

function pageTop(type, config) {
  const keys = months(12);
  const monthsElapsed = new Date().getMonth() + 1;

  if (type === "stipends") {
    const rows = ytdRows(config.rows);
    const byMember = new Map();
    for (const row of rows) {
      const name = row.recipient || "Unknown";
      const current = byMember.get(name) || { usd: 0, zec: 0 };
      current.usd += row.usd;
      current.zec += row.zec;
      byMember.set(name, current);
    }
    const totalUSD = rows.reduce((s, r) => s + r.usd, 0);
    const totalZEC = rows.reduce((s, r) => s + r.zec, 0);
    const members = [...byMember].sort((a, b) => b[1].usd - a[1].usd);
    return `
      <div class="metrics-grid">
        <article class="card treasury-card">
          <div class="metric-label">Total YTD paid out</div>
          <div class="metric-value">${usd(totalUSD)}</div>
          <p class="metric-subtitle">${zec(totalZEC)} · ${members.length} members</p>
          ${stat("Avg per month (all members)", usd(totalUSD / monthsElapsed))}
          ${stat("Avg per member per month", usd(
            members.length ? totalUSD / monthsElapsed / members.length : 0,
          ))}
        </article>
        ${members
          .map(
            ([name, v]) => `
          <article class="card">
            <div class="metric-label">${escapeHTML(name)} · YTD</div>
            <div class="metric-value">${usd(v.usd)}</div>
            <p class="metric-subtitle">total paid this year · ${zec(v.zec)}</p>
            ${stat("Avg per month (YTD)", usd(v.usd / monthsElapsed))}
          </article>`,
          )
          .join("")}
      </div>
      ${chartCard("stipends", "Monthly stipend payments", "USD paid per month · last 12 months")}`;
  }

  if (type === "notetaker") {
    const values = monthly(config.rows, keys, "usd");
    const firstIndex = values.findIndex((v) => v > 0);
    const divisor = firstIndex < 0 ? 12 : 12 - firstIndex;
    const last12 = values.reduce((s, v) => s + v, 0);
    const ytd = ytdRows(config.rows).reduce((s, r) => s + r.usd, 0);
    return `
      <div class="metrics-grid">
        <article class="card treasury-card">
          <div class="metric-label">Avg pay per month</div>
          <div class="metric-value">${usd(last12 / divisor)}</div>
          <p class="metric-subtitle">average over the last ${divisor} month${divisor === 1 ? "" : "s"} with data</p>
        </article>
        <article class="card">
          <div class="metric-label">Total YTD paid out</div>
          <div class="metric-value">${usd(ytd)}</div>
          <p class="metric-subtitle">${usd(ytd / monthsElapsed)} avg per month YTD</p>
        </article>
        <article class="card">
          <div class="metric-label">Last 12 months</div>
          <div class="metric-value">${usd(last12)}</div>
          <p class="metric-subtitle">${config.rows.length} payments all time</p>
        </article>
      </div>
      ${chartCard("notetaker", "Monthly notetaker payments", "USD paid per month · last 12 months")}`;
  }

  if (type === "events") {
    const all = config.rows;
    const done = all.filter((e) => e.status === "done");
    const upcoming = all.filter((e) => e.status !== "done");
    const start = yearStart();
    const doneYtd = done.filter((e) => {
      const d = date(e.date);
      return d && d >= start;
    });
    const sum = (list) => list.reduce((s, e) => s + e.usd, 0);
    const byType = {};
    for (const e of done) byType[e.type] = (byType[e.type] || 0) + e.usd;
    return `
      <div class="metrics-grid">
        <article class="card treasury-card">
          <div class="metric-label">Total YTD paid out</div>
          <div class="metric-value">${usd(sum(doneYtd))}</div>
          <p class="metric-subtitle">${doneYtd.length} completed events</p>
          ${stat("Avg per event", usd(doneYtd.length ? sum(doneYtd) / doneYtd.length : 0))}
        </article>
        <article class="card">
          <div class="metric-label">Upcoming committed</div>
          <div class="metric-value">${usd(sum(upcoming))}</div>
          <p class="metric-subtitle">${upcoming.length} upcoming events</p>
          ${stat("Total tracked", usd(sum(all)))}
        </article>
        <article class="card">
          <div class="metric-label">Completed by type</div>
          <div class="metric-value">${done.length}</div>
          <p class="metric-subtitle">events done</p>
          ${Object.entries(byType)
            .sort((a, b) => b[1] - a[1])
            .map(([name, value]) => stat(escapeHTML(name), usd(value)))
            .join("")}
        </article>
      </div>
      ${chartCard("events", "Monthly event spending", "Completed events by start month · last 12 months · upcoming events excluded")}`;
  }
  return "";
}

function drawTableChart(type, config) {
  const colors = chartColors();
  const keys = months(12);
  const id = `${type}Chart`;
  const tooltip = {
    callbacks: { label: (c) => `${c.dataset.label}: ${usd(c.raw)}` },
  };
  const yAxis = { ticks: { color: colors.text, callback: (v) => usd(v) } };

  if (type === "events") {
    const done = config.rows.filter((e) => e.status === "done" && e.date);
    const types = [
      ["Grant", colors.ink],
      ["Sponsorship", colors.amber],
      ["Reimbursement", colors.gray],
      ["Other", "#c9c6bb"],
    ];
    const datasets = types
      .map(([name, color]) => ({
        label: name,
        backgroundColor: color,
        borderRadius: 4,
        data: monthly(
          done.filter((e) => e.type === name),
          keys,
          "usd",
        ),
      }))
      .filter((d) => d.data.some(Boolean));
    makeChart(id, {
      type: "bar",
      data: { labels: keys, datasets },
      options: {
        scales: { x: { stacked: true }, y: { stacked: true, ...yAxis } },
        plugins: { tooltip },
      },
    });
    return;
  }
  makeChart(id, {
    type: "bar",
    data: {
      labels: keys,
      datasets: [
        {
          label: "Paid (USD)",
          data: monthly(config.rows, keys, "usd"),
          backgroundColor: colors.amber,
          borderRadius: 4,
        },
      ],
    },
    options: {
      scales: { y: yAxis },
      plugins: { legend: { display: false }, tooltip },
    },
  });
}

function renderTable(type) {
  const config = tableConfig(type);
  const state = tableStates.get(type) || {
    query: "",
    sort: "date",
    direction: -1,
  };
  tableStates.set(type, state);
  const hasChart = type !== "security";
  $(config.target).innerHTML = `
    ${hasChart ? pageTop(type, config) : ""}
    <article class="card" data-table="${type}">
      <div class="table-summary" id="${type}Summary"></div>
      <input type="search" data-table-search="${type}"
        value="${escapeHTML(state.query)}"
        placeholder="Search all columns…" aria-label="Search ${type} records" />
      <p class="result-count" id="${type}Count"></p>
      <div class="table-scroll">
        <table>
          <thead><tr>
            ${config.columns
              .map(
                ([key, label, format]) => `
              <th scope="col" data-column="${key}"
                class="${NUMERIC_FORMATS.includes(format) ? "number" : ""}">
                <button data-table-sort="${type}" data-key="${key}">
                  ${label} <span data-sort-mark="${key}"></span>
                </button>
              </th>`,
              )
              .join("")}
          </tr></thead>
          <tbody id="${type}Rows"></tbody>
          <tfoot><tr>
            <td colspan="${config.columns.length}" id="${type}Totals"></td>
          </tr></tfoot>
        </table>
      </div>
    </article>`;
  if (hasChart) drawTableChart(type, config);
  updateTable(type);
}

function updateTable(type) {
  const config = tableConfig(type);
  const state = tableStates.get(type);
  if (!state || !$(`${type}Rows`)) return;
  const query = norm(state.query);
  const cellText = (row, key, format) =>
    format === "date"
      ? fmtDate(row[key])
      : format === "datelabel"
        ? row.dateLabel
        : row[key];
  const rows = config.rows.filter((row) =>
    norm(
      config.columns
        .map(([key, , format]) => cellText(row, key, format))
        .join(" "),
    ).includes(query),
  );

  rows.sort((a, b) => {
    const column = config.columns.find(([key]) => key === state.sort);
    const isDate = DATE_FORMATS.includes(column?.[2]);
    const left = isDate ? +(date(a[state.sort]) || 0) : a[state.sort];
    const right = isDate ? +(date(b[state.sort]) || 0) : b[state.sort];
    return (
      (typeof left === "number"
        ? left - right
        : String(left || "").localeCompare(String(right || ""))) *
      state.direction
    );
  });

  const sumOf = (list, field) =>
    list.reduce((sum, row) => sum + (row[field] || 0), 0);

  if (config.tiles) {
    const ytd = ytdRows(config.rows);
    $(`${type}Summary`).innerHTML = `
      <div><strong>${usd(sumOf(ytd, "usd"))}</strong><span>Total YTD paid out</span></div>
      ${
        config.hasZec
          ? `<div><strong>${zec(sumOf(ytd, "zec"))}</strong><span>Total YTD paid out (ZEC units)</span></div>`
          : ""
      }
      <div><strong>${ytd.length}</strong><span>Payments YTD</span></div>`;
  } else {
    $(`${type}Summary`).innerHTML = "";
  }

  $(`${type}Count`).textContent =
    `${rows.length} of ${config.rows.length} records shown`;

  const formatCell = (value, format, row) => {
    if (format === "date") return fmtDate(value);
    if (format === "datelabel") return escapeHTML(row.dateLabel || "—");
    if (format === "usd") return usd(value || 0);
    if (format === "zec") return value ? zec(value) : "—";
    if (format === "rate") return value ? Number(value).toFixed(2) : "—";
    if (format === "link") {
      return row.url
        ? `<a href="${escapeHTML(row.url)}" target="_blank"
            rel="noopener noreferrer">${escapeHTML(value)} ↗</a>`
        : escapeHTML(value || "—");
    }
    if (format === "badge") {
      const label = String(value || "—");
      return `<span class="badge ${value === "done" ? "green" : "yellow"}">${escapeHTML(
        label.charAt(0).toUpperCase() + label.slice(1),
      )}</span>`;
    }
    return escapeHTML(value || "—");
  };
  $(`${type}Rows`).innerHTML = rows.length
    ? rows
        .map(
          (row) => `<tr>${config.columns
            .map(
              ([key, , format]) =>
                `<td class="${NUMERIC_FORMATS.includes(format) ? "number" : ""}">${formatCell(row[key], format, row)}</td>`,
            )
            .join("")}</tr>`,
        )
        .join("")
    : `<tr><td colspan="${config.columns.length}" class="empty">
        No matching records.</td></tr>`;
  $(`${type}Totals`).textContent = config.hasZec
    ? `Totals for rows shown: ${usd(sumOf(rows, "usd"))} · ${zec(sumOf(rows, "zec"))}`
    : `Total for rows shown: ${usd(sumOf(rows, "usd"))}`;

  $(config.target)
    .querySelectorAll("[data-column]")
    .forEach((header) => {
      const selected = header.dataset.column === state.sort;
      header.setAttribute(
        "aria-sort",
        selected ? (state.direction === 1 ? "ascending" : "descending") : "none",
      );
      header.querySelector("[data-sort-mark]").textContent = selected
        ? state.direction === 1
          ? "↑"
          : "↓"
        : "";
    });
}

/* ========================================================================
 * Liquidity: live Maya position, with sheet fallback
 * ===================================================================== */
async function getJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
  return response.json();
}

async function fetchMaya() {
  const [member, pool] = await Promise.all([
    getJSON(`${MIDGARD}/member/${MAYA_ADDRESS}`),
    getJSON(`${MIDGARD}/pool/${MAYA_POOL}`),
  ]);
  const mine = member.pools?.find((p) => p.pool === MAYA_POOL);
  if (!mine) throw new Error("No ZEC.ZEC position found for this address.");
  const units = number(mine.liquidityUnits ?? mine.units);
  const totalUnits = number(pool.units ?? pool.liquidityUnits);
  const share = totalUnits ? units / totalUnits : 0;
  const assetDepth = number(pool.assetDepth) / ASSET_DECIMALS;
  const cacaoDepth = number(pool.runeDepth) / CACAO_DECIMALS;
  const zecUsd = number(pool.assetPriceUSD);
  const cacaoUsd = cacaoDepth ? (zecUsd * assetDepth) / cacaoDepth : 0;
  const myZec = assetDepth * share;
  const myCacao = cacaoDepth * share;
  const value = myZec * zecUsd + myCacao * cacaoUsd;
  /* Impermanent loss is measured against simply holding the original
   * 2,580.34 ZEC (worth exactly $100,000 at deposit). */
  const held = ENTRY_ZEC * zecUsd;
  return {
    share: share * 100,
    myZec,
    myCacao,
    zecUsd,
    cacaoUsd,
    value,
    poolZec: assetDepth,
    poolUsd: assetDepth * zecUsd + cacaoDepth * cacaoUsd,
    held,
    il: held ? (value / held - 1) * 100 : 0,
    vsHeld: value - held,
    vsEntry: value - ENTRY_USD,
  };
}

function drawLiquidity(m, timestamp = Date.now()) {
  const pct = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const cacao = (v) =>
    Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  $("liquidityCaption").textContent =
    `Live position data from Maya Midgard · Updated ` +
    `${new Date(timestamp).toLocaleString()} · refreshes every 6h`;
  $("liquidityContent").innerHTML = `
    <article class="card">
      <div class="metric-label">Position value</div>
      <div class="metric-value">${usd(m.value)}</div>
      ${stat("ZEC", zec(m.myZec))}
      ${stat("CACAO", cacao(m.myCacao))}
      ${stat("Pool share", m.share.toFixed(2) + "%")}
      ${stat("vs $100K entry", usd(m.vsEntry))}
    </article>
    <article class="card">
      <div class="metric-label">Impermanent loss</div>
      <div class="metric-value">${pct(m.il)}</div>
      <p class="metric-subtitle">position vs. holding the original ${zec(ENTRY_ZEC)}</p>
      ${stat(`If ${zec(ENTRY_ZEC)} were held`, usd(m.held))}
      ${stat("Position vs holding", usd(m.vsHeld))}
      ${stat("Initial deposit", `${zec(ENTRY_ZEC)} = ${usd(ENTRY_USD)}`)}
    </article>
    <article class="card">
      <div class="metric-label">Total ZEC pool liquidity on Maya</div>
      <div class="metric-value">${usd(m.poolUsd)}</div>
      ${stat("ZEC in pool", zec(m.poolZec))}
      ${stat("ZEC price", usd(m.zecUsd))}
      ${stat("CACAO price", "$" + m.cacaoUsd.toFixed(3))}
    </article>`;
}

function drawSheetLiquidity() {
  const metrics = new Map();
  let contributions = 0;
  for (const row of (data?.liquidity || []).slice(1)) {
    if (row[0] && number(row[1]) > 0) contributions += number(row[1]);
    if (row[7]) metrics.set(norm(row[7]), number(row[8]));
  }
  const loss = [...metrics].find(([key]) => key.includes("gain/loss"))?.[1];
  const values = [
    ["Recorded contributions", usd(contributions)],
    [
      "Current wallet value",
      metrics.has("usd value in wallet")
        ? usd(metrics.get("usd value in wallet"))
        : "—",
    ],
    ["ZEC balance", metrics.has("zec") ? zec(metrics.get("zec")) : "—"],
    [
      "CACAO balance",
      metrics.has("cacao") ? metrics.get("cacao").toLocaleString() : "—",
    ],
    ["Reported gain / loss", loss == null ? "—" : usd(loss)],
  ];
  $("liquidityCaption").textContent =
    "Live Maya data unavailable · showing figures from the spreadsheet.";
  $("liquidityContent").innerHTML = values
    .map(
      ([label, value]) => `
      <article class="card">
        <div class="metric-label">${label}</div>
        <div class="metric-value">${value}</div>
      </article>`,
    )
    .join("");
}

async function renderLiquidity() {
  if (mayaLoading) return;
  const cached = readCache(MAYA_KEY);
  if (cached?.value) {
    drawLiquidity(cached.value, cached.timestamp);
    if (Date.now() - cached.timestamp < MAYA_TTL) return;
  } else {
    $("liquidityContent").innerHTML = '<div class="card skeleton-card"></div>';
  }
  mayaLoading = true;
  try {
    const m = await fetchMaya();
    writeCache(MAYA_KEY, m);
    drawLiquidity(m);
  } catch (error) {
    console.error(error);
    if (!cached?.value) {
      if (data?.liquidity?.length) drawSheetLiquidity();
      else {
        $("liquidityContent").innerHTML = `<div class="card">
          Could not load Maya liquidity. ${escapeHTML(error.message)}</div>`;
      }
    }
  } finally {
    mayaLoading = false;
  }
}

/* ========================================================================
 * Events & init
 * ===================================================================== */
function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem("theme", theme);
    } catch {}
  }
  $("themeToggle").setAttribute(
    "aria-label",
    `Switch to ${theme === "dark" ? "light" : "dark"} mode`,
  );
}

$("refreshButton").addEventListener("click", refreshData);
$("themeToggle").addEventListener("click", () => {
  const theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(theme);
  // Re-render so charts pick up the new CSS variable colors.
  renderedPages.clear();
  renderActivePage();
});

$("grantSearch").addEventListener(
  "input",
  debounce(() => {
    if (data) renderGrants();
  }),
);
for (const id of ["grantStatus", "grantBudget", "grantCategory", "grantSort"]) {
  $(id).addEventListener("change", () => {
    updateGrantURL();
    if (data) renderGrants();
  });
}
$("grantsContainer").addEventListener("click", (event) => {
  const button = event.target.closest("[data-grant]");
  if (!button || !data) return;
  const grant = data.grants.find((item) => item.id === button.dataset.grant);
  if (grant) showGrant(grant);
});

document.addEventListener(
  "input",
  debounce((event) => {
    const type = event.target.dataset?.tableSearch;
    if (!type || !tableStates.has(type)) return;
    tableStates.get(type).query = event.target.value;
    updateTable(type);
  }),
);

document.addEventListener("click", (event) => {
  const tableSort = event.target.closest("[data-table-sort]");
  if (tableSort) {
    const type = tableSort.dataset.tableSort;
    const state = tableStates.get(type);
    state.direction =
      state.sort === tableSort.dataset.key ? -state.direction : 1;
    state.sort = tableSort.dataset.key;
    updateTable(type);
    return;
  }
  const rangeBtn = event.target.closest("[data-recipient-range]");
  if (rangeBtn && data) {
    recipientView.range = rangeBtn.dataset.recipientRange;
    renderRecipients();
    return;
  }
  const sizeBtn = event.target.closest("[data-recipient-size]");
  if (sizeBtn && data) {
    recipientView.size = sizeBtn.dataset.recipientSize;
    renderRecipients();
    return;
  }
  const recipientButton = event.target.closest("[data-recipient-sort]");
  if (recipientButton && data) {
    const k = recipientButton.dataset.recipientSort;
    recipientSort.dir =
      recipientSort.key === k ? -recipientSort.dir : k === "name" ? 1 : -1;
    recipientSort.key = k;
    renderRecipients();
  }
  const payoutBtn = event.target.closest("[data-payout-range]");
  if (payoutBtn && data) {
    chartRanges.payout = payoutBtn.dataset.payoutRange;
    payoutBtn.parentElement
      .querySelectorAll("button")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === payoutBtn)));
    renderOverviewCharts();
    return;
  }

  const approvalBtn = event.target.closest("[data-approval-range]");
  if (approvalBtn && data) {
    chartRanges.approval = approvalBtn.dataset.approvalRange;
    approvalBtn.parentElement
      .querySelectorAll("button")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === approvalBtn)));
    renderOverviewCharts();
    return;
  }
});

$("closeDialog").addEventListener("click", () => $("grantDialog").close());
$("grantDialog").addEventListener("close", clearModalURL);
$("grantDialog").addEventListener("click", (event) => {
  if (event.target !== $("grantDialog")) return;
  const bounds = $("grantDialog").getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  ) {
    $("grantDialog").close();
  }
});
window.addEventListener("hashchange", route);

/* ========================================================================
 * Custom dropdowns (native <select> stays hidden and keeps working)
 * ===================================================================== */
function closeMenus() {
  document.querySelectorAll(".dropdown-menu:not([hidden])").forEach((menu) => {
    menu.hidden = true;
    menu.previousElementSibling.setAttribute("aria-expanded", "false");
  });
}

function syncDropdowns() {
  document.querySelectorAll("select").forEach((s) => s._sync?.());
}

function enhanceSelect(select) {
  if (select.dataset.enhanced) return;
  select.dataset.enhanced = "1";
  select.classList.add("native-hidden");
  const wrap = document.createElement("div");
  wrap.className = "dropdown";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dropdown-button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", select.getAttribute("aria-label") || "Choose");
  const menu = document.createElement("div");
  menu.className = "dropdown-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  select.after(wrap);
  wrap.append(select, button, menu);

  const sync = () => {
    button.textContent = select.selectedOptions[0]?.textContent || "";
    menu.innerHTML = [...select.options]
      .map((o) => `<button type="button" class="button" role="option" class="dropdown-option"
        data-value="${escapeHTML(o.value)}" aria-selected="${o.selected}">
        ${escapeHTML(o.textContent)}</button>`)
      .join("");
  };
  select._sync = sync;
  sync();

  button.addEventListener("click", () => {
    const wasOpen = !menu.hidden;
    closeMenus();
    if (wasOpen) return;
    sync();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    select.value = option.dataset.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
    closeMenus();
  });
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".dropdown")) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});
document.querySelectorAll("select").forEach(enhanceSelect);

/* Boot */
applyTheme(document.documentElement.dataset.theme || "light", false);
const cached = readCache(CACHE_KEY);
if (
  cached?.value?.grants &&
  cached.value.treasury &&
  cached.value.security &&
  cached.value.recipients
) {
  data = cached.value;
}
const cachedEvents = readCache(EVENTS_KEY);
if (Array.isArray(cachedEvents?.value) && cachedEvents.value.length) {
  events = cachedEvents.value;
}
route();
if (data) updateStatus();
if (!data || Date.now() - cached.timestamp > CACHE_TTL) refreshData();
else if (!events || Date.now() - cachedEvents.timestamp > CACHE_TTL) {
  loadEvents();
}
