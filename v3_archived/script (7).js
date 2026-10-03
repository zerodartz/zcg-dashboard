/* ===== ZCG Dashboard — Optimized Complete Edition ===== */

/* ===== Global Variables ===== */
let workbook = null;
let workbookPromise = null;

let allGrants = [];
let filteredGrants = [];
let currentPayoutData = [];
let currentTimeFilter = "ytd";
let currentSortMode = 0;
let lastUpdateTime = null;
let updateTimeTimeout = null;
let currentStatusFilter = "all";
let currentBudgetFilter = "all";
let currentCategoryFilter = "all";
let currentPaidOutAmountFilter = "all";
let currentApprovedTimeFilter = "ytd";
let loadedTabs = new Set();
let pendingGrantToOpen = null;

// GitHub cache
const githubIssueCache = {};

// App-level cache
const parsedSheetCache = {
  aoa: new Map(),
  objects: new Map(),
};

let appData = null;
let appDataPromise = null;
let zecPricePromise = null;

/* ===== Local Cache ===== */
const LOCAL_CACHE_KEY = "zcg-dashboard-appdata-v3";
const LOCAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const ZEC_PRICE_CACHE_KEY = "zcg-dashboard-zec-price-v1";
const ZEC_PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/* ===== Sort Modes ===== */
const sortModes = [
  { key: "newest", icon: "📅", text: "Newest" },
  { key: "oldest", icon: "📅", text: "Oldest" },
  { key: "biggest", icon: "💰", text: "Biggest" },
  { key: "smallest", icon: "💰", text: "Smallest" },
];

/* ===== XLSX Source ===== */
const XLSX_URL =
  "https://docs.google.com/spreadsheets/d/1FQ28rDCyRW0TiNxrm3rgD8ai2KGUsXAjPieQmI1kKKg/export?format=xlsx";

const ZEC_PRICE_URL =
  "https://api.coingecko.com/api/v3/coins/zcash/market_chart?vs_currency=usd&days=90";

const SHEETS = {
  DASHBOARD_ZCG: "ZCG Dashboard",
  DASHBOARD_LOCKBOX: "Lockbox Dashboard",
  GRANTS_ZCG: "ZCG Grants",
  GRANTS_LOCKBOX: "Lockbox Grants",
  FUNDS: "ZCG Funds Distribution",
  LIQUIDITY: "ZCG Liquidity",
  STIPENDS: "ZCG 2026 Stipend",
  IC_PAYOUTS: "ZCG IC Payouts",
  BUDGET_2025: "ZCG 2026 Disc. Budget",
  ALL_GRANTS: "ZCG All Grants Tracking",
};

/* ===== Tab Routes ===== */
const tabRoutes = {
  dashboard: { id: "dashboard", load: loadOverview },
  grants: { id: "grants", load: loadGrants },
  payments: { id: "payments", load: loadPayouts },
  auditpayments: { id: "auditpayments", load: loadICPayouts },
  liquidity: { id: "liquidity", load: loadLiquidity },
  stipends: { id: "stipends", load: loadStipends },
  notetaker: { id: "notetaker", load: loadNotetaker },
};

/* ===== Utility Functions ===== */
const cleanNumber = (val) =>
  parseFloat((val ?? "0").toString().replace(/[$,%\s,]/g, "")) || 0;

const formatUSD = (num) =>
  "$" +
  Number(num).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const formatZEC = (num) =>
  Number(num).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " ZEC";

function formatZecPrice(num) {
  const n = Number(cleanNumber(num)) || 0;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function normKey(s) {
  return (s || "")
    .toString()
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getCurrentYear() {
  return new Date().getFullYear();
}

function debounce(fn, delay = 150) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

/* ===== Date Coercion ===== */
const dateCache = new Map();

function toDate(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (v === null || v === undefined || v === "") return null;

  const key = typeof v === "string" || typeof v === "number" ? String(v) : null;
  if (key && dateCache.has(key)) return dateCache.get(key);

  let result = null;

  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) {
      result = new Date(
        Date.UTC(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0)
      );
    }
  } else if (typeof v === "string") {
    const s = v.trim();
    if (s) {
      const dt = new Date(s);
      if (!isNaN(dt)) {
        result = dt;
      } else {
        const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if (m) {
          const mm = parseInt(m[1], 10);
          const dd = parseInt(m[2], 10);
          const yy = parseInt(m[3], 10);
          const yyyy = yy < 100 ? 2000 + yy : yy;
          const d2 = new Date(yyyy, mm - 1, dd);
          if (!isNaN(d2)) result = d2;
        }
      }
    }
  }

  if (key) dateCache.set(key, result);
  return result;
}

function fmtDateCell(v) {
  const d = toDate(v);
  if (!d || isNaN(d)) return "";
  return d.toLocaleDateString();
}

/* ===== Workbook Loader ===== */
async function loadWorkbook({ force = false } = {}) {
  if (!force && workbook) return workbook;
  if (!force && workbookPromise) return workbookPromise;

  workbookPromise = (async () => {
    const res = await fetch(XLSX_URL, { cache: "default" });
    if (!res.ok) throw new Error("Failed to download XLSX");

    const buf = await res.arrayBuffer();

    parsedSheetCache.aoa.clear();
    parsedSheetCache.objects.clear();

    workbook = XLSX.read(buf, { type: "array" });
    return workbook;
  })();

  try {
    return await workbookPromise;
  } finally {
    workbookPromise = null;
  }
}

/* ===== Sheet Helpers ===== */
function sheetToAoA(name, opts = {}) {
  const cacheKey = `${name}::aoa::${JSON.stringify(opts)}`;
  if (parsedSheetCache.aoa.has(cacheKey)) {
    return parsedSheetCache.aoa.get(cacheKey);
  }

  const ws = workbook?.Sheets?.[name];
  const value = ws
    ? XLSX.utils.sheet_to_json(ws, {
        header: 1,
        blankrows: false,
        raw: true,
        ...opts,
      })
    : [];

  parsedSheetCache.aoa.set(cacheKey, value);
  return value;
}

function sheetToObjects(name, headerRowIndex = 0, opts = {}) {
  const cacheKey = `${name}::obj::${headerRowIndex}::${JSON.stringify(opts)}`;
  if (parsedSheetCache.objects.has(cacheKey)) {
    return parsedSheetCache.objects.get(cacheKey);
  }

  const aoa = sheetToAoA(name, opts);
  if (!aoa.length) {
    parsedSheetCache.objects.set(cacheKey, []);
    return [];
  }

  const headers = (aoa[headerRowIndex] || []).map((h) =>
    (h || "").toString().replace(/\u00A0/g, " ").trim()
  );

  const rows = aoa
    .slice(headerRowIndex + 1)
    .filter((r) => r.some((c) => c !== null && c !== undefined && c !== ""));

  const objs = rows.map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      if (!h) return;
      o[h] = r[i];
    });
    return o;
  });

  parsedSheetCache.objects.set(cacheKey, objs);
  return objs;
}

/* ===== Local Cache Helpers ===== */
function serializeAppDataForCache(data) {
  return JSON.stringify({
    timestamp: Date.now(),
    data: {
      ...data,
      lastUpdateTime: data.lastUpdateTime
        ? data.lastUpdateTime.toISOString()
        : null,
      grants: (data.grants || []).map((g) => ({
        ...g,
        submissionDate: g.submissionDate
          ? g.submissionDate.toISOString()
          : null,
        lastPaidDate: g.lastPaidDate ? g.lastPaidDate.toISOString() : null,
        milestones: (g.milestones || []).map((m) => ({
          ...m,
          dueDate: m.dueDate && toDate(m.dueDate)
            ? toDate(m.dueDate).toISOString()
            : m.dueDate || null,
          paidDate: m.paidDate && toDate(m.paidDate)
            ? toDate(m.paidDate).toISOString()
            : m.paidDate || null,
          estimate: m.estimate && toDate(m.estimate)
            ? toDate(m.estimate).toISOString()
            : m.estimate || null,
        })),
      })),
      approvedAllRaw: (data.approvedAllRaw || []).map((r) => ({
        ...r,
        date: r.date ? new Date(r.date).toISOString() : null,
      })),
    },
  });
}

function hydrateAppDataFromCache(payload) {
  if (!payload?.data) return null;
  const d = payload.data;

  return {
    ...d,
    lastUpdateTime: d.lastUpdateTime ? new Date(d.lastUpdateTime) : null,
    grants: (d.grants || []).map((g) => ({
      ...g,
      submissionDate: g.submissionDate ? new Date(g.submissionDate) : null,
      lastPaidDate: g.lastPaidDate ? new Date(g.lastPaidDate) : null,
      milestones: (g.milestones || []).map((m) => ({
        ...m,
        dueDate: m.dueDate ? new Date(m.dueDate) : null,
        paidDate: m.paidDate ? new Date(m.paidDate) : null,
        estimate: m.estimate ? new Date(m.estimate) : null,
      })),
    })),
    approvedAllRaw: (d.approvedAllRaw || []).map((r) => ({
      ...r,
      date: r.date ? new Date(r.date) : null,
    })),
  };
}

function loadCachedAppData() {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed?.timestamp || !parsed?.data) return null;
    if (Date.now() - parsed.timestamp > LOCAL_CACHE_TTL_MS) return null;

    return hydrateAppDataFromCache(parsed);
  } catch (err) {
    console.warn("Failed to read local app cache:", err);
    return null;
  }
}

function saveCachedAppData(data) {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, serializeAppDataForCache(data));
  } catch (err) {
    console.warn("Failed to write local app cache:", err);
  }
}

function loadTimedJsonCache(key, ttlMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed?.timestamp) return null;
    if (Date.now() - parsed.timestamp > ttlMs) return null;

    return parsed.data ?? null;
  } catch (err) {
    console.warn(`Failed to read cache for ${key}:`, err);
    return null;
  }
}

function saveTimedJsonCache(key, data) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        timestamp: Date.now(),
        data,
      })
    );
  } catch (err) {
    console.warn(`Failed to write cache for ${key}:`, err);
  }
}

/* ===== Status Helpers ===== */
function getDecisionStatus(rawDecision) {
  const s = (rawDecision || "")
    .toString()
    .replace(/\u00A0/g, " ")
    .trim()
    .toLowerCase();

  if (!s) return "unknown";

  if (s.includes("approved")) return "approved";
  if (s.includes("reject") || s.includes("decline")) return "rejected";
  if (s.includes("withdraw")) return "withdrawn";
  if (s.includes("filter")) return "filtered";
  if (
    s.includes("discussion") ||
    s.includes("discuss") ||
    s.includes("zcg to discuss")
  ) {
    return "discussion";
  }
  if (s.includes("cancel")) return "cancelled";

  return "unknown";
}

function getOperationalStatusFromMilestones(milestones) {
  const completedMilestones = milestones.filter((m) => !!m.paidDate).length;
  const totalMilestones = milestones.length;

  let status = "waiting";
  if (completedMilestones === totalMilestones && totalMilestones > 0) {
    status = "completed";
  } else if (completedMilestones > 0) {
    status = "in-progress";
  }

  return {
    status,
    completedMilestones,
    totalMilestones,
  };
}

/* ===== Data Builders ===== */
function buildProjectMetaFromAllGrants(allAoA) {
  const meta = {};
  if (!allAoA.length) return meta;

  const headers = (allAoA[0] || []).map((h) =>
    (h || "").toString().replace(/\u00A0/g, " ").trim()
  );
  const normHeaders = headers.map((h) => h.toLowerCase().replace(/\s+/g, " "));

  const COL_DATE = 0;
  const COL_TITLE = 1;
  const COL_DECISION = 5;
  const forumIdx = normHeaders.findIndex(
    (h) => h.includes("forum") && h.includes("link")
  );

  for (let i = 1; i < allAoA.length; i++) {
    const row = allAoA[i] || [];
    const rawTitle = (row[COL_TITLE] || "").toString().trim();
    if (!rawTitle) continue;

    const d = toDate(row[COL_DATE]);
    const decisionRaw = row[COL_DECISION];
    const forumLink =
      forumIdx >= 0 ? (row[forumIdx] || "").toString().trim() : "";

    const key = normKey(rawTitle);
    const existing = meta[key] || {};

    const submissionDate =
      existing.submissionDate && d
        ? d < existing.submissionDate
          ? d
          : existing.submissionDate
        : d || existing.submissionDate || null;

    const decisionStatus = getDecisionStatus(
      decisionRaw != null ? decisionRaw : existing.decisionRaw
    );

    meta[key] = {
      submissionDate,
      decisionStatus,
      forumLink: forumLink || existing.forumLink || null,
    };
  }

  return meta;
}

function buildUnifiedGrants(grantsRows, allGrantsAoA) {
  const projectMeta = buildProjectMetaFromAllGrants(allGrantsAoA);

  const grantsHeaderAoa = sheetToAoA(SHEETS.GRANTS_ZCG);
  const headers = (grantsHeaderAoa[0] || []).map((h) =>
    (h || "").toString().replace(/\u00A0/g, " ").trim()
  );
  const headerNorm = headers.map((h) => h.replace(/\s+/g, " ").toLowerCase());
  const idxCategory = headerNorm.indexOf("category (as determined by zcg)");
  const categoryHeader =
    idxCategory >= 0 ? headers[idxCategory] : "Category (as determined by ZCG)";

  const projectMap = {};

  // Pass 1: approved/active grants from ZCG Grants
  grantsRows.forEach((row) => {
    const project = (row["Project"] || "").toString().trim();
    const grantee =
      (
        row["Grantee"] ||
        row["Applicant(s)"] ||
        row["Applicant"] ||
        row["Recipient"] ||
        ""
      )
        .toString()
        .trim();

    if (!project || !grantee) return;

    const key = `${project}_${grantee}`;
    const meta = projectMeta[normKey(project)] || {};

    if (!projectMap[key]) {
      projectMap[key] = {
        project,
        grantee,
        totalAmount: 0,
        paidAmount: 0,
        milestones: [],
        lastPaidDate: null,
        category: "",
        submissionDate: meta.submissionDate || null,
        decisionStatus: meta.decisionStatus || "approved",
        forumLink: meta.forumLink || null,
      };
    }

    const cat = (row[categoryHeader] || "")
      .toString()
      .replace(/\u00A0/g, " ")
      .trim();
    if (cat && !projectMap[key].category) {
      projectMap[key].category = cat;
    }

    const amount = cleanNumber(row["Amount (USD)"]);
    projectMap[key].totalAmount += amount;

    const paidDate = toDate(row["Paid Out"]);
    if (paidDate) {
      projectMap[key].paidAmount += amount;
      if (!projectMap[key].lastPaidDate || paidDate > projectMap[key].lastPaidDate) {
        projectMap[key].lastPaidDate = paidDate;
      }
    }

    projectMap[key].milestones.push({
      amount,
      dueDate: toDate(row["Milestone Due Date"]),
      paidDate,
      estimate: toDate(row["Estimate"]),
    });
  });

  // Pass 2: add discussion/rejected proposals from ALL_GRANTS
  for (let i = 1; i < allGrantsAoA.length; i++) {
    const row = allGrantsAoA[i] || [];
    const project = (row[1] || "").toString().trim();
    const grantee = (row[2] || "").toString().trim();
    const decisionStatus = getDecisionStatus(row[5]);

    if (!project || !grantee) continue;
    if (decisionStatus !== "rejected" && decisionStatus !== "discussion") {
      continue;
    }

    const key = `${project}_${grantee}`;
    if (projectMap[key]) {
      if (
        projectMap[key].decisionStatus === "unknown" ||
        projectMap[key].decisionStatus === "approved"
      ) {
        projectMap[key].decisionStatus = decisionStatus;
      }
      continue;
    }

    const meta = projectMeta[normKey(project)] || {};

    projectMap[key] = {
      project,
      grantee,
      totalAmount: 0,
      paidAmount: 0,
      milestones: [],
      lastPaidDate: null,
      category: "",
      submissionDate: meta.submissionDate || toDate(row[0]),
      decisionStatus,
      forumLink: meta.forumLink || null,
    };
  }

  return Object.values(projectMap)
    .filter(
      (grant) =>
        grant.decisionStatus !== "cancelled" &&
        grant.decisionStatus !== "withdrawn"
    )
    .map((grant) => {
      const operational = getOperationalStatusFromMilestones(grant.milestones);
      return {
        ...grant,
        ...operational,
        category: grant.category || "",
        submissionDate: grant.submissionDate || null,
        decisionStatus: grant.decisionStatus || "unknown",
        forumLink: grant.forumLink || null,
      };
    });
}

function buildProjectTotalsFromGrants(grantsRows) {
  const totals = {};
  grantsRows.forEach((r) => {
    const project = (r["Project"] || "").toString();
    const key = normKey(project);
    if (!key) return;
    totals[key] = (totals[key] || 0) + cleanNumber(r["Amount (USD)"]);
  });
  return totals;
}

function computeGrantStatsFromRows(grantRows) {
  const year = getCurrentYear();
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const twelveMonthsAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  const getKey = (r) => {
    const project = (r["Project"] || "").toString().trim();
    const grantee = (
      r["Grantee"] ||
      r["Applicant(s)"] ||
      r["Applicant"] ||
      r["Recipient"] ||
      ""
    )
      .toString()
      .trim();
    return project && grantee ? `${project}__${grantee}` : "";
  };

  const getApprovedDate = (r) =>
    toDate(
      r["Date Committee Approved/ Rejected"] ||
        r["Date Committee Approved/Rejected"] ||
        r["Approved Date"] ||
        r["Date"]
    );

  const getPaidDate = (r) => toDate(r["Paid Out"]);
  const getAmountUSD = (r) => cleanNumber(r["Amount (USD)"]);
  const getZecDisbursed = (r) => cleanNumber(r["ZEC Disbursed"] || r["ZEC"] || 0);

  const projectMap = new Map();

  let payout30dUSD = 0;
  let payout30dZEC = 0;
  let payout12mUSD = 0;
  let payout12mZEC = 0;
  let newLiabilities12m = 0;

  grantRows.forEach((r) => {
    const key = getKey(r);
    if (!key) return;

    if (!projectMap.has(key)) {
      projectMap.set(key, {
        project: (r["Project"] || "").toString().trim(),
        grantee: (
          r["Grantee"] ||
          r["Applicant(s)"] ||
          r["Applicant"] ||
          r["Recipient"] ||
          ""
        )
          .toString()
          .trim(),
        milestones: [],
        approvedDates: [],
        totalBudget: 0,
      });
    }

    const rec = projectMap.get(key);
    const paidDate = getPaidDate(r);
    const amtUsd = getAmountUSD(r);
    const zec = getZecDisbursed(r);
    const approvedDate = getApprovedDate(r);

    rec.milestones.push({ paidDate, amtUsd, zec });
    rec.totalBudget += amtUsd;

    if (approvedDate) rec.approvedDates.push(approvedDate);

    if (paidDate && paidDate >= thirtyDaysAgo) {
      payout30dUSD += amtUsd;
      payout30dZEC += zec;
    }

    if (paidDate && paidDate >= twelveMonthsAgo) {
      payout12mUSD += amtUsd;
      payout12mZEC += zec;
    }
  });

  const totalProjects = projectMap.size;
  let totalCompleted = 0;
  let inProgress = 0;
  let waiting = 0;
  let approvedYTD = 0;
  let completedYTD = 0;
  let payoutsYTDUSD = 0;
  let payoutsYTDZEC = 0;
  let totalApprovedBudget = 0;
  let approvedBudgetYTD = 0;
  let approvedBudget30d = 0;

  projectMap.forEach((rec) => {
    const hasMilestones = rec.milestones.length > 0;
    const allPaid = hasMilestones && rec.milestones.every((m) => !!m.paidDate);
    const anyPaid = rec.milestones.some((m) => !!m.paidDate);

    if (allPaid) totalCompleted++;
    else if (anyPaid) inProgress++;
    else waiting++;

    const earliestApproved = rec.approvedDates.length
      ? new Date(Math.min(...rec.approvedDates.map((d) => d.getTime())))
      : null;

    let earliestActivity = earliestApproved;
    if (!earliestActivity) {
      const paidDates = rec.milestones.map((m) => m.paidDate).filter(Boolean);
      if (paidDates.length) {
        earliestActivity = new Date(Math.min(...paidDates.map((d) => d.getTime())));
      }
    }

    totalApprovedBudget += rec.totalBudget;

    if (earliestActivity && earliestActivity.getFullYear() === year) {
      approvedYTD++;
      approvedBudgetYTD += rec.totalBudget;

      if (earliestActivity >= thirtyDaysAgo) {
        approvedBudget30d += rec.totalBudget;
      }
    }

    if (earliestActivity && earliestActivity >= twelveMonthsAgo) {
      newLiabilities12m += rec.totalBudget;
    }

    if (allPaid) {
      const paidDates = rec.milestones.map((m) => m.paidDate).filter(Boolean);
      if (paidDates.length) {
        const lastPaid = new Date(Math.max(...paidDates.map((d) => d.getTime())));
        if (lastPaid.getFullYear() === year) {
          completedYTD++;
        }
      }
    }

    rec.milestones.forEach((m) => {
      if (m.paidDate && m.paidDate.getFullYear() === year) {
        payoutsYTDUSD += m.amtUsd;
        payoutsYTDZEC += m.zec;
      }
    });
  });

  return {
    year,
    totalProjects,
    totalCompleted,
    inProgress,
    waiting,
    approvedYTD,
    completedYTD,
    payoutsYTDUSD,
    payoutsYTDZEC,
    payout30dUSD,
    payout30dZEC,
    approvedBudget30d,
    avgMonthlyPayout12m: payout12mUSD / 12,
    avgMonthlyPayoutZec12m: payout12mZEC / 12,
    avgMonthlyLiabilities12m: newLiabilities12m / 12,
    totalApprovedBudget,
    approvedBudgetYTD,
  };
}

function buildApprovedAllRaw(allGrantsAoA) {
  const COL_DATE = 6;
  const COL_TITLE = 1;
  const COL_DECISION = 5;

  const approvedRows = [];

  for (let i = 1; i < allGrantsAoA.length; i++) {
    const row = allGrantsAoA[i];
    if (!row) continue;

    const rawDate = row[COL_DATE];
    const title = (row[COL_TITLE] || "").toString().trim();
    const decisionRaw = (row[COL_DECISION] || "")
      .toString()
      .replace(/\u00A0/g, " ")
      .trim()
      .toLowerCase();
    const decision = decisionRaw.replace(/[^\w\s]/g, "").trim();

    if (!title || !rawDate) continue;
    if (decision !== "approved") continue;

    const d = toDate(rawDate);
    if (!d) continue;

    approvedRows.push({ date: d, title });
  }

  return approvedRows;
}

function buildCategoryTotalsFromFunds(aoaFunds) {
  const COL_CLASSIFICATION = 14;
  const COL_USD_PAID = 15;

  const categoryTotals = {};

  for (let r = 2; r < aoaFunds.length; r++) {
    const row = aoaFunds[r] || [];
    const labelCell = row[COL_CLASSIFICATION];
    const valueCell = row[COL_USD_PAID];

    if (typeof labelCell === "string" && labelCell.trim()) {
      const label = labelCell.trim();
      if (label.length > 0 && label !== "TOTAL") {
        const amount = cleanNumber(valueCell);
        if (amount > 0) {
          categoryTotals[label] = (categoryTotals[label] || 0) + amount;
        }
      }
    }
  }

  return categoryTotals;
}

function buildPayoutsByMonth(grantsRows) {
  const monthlyMap = {};

  grantsRows.forEach((row) => {
    const date = toDate(row["Paid Out"]);
    if (!date) return;

    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0"
    )}`;

    if (!monthlyMap[monthKey]) {
      monthlyMap[monthKey] = { amount: 0, milestones: 0 };
    }

    monthlyMap[monthKey].amount += cleanNumber(row["Amount (USD)"]);
    monthlyMap[monthKey].milestones += 1;
  });

  return monthlyMap;
}

function aggregateByGrantee(rawRows) {
  const by = {};
  rawRows.forEach((r) => {
    by[r.grantee] = (by[r.grantee] || 0) + (r.amount || 0);
  });

  return Object.entries(by)
    .map(([grantee, amount]) => ({ grantee, amount }))
    .sort((a, b) => b.amount - a.amount);
}

function applyAmountFilter(aggregated, range) {
  if (range === "all") return aggregated.slice();

  switch (range) {
    case "small":
      return aggregated.filter((d) => d.amount < 50000);
    case "medium":
      return aggregated.filter((d) => d.amount >= 50000 && d.amount <= 200000);
    case "large":
      return aggregated.filter((d) => d.amount > 200000);
    default:
      return aggregated.slice();
  }
}

function buildPaymentsData(aoaFunds) {
  let headerRowIndex = -1;

  for (let i = 0; i < Math.min(aoaFunds.length, 10); i++) {
    const row = aoaFunds[i] || [];
    const rowText = row.join(" ").toLowerCase();
    if (rowText.includes("recipient") && rowText.includes("paid out")) {
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex === -1) {
    return {
      paidOutRawFunds: [],
      paidOutOriginal: [],
      futureOriginal: [],
    };
  }

  const headers = (aoaFunds[headerRowIndex] || []).map((h) =>
    (h || "").toString().replace(/\u00A0/g, " ").trim()
  );

  const dataRows = aoaFunds
    .slice(headerRowIndex + 1)
    .filter((r) => r.some((c) => c !== null && c !== undefined && c !== ""));

  const objF = dataRows.map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      if (h) o[h] = r[i];
    });
    return o;
  });

  const recipientCol = headers.find((h) => /recipient|classification/i.test(h));
  const paidOutAmtCol = headers.find((h) => /paid\s*out/i.test(h));
  const futureCol = headers.find((h) => /future\s*milestones/i.test(h));

  if (!recipientCol || !paidOutAmtCol || !futureCol) {
    return {
      paidOutRawFunds: [],
      paidOutOriginal: [],
      futureOriginal: [],
    };
  }

  const paidOutRawFunds = objF
    .filter((r) => {
      const recipient = (r[recipientCol] || "").toString().trim().toLowerCase();
      return (
        cleanNumber(r[paidOutAmtCol]) > 0 &&
        r[recipientCol] &&
        !recipient.includes("total")
      );
    })
    .map((r) => ({
      grantee: (r[recipientCol] || "").toString().trim(),
      amount: cleanNumber(r[paidOutAmtCol]),
      date: "",
    }));

  const paidOutOriginal = aggregateByGrantee(paidOutRawFunds);

  const futureOriginal = objF
    .map((r) => ({
      grantee: (r[recipientCol] || "").toString().trim(),
      amount: cleanNumber(r[futureCol]),
    }))
    .filter(
      (r) =>
        r.amount > 0 &&
        r.grantee !== "" &&
        !r.grantee.toLowerCase().includes("total")
    )
    .sort((a, b) => b.amount - a.amount);

  return {
    paidOutRawFunds,
    paidOutOriginal,
    futureOriginal,
  };
}

/* ===== App Data Boot ===== */
async function buildAppData(options = {}) {
  await loadWorkbook(options);

  const dashboardRows = sheetToAoA(SHEETS.DASHBOARD_ZCG, { blankrows: true });
  const grantsRows = sheetToObjects(SHEETS.GRANTS_ZCG, 0);
  const allGrantsAoA = sheetToAoA(SHEETS.ALL_GRANTS);
  const fundsAoA = sheetToAoA(SHEETS.FUNDS);
  const stipendsRows = sheetToObjects(SHEETS.STIPENDS, 0);
  const icRows = sheetToObjects(SHEETS.IC_PAYOUTS, 0);
  const liquidityAoA = sheetToAoA(SHEETS.LIQUIDITY);

  const grants = buildUnifiedGrants(grantsRows, allGrantsAoA);
  const projectTotalsMap = buildProjectTotalsFromGrants(grantsRows);
  const grantStats = computeGrantStatsFromRows(grantsRows);
  const approvedAllRaw = buildApprovedAllRaw(allGrantsAoA);
  const categoryTotals = buildCategoryTotalsFromFunds(fundsAoA);
  const payoutsByMonth = buildPayoutsByMonth(grantsRows);
  const paymentsData = buildPaymentsData(fundsAoA);

  const norm = (s) =>
    (s || "").toString().replace(/\u00A0/g, " ").trim().toLowerCase();

  const getValue = (label) => {
    const r = dashboardRows.find((row) => norm(row[0]).includes(norm(label)));
    return r ? r[1] : null;
  };

  const blockTimeUTC = getValue("Block time (UTC)");
  const dt =
    blockTimeUTC ? toDate(blockTimeUTC) || new Date(`${blockTimeUTC} UTC`) : null;

  return {
    dashboardRows,
    grantsRows,
    allGrantsAoA,
    fundsAoA,
    stipendsRows,
    icRows,
    liquidityAoA,
    grants,
    projectTotalsMap,
    grantStats,
    approvedAllRaw,
    categoryTotals,
    payoutsByMonth,
    paidOutRawFunds: paymentsData.paidOutRawFunds,
    paidOutOriginal: paymentsData.paidOutOriginal,
    futureOriginal: paymentsData.futureOriginal,
    lastUpdateTime: dt || null,
  };
}

async function ensureAppData({ force = false } = {}) {
  if (!force && appData) return appData;
  if (!force && appDataPromise) return appDataPromise;

  if (!force) {
    const cached = loadCachedAppData();
    if (cached) {
      appData = cached;
      allGrants = appData.grants || [];
      lastUpdateTime = appData.lastUpdateTime || null;
      updateLastUpdateTime();
      return appData;
    }
  }

  appDataPromise = (async () => {
    try {
      const fresh = await buildAppData({ force });

      appData = fresh;
      allGrants = fresh.grants || [];
      lastUpdateTime = fresh.lastUpdateTime || null;
      updateLastUpdateTime();
      saveCachedAppData(fresh);

      return appData;
    } finally {
      appDataPromise = null;
    }
  })();

  return appDataPromise;
}

async function getCachedZecPriceChart() {
  const cached = loadTimedJsonCache(
    ZEC_PRICE_CACHE_KEY,
    ZEC_PRICE_CACHE_TTL_MS
  );
  if (cached) return cached;

  if (zecPricePromise) return zecPricePromise;

  zecPricePromise = (async () => {
    const res = await fetch(ZEC_PRICE_URL, { cache: "default" });
    if (!res.ok) {
      throw new Error(`CoinGecko fetch failed: ${res.status}`);
    }

    const data = await res.json();
    saveTimedJsonCache(ZEC_PRICE_CACHE_KEY, data);
    return data;
  })();

  try {
    return await zecPricePromise;
  } finally {
    zecPricePromise = null;
  }
}

/* ===== Navigation ===== */
function showPage(pageName) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));

  const targetPage = document.getElementById(pageName);
  if (targetPage) targetPage.classList.add("active");

  document.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));
  document
    .querySelectorAll(".bottom-nav-link")
    .forEach((l) => l.classList.remove("active"));
  document
    .querySelectorAll(`[data-page="${pageName}"]`)
    .forEach((l) => l.classList.add("active"));

  if (pendingGrantToOpen && !loadedTabs.has("grants")) {
    loadGrants();
    loadedTabs.add("grants");
  }

  if (!loadedTabs.has(pageName)) {
    const tabInfo = tabRoutes[pageName];
    if (tabInfo) {
      tabInfo.load();
      loadedTabs.add(pageName);
    }
  }

  if (pageName === "dashboard" && loadedTabs.has("dashboard")) {
    loadPayoutsChart();
    loadCategoryChart();
    loadZecPriceTrend();
    loadApprovedChart();
  }

  if (!window.location.hash.includes("?")) {
    history.pushState({ page: pageName }, "", `#${pageName}`);
  }

  const titles = {
    dashboard: "Dashboard",
    grants: "Grants",
    payments: "Payments",
    auditpayments: "Audit Payments",
    liquidity: "Maya Liquidity",
    stipends: "Stipends",
    notetaker: "Notetaker Payments",
  };

  document.title = `${titles[pageName] || "Dashboard"} - Zcash Community Grants`;
}

function initNavigation() {
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showPage(link.dataset.page);
    });
  });

  document.querySelectorAll(".bottom-nav-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showPage(link.dataset.page);
    });
  });

  window.addEventListener("popstate", (e) => {
    const page = e.state?.page || getPageFromHash();
    showPage(page);
  });

  const initialPage = getPageFromHash();
  showPage(initialPage);
}

function getPageFromHash() {
  const hash = window.location.hash.substring(1);
  const basePage = hash.split("?")[0];
  return tabRoutes[basePage] ? basePage : "dashboard";
}

function checkPendingGrant() {
  const hash = window.location.hash;
  if (hash.includes("grant=")) {
    const params = new URLSearchParams(hash.split("?")[1]);
    const grantId = params.get("grant");
    if (grantId) {
      pendingGrantToOpen = decodeGrantId(grantId);
    }
  }
}

/* ===== Theme Toggle ===== */
function initThemeToggle() {
  const themeToggle = document.getElementById("themeToggle");
  if (!themeToggle) return;

  const savedTheme = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  themeToggle.textContent = savedTheme === "dark" ? "☀️" : "🌙";

  themeToggle.addEventListener("click", () => {
    const currentTheme = document.documentElement.getAttribute("data-theme");
    const newTheme = currentTheme === "dark" ? "light" : "dark";

    document.documentElement.setAttribute("data-theme", newTheme);
    localStorage.setItem("theme", newTheme);
    themeToggle.textContent = newTheme === "dark" ? "☀️" : "🌙";
  });
}

/* ===== Update Time ===== */
function updateLastUpdateTime() {
  const desktopEl = document.getElementById("desktopUpdateTime");
  if (!desktopEl) return;

  if (lastUpdateTime) {
    desktopEl.textContent = `Last updated: ${lastUpdateTime.toLocaleString()}`;
  } else {
    desktopEl.textContent = "Last updated: Unavailable";
  }
}

function startUpdateTimeFallback() {
  updateTimeTimeout = setTimeout(() => {
    if (!lastUpdateTime) updateLastUpdateTime();
  }, 10000);
}

/* ===== Search & Filters ===== */
function setupSearch() {
  const searchInput = document.getElementById("desktopSearch");
  if (!searchInput) return;

  searchInput.addEventListener("focus", () => {
    if (window.location.hash.split("?")[0] !== "#grants") {
      showPage("grants");
    }
  });

  searchInput.addEventListener(
    "input",
    debounce((e) => {
      const query = (e.target.value || "").toLowerCase();
      filterGrantsBySearch(query);
    }, 150)
  );
}

function initGrantsFilters() {
  document.querySelectorAll("#statusFilters .filter-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#statusFilters .filter-tab")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentStatusFilter = btn.dataset.filter;
      applyFilters();
    });
  });

  document.querySelectorAll("#budgetFilters .filter-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#budgetFilters .filter-tab")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentBudgetFilter = btn.dataset.budget;
      applyFilters();
    });
  });

  const sortBtn = document.getElementById("sortBtn");
  if (sortBtn) {
    sortBtn.addEventListener("click", cycleSortMode);
  }

  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".view-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const container = document.getElementById("grantsContainer");
      if (container) {
        container.classList.toggle("list-view", btn.dataset.view === "list");
      }
    });
  });
}

function initDashboardFilters() {
  document.querySelectorAll("#timeFilters .filter-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#timeFilters .filter-tab")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentTimeFilter = btn.dataset.range;
      loadPayoutsChart();
    });
  });
}

/* ===== Chart Options ===== */
const getChartOptions = () => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      labels: {
        color: getComputedStyle(document.documentElement)
          .getPropertyValue("--text-secondary")
          .trim(),
        font: { size: 12, weight: "400" },
      },
    },
  },
  scales: {
    x: {
      grid: {
        color: getComputedStyle(document.documentElement)
          .getPropertyValue("--grid-color")
          .trim(),
      },
      ticks: {
        color: getComputedStyle(document.documentElement)
          .getPropertyValue("--text-tertiary")
          .trim(),
        font: { size: 11 },
      },
    },
    y: {
      grid: {
        color: getComputedStyle(document.documentElement)
          .getPropertyValue("--grid-color")
          .trim(),
      },
      ticks: {
        color: getComputedStyle(document.documentElement)
          .getPropertyValue("--text-tertiary")
          .trim(),
        font: { size: 11 },
      },
    },
  },
});

/* ===== Global Event Listeners ===== */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modalOverlay = document.getElementById("modalOverlay");
    if (modalOverlay && modalOverlay.classList.contains("active")) {
      closeModal();
    }
  }
});

/* ===== URL Filter Functions ===== */
function updateURLWithFilters() {
  if (window.location.hash.split("?")[0] !== "#grants") return;

  const params = new URLSearchParams();
  if (currentStatusFilter !== "all") params.set("status", currentStatusFilter);
  if (currentBudgetFilter !== "all") params.set("budget", currentBudgetFilter);
  if (currentCategoryFilter !== "all") params.set("category", currentCategoryFilter);
  if (currentSortMode !== 0) params.set("sort", sortModes[currentSortMode].key);

  const currentHash = window.location.hash;
  if (currentHash.includes("grant=")) {
    const currentParams = new URLSearchParams(currentHash.split("?")[1] || "");
    const grant = currentParams.get("grant");
    if (grant) params.set("grant", grant);
  }

  const paramString = params.toString();
  const newHash = paramString ? `#grants?${paramString}` : "#grants";
  history.replaceState({ page: "grants" }, "", newHash);
}

function readFiltersFromURL() {
  const hash = window.location.hash;
  if (!hash.startsWith("#grants")) return false;

  const queryPart = hash.split("?")[1];
  if (!queryPart) return false;

  const params = new URLSearchParams(queryPart);

  if (params.has("status")) {
    currentStatusFilter = params.get("status");
    document.querySelectorAll("#statusFilters .filter-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.filter === currentStatusFilter);
    });
  }

  if (params.has("budget")) {
    currentBudgetFilter = params.get("budget");
    document.querySelectorAll("#budgetFilters .filter-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.budget === currentBudgetFilter);
    });
  }

  if (params.has("category")) {
    currentCategoryFilter = params.get("category");
  }

  if (params.has("sort")) {
    const sortKey = params.get("sort");
    const idx = sortModes.findIndex((m) => m.key === sortKey);
    if (idx >= 0) {
      currentSortMode = idx;
      const sortBtn = document.getElementById("sortBtn");
      if (sortBtn) {
        sortBtn.innerHTML = `${sortModes[idx].icon} ${sortModes[idx].text}`;
      }
    }
  }

  return true;
}

/* ===== Dashboard / Overview ===== */
async function loadOverview() {
  try {
    const data = await ensureAppData();
    clearTimeout(updateTimeTimeout);
    updateLastUpdateTime();

    const rows = data.dashboardRows;
    const grantStats = data.grantStats;

    const norm = (s) =>
      (s || "").toString().replace(/\u00A0/g, " ").trim().toLowerCase();

    const getValue = (label) => {
      const r = rows.find((row) => norm(row[0]).includes(norm(label)));
      return r ? r[1] : null;
    };

    const getCellValue = (rowIndex, colIndex) => {
      const row = rows[rowIndex];
      return row ? row[colIndex] : null;
    };

    const zecPrice = cleanNumber(getValue("ZECUSD price"));
    const zecBal = cleanNumber(getValue("Current ZEC balance"));
    const usdBal = cleanNumber(getValue("Current USD balance"));
    const futureLiab = Math.abs(cleanNumber(getValue("Future grant liabilities")));
    const overhedgePercent = cleanNumber(getCellValue(48, 2)) * 100;
    const totalLifetimePayouts = cleanNumber(getCellValue(42, 1));
    const zecValueUSD = zecBal * zecPrice;
    const totalTreasuryUSD = zecValueUSD + usdBal;

    const DAILY_ZEC_INFLOW = 144;
    const MONTHLY_ZEC_INFLOW = DAILY_ZEC_INFLOW * 30;
    const monthlyInflowUSD = MONTHLY_ZEC_INFLOW * zecPrice;

    let otherPayouts30d = 0;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    data.icRows.forEach((r) => {
      const paidDate = toDate(r["Paid Out"]);
      if (paidDate && paidDate >= thirtyDaysAgo) {
        otherPayouts30d += cleanNumber(r["Amount (USD)"]);
      }
    });

    data.stipendsRows.forEach((r) => {
      const paidDate = toDate(r["Date"]);
      if (paidDate && paidDate >= thirtyDaysAgo) {
        otherPayouts30d += cleanNumber(r["USD Amount"]);
      }
    });

    const totalPayouts30d = grantStats.payout30dUSD + otherPayouts30d;

    const usdMetricsEl = document.getElementById("usdMetrics");
    const activityEl = document.getElementById("activityMetrics");
    if (!usdMetricsEl || !activityEl) return;

    const netFlow = monthlyInflowUSD - totalPayouts30d;
    const netFlowClass =
      netFlow >= 0 ? "color:var(--success)" : "color:var(--danger)";
    const avgBudgetAllTime =
      grantStats.totalProjects > 0
        ? grantStats.totalApprovedBudget / grantStats.totalProjects
        : 0;
    const avgGrantSizeYTD =
      grantStats.approvedYTD > 0
        ? grantStats.approvedBudgetYTD / grantStats.approvedYTD
        : 0;

    usdMetricsEl.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Total Treasury Value</div>
        <div class="stat-value">${formatUSD(totalTreasuryUSD)}</div>
        <div class="stat-change" style="margin-top:0.5rem;">
          <div><strong>ZEC Price:</strong> $${zecPrice.toFixed(2)}</div>
          <div><strong>ZEC:</strong> ${zecBal.toLocaleString(undefined, {
            maximumFractionDigits: 0,
          })} (${formatUSD(zecValueUSD)})</div>
          <div><strong>USD Stables:</strong> ${formatUSD(usdBal)}</div>
          <div style="color:var(--success);">
            <strong>Overhedge:</strong> ${overhedgePercent.toFixed(0)}% of assets
          </div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">30 Day Inflow & Outflow</div>
        <div class="stat-value" style="${netFlowClass}">
          ${netFlow >= 0 ? "+" : ""}${formatUSD(netFlow)}
        </div>
        <div class="stat-change" style="margin-top:0.5rem;">
          <div>
            <strong>Income:</strong> ${MONTHLY_ZEC_INFLOW.toLocaleString()} ZEC
            (${formatUSD(monthlyInflowUSD)}) — ${DAILY_ZEC_INFLOW} ZEC/day
          </div>
          <div style="margin-top:0.35rem;">
            <strong>Grant Payouts:</strong> ${formatUSD(grantStats.payout30dUSD)}
          </div>
          <div><strong>Other Payouts:</strong> ${formatUSD(otherPayouts30d)}</div>
          <div style="font-size:0.8em;color:var(--text-tertiary);">
            (Audit, Notetaker, Committee)
          </div>
          <div style="margin-top:0.35rem;font-weight:600;">
            <strong>Total Payouts:</strong> ${formatUSD(totalPayouts30d)}
          </div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Future Liabilities</div>
        <div class="stat-value">${formatUSD(futureLiab)}</div>
        <div class="stat-change" style="margin-top:0.5rem;">
          <div><strong>Grants in progress:</strong> ${formatUSD(futureLiab)}</div>
          <div style="margin-top:0.35rem;">
            <strong>New Approved (30d):</strong> ${formatUSD(
              grantStats.approvedBudget30d
            )}
          </div>
        </div>
      </div>
    `;

    activityEl.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Total Stats</div>
        <div class="stat-value">Lifetime payouts: ${formatUSD(
          totalLifetimePayouts
        )}</div>
        <div class="stat-value">${grantStats.totalProjects.toLocaleString()} Grants</div>
        <div class="stat-change">
          <div>
            <strong>Status:</strong> ${grantStats.totalCompleted} Done ·
            ${grantStats.inProgress} Active · ${grantStats.waiting} Pending
          </div>
          <div style="margin-top:0.35rem;">
            <strong>Avg Budget:</strong> ${formatUSD(avgBudgetAllTime)}
          </div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">${grantStats.year} Activity</div>
        <div class="stat-value">${grantStats.approvedYTD} Approved</div>
        <div class="stat-change">
          <div><strong>Completed:</strong> ${grantStats.completedYTD}</div>
          <div><strong>Payouts:</strong> ${formatUSD(grantStats.payoutsYTDUSD)}</div>
          <div>
            <strong>New Liabilities:</strong> ${formatUSD(
              grantStats.approvedBudgetYTD
            )}
          </div>
          <div style="margin-top:0.35rem;">
            <strong>Avg Size:</strong> ${formatUSD(avgGrantSizeYTD)}
          </div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Avg Monthly Payouts (12M)</div>
        <div class="stat-value">${formatUSD(grantStats.avgMonthlyPayout12m)}</div>
        <div class="stat-change">
          <div>
            <strong>ZEC:</strong> ${grantStats.avgMonthlyPayoutZec12m.toFixed(
              2
            )} ZEC/month
          </div>
          <div>
            <strong>New Liabilities/mo:</strong> ${formatUSD(
              grantStats.avgMonthlyLiabilities12m
            )}
          </div>
        </div>
      </div>
    `;

    requestIdleCallbackSafe(() => {
      loadPayoutsChart();
      loadCategoryChart();
      loadZecPriceTrend();
      loadApprovedChart();
    });
  } catch (error) {
    console.error("Error in loadOverview:", error);
    const usdEl = document.getElementById("usdMetrics");
    const actEl = document.getElementById("activityMetrics");
    if (usdEl) {
      usdEl.innerHTML =
        '<div class="loading-placeholder">Error loading treasury metrics</div>';
    }
    if (actEl) {
      actEl.innerHTML =
        '<div class="loading-placeholder">Error loading grants metrics</div>';
    }
  }
}

/* ===== Request Idle Safe ===== */
function requestIdleCallbackSafe(fn) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(fn);
  } else {
    setTimeout(fn, 0);
  }
}

/* ===== Payouts Chart ===== */
function filterMonthlyMapByTime(monthlyMap, range) {
  const now = new Date();
  let startDate = new Date();

  switch (range) {
    case "1m":
      startDate.setDate(now.getDate() - 30);
      break;
    case "3m":
      startDate.setDate(now.getDate() - 90);
      break;
    case "1y":
      startDate.setFullYear(now.getFullYear() - 1);
      break;
    case "ytd":
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    case "max":
      startDate = new Date(2020, 0, 1);
      break;
  }

  const filteredEntries = Object.entries(monthlyMap).filter(([monthKey]) => {
    const [year, month] = monthKey.split("-").map(Number);
    const d = new Date(year, month - 1, 1);
    return d >= startDate;
  });

  filteredEntries.sort(([a], [b]) => a.localeCompare(b));

  return {
    labels: filteredEntries.map(([m]) => m),
    amounts: filteredEntries.map(([, v]) => v.amount),
    milestones: filteredEntries.map(([, v]) => v.milestones),
  };
}

async function loadPayoutsChart() {
  try {
    const data = await ensureAppData();
    const chartData = filterMonthlyMapByTime(data.payoutsByMonth, currentTimeFilter);

    const ctx = document.getElementById("payoutsChart");
    if (!ctx) return;
    if (ctx.chart) ctx.chart.destroy();

    ctx.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: chartData.labels,
        datasets: [
          {
            label: "Milestones",
            data: chartData.milestones,
            borderColor: "#ff9800",
            backgroundColor: "rgba(255,152,0,0.2)",
            yAxisID: "y1",
            tension: 0.4,
          },
          {
            label: "Payouts (USD)",
            data: chartData.amounts,
            borderColor:
              getComputedStyle(document.documentElement)
                .getPropertyValue("--accent-third")
                .trim() || "#ffc17c",
            backgroundColor: "rgba(255,193,124,0.2)",
            yAxisID: "y2",
            tension: 0.4,
          },
        ],
      },
      options: {
        ...getChartOptions(),
        interaction: { mode: "index", intersect: false },
        scales: {
          x: getChartOptions().scales.x,
          y1: {
            type: "linear",
            position: "left",
            title: { display: true, text: "Milestones" },
            beginAtZero: true,
            grid: {
              color: getComputedStyle(document.documentElement)
                .getPropertyValue("--grid-color")
                .trim(),
            },
            ticks: {
              color: getComputedStyle(document.documentElement)
                .getPropertyValue("--text-tertiary")
                .trim(),
            },
          },
          y2: {
            type: "linear",
            position: "right",
            title: { display: true, text: "USD" },
            grid: { drawOnChartArea: false },
            ticks: {
              color: getComputedStyle(document.documentElement)
                .getPropertyValue("--text-tertiary")
                .trim(),
            },
          },
        },
      },
    });
  } catch (error) {
    console.error("Error loading payouts chart:", error);
  }
}

/* ===== Category Chart ===== */
async function loadCategoryChart() {
  try {
    const data = await ensureAppData();
    const categoryTotals = data.categoryTotals || {};
    const entries = Object.entries(categoryTotals).filter(([, v]) => v > 0);

    const canvas = document.getElementById("categoryChart");
    if (!canvas) return;

    if (!entries.length) {
      canvas.parentNode.innerHTML =
        '<div class="loading-placeholder">No category data found</div>';
      return;
    }

    const sorted = entries.sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(([cat]) => cat);
    const values = sorted.map(([, amount]) => amount);
    const total = values.reduce((sum, v) => sum + v, 0);

    const colors = [
      "#FFF3C4",
      "#FFE08A",
      "#FFC04D",
      "#FFB347",
      "#FFA534",
      "#FF9F1C",
      "#FF8C42",
      "#FF7F50",
      "#FF7043",
      "#FF6347",
      "#F4511E",
      "#E64A19",
      "#D84315",
      "#BF360C",
      "#FFD166",
    ];

    if (canvas.chart) canvas.chart.destroy();

    canvas.chart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: colors.slice(0, labels.length),
            borderColor:
              getComputedStyle(document.documentElement)
                .getPropertyValue("--bg-primary")
                .trim() || "#1a1a2e",
            borderWidth: 2,
            hoverOffset: 8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "28%",
        plugins: {
          legend: {
            display: true,
            position: "bottom",
            labels: {
              color: getComputedStyle(document.documentElement)
                .getPropertyValue("--text-secondary")
                .trim(),
              font: { size: 10 },
              padding: 10,
              usePointStyle: true,
              pointStyle: "circle",
            },
          },
          tooltip: {
            callbacks: {
              label(context) {
                const value = context.parsed || 0;
                const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
                return `${context.label}: ${formatUSD(value)} (${pct}%)`;
              },
            },
          },
        },
      },
    });
  } catch (error) {
    console.error("Error loading category chart:", error);
    const canvas = document.getElementById("categoryChart");
    if (canvas?.parentNode) {
      canvas.parentNode.innerHTML =
        '<div class="loading-placeholder">Error loading category data</div>';
    }
  }
}

/* ===== ZEC Price Trend ===== */
async function loadZecPriceTrend() {
  try {
    const data = await getCachedZecPriceChart();

    const filtered = (data.prices || []).filter((_, i) => i % 24 === 0);
    const prices = filtered.map((p) => ({ date: new Date(p[0]), price: p[1] }));

    const ctx = document.getElementById("zecPriceChart");
    if (!ctx) return;
    if (ctx.chart) ctx.chart.destroy();

    ctx.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: prices.map((p) => p.date.toLocaleDateString()),
        datasets: [
          {
            label: "ZEC/USD",
            data: prices.map((p) => p.price),
            borderColor: getComputedStyle(document.documentElement)
              .getPropertyValue("--accent-primary")
              .trim(),
            backgroundColor: "rgba(255,193,124,0.2)",
            fill: true,
            tension: 0.4,
            pointRadius: 2,
            pointHoverRadius: 5,
          },
        ],
      },
      options: getChartOptions(),
    });
  } catch (error) {
    console.error("Error loading ZEC price:", error);
  }
}

/* ===== Approved Grants Chart ===== */
function filterByTimeApproved(raw, range) {
  if (!Array.isArray(raw)) return [];
  if (range === "max") return raw.slice();

  const now = new Date();
  let start = new Date();

  switch (range) {
    case "1m":
      start.setMonth(now.getMonth() - 1);
      break;
    case "3m":
      start.setMonth(now.getMonth() - 3);
      break;
    case "1y":
      start.setFullYear(now.getFullYear() - 1);
      break;
    case "ytd":
      start = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      return raw.slice();
  }

  return raw.filter((r) => {
    const d = toDate(r.date);
    return d && d >= start;
  });
}

function bucketApprovedByMonthJoined(raw, projectMap) {
  const byMonth = {};

  raw.forEach((r) => {
    const d = toDate(r.date);
    if (!d) return;

    const keyMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}`;

    if (!byMonth[keyMonth]) byMonth[keyMonth] = { amount: 0, count: 0 };
    byMonth[keyMonth].count += 1;

    const usd = projectMap[normKey(r.title)] || 0;
    byMonth[keyMonth].amount += usd;
  });

  const entries = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b));
  return {
    labels: entries.map(([k]) => k),
    amounts: entries.map(([, v]) => v.amount),
    counts: entries.map(([, v]) => v.count),
  };
}

function renderApprovedChartJoined(data) {
  const ctx = document.getElementById("approvedChart");
  if (!ctx) return;
  if (ctx.chart) ctx.chart.destroy();

  const { labels, amounts, counts } = data;

  ctx.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Grants",
          data: counts,
          borderColor: "#ff9800",
          backgroundColor: "rgba(255,152,0,0.2)",
          yAxisID: "y1",
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
        {
          label: "Approved (USD)",
          data: amounts,
          borderColor:
            getComputedStyle(document.documentElement)
              .getPropertyValue("--accent-third")
              .trim() || "#ffc17c",
          backgroundColor: "rgba(255,193,124,0.2)",
          yAxisID: "y2",
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      ...getChartOptions(),
      interaction: { mode: "index", intersect: false },
      scales: {
        x: getChartOptions().scales.x,
        y1: {
          type: "linear",
          position: "left",
          title: { display: true, text: "Grants (count)" },
          beginAtZero: true,
          grid: {
            color: getComputedStyle(document.documentElement)
              .getPropertyValue("--grid-color")
              .trim(),
          },
          ticks: {
            color: getComputedStyle(document.documentElement)
              .getPropertyValue("--text-tertiary")
              .trim(),
          },
        },
        y2: {
          type: "linear",
          position: "right",
          title: { display: true, text: "USD" },
          grid: { drawOnChartArea: false },
          ticks: {
            color: getComputedStyle(document.documentElement)
              .getPropertyValue("--text-tertiary")
              .trim(),
            callback: (v) => formatUSD(v),
          },
        },
      },
    },
  });
}

function setupApprovedTimeFilters() {
  const container = document.getElementById("approvedTimeFilters");
  if (!container || container.dataset.bound === "1") return;

  container.querySelectorAll(".filter-tab").forEach((pill) => {
    pill.addEventListener("click", () => {
      container
        .querySelectorAll(".filter-tab")
        .forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentApprovedTimeFilter = pill.dataset.range || "ytd";
      loadApprovedChart();
    });
  });

  container.dataset.bound = "1";
}

async function loadApprovedChart() {
  try {
    const data = await ensureAppData();
    const filtered = filterByTimeApproved(
      data.approvedAllRaw,
      currentApprovedTimeFilter
    );
    const bucketed = bucketApprovedByMonthJoined(
      filtered,
      data.projectTotalsMap
    );
    renderApprovedChartJoined(bucketed);
    setupApprovedTimeFilters();
  } catch (err) {
    console.error("Error loading approved chart:", err);
  }
}

/* ===== Grants ===== */
async function loadGrants() {
  try {
    const data = await ensureAppData();
    allGrants = data.grants || [];
    readFiltersFromURL();
    setupCategoryFilters();
    applyFilters();
    openGrantFromURL();
  } catch (error) {
    console.error("Error in loadGrants:", error);
    const container = document.getElementById("grantsContainer");
    if (container) {
      container.innerHTML =
        '<div class="loading-placeholder">Error loading grants data</div>';
    }
  }
}

/* ===== URL Sharing ===== */
function encodeGrantId(project, grantee) {
  return encodeURIComponent(`${project}::${grantee}`);
}

function decodeGrantId(id) {
  const decoded = decodeURIComponent(id);
  const parts = decoded.split("::");
  if (parts.length >= 2) {
    return { project: parts[0], grantee: parts.slice(1).join("::") };
  }
  return null;
}

/* ===== Grant Sorting ===== */
function cycleSortMode() {
  currentSortMode = (currentSortMode + 1) % sortModes.length;
  const mode = sortModes[currentSortMode];

  const sortBtn = document.getElementById("sortBtn");
  if (sortBtn) sortBtn.innerHTML = `${mode.icon} ${mode.text}`;

  sortGrants();
  updateURLWithFilters();
}

function sortGrants() {
  const mode = sortModes[currentSortMode];
  const getDate = (g) => g.lastPaidDate || g.submissionDate;

  switch (mode.key) {
    case "newest":
      filteredGrants.sort((a, b) => {
        const dateA = getDate(a);
        const dateB = getDate(b);
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB - dateA;
      });
      break;
    case "oldest":
      filteredGrants.sort((a, b) => {
        const dateA = getDate(a);
        const dateB = getDate(b);
        if (!dateA && !dateB) return 0;
        if (!dateA) return -1;
        if (!dateB) return 1;
        return dateA - dateB;
      });
      break;
    case "biggest":
      filteredGrants.sort((a, b) => b.totalAmount - a.totalAmount);
      break;
    case "smallest":
      filteredGrants.sort((a, b) => a.totalAmount - b.totalAmount);
      break;
  }

  renderGrants(filteredGrants);
}

/* ===== Grant Filters ===== */
function filterByStatusSet(grants, statusFilter) {
  if (statusFilter === "all") {
    return grants.filter(
      (g) => g.decisionStatus !== "rejected" && g.decisionStatus !== "discussion"
    );
  }

  if (statusFilter === "discussion") {
    return grants.filter((g) => g.decisionStatus === "discussion");
  }

  if (statusFilter === "declined") {
    return grants.filter((g) => g.decisionStatus === "rejected");
  }

  return grants.filter(
    (g) =>
      g.status === statusFilter &&
      g.decisionStatus !== "rejected" &&
      g.decisionStatus !== "discussion"
  );
}

function filterByBudgetSet(grants, budgetFilter) {
  switch (budgetFilter) {
    case "small":
      return grants.filter((g) => g.totalAmount < 50000);
    case "medium":
      return grants.filter((g) => g.totalAmount >= 50000 && g.totalAmount <= 200000);
    case "large":
      return grants.filter((g) => g.totalAmount > 200000);
    default:
      return grants;
  }
}

function filterByCategorySet(grants, categoryFilter) {
  if (categoryFilter === "all") return grants;
  const catNorm = categoryFilter.toLowerCase();
  return grants.filter((g) => (g.category || "").toLowerCase() === catNorm);
}

function filterGrantsBySearch(query) {
  if (!allGrants.length) return;

  let result = [...allGrants];

  if (query) {
    result = result.filter((grant) => {
      const cat = (grant.category || "").toLowerCase();
      return (
        grant.project.toLowerCase().includes(query) ||
        grant.grantee.toLowerCase().includes(query) ||
        cat.includes(query)
      );
    });
  }

  result = filterByStatusSet(result, currentStatusFilter);
  result = filterByBudgetSet(result, currentBudgetFilter);
  result = filterByCategorySet(result, currentCategoryFilter);

  filteredGrants = result;
  sortGrants();
  updateURLWithFilters();
}

function applyFilters() {
  let result = [...allGrants];
  result = filterByStatusSet(result, currentStatusFilter);
  result = filterByBudgetSet(result, currentBudgetFilter);
  result = filterByCategorySet(result, currentCategoryFilter);

  filteredGrants = result;
  sortGrants();
  updateURLWithFilters();
}

/* ===== Category Filters ===== */
function setupCategoryFilters() {
  const container = document.getElementById("categoryFilters");
  if (!container) return;

  const cats = Array.from(
    new Set(
      allGrants
        .map((g) => (g.category || "").replace(/\u00A0/g, " ").trim())
        .filter((c) => c)
    )
  ).sort((a, b) => a.localeCompare(b));

  const base = `<button class="filter-tab ${
    currentCategoryFilter === "all" ? "active" : ""
  }" data-cat="all">All Categories</button>`;

  const pills = cats
    .map(
      (c) =>
        `<button class="filter-tab ${
          currentCategoryFilter === c ? "active" : ""
        }" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
    )
    .join("");

  container.innerHTML = base + pills;

  container.querySelectorAll(".filter-tab").forEach((pill) => {
    pill.addEventListener("click", () => {
      container
        .querySelectorAll(".filter-tab")
        .forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentCategoryFilter = pill.dataset.cat || "all";
      applyFilters();
    });
  });
}

/* ===== Render Grants ===== */
function renderGrants(grants) {
  const container = document.getElementById("grantsContainer");
  if (!container) return;

  updateGrantsCounter(grants.length, allGrants.length);

  if (!grants.length) {
    container.innerHTML =
      '<div class="loading-placeholder">No grants found</div>';
    return;
  }

  container.innerHTML = grants
    .map((grant) => {
      const progressPercent =
        grant.totalMilestones > 0
          ? (grant.completedMilestones / grant.totalMilestones) * 100
          : 0;

      const pctPaid =
        grant.totalAmount > 0
          ? Math.round((grant.paidAmount / grant.totalAmount) * 100)
          : 0;

      const decisionLabel =
        grant.decisionStatus === "discussion"
          ? "Discussion Required"
          : grant.decisionStatus === "rejected"
          ? "Declined"
          : null;

      const openedPill = grant.submissionDate
        ? `<span class="meta-pill meta-pill-opened">
             Opened: ${new Date(grant.submissionDate).toLocaleDateString()}
           </span>`
        : "";

      const categoryPill = grant.category
        ? `<span class="category-pill">${escapeHtml(grant.category)}</span>`
        : "";

      const statusPill =
        grant.decisionStatus !== "rejected" &&
        grant.decisionStatus !== "discussion"
          ? `<span class="grant-status ${grant.status}">
               ${grant.status.replace("-", " ").toUpperCase()}
               (${grant.completedMilestones}/${grant.totalMilestones})
             </span>`
          : "";

      return `
        <div class="grant-card ${grant.status}" onclick="showGrantDetails('${escapeHtml(
          grant.project
        )}', '${escapeHtml(grant.grantee)}')">
          <div class="grant-title">${escapeHtml(grant.project)}</div>
          <div class="grant-grantee">${escapeHtml(grant.grantee)}</div>

          <div class="meta-pill-row">
            ${openedPill}
            ${categoryPill}
            ${statusPill}
          </div>

          <div class="grant-amount">${formatUSD(grant.totalAmount)}</div>

          <div class="progress-bar">
            <div class="progress-fill ${grant.status}" style="width: ${progressPercent}%;"></div>
          </div>

          <div class="grant-paid-line">
            ${formatUSD(grant.paidAmount)} paid (${pctPaid}%)
          </div>

          ${
            decisionLabel
              ? `<div class="grant-status ${
                  grant.decisionStatus === "discussion"
                    ? "discussion"
                    : "declined"
                }">Decision: ${decisionLabel.toUpperCase()}</div>`
              : ""
          }

          <div class="grant-plus-btn"><span>+</span></div>
        </div>
      `;
    })
    .join("");
}

function updateGrantsCounter(filtered, total) {
  const counter = document.getElementById("grantsCounter");
  if (!counter) return;

  const percent = total > 0 ? ((filtered / total) * 100).toFixed(1) : 0;
  counter.textContent = `Showing ${filtered} of ${total} grants (${percent}%)`;
}

/* ===== Grant Details Modal (with GitHub) ===== */
async function findGitHubIssueByTitle(title) {
  if (githubIssueCache[title] !== undefined) return githubIssueCache[title];

  try {
    const searchGitHub = async (queryTitle) => {
      const query = encodeURIComponent(
        `"${queryTitle}" repo:ZcashCommunityGrants/zcashcommunitygrants`
      );
      const url = `https://api.github.com/search/issues?q=${query}`;
      const res = await fetch(url, {
        headers: { Accept: "application/vnd.github.v3+json" },
      });
      if (!res.ok) throw new Error(`GitHub search failed: ${res.status}`);

      const data = await res.json();
      if (data.items && data.items.length > 0) {
        const normalizedGrantTitle = queryTitle.trim().toLowerCase();
        const exactMatch = data.items.find(
          (issue) => issue.title.trim().toLowerCase() === normalizedGrantTitle
        );
        return exactMatch || data.items[0];
      }
      return null;
    };

    let issue = await searchGitHub(title);
    if (!issue) issue = await searchGitHub(`Grant Application - ${title}`);

    githubIssueCache[title] = issue;
    return issue;
  } catch (err) {
    console.error("Error searching GitHub issue:", err);
    githubIssueCache[title] = null;
    return null;
  }
}

async function fetchGitHubIssueBody(issueNumber) {
  try {
    const url = `https://api.github.com/repos/ZcashCommunityGrants/zcashcommunitygrants/issues/${issueNumber}`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) throw new Error(`GitHub issue fetch failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("Error fetching GitHub issue body:", err);
    return null;
  }
}

function extractProjectSummary(markdown) {
  const lines = markdown.split("\n");

  function findSection(keyword) {
    const regexHeading = new RegExp(`^#{2,}\\s*${keyword}.*$`, "i");
    const regexBold = new RegExp(`^\\*\\*\\s*${keyword}.*\\*\\*$`, "i");

    const startIndex = lines.findIndex((line) => {
      const clean = line.trim();
      return regexHeading.test(clean) || regexBold.test(clean);
    });

    if (startIndex === -1) return null;

    const sectionLines = [];
    for (let i = startIndex + 1; i < lines.length; i++) {
      if (/^#{1,6}\s+/.test(lines[i]) || /^\*\*.+\*\*$/.test(lines[i].trim())) {
        break;
      }
      sectionLines.push(lines[i]);
    }

    return sectionLines.join("\n").trim();
  }

  let summary = findSection("project summary");
  if (!summary) summary = findSection("description");
  return summary || null;
}

async function showGrantDetails(project, grantee) {
  const grant = allGrants.find(
    (g) => g.project === project && g.grantee === grantee
  );
  if (!grant) return;

  const grantId = encodeGrantId(project, grantee);
  const currentHash = window.location.hash;
  const params = new URLSearchParams(currentHash.split("?")[1] || "");
  params.set("grant", grantId);
  history.replaceState(
    { page: "grants", grant: grantId },
    "",
    `#grants?${params.toString()}`
  );

  const progressPercent =
    grant.totalMilestones > 0
      ? (grant.completedMilestones / grant.totalMilestones) * 100
      : 0;

  const paidMilestones = grant.milestones.filter((m) => !!m.paidDate);
  const futureMilestones = grant.milestones.filter((m) => !m.paidDate);

  const renderPaid = (m, i) => `
    <div class="milestone-item">
      <span>#${i + 1} — ${formatUSD(m.amount)}</span>
      <span style="color:var(--success);">Paid ${fmtDateCell(m.paidDate)}</span>
    </div>
  `;

  const renderFuture = (m, i) => {
    const est = fmtDateCell(m.estimate);
    const due = fmtDateCell(m.dueDate);
    const label = est || due ? (est ? `Est. ${est}` : `Due ${due}`) : "Date TBA";

    return `
      <div class="milestone-item">
        <span>#${i + 1} — ${formatUSD(m.amount)}</span>
        <span style="color: var(--text-tertiary);">${label}</span>
      </div>
    `;
  };

  const content = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
      <h2 style="font-size:1.25rem;font-weight:700;margin:0;">
        ${escapeHtml(project)}
      </h2>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="github-btn" id="shareGrantBtn" title="Copy link to this grant">
          🔗 Share
        </button>
        <span id="forumBtnSlot"></span>
        <span id="githubBtnSlot"></span>
      </div>
    </div>

    <div class="progress-bar" style="margin: 12px 0;">
      <div class="progress-fill ${grant.status}" style="width: ${progressPercent}%;"></div>
    </div>

    <div style="color:var(--text-secondary);margin-bottom:1rem;">
      ${escapeHtml(grantee)}
    </div>

    <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;font-size:0.85rem;">
      ${
        grant.submissionDate
          ? `<span><strong>Opened:</strong> ${new Date(
              grant.submissionDate
            ).toLocaleDateString()}</span>`
          : ""
      }
      <span><strong>Budget:</strong> ${formatUSD(grant.paidAmount)} / ${formatUSD(
    grant.totalAmount
  )}</span>
      ${
        grant.lastPaidDate
          ? `<span><strong>Last Payment:</strong> ${fmtDateCell(
              grant.lastPaidDate
            )}</span>`
          : ""
      }
      <span><strong>Milestones:</strong> ${grant.completedMilestones}/${
    grant.totalMilestones
  }</span>
    </div>

    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem;">
      ${
        grant.category
          ? `<span class="category-pill">${escapeHtml(grant.category)}</span>`
          : ""
      }
      ${
        grant.decisionStatus !== "rejected" &&
        grant.decisionStatus !== "discussion"
          ? `<span class="grant-status ${grant.status}">
               ${grant.status.replace("-", " ").toUpperCase()}
             </span>`
          : `<span class="grant-status ${
              grant.decisionStatus === "discussion" ? "discussion" : "declined"
            }">
               ${
                 grant.decisionStatus === "discussion"
                   ? "DISCUSSION REQUIRED"
                   : "DECLINED"
               }
             </span>`
      }
    </div>

    <div id="githubSection" style="margin-bottom:1.5rem;">
      <div style="color:var(--text-tertiary);font-size:0.85rem;">
        Loading GitHub details...
      </div>
    </div>

    ${
      paidMilestones.length
        ? `
      <h3 style="font-size:0.9rem;color:var(--text-secondary);margin-bottom:0.75rem;">
        Paid Milestones
      </h3>
      <div class="milestone-list">
        ${paidMilestones.map((m, idx) => renderPaid(m, idx)).join("")}
      </div>
    `
        : ""
    }

    ${
      futureMilestones.length
        ? `
      <h3 style="font-size:0.9rem;color:var(--text-secondary);margin:1rem 0 0.75rem;">
        Future Milestones
      </h3>
      <div class="milestone-list">
        ${futureMilestones
          .map((m, idx) => renderFuture(m, idx + paidMilestones.length))
          .join("")}
      </div>
    `
        : ""
    }
  `;

  openModal(content);

  document.getElementById("shareGrantBtn")?.addEventListener("click", () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      const btn = document.getElementById("shareGrantBtn");
      if (!btn) return;
      btn.innerHTML = "✓ Copied!";
      setTimeout(() => {
        btn.innerHTML = "🔗 Share";
      }, 2000);
    });
  });

  const issue = await findGitHubIssueByTitle(grant.project);
  const githubContainer = document.getElementById("githubSection");
  const btnSlot = document.getElementById("githubBtnSlot");
  const forumSlot = document.getElementById("forumBtnSlot");

  if (forumSlot && grant.forumLink) {
    forumSlot.innerHTML = `
      <a class="github-btn" href="${grant.forumLink}" target="_blank" rel="noopener">
        Forum
      </a>
    `;
  }

  if (issue) {
    const issueData = await fetchGitHubIssueBody(issue.number);

    if (btnSlot && issueData?.html_url) {
      btnSlot.innerHTML = `
        <a class="github-btn github-btn--accent" href="${issueData.html_url}" target="_blank" rel="noopener">
          <svg viewBox="0 0 16 16" style="width:16px;height:16px;fill:currentColor;">
            <path d="M8 .2a8 8 0 00-2.53 15.6c.4.07.55-.17.55-.38 0-.18-.01-.78-.01-1.42-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.12-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.58.82-2.14-.08-.2-.36-1.01.08-2.1 0 0 .67-.21 2.2.82a7.6 7.6 0 012 0c1.53-1.03 2.2-.82 2.2-.82.44 1.09.16 1.9.08 2.1.51.56.82 1.27.82 2.14 0 3.07-1.87 3.75-3.65 3.95.29.25.54.74.54 1.5 0 1.08-.01 1.95-.01 2.22 0 .21.15.46.55.38A8 8 0 008 .2z"></path>
          </svg>
          GitHub
        </a>
      `;
    }

    if (issueData?.body && githubContainer) {
      const summary = extractProjectSummary(issueData.body);
      if (summary) {
        const maxChars = 800;
        const plain = summary.replace(/[#*`>\[\]()]/g, "").trim();
        const truncated =
          plain.length > maxChars ? `${plain.slice(0, maxChars)}...` : plain;

        githubContainer.innerHTML = `
          <h3 style="font-size:0.9rem;color:var(--text-secondary);margin-bottom:0.5rem;">
            Project Summary
          </h3>
          <p style="color:var(--text-secondary);font-size:0.85rem;line-height:1.6;">
            ${escapeHtml(truncated)}
          </p>
          ${
            plain.length > maxChars
              ? `<a href="${issueData.html_url}" target="_blank" style="color:var(--accent-secondary);font-size:0.85rem;">
                   Read more on GitHub →
                 </a>`
              : ""
          }
        `;
      } else {
        githubContainer.innerHTML = `
          <div style="color:var(--text-tertiary);font-size:0.85rem;">
            No project summary found.
          </div>
        `;
      }
    } else if (githubContainer) {
      githubContainer.innerHTML = `
        <div style="color:var(--text-tertiary);font-size:0.85rem;">
          No GitHub details found.
        </div>
      `;
    }
  } else if (githubContainer) {
    githubContainer.innerHTML = `
      <div style="color:var(--text-tertiary);font-size:0.85rem;">
        No GitHub issue found.
      </div>
    `;
  }
}

/* ===== Modal Functions ===== */
function openModal(content) {
  const modalBody = document.getElementById("modalBody");
  const modalOverlay = document.getElementById("modalOverlay");

  if (modalBody) modalBody.innerHTML = content;
  if (modalOverlay) modalOverlay.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  const modalOverlay = document.getElementById("modalOverlay");
  if (modalOverlay) modalOverlay.classList.remove("active");
  document.body.style.overflow = "auto";

  if (window.location.hash.includes("grant=")) {
    const hash = window.location.hash;
    const params = new URLSearchParams(hash.split("?")[1] || "");
    params.delete("grant");

    const newQuery = params.toString();
    const newHash = newQuery ? `#grants?${newQuery}` : "#grants";
    history.replaceState({ page: "grants" }, "", newHash);
  }
}

function openGrantFromURL() {
  if (!pendingGrantToOpen) {
    const hash = window.location.hash;
    if (!hash.includes("grant=")) return false;

    const params = new URLSearchParams(hash.split("?")[1]);
    const grantId = params.get("grant");
    if (!grantId) return false;

    pendingGrantToOpen = decodeGrantId(grantId);
  }

  if (!pendingGrantToOpen) return false;

  const grant = allGrants.find(
    (g) =>
      g.project === pendingGrantToOpen.project &&
      g.grantee === pendingGrantToOpen.grantee
  );

  if (grant) {
    pendingGrantToOpen = null;
    showGrantDetails(grant.project, grant.grantee);
    return true;
  }

  return false;
}

/* ===== Payments ===== */
function getPaidOutDataForChart() {
  if (!appData) return [];
  return applyAmountFilter(appData.paidOutOriginal, currentPaidOutAmountFilter);
}

function renderPaidOutChart(data) {
  const ctx = document.getElementById("paidOutChart");
  if (!ctx) return;
  if (ctx.chart) ctx.chart.destroy();

  const titleEl = document.getElementById("paidOutTitle");
  if (titleEl) titleEl.textContent = "Total Paid Out";

  ctx.parentElement.style.height = `${Math.max(200, data.length * 30)}px`;

  const totalPaid = data.reduce((sum, d) => sum + (d.amount || 0), 0);

  ctx.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map((d) => d.grantee),
      datasets: [
        {
          label: "Total Paid Out (USD)",
          data: data.map((d) => d.amount),
          backgroundColor: "rgba(243, 166, 34, 0.7)",
          borderColor: "#f3a622",
          borderWidth: 1,
        },
      ],
    },
    options: {
      ...getChartOptions(),
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const value = context.parsed.x || 0;
              const pct =
                totalPaid > 0 ? ((value / totalPaid) * 100).toFixed(1) : "0.0";
              return `${formatUSD(value)} (${pct}%)`;
            },
          },
        },
      },
      scales: {
        x: {
          ...getChartOptions().scales.x,
          title: { display: true, text: "USD" },
          ticks: {
            ...getChartOptions().scales.x.ticks,
            callback: (v) => formatUSD(v),
          },
        },
      },
    },
  });
}

function renderFutureChart(data) {
  const ctx = document.getElementById("futureMilestonesChart");
  if (!ctx) return;
  if (ctx.chart) ctx.chart.destroy();

  ctx.parentElement.style.height = `${Math.max(200, data.length * 30)}px`;

  ctx.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map((d) => d.grantee),
      datasets: [
        {
          label: "Future Milestones (USD)",
          data: data.map((d) => d.amount),
          backgroundColor: "rgba(124, 176, 255, 0.7)",
          borderColor: "#7cb0ff",
          borderWidth: 1,
        },
      ],
    },
    options: {
      ...getChartOptions(),
      indexAxis: "y",
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ...getChartOptions().scales.x,
          ticks: {
            ...getChartOptions().scales.x.ticks,
            callback: (v) => formatUSD(v),
          },
        },
      },
    },
  });
}

function setupPaidOutAmountFilters() {
  const container = document.getElementById("paidOutFilters");
  if (!container || container.dataset.bound === "1") return;

  container.querySelectorAll(".filter-tab").forEach((pill) => {
    pill.addEventListener("click", () => {
      container
        .querySelectorAll(".filter-tab")
        .forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentPaidOutAmountFilter = pill.dataset.range || "all";
      renderPaidOutChart(getPaidOutDataForChart());
    });
  });

  container.dataset.bound = "1";
}

function setupChartFilters(containerId, originalData, renderFn) {
  const container = document.getElementById(containerId);
  if (!container || container.dataset.bound === "1") return;

  container.querySelectorAll(".filter-tab").forEach((pill) => {
    pill.addEventListener("click", () => {
      container
        .querySelectorAll(".filter-tab")
        .forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");

      const range = pill.dataset.range;
      let filtered = [...originalData];

      if (range === "small") filtered = filtered.filter((d) => d.amount < 50000);
      if (range === "medium") {
        filtered = filtered.filter(
          (d) => d.amount >= 50000 && d.amount <= 200000
        );
      }
      if (range === "large") filtered = filtered.filter((d) => d.amount > 200000);

      renderFn(filtered);
    });
  });

  container.dataset.bound = "1";
}

async function loadPayouts() {
  try {
    const data = await ensureAppData();

    renderPaidOutChart(getPaidOutDataForChart());
    renderFutureChart(data.futureOriginal);

    setupPaidOutAmountFilters();
    setupChartFilters("futureFilters", data.futureOriginal, renderFutureChart);
  } catch (error) {
    console.error("Error loading payouts data:", error);
  }
}

/* ===== Liquidity ===== */
async function loadLiquidity() {
  try {
    const data = await ensureAppData();
    const aoa = data.liquidityAoA;

    if (!aoa.length) {
      document.getElementById("liquidityContent").innerHTML =
        '<div class="loading-placeholder">No liquidity data</div>';
      return;
    }

    const COL_PROJECT = 0;
    const COL_AMOUNT_USD = 1;
    const COL_KPI_LABEL = 7;
    const COL_KPI_VALUE = 8;

    const norm = (s) =>
      (s || "").toString().replace(/\u00A0/g, " ").trim().toLowerCase();

    let zecBalance = 0;
    let cacaoBalance = 0;
    let usdValueWallet = 0;
    let gainLossKPI = 0;

    for (let r = 1; r < aoa.length; r++) {
      const label = aoa[r]?.[COL_KPI_LABEL];
      const value = aoa[r]?.[COL_KPI_VALUE];

      if (!label && !value) continue;

      const k = norm(label);
      const v = cleanNumber(value);

      if (k === "usd value in wallet") usdValueWallet = v;
      else if (k === "zec") zecBalance = v;
      else if (k === "cacao") cacaoBalance = v;
      else if (k.includes("gain/loss")) gainLossKPI = v;
    }

    let totalLiquidityAdded = 0;
    for (let r = 1; r < aoa.length; r++) {
      const proj = aoa[r]?.[COL_PROJECT];
      if (!proj) continue;
      const amt = cleanNumber(aoa[r]?.[COL_AMOUNT_USD]);
      if (amt > 0) totalLiquidityAdded += amt;
    }

    document.getElementById("liquidityContent").innerHTML = `
      <div class="liquidity-cards">
        <div class="liquidity-card">
          <div class="liquidity-content">
            <div class="liquidity-icon liquidity-icon-bg">🌊</div>
            <div>
              <div class="liquidity-label">Total Liquidity Added</div>
              <div class="liquidity-value">${formatUSD(totalLiquidityAdded)}</div>
            </div>
          </div>
        </div>
        <div class="liquidity-card">
          <div class="liquidity-content">
            <div class="liquidity-icon liquidity-icon-bg">💵</div>
            <div>
              <div class="liquidity-label">Current USD Value</div>
              <div class="liquidity-value">${formatUSD(usdValueWallet)}</div>
            </div>
          </div>
        </div>
        <div class="liquidity-card">
          <div class="liquidity-content">
            <div class="liquidity-icon liquidity-icon-bg">⚡</div>
            <div>
              <div class="liquidity-label">ZEC Balance</div>
              <div class="liquidity-value">${formatZEC(zecBalance)}</div>
            </div>
          </div>
        </div>
        <div class="liquidity-card">
          <div class="liquidity-content">
            <div class="liquidity-icon liquidity-icon-bg">☕</div>
            <div>
              <div class="liquidity-label">CACAO Balance</div>
              <div class="liquidity-value">${cacaoBalance.toLocaleString()}</div>
            </div>
          </div>
        </div>
        <div class="liquidity-card ${gainLossKPI >= 0 ? "positive" : "negative"}">
          <div class="liquidity-content">
            <div class="liquidity-icon liquidity-icon-bg">🔻</div>
            <div>
              <div class="liquidity-label">Impermanent Loss</div>
              <div class="liquidity-value">
                ${gainLossKPI >= 0 ? "+" : ""}${formatUSD(gainLossKPI)}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  } catch (error) {
    console.error("Error loading liquidity data:", error);
    document.getElementById("liquidityContent").innerHTML =
      '<div class="loading-placeholder">Error loading liquidity data</div>';
  }
}

/* ===== Stipends ===== */
async function loadStipends() {
  try {
    const data = await ensureAppData();
    const rows = data.stipendsRows;

    const monthly = {};
    let totalUSDYTD = 0;
    let totalZECYTD = 0;

    rows.forEach((r) => {
      const date = toDate(r["Date"]);
      if (!date) return;

      const monthKey = date.toLocaleString("default", {
        month: "long",
        year: "numeric",
      });

      const usd = cleanNumber(r["USD Amount"]);
      const zec = cleanNumber(r["ZEC Amount"]) || cleanNumber(r["ZEC"]) || 0;

      if (!monthly[monthKey]) {
        monthly[monthKey] = { usd: 0, zec: 0 };
      }

      monthly[monthKey].usd += usd;
      monthly[monthKey].zec += zec;
      totalUSDYTD += usd;
      totalZECYTD += zec;
    });

    const months = Object.keys(monthly);
    const usdAllMembers = months.map((m) => monthly[m].usd);
    const zecAllMembers = months.map((m) => monthly[m].zec);

    const MEMBERS = 5;
    const perMemberUsdYTD = totalUSDYTD / MEMBERS;
    const avgMonths = months.length > 0 ? months.length : 1;
    const avgPerMemberPerMonth = perMemberUsdYTD / avgMonths;

    document.getElementById("stipendsContent").innerHTML = `
      <div class="stipends-cards">
        <div class="stipend-card">
          <div class="stipend-label">Total Stipend Value YTD (USD)</div>
          <div class="stipend-value">${formatUSD(totalUSDYTD)}</div>
        </div>
        <div class="stipend-card">
          <div class="stipend-label">Total Paid YTD (ZEC units)</div>
          <div class="stipend-value">${formatZEC(totalZECYTD)}</div>
        </div>
        <div class="stipend-card">
          <div class="stipend-label">Per Member YTD (USD value)</div>
          <div class="stipend-value">${formatUSD(perMemberUsdYTD)}</div>
        </div>
        <div class="stipend-card">
          <div class="stipend-label">Avg Per Member / Month (USD value)</div>
          <div class="stipend-value">${formatUSD(avgPerMemberPerMonth)}</div>
        </div>
      </div>

      <p style="color:var(--text-secondary);margin-bottom:1.5rem;">
        5 committee members each receive a stipend worth
        <strong>$1,725 USD + 10 ZEC</strong> per month. In practice, the USD
        portion is paid in ZEC at the payout exchange rate, so the chart shows:
        <br />
        • total stipend value per month in USD (from the sheet), and<br />
        • total ZEC units paid per month.
        <br />
        These are two views of the same payouts; the ZEC line should
        <em>not</em> be added to the USD line.
      </p>

      <div class="stipends-chart-wrapper">
        <div class="stipends-chart-title">Committee Stipends (All 5 Members)</div>
        <div class="stipends-chart-subtitle">
          USD value vs. ZEC units paid (same underlying payouts)
        </div>
        <div class="chart-container">
          <canvas id="stipendsChart"></canvas>
        </div>
      </div>
    `;

    renderStipendsChart(months, usdAllMembers, zecAllMembers, null);
  } catch (error) {
    console.error(error);
    document.getElementById("stipendsContent").innerHTML =
      '<div class="loading-placeholder">Error loading stipends data</div>';
  }
}

function renderStipendsChart(
  months,
  usdAllMembers,
  zecAllMembers,
  fixed10ZecUsdLine
) {
  const ctx = document.getElementById("stipendsChart");
  if (!ctx) return;
  if (ctx.chart) ctx.chart.destroy();

  const hasFixedLine =
    Array.isArray(fixed10ZecUsdLine) && fixed10ZecUsdLine.length === months.length;

  const datasets = [
    {
      label: "Stipend value (USD, all members)",
      data: usdAllMembers,
      borderColor: "#4caf50",
      backgroundColor: "rgba(76, 175, 80, 0.1)",
      tension: 0.3,
      fill: true,
      yAxisID: "yUSD",
    },
    {
      label: "Stipend paid (ZEC, all members)",
      data: zecAllMembers,
      borderColor: "#f3a622",
      backgroundColor: "rgba(243, 166, 34, 0.1)",
      tension: 0.3,
      fill: true,
      yAxisID: "yZEC",
    },
  ];

  if (hasFixedLine) {
    datasets.push({
      label: "USD value of fixed 10 ZEC/member",
      data: fixed10ZecUsdLine,
      borderColor: "#e91e63",
      backgroundColor: "rgba(233, 30, 99, 0.05)",
      tension: 0.3,
      fill: false,
      yAxisID: "yUSD",
      borderDash: [5, 4],
    });
  }

  ctx.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: months,
      datasets,
    },
    options: {
      ...getChartOptions(),
      interaction: { mode: "index", intersect: false },
      scales: {
        x: getChartOptions().scales.x,
        yUSD: {
          type: "linear",
          position: "left",
          title: { display: true, text: "USD value" },
          beginAtZero: true,
          grid: {
            color: getComputedStyle(document.documentElement)
              .getPropertyValue("--grid-color")
              .trim(),
          },
          ticks: {
            color: getComputedStyle(document.documentElement)
              .getPropertyValue("--text-tertiary")
              .trim(),
            callback: (v) => formatUSD(v),
          },
        },
        yZEC: {
          type: "linear",
          position: "right",
          title: { display: true, text: "ZEC units" },
          beginAtZero: true,
          grid: { drawOnChartArea: false },
          ticks: {
            color: getComputedStyle(document.documentElement)
              .getPropertyValue("--text-tertiary")
              .trim(),
          },
        },
      },
      plugins: {
        ...getChartOptions().plugins,
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            label(context) {
              const i = context.dataIndex;
              const label = context.dataset.label || "";

              if (label.startsWith("Stipend value (USD")) {
                return `USD value: ${formatUSD(usdAllMembers[i] || 0)}`;
              }

              if (label.startsWith("Stipend paid (ZEC")) {
                return `ZEC paid: ${formatZEC(zecAllMembers[i] || 0)}`;
              }

              if (label.startsWith("USD value of fixed 10 ZEC")) {
                return `10 ZEC/member (USD): ${formatUSD(
                  fixed10ZecUsdLine[i] || 0
                )}`;
              }

              return `${label}: ${context.formattedValue}`;
            },
          },
        },
      },
    },
  });
}

/* ===== IC Payouts (Audit) ===== */
function renderAuditPaymentsChart(rows) {
  const monthly = {};

  rows.forEach((r) => {
    const date = toDate(r["Paid Out"]);
    if (!date) return;

    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0"
    )}`;

    const usd = cleanNumber(r["Amount (USD)"]);
    const zec = cleanNumber(r["ZEC Disbursed"]);

    if (!monthly[monthKey]) monthly[monthKey] = { usd: 0, zec: 0 };
    monthly[monthKey].usd += usd;
    monthly[monthKey].zec += zec;
  });

  const labels = Object.keys(monthly).sort();
  const usdData = labels.map((m) => monthly[m].usd);
  const zecData = labels.map((m) => monthly[m].zec);

  const ctx = document.getElementById("auditPaymentsChart");
  if (!ctx) return;
  if (ctx.chart) ctx.chart.destroy();

  ctx.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "USD",
          data: usdData,
          yAxisID: "yUSD",
          borderColor: "#4caf50",
          backgroundColor: "rgba(76, 175, 80, 0.2)",
          fill: true,
          tension: 0.3,
        },
        {
          label: "ZEC",
          data: zecData,
          yAxisID: "yZEC",
          borderColor: "#f3a622",
          backgroundColor: "rgba(243, 166, 34, 0.2)",
          fill: true,
          tension: 0.3,
        },
      ],
    },
    options: {
      ...getChartOptions(),
      interaction: { mode: "index", intersect: false },
      scales: {
        yUSD: {
          type: "linear",
          position: "left",
          title: { display: true, text: "USD" },
          beginAtZero: true,
        },
        yZEC: {
          type: "linear",
          position: "right",
          title: { display: true, text: "ZEC" },
          grid: { drawOnChartArea: false },
          beginAtZero: true,
        },
        x: getChartOptions().scales.x,
      },
    },
  });
}

async function loadICPayouts() {
  try {
    const data = await ensureAppData();
    const rows = data.icRows;

    const filteredRows = rows.filter(
      (r) =>
        !((r["Project"] || "").toString().toLowerCase().includes(
          "arborist call meeting notes"
        ))
    );

    let totalUSD = 0;
    let totalZEC = 0;

    filteredRows.forEach((r) => {
      totalUSD += cleanNumber(r["Amount (USD)"]);
      totalZEC += cleanNumber(r["ZEC Disbursed"]);
    });

    let html = `
      <div class="chart-card" style="margin-bottom:1rem;">
        <h3 class="chart-title">Audit Payments Over Time</h3>
        <div class="chart-container">
          <canvas id="auditPaymentsChart"></canvas>
        </div>
      </div>
      <table class="data-table">
        <tr>
          <th>Project</th>
          <th>Recipient</th>
          <th>USD</th>
          <th>ZEC</th>
          <th>Date</th>
        </tr>
    `;

    filteredRows.forEach((r) => {
      html += `
        <tr>
          <td>${escapeHtml(r["Project"] || "")}</td>
          <td>${escapeHtml(r["Independent Contractor (IC)"] || "")}</td>
          <td>${formatUSD(cleanNumber(r["Amount (USD)"]))}</td>
          <td>${formatZEC(cleanNumber(r["ZEC Disbursed"]))}</td>
          <td>${fmtDateCell(r["Paid Out"])}</td>
        </tr>
      `;
    });

    html += `
        <tr style="background:rgba(255,193,124,0.1);font-weight:600;">
          <td colspan="2">Total</td>
          <td>${formatUSD(totalUSD)}</td>
          <td>${formatZEC(totalZEC)}</td>
          <td></td>
        </tr>
      </table>
    `;

    document.getElementById("icPayoutsContent").innerHTML = html;
    renderAuditPaymentsChart(filteredRows);
  } catch (error) {
    console.error(error);
    document.getElementById("icPayoutsContent").innerHTML =
      '<div class="loading-placeholder">Error loading IC payouts data</div>';
  }
}

/* ===== Notetaker ===== */
async function loadNotetaker() {
  try {
    const data = await ensureAppData();
    const rows = data.icRows;

    const filtered = rows.filter((r) =>
      (r["Project"] || "").toString().includes("Arborist Call Meeting Notes")
    );

    let totalUSD = 0;
    let totalZEC = 0;

    let html = `
      <table class="data-table">
        <tr>
          <th>Date</th>
          <th>USD</th>
          <th>ZEC</th>
          <th>ZEC/USD</th>
        </tr>
    `;

    filtered.forEach((r) => {
      const usd = cleanNumber(r["Amount (USD)"]);
      const zec = cleanNumber(r["ZEC Disbursed"]);
      totalUSD += usd;
      totalZEC += zec;

      html += `
        <tr>
          <td>${fmtDateCell(r["Paid Out"])}</td>
          <td>${formatUSD(usd)}</td>
          <td>${formatZEC(zec)}</td>
          <td>${escapeHtml(r["ZEC/USD"] || "")}</td>
        </tr>
      `;
    });

    html += `
        <tr style="background:rgba(255,193,124,0.1);font-weight:600;">
          <th>Total</th>
          <th>${formatUSD(totalUSD)}</th>
          <th>${formatZEC(totalZEC)}</th>
          <th></th>
        </tr>
      </table>
    `;

    document.getElementById("notetakerContent").innerHTML = html;
  } catch (error) {
    console.error("Error loading notetaker data:", error);
    document.getElementById("notetakerContent").innerHTML =
      '<div class="loading-placeholder">Error loading notetaker data</div>';
  }
}

/* ===== Optional Manual Cache Controls ===== */
function clearDashboardCaches() {
  try {
    localStorage.removeItem(LOCAL_CACHE_KEY);
    localStorage.removeItem(ZEC_PRICE_CACHE_KEY);
  } catch (err) {
    console.warn("Failed clearing caches:", err);
  }

  workbook = null;
  workbookPromise = null;
  appData = null;
  appDataPromise = null;
  zecPricePromise = null;
  allGrants = [];

  parsedSheetCache.aoa.clear();
  parsedSheetCache.objects.clear();
}

async function refreshDashboardData() {
  clearDashboardCaches();
  await ensureAppData({ force: true });
}

/* ===== Safety Check for marked library ===== */
if (typeof marked === "undefined") {
  window.marked = { parse: (s) => s };
}

/* ===== Init ===== */
document.addEventListener("DOMContentLoaded", () => {
  checkPendingGrant();
  initThemeToggle();
  initNavigation();
  initGrantsFilters();
  initDashboardFilters();
  setupSearch();
  startUpdateTimeFallback();

  const modalOverlay = document.getElementById("modalOverlay");
  if (modalOverlay) {
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) {
        closeModal();
      }
    });
  }
});

/* ===== Expose Functions to Window ===== */
window.showGrantDetails = showGrantDetails;
window.closeModal = closeModal;
window.clearDashboardCaches = clearDashboardCaches;
window.refreshDashboardData = refreshDashboardData;
