/* ===== ZCG Dashboard — Complete Edition =====
   Combines V7 UI features with comprehensive data implementation
*/

/* ===== Global Variables ===== */
let allGrants = [];
let filteredGrants = [];
let allMilestones = [];
let currentPayoutData = [];
let currentTimeFilter = "ytd";
let currentSortMode = 0;
let lastUpdateTime = null;
let updateTimeTimeout = null;
let currentStatusFilter = "all";
let currentBudgetFilter = "all";
let loadedTabs = new Set();
let lastScrollTop = 0;
let currentCategoryFilter = "all";

// Payment filters
let paidOutOriginal = [];
let futureOriginal = [];
let paidOutRawFunds = [];
let paidOutRawGrants = [];
let currentPaymentsTimeFilter = "max";
let currentPaidOutAmountFilter = "all";

// Approved chart
let approvedAllRaw = [];
let projectTotalsMap = {};
let currentApprovedTimeFilter = "ytd";

// GitHub cache
const githubIssueCache = {};

/* ===== Mobile Header Scroll Behavior ===== */
window.addEventListener("scroll", function () {
  const header = document.querySelector(".mobile-header");
  let st = window.pageYOffset || document.documentElement.scrollTop;
  if (st > lastScrollTop && st > 50) {
    header.style.transform = "translateY(-100%)";
  } else {
    header.style.transform = "translateY(0)";
  }
  lastScrollTop = st <= 0 ? 0 : st;
}, false);

/* ===== Sort Modes ===== */
const sortModes = [
  { key: "newest", icon: "📅", text: "Newest" },
  { key: "oldest", icon: "📅", text: "Oldest" },
  { key: "biggest", icon: "💰", text: "Biggest" },
  { key: "smallest", icon: "💰", text: "Smallest" }
];

/* ===== XLSX Source ===== */
const XLSX_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vS1zjfVFYsO5u8HTv-zF8XgbtgbywkFlLJ6UvFjRdZFnncHOlqWSR1be_ohfVxeUQ9gdDEtUciBMADb/pub?output=xlsx";

let workbook = null;

const SHEETS = {
  DASHBOARD_ZCG: "ZCG Dashboard",
  DASHBOARD_LOCKBOX: "Lockbox Dashboard",
  GRANTS_ZCG: "ZCG Grants",
  GRANTS_LOCKBOX: "Lockbox Grants",
  FUNDS: "ZCG Funds Distribution",
  LIQUIDITY: "Liquidity",
  STIPENDS: "ZCG 2025 Stipend",
  IC_PAYOUTS: "ZCG IC Payouts",
  BUDGET_2025: "ZCG 2025 Disc. Budget",
  ALL_GRANTS: "ZCG All Grants Tracking"
};

/* ===== Workbook Loader ===== */
async function loadWorkbook() {
  if (workbook) return workbook;
  const res = await fetch(XLSX_URL);
  if (!res.ok) throw new Error("Failed to download XLSX");
  const buf = await res.arrayBuffer();
  workbook = XLSX.read(buf, { type: "array" });
  return workbook;
}

/* ===== Sheet Helpers ===== */
function sheetToAoA(name, opts = {}) {
  const ws = workbook.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, {
    header: 1,
    blankrows: false,
    raw: true,
    ...opts
  });
}

function sheetToObjects(name, headerRowIndex = 0, opts = {}) {
  const aoa = sheetToAoA(name, opts);
  if (!aoa.length) return [];
  const headers = (aoa[headerRowIndex] || []).map((h) =>
    (h || "").toString().replace(/\u00A0/g, " ").trim()
  );
  const rows = aoa
    .slice(headerRowIndex + 1)
    .filter((r) => r.some((c) => c !== null && c !== undefined && c !== ""));
  return rows.map((r) => {
    const o = {};
    headers.forEach((h, i) => {
      if (!h) return;
      o[h] = r[i];
    });
    return o;
  });
}

/* ===== Date Coercion ===== */
function toDate(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H || 0, d.M || 0, d.S || 0));
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const dt = new Date(s);
    if (!isNaN(dt)) return dt;
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      const mm = parseInt(m[1], 10);
      const dd = parseInt(m[2], 10);
      const yy = parseInt(m[3], 10);
      const yyyy = yy < 100 ? 2000 + yy : yy;
      const d = new Date(yyyy, mm - 1, dd);
      if (!isNaN(d)) return d;
    }
  }
  return null;
}

function fmtDateCell(v) {
  const d = toDate(v);
  if (!d || isNaN(d)) return "";
  return d.toLocaleDateString();
}

/* ===== Utility Functions ===== */
const cleanNumber = (val) =>
  parseFloat((val ?? "0").toString().replace(/[$,]/g, "")) || 0;

const formatUSD = (num) =>
  "$" + Number(num).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });

const formatUSDInt = (num) => {
  const n = Math.abs(Number(cleanNumber(num)) || 0);
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

const formatZEC = (num) =>
  Number(num).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + " ZEC";

const formatZecPrice = (num) => {
  const n = Number(cleanNumber(num)) || 0;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function normKey(s) {
  return (s || "")
    .toString()
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function monthDiff(start, end) {
  const s = new Date(start.getFullYear(), start.getMonth(), 1);
  const e = new Date(end.getFullYear(), end.getMonth(), 1);
  const diff = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1;
  return Math.max(diff, 1);
}

function getCurrentYear() {
  return new Date().getFullYear();
}

/* ===== Tab Routes ===== */
const tabRoutes = {
  dashboard: { id: "dashboard", load: loadOverview },
  grants: { id: "grants", load: loadGrants },
  payments: { id: "payments", load: loadPayouts },
  auditpayments: { id: "auditpayments", load: loadICPayouts },
  liquidity: { id: "liquidity", load: loadLiquidity },
  stipends: { id: "stipends", load: loadStipends },
  notetaker: { id: "notetaker", load: loadNotetaker }
};

/* ===== Router Functions ===== */
function initRouter() {
  const initialTab = getTabFromHash();
  navigateToTab(initialTab, false);

  window.addEventListener("popstate", (e) => {
    const tab = e.state?.tab || getTabFromHash();
    navigateToTab(tab, false);
  });

  document.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const tab = link.getAttribute("href").substring(1);
      navigateToTab(tab, true);
    });
  });
}

function getTabFromHash() {
  const hash = window.location.hash.substring(1);
  return tabRoutes[hash] ? hash : "dashboard";
}

function navigateToTab(tabName, pushState = true) {
  closeMobileMenu();

  if (pushState) {
    const newUrl = `${window.location.pathname}#${tabName}`;
    history.pushState({ tab: tabName }, "", newUrl);
  }

  document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach((l) => l.classList.remove("active"));

  const tabElement = document.getElementById(tabName);
  const navElement = document.querySelector(`[href="#${tabName}"]`);

  if (tabElement) tabElement.classList.add("active");
  if (navElement) navElement.classList.add("active");

  const mobileSearchBar = document.querySelector(".mobile-search-bar");
  if (window.innerWidth <= 768 && tabName === "grants") {
    mobileSearchBar.style.display = "block";
  } else {
    mobileSearchBar.style.display = "none";
  }

  const tabInfo = tabRoutes[tabName];
  if (tabInfo && !loadedTabs.has(tabName)) {
    tabInfo.load();
    loadedTabs.add(tabName);
  }

  if (tabName === "dashboard" && loadedTabs.has("dashboard")) {
    loadPayoutsChart();
    loadCategoryChart();
    loadZecPriceTrend();
    loadActivityMetrics();
    loadApprovedChart();
  }

  const tabTitles = {
    dashboard: "Dashboard",
    grants: "Grants",
    payments: "Payments",
    auditpayments: "Audit Payments",
    liquidity: "Maya Liquidity",
    stipends: "Stipends",
    notetaker: "Notetaker Payments"
  };
  if (tabTitles[tabName]) {
    document.title = `${tabTitles[tabName]} - Zcash Community Grants Dashboard`;
  }
}

function jumpToGrantsTab() {
  if (location.hash !== "#grants") {
    navigateToTab("grants", true);
  }
}

/* ===== Mobile Menu ===== */
function toggleMobileMenu() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.querySelector(".sidebar-overlay");
  const hamburger = document.querySelector(".hamburger");

  sidebar.classList.toggle("active");
  overlay.classList.toggle("active");
  hamburger.classList.toggle("active");
}

function closeMobileMenu() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.querySelector(".sidebar-overlay");
  const hamburger = document.querySelector(".hamburger");

  sidebar.classList.remove("active");
  overlay.classList.remove("active");
  hamburger.classList.remove("active");
}

/* ===== Dark Mode ===== */
function toggleDarkMode() {
  const currentTheme = document.documentElement.getAttribute("data-theme");
  const newTheme = currentTheme === "dark" ? "light" : "dark";

  document.documentElement.setAttribute("data-theme", newTheme);
  localStorage.setItem("theme", newTheme);

  const icon = document.getElementById("darkModeIcon");
  const text = document.getElementById("darkModeText");

  if (newTheme === "dark") {
    icon.textContent = "☀️";
    text.textContent = "Light Mode";
  } else {
    icon.textContent = "🌙";
    text.textContent = "Dark Mode";
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);

  const icon = document.getElementById("darkModeIcon");
  const text = document.getElementById("darkModeText");

  if (savedTheme === "dark") {
    icon.textContent = "☀️";
    text.textContent = "Light Mode";
  }
}

/* ===== Update Time ===== */
function updateLastUpdateTime() {
  const desktopEl = document.getElementById("desktopUpdateTime");
  const mobileEl = document.getElementById("mobileUpdateTime");

  if (lastUpdateTime) {
    const timeString = lastUpdateTime.toLocaleString();
    desktopEl.textContent = `Last updated: ${timeString}`;
    mobileEl.textContent = `Updated: ${timeString}`;
  } else {
    desktopEl.textContent = `Last updated: Unavailable`;
    mobileEl.textContent = `Updated: Unavailable`;
  }
}

function startUpdateTimeFallback() {
  updateTimeTimeout = setTimeout(() => {
    if (!lastUpdateTime) {
      updateLastUpdateTime();
    }
  }, 10000);
}

/* ===== Search & Filters ===== */
function setupSearch() {
  const desktopSearch = document.getElementById("desktopSearch");
  const mobileSearch = document.getElementById("mobileSearch");

  [desktopSearch, mobileSearch].forEach((input) => {
    input.addEventListener("focus", () => {
      jumpToGrantsTab();
    });
    input.addEventListener("input", (e) => {
      const query = (e.target.value || "").toLowerCase();
      if (input === desktopSearch) mobileSearch.value = query;
      if (input === mobileSearch) desktopSearch.value = query;
      filterGrantsBySearch(query);
    });
  });
}

function setupMobileFilters() {
  const mobileFilters = document.getElementById("mobileFilters");
  mobileFilters.innerHTML = `
    <div class="pill active" onclick="filterGrants('all')">All</div>
    <div class="pill" onclick="filterGrants('completed')">✓</div>
    <div class="pill" onclick="filterGrants('in-progress')">⏳</div>
    <div class="pill" onclick="filterGrants('waiting')">⏸</div>
    <div class="pill active" onclick="filterGrantsByBudget('all')">💰</div>
    <div class="pill" onclick="filterGrantsByBudget('small')">&lt;50k</div>
    <div class="pill" onclick="filterGrantsByBudget('medium')">50-200k</div>
    <div class="pill" onclick="filterGrantsByBudget('large')">200k+</div>
    <button class="sort-btn" onclick="cycleSortMode()">📅 Newest</button>
  `;
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
        font: { size: 12, weight: "400" }
      }
    }
  },
  scales: {
    x: {
      grid: {
        color: getComputedStyle(document.documentElement)
          .getPropertyValue("--grid-color")
          .trim()
      },
      ticks: {
        color: getComputedStyle(document.documentElement)
          .getPropertyValue("--text-tertiary")
          .trim(),
        font: { size: 11 }
      }
    },
    y: {
      grid: {
        color: getComputedStyle(document.documentElement)
          .getPropertyValue("--grid-color")
          .trim()
      },
      ticks: {
        color: getComputedStyle(document.documentElement)
          .getPropertyValue("--text-tertiary")
          .trim(),
        font: { size: 11 }
      }
    }
  }
});

/* ===== Global Event Listeners ===== */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.getElementById("modalOverlay").classList.contains("active")) {
      closeModal();
    }
    if (document.getElementById("sidebar").classList.contains("active")) {
      closeMobileMenu();
    }
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const overlay = document.querySelector(".sidebar-overlay");
  if (overlay) {
    overlay.addEventListener("click", () => {
      closeMobileMenu();
    });
  }
  
  const modalOverlay = document.getElementById("modalOverlay");
  if (modalOverlay) {
    modalOverlay.addEventListener("click", (e) => {
      if (!e.target.closest(".modal-content")) {
        closeModal();
      }
    });
  }
});

/* ===== Initialize ===== */
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initRouter();
  setupSearch();
  setupMobileFilters();
  startUpdateTimeFallback();
});

/* ===== Compute Grant Stats ===== */
async function computeGrantStats() {
  await loadWorkbook();
  const year = getCurrentYear();

  const grantRows = sheetToObjects(SHEETS.GRANTS_ZCG, 0);

  const getKey = (r) => {
    const project = (r["Project"] || "").toString().trim();
    const grantee =
      (r["Grantee"] ||
        r["Applicant(s)"] ||
        r["Applicant"] ||
        r["Recipient"] ||
        "").toString().trim();
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
  const getZecDisbursed = (r) =>
    cleanNumber(r["ZEC Disbursed"] || r["ZEC"] || 0);

  const projectMap = new Map();

  grantRows.forEach((r) => {
    const key = getKey(r);
    if (!key) return;
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        project: (r["Project"] || "").toString().trim(),
        grantee:
          (r["Grantee"] ||
            r["Applicant(s)"] ||
            r["Applicant"] ||
            r["Recipient"] ||
            "").toString().trim(),
        milestones: [],
        approvedDates: []
      });
    }
    const rec = projectMap.get(key);

    const paidDate = getPaidDate(r);
    const amtUsd = getAmountUSD(r);
    const zec = getZecDisbursed(r);

    rec.milestones.push({ paidDate, amtUsd, zec });

    const d = getApprovedDate(r);
    if (d) rec.approvedDates.push(d);
  });

  const totalProjects = projectMap.size;

  let totalCompleted = 0;
  let inProgress = 0;
  let waiting = 0;

  let approvedYTD = 0;
  let completedYTD = 0;

  let payoutsYTDUSD = 0;
  let payoutsYTDZEC = 0;

  let lifetimePayoutUSD = 0;
  let lifetimeFirstPayout = null;
  let lifetimeLastPayout = null;

  projectMap.forEach((rec) => {
    const hasMilestones = rec.milestones.length > 0;
    const allPaid =
      hasMilestones && rec.milestones.every((m) => !!m.paidDate);
    const anyPaid = rec.milestones.some((m) => !!m.paidDate);

    if (allPaid) totalCompleted++;
    else if (anyPaid) inProgress++;
    else waiting++;

    const earliestApproved = rec.approvedDates.length
      ? new Date(Math.min(...rec.approvedDates.map((d) => d.getTime())))
      : null;

    let earliestActivity = earliestApproved;
    if (!earliestActivity) {
      const paidDates = rec.milestones
        .map((m) => m.paidDate)
        .filter(Boolean);
      if (paidDates.length) {
        earliestActivity = new Date(
          Math.min(...paidDates.map((d) => d.getTime()))
        );
      }
    }

    if (earliestActivity && earliestActivity.getFullYear() === year) {
      approvedYTD++;
    }

    if (allPaid) {
      const paidDates = rec.milestones
        .map((m) => m.paidDate)
        .filter(Boolean);
      if (paidDates.length) {
        const lastPaid = new Date(
          Math.max(...paidDates.map((d) => d.getTime()))
        );
        if (lastPaid.getFullYear() === year) {
          completedYTD++;
        }
      }
    }

    rec.milestones.forEach((m) => {
      if (m.paidDate) {
        lifetimePayoutUSD += m.amtUsd;
        if (!lifetimeFirstPayout || m.paidDate < lifetimeFirstPayout) {
          lifetimeFirstPayout = m.paidDate;
        }
        if (!lifetimeLastPayout || m.paidDate > lifetimeLastPayout) {
          lifetimeLastPayout = m.paidDate;
        }
        if (m.paidDate.getFullYear() === year) {
          payoutsYTDUSD += m.amtUsd;
          payoutsYTDZEC += m.zec;
        }
      }
    });
  });

  // Proposals received YTD from ALL_GRANTS
  const aoaAll = sheetToAoA(SHEETS.ALL_GRANTS);
  let proposalsReceivedYTD = 0;
  for (let r = 0; r < aoaAll.length; r++) {
    const cell = aoaAll[r]?.[0];
    let d = toDate(cell);
    if ((!d || isNaN(d)) && typeof cell === "number") {
      const parsed = XLSX.SSF.parse_date_code(cell);
      if (parsed) d = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    }
    if (d && !isNaN(d) && d.getFullYear() === year) {
      proposalsReceivedYTD++;
    }
  }

  let avgMonthlyPayoutUSD = 0;
  let monthsSpan = 0;
  if (lifetimeFirstPayout && lifetimeLastPayout) {
    monthsSpan = monthDiff(lifetimeFirstPayout, lifetimeLastPayout);
    avgMonthlyPayoutUSD = lifetimePayoutUSD / monthsSpan;
  }

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
    proposalsReceivedYTD,
    lifetimePayoutUSD,
    lifetimeFirstPayout,
    lifetimeLastPayout,
    avgMonthlyPayoutUSD,
    monthsSpan
  };
}

/* ===== DASHBOARD / OVERVIEW (8-card layout) ===== */
async function loadOverview() {
  try {
    await loadWorkbook();
    const rows = sheetToAoA(SHEETS.DASHBOARD_ZCG);

    const norm = (s) =>
      (s || "").toString().replace(/\u00A0/g, " ").trim().toLowerCase();

    const getValue = (label) => {
      const r = rows.find((row) => norm(row[0]).includes(norm(label)));
      return r ? r[1] : null;
    };

    // Block time / last update
    const blockTimeUTC = getValue("Block time (UTC)");
    if (blockTimeUTC) {
      clearTimeout(updateTimeTimeout);
      const dt = toDate(blockTimeUTC) || new Date(blockTimeUTC + " UTC");
      if (dt) {
        lastUpdateTime = dt;
        updateLastUpdateTime();
      }
    }

    // Core treasury data
    const valZecBal = getValue("Current ZEC balance");
    const valZecBalUsd = getValue("USD value of Current ZEC balance");
    const valUsdBal = getValue("Current USD balance");
    const valUsdReserves = getValue("USD reserves");
    const valFuture = getValue("Future grant liabilities");
    const valUnhedged = getValue("Unhedged grant liabilities (USD)");
    const valZecPrice = getValue("ZECUSD price");
    const valTotalZecAccr = getValue("Total ZEC accrued to date");
    const valDev1 = getValue("ZEC accrued from 1st Dev Fund");
    const valDev2 = getValue("ZEC accrued from 2nd Dev Fund");
    const valDev3 = getValue("ZEC accrued from 3rd Dev Fund");

    const zecPrice = cleanNumber(valZecPrice);
    const zecBal = cleanNumber(valZecBal);
    const zecBalUsdNum = cleanNumber(valZecBalUsd);
    const usdBal = cleanNumber(valUsdBal);
    const usdRes = cleanNumber(valUsdReserves);
    const futureLiab = cleanNumber(valFuture);
    const unhedged = cleanNumber(valUnhedged);
    const hedgedUSD = usdRes;

    const totalTreasuryUSD =
      (zecBalUsdNum || zecBal * zecPrice) + usdBal + usdRes;

    // ZEC accrued pieces
    const zecAccTotal = cleanNumber(valTotalZecAccr);
    const zecDev1 = cleanNumber(valDev1);
    const zecDev2 = cleanNumber(valDev2);
    const zecDev3 = cleanNumber(valDev3);

    // Grants stats
    const grantStats = await computeGrantStats();

    // Dev fund inflow approximation
    const valZecAccruedYTDFromSheet = getValue("ZEC accrued YTD");
    let zecAccruedYTD = cleanNumber(valZecAccruedYTDFromSheet);

    const monthsElapsedThisYear = new Date().getMonth() + 1;
    const avgMonthlyInflowZEC =
      monthsElapsedThisYear > 0 ? zecAccruedYTD / monthsElapsedThisYear : 0;

    // Coverage
    const hedgedCoverageRatio =
      futureLiab > 0 ? hedgedUSD / futureLiab : null;

    const usdMetricsEl = document.getElementById("usdMetrics");
    const activityEl = document.getElementById("activityMetrics");

    if (!usdMetricsEl || !activityEl) return;

    /* ===== Treasury (5 cards) ===== */

    // 1. Total Treasury Value
    const cardTotalTreasury = `
      <div class="metric-card">
        <div class="metric-label">Total Treasury Value</div>
        <div class="metric-number">${formatUSD(totalTreasuryUSD)}</div>
        <div style="font-size:0.85rem;color:var(--text-secondary);margin-top:0.5rem;">
          ZEC + USD at current market price
        </div>
        <div style="font-size:0.8rem;color:var(--text-tertiary);margin-top:0.25rem;">
          Price: $${formatZecPrice(zecPrice)}
        </div>
      </div>
    `;

    // 2. Asset Mix
    const cardAssetMix = `
      <div class="metric-card">
        <div class="metric-label">Asset Mix</div>
        <div style="font-size:0.9rem;color:var(--text-secondary);display:flex;flex-direction:column;gap:0.25rem;">
          <div><strong>ZEC Holdings:</strong> ${zecBal.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          })} ZEC (≈${formatUSD(zecBalUsdNum || zecBal * zecPrice)})</div>
          <div><strong>USD Reserves:</strong> ${formatUSD(usdBal + usdRes)}</div>
        </div>
        ${
          (hedgedUSD || unhedged)
            ? `
        <div style="margin-top:0.75rem;">
          <div style="font-size:0.75rem;color:var(--text-tertiary);margin-bottom:0.25rem;">
            Hedged vs Unhedged (USD)
          </div>
          <div style="width:100%;height:6px;background:var(--bg-secondary);border-radius:999px;overflow:hidden;">
            <div style="height:100%;width:${
              futureLiab > 0
                ? Math.min(100, (hedgedUSD / Math.max(futureLiab, hedgedUSD)) * 100)
                : 100
            }%;background:linear-gradient(90deg,#4caf50,#8bc34a);"></div>
          </div>
          <div style="font-size:0.75rem;color:var(--text-tertiary);margin-top:0.25rem;">
            Hedged: ${formatUSD(hedgedUSD)} • Unhedged: ${formatUSD(unhedged)}
          </div>
        </div>
        `
            : ""
        }
      </div>
    `;

    // 3. ZEC Accrued
    const cardZecAccrued = `
      <div class="metric-card">
        <div class="metric-label">ZEC Accrued</div>
        <div class="metric-number">
          ${zecAccTotal.toLocaleString(undefined, {
            minimumFractionDigits: 3,
            maximumFractionDigits: 3
          })} ZEC
        </div>
        <div style="font-size:0.8rem;color:var(--text-tertiary);margin-top:0.25rem;">
          ≈${formatUSD(zecAccTotal * zecPrice)} @ $${formatZecPrice(zecPrice)}/ZEC
        </div>
        <div style="display:flex;gap:1.5rem;margin-top:0.75rem;font-size:0.85rem;color:var(--text-secondary);flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;margin-bottom:0.25rem;">By Dev Fund (lifetime)</div>
            <div>1st Dev Fund: ${zecDev1.toLocaleString(undefined,{maximumFractionDigits:3})} ZEC</div>
            <div>2nd Dev Fund: ${zecDev2.toLocaleString(undefined,{maximumFractionDigits:3})} ZEC</div>
            ${
              zecDev3
                ? `<div>3rd Dev Fund: ${zecDev3.toLocaleString(undefined,{maximumFractionDigits:3})} ZEC</div>`
                : ""
            }
          </div>
          <div>
            <div style="font-weight:600;margin-bottom:0.25rem;">YTD Accrual</div>
            <div>${zecAccruedYTD.toLocaleString(undefined,{
              maximumFractionDigits:3
            })} ZEC</div>
            <div style="font-size:0.8rem;color:var(--text-tertiary);">
              ≈${formatUSD(zecAccruedYTD * zecPrice)}
            </div>
          </div>
        </div>
      </div>
    `;

    // 4. Dev Fund Inflow
    const cardDevInflow = `
      <div class="metric-card">
        <div class="metric-label">Dev Fund Inflow</div>
        <div class="metric-number">
          Avg Monthly Inflow: ${avgMonthlyInflowZEC.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          })} ZEC
        </div>
        <div style="font-size:0.85rem;color:var(--text-tertiary);margin-top:0.25rem;">
          ≈${formatUSD(avgMonthlyInflowZEC * zecPrice)} at current price
        </div>
      </div>
    `;

    // 5. Treasury Commitments & Coverage
    const coverageText =
      hedgedCoverageRatio === null
        ? ""
        : hedgedCoverageRatio >= 1
        ? `Hedged: ${(hedgedCoverageRatio * 100).toFixed(0)}% of liabilities`
        : `Hedged: ${(hedgedCoverageRatio * 100).toFixed(0)}% of liabilities`;

    const cardCommitments = `
      <div class="metric-card">
        <div class="metric-label">Commitments & Coverage</div>
        <div class="metric-number">
          Future Liabilities: ${formatUSD(futureLiab)}
        </div>
        <div style="font-size:0.85rem;color:var(--text-secondary);margin-top:0.5rem;">
          Hedged Coverage: ${formatUSD(hedgedUSD)}${coverageText ? " • " + coverageText : ""}
        </div>
        <div style="font-size:0.8rem;color:var(--text-tertiary);margin-top:0.25rem;">
          Unhedged: ${formatUSD(unhedged)}
        </div>
      </div>
    `;

    usdMetricsEl.innerHTML =
      cardTotalTreasury +
      cardAssetMix +
      cardZecAccrued +
      cardDevInflow +
      cardCommitments;

    /* ===== Grants (3 cards) ===== */

    // 6. Grants Overview
    const cardGrantsOverview = `
      <div class="metric-card">
        <div class="metric-label">Grants Overview</div>
        <div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:0.25rem;">
          ${grantStats.totalProjects.toLocaleString()} Total Grants
        </div>
        <div style="font-size:0.9rem;color:var(--text-secondary);display:flex;gap:1.5rem;flex-wrap:wrap;">
          <div>Completed: ${grantStats.totalCompleted.toLocaleString()}</div>
          <div>In Progress: ${grantStats.inProgress.toLocaleString()}</div>
          <div>Pending: ${grantStats.waiting.toLocaleString()}</div>
        </div>
      </div>
    `;

    // 7. YTD Grant Activity
    const cardYTDActivity = `
      <div class="metric-card">
        <div class="metric-label">${grantStats.year} Grant Activity</div>
        <div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:0.25rem;">
          ${grantStats.approvedYTD.toLocaleString()} Approved • ${grantStats.completedYTD.toLocaleString()} Completed
        </div>
        <div style="font-size:0.9rem;color:var(--text-secondary);">
          Payouts YTD: ${formatUSD(grantStats.payoutsYTDUSD)}
        </div>
        <div style="font-size:0.8rem;color:var(--text-tertiary);margin-top:0.25rem;">
          = ${grantStats.payoutsYTDZEC.toLocaleString(undefined,{
            minimumFractionDigits:2,
            maximumFractionDigits:2
          })} ZEC (≈${formatUSD(grantStats.payoutsYTDZEC * zecPrice)})
        </div>
      </div>
    `;

    // 8. Historical Payout Velocity
    const cardPayoutVelocity = `
      <div class="metric-card">
        <div class="metric-label">Average Monthly Payout (All-Time)</div>
        <div class="metric-number">
          ${formatUSD(grantStats.avgMonthlyPayoutUSD)}
        </div>
        <div style="font-size:0.85rem;color:var(--text-secondary);margin-top:0.25rem;">
          Based on ${formatUSD(grantStats.lifetimePayoutUSD)} paid over ${grantStats.monthsSpan} months
        </div>
        <div style="font-size:0.8rem;color:var(--text-tertiary);margin-top:0.25rem;">
          ≈${(grantStats.avgMonthlyPayoutUSD / zecPrice || 0).toLocaleString(undefined,{
            minimumFractionDigits:2,
            maximumFractionDigits:2
          })} ZEC / month @ $${formatZecPrice(zecPrice)}
        </div>
      </div>
    `;

    activityEl.innerHTML =
      cardGrantsOverview + cardYTDActivity + cardPayoutVelocity;
  } catch (error) {
    console.error("Error in loadOverview (8-card layout):", error);
    const usdEl = document.getElementById("usdMetrics");
    const actEl = document.getElementById("activityMetrics");
    if (usdEl)
      usdEl.innerHTML =
        '<div class="loading">Error loading treasury metrics</div>';
    if (actEl)
      actEl.innerHTML =
        '<div class="loading">Error loading grants metrics</div>';
  }
}

/* ===== Payouts Chart ===== */
function filterPayoutsByTime(period) {
  currentTimeFilter = period;
  document
    .querySelectorAll("#timeFilters .pill")
    .forEach((p) => p.classList.remove("active"));
  event.target.classList.add("active");
  loadPayoutsChart();
}

async function loadPayoutsChart() {
  try {
    await loadWorkbook();
    if (!currentPayoutData.length) {
      currentPayoutData = sheetToObjects(SHEETS.GRANTS_ZCG, 0);
    }

    const now = new Date();
    let startDate = new Date();

    switch (currentTimeFilter) {
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

    const monthlyMap = {};
    currentPayoutData.forEach((row) => {
      if (!row["Paid Out"]) return;
      const date = toDate(row["Paid Out"]);
      if (!date || date < startDate) return;

      const monthKey = `${date.getFullYear()}-${String(
        date.getMonth() + 1
      ).padStart(2, "0")}`;
      if (!monthlyMap[monthKey])
        monthlyMap[monthKey] = { amount: 0, milestones: 0 };
      monthlyMap[monthKey].amount += cleanNumber(row["Amount (USD)"]);
      monthlyMap[monthKey].milestones++;
    });

    const sorted = Object.entries(monthlyMap).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const labels = sorted.map(([m]) => m);
    const amounts = sorted.map(([, v]) => v.amount);
    const milestones = sorted.map(([, v]) => v.milestones);

    const ctx = document.getElementById("payoutsChart");
    if (ctx.chart) ctx.chart.destroy();

    ctx.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Milestones",
            data: milestones,
            borderColor: "#ff9800",
            backgroundColor: "rgba(255,152,0,0.2)",
            yAxisID: "y1",
            tension: 0.4
          },
          {
            label: "Payouts (USD)",
            data: amounts,
            borderColor: getComputedStyle(document.documentElement)
              .getPropertyValue("--accent-third")
              .trim(),
            backgroundColor: "rgba(255,193,124,0.2)",
            yAxisID: "y2",
            tension: 0.4
          }
        ]
      },
      options: {
        ...getChartOptions(),
        interaction: { mode: "index", intersect: false },
        scales: {
          x: getChartOptions().scales.x,
          y1: {
            type: "linear",
            position: "left",
            title: { display: true, text: "Milestones (count)" },
            beginAtZero: true,
            grid: {
              color: getComputedStyle(document.documentElement)
                .getPropertyValue("--grid-color")
                .trim()
            },
            ticks: {
              color: getComputedStyle(document.documentElement)
                .getPropertyValue("--text-tertiary")
                .trim()
            }
          },
          y2: {
            type: "linear",
            position: "right",
            title: { display: true, text: "USD" },
            grid: { drawOnChartArea: false },
            ticks: {
              color: getComputedStyle(document.documentElement)
                .getPropertyValue("--text-tertiary")
                .trim()
            }
          }
        }
      }
    });
  } catch (error) {
    console.error("Error loading payouts chart:", error);
  }
}

/* ===== Category Chart ===== */
async function loadCategoryChart() {
  try {
    await loadWorkbook();
    const aoa = sheetToAoA(SHEETS.FUNDS);
    if (!aoa.length) return;

    const COL_LABEL = 12;
    const COL_VALUE = 13;

    const isText = (v) => typeof v === "string" && v.trim() !== "";
    const toNum = (v) => cleanNumber(v);

    const categoryTotals = {};

    for (let r = 0; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const labelCell = row[COL_LABEL];
      const valueCell = row[COL_VALUE];

      if (!labelCell && !valueCell) continue;

      if (isText(labelCell)) {
        const label = labelCell.trim();
        if (label.length > 0 && label.length <= 60) {
          const amount = toNum(valueCell);
          if (amount > 0) {
            categoryTotals[label] = (categoryTotals[label] || 0) + amount;
          }
        }
      }
    }

    const entries = Object.entries(categoryTotals).filter(([, v]) => v > 0);
    if (!entries.length) {
      console.warn("Category chart: no M:N data detected.");
      return;
    }

    const sorted = entries.sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(([cat]) => cat);
    const data = sorted.map(([, amount]) => amount);

    const ctx = document.getElementById("categoryChart");
    if (ctx.chart) ctx.chart.destroy();

    ctx.chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            data,
            backgroundColor: labels.map(
              (_, i) => `rgba(255, 193, 124, ${Math.max(0.85 - i * 0.08, 0.35)})`
            ),
            borderColor: getComputedStyle(document.documentElement)
              .getPropertyValue("--accent-primary")
              .trim(),
            borderWidth: 1
          }
        ]
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
              callback: (v) => formatUSD(v)
            }
          }
        }
      }
    });
  } catch (error) {
    console.error("Error loading category chart:", error);
  }
}

/* ===== ZEC Price Trend ===== */
async function loadZecPriceTrend() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/zcash/market_chart?vs_currency=usd&days=90"
    );
    const data = await res.json();

    const filtered = data.prices.filter((_, i) => i % 24 === 0);
    const prices = filtered.map((p) => ({ date: new Date(p[0]), price: p[1] }));

    const ctx = document.getElementById("zecPriceChart");
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
            pointRadius: 3,
            pointHoverRadius: 5
          }
        ]
      },
      options: getChartOptions()
    });
  } catch (error) {
    console.error("Error loading ZEC price:", error);
  }
}

/* ===== Approved Grants Chart ===== */
function approvedRangeLabel() {
  switch (currentApprovedTimeFilter) {
    case "1m": return " (Last 1m)";
    case "3m": return " (Last 3m)";
    case "1y": return " (Last 1y)";
    case "ytd": return ` (YTD ${new Date().getFullYear()})`;
    default: return " (Max)";
  }
}

function filterByTimeApproved(raw, range) {
  if (!Array.isArray(raw)) return [];
  if (range === "max") return raw.slice();

  const now = new Date();
  let start = new Date();

  switch (range) {
    case "1m": start.setMonth(now.getMonth() - 1); break;
    case "3m": start.setMonth(now.getMonth() - 3); break;
    case "1y": start.setFullYear(now.getFullYear() - 1); break;
    case "ytd": start = new Date(now.getFullYear(), 0, 1); break;
    default: return raw.slice();
  }
  return raw.filter((r) => {
    const d = toDate(r.date);
    return d && d >= start;
  });
}

function buildProjectTotalsFromGrants() {
  const rows = sheetToObjects(SHEETS.GRANTS_ZCG, 0);
  const totals = {};
  rows.forEach((r) => {
    const project = (r["Project"] || "").toString();
    const key = normKey(project);
    if (!key) return;
    const amt = cleanNumber(r["Amount (USD)"]);
    totals[key] = (totals[key] || 0) + amt;
  });
  return totals;
}

function bucketApprovedByMonthJoined(raw, projectMap) {
  const byMonth = {};
  raw.forEach((r) => {
    const d = toDate(r.date);
    if (!d) return;
    const keyMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!byMonth[keyMonth]) byMonth[keyMonth] = { amount: 0, count: 0 };

    byMonth[keyMonth].count += 1;

    const k = normKey(r.title);
    const usd = projectMap[k] || 0;
    byMonth[keyMonth].amount += usd;
  });

  const entries = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b));
  const labels = entries.map(([k]) => k);
  const amounts = entries.map(([, v]) => v.amount);
  const counts = entries.map(([, v]) => v.count);
  return { labels, amounts, counts };
}

function renderApprovedChartJoined(data) {
  const ctx = document.getElementById("approvedChart");
  if (!ctx) return;
  if (ctx.chart) ctx.chart.destroy();

  const titleEl = document.getElementById("approvedTitle");
  if (titleEl) titleEl.textContent = "Approved Grants/month";

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
          pointHoverRadius: 5
        },
        {
          label: "Approved (USD)",
          data: amounts,
          borderColor: getComputedStyle(document.documentElement)
            .getPropertyValue("--accent-third")
            .trim(),
          backgroundColor: "rgba(255,193,124,0.2)",
          yAxisID: "y2",
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5
        }
      ]
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
          grid: { color: getComputedStyle(document.documentElement).getPropertyValue("--grid-color").trim() },
          ticks: { color: getComputedStyle(document.documentElement).getPropertyValue("--text-tertiary").trim() }
        },
        y2: {
          type: "linear",
          position: "right",
          title: { display: true, text: "USD" },
          grid: { drawOnChartArea: false },
          ticks: {
            color: getComputedStyle(document.documentElement).getPropertyValue("--text-tertiary").trim(),
            callback: (v) => formatUSD(v)
          }
        }
      }
    }
  });
}

function setupApprovedTimeFilters() {
  const container = document.getElementById("approvedTimeFilters");
  if (!container) return;
  container.querySelectorAll(".pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      container.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentApprovedTimeFilter = pill.dataset.range || "ytd";

      const filtered = filterByTimeApproved(approvedAllRaw, currentApprovedTimeFilter);
      const b = bucketApprovedByMonthJoined(filtered, projectTotalsMap);
      renderApprovedChartJoined(b);
    });
  });
}

async function loadApprovedChart() {
  try {
    await loadWorkbook();

    projectTotalsMap = buildProjectTotalsFromGrants();

    const aoa = sheetToAoA(SHEETS.ALL_GRANTS);

    const COL_DATE = 0;
    const COL_TITLE = 1;
    const COL_DECISION = 5;

    const approvedRows = [];
    for (let i = 1; i < aoa.length; i++) {
      const row = aoa[i];
      if (!row) continue;

      const rawDate = row[COL_DATE];
      const title = (row[COL_TITLE] || "").toString().trim();
      let decisionRaw = (row[COL_DECISION] || "").toString().replace(/\u00A0/g, " ").trim().toLowerCase();
      const decision = decisionRaw.replace(/[^\w\s]/g, "").trim();

      if (!title || !rawDate) continue;
      if (decision !== "approved") continue;

      const d = toDate(rawDate);
      if (!d) continue;

      approvedRows.push({ date: d, title });
    }

    approvedAllRaw = approvedRows;

    const filtered = filterByTimeApproved(approvedAllRaw, currentApprovedTimeFilter);
    const b = bucketApprovedByMonthJoined(filtered, projectTotalsMap);
    renderApprovedChartJoined(b);

    setupApprovedTimeFilters();
  } catch (err) {
    console.error("Error loading approved chart (joined):", err);
  }
}

/* ===== GRANTS ===== */
function buildProjectSubmissionDates() {
  const aoa = sheetToAoA(SHEETS.ALL_GRANTS);
  const map = {};
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (!row) continue;
    const d = toDate(row[0]);
    const title = (row[1] || "").toString().trim();
    if (!title || !d) continue;
    const k = title.toLowerCase().replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
    const prev = map[k];
    if (!prev || d < prev) map[k] = d;
  }
  return map;
}

async function loadGrants() {
    try {
      await loadWorkbook();
  
      const aoa = sheetToAoA(SHEETS.GRANTS_ZCG);
      if (!aoa.length) {
        document.getElementById("grantsContainer").innerHTML =
          '<div class="loading">Error loading grants data</div>';
        return;
      }
      const headers = (aoa[0] || []).map((h) => (h || "").toString().replace(/\u00A0/g, " ").trim());
      const headerNorm = headers.map((h) => h.replace(/\s+/g, " ").toLowerCase());
      const idxCategory = headerNorm.indexOf("category (as determined by zcg)");
      const categoryHeader = idxCategory >= 0 ? headers[idxCategory] : "Category (as determined by ZCG)";
  
      const submissionMap = buildProjectSubmissionDates();
  
      const rows = sheetToObjects(SHEETS.GRANTS_ZCG, 0);
  
      const projectMap = {};
      rows.forEach((row) => {
        const project = (row["Project"] || "").toString().trim();
        const grantee =
          row["Grantee"] || row["Applicant(s)"] || row["Applicant"] || row["Recipient"];
        if (!project || !grantee) return;
  
        const key = `${project}_${grantee}`;
        if (!projectMap[key]) {
          projectMap[key] = {
            project,
            grantee,
            totalAmount: 0,
            paidAmount: 0,
            milestones: [],
            lastPaidDate: null,
            category: "",
            submissionDate: null
          };
        }
  
        const cat = (row[categoryHeader] || "").toString().replace(/\u00A0/g, " ").trim();
        if (cat && !projectMap[key].category) {
          projectMap[key].category = cat;
        }
  
        if (!projectMap[key].submissionDate) {
          const k = project.toLowerCase().replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
          if (submissionMap[k]) projectMap[key].submissionDate = submissionMap[k];
        }
  
        const amount = cleanNumber(row["Amount (USD)"]);
        projectMap[key].totalAmount += amount;
  
        if (row["Paid Out"]) {
          projectMap[key].paidAmount += amount;
          const paidDate = toDate(row["Paid Out"]);
          if (paidDate && (!projectMap[key].lastPaidDate || paidDate > projectMap[key].lastPaidDate)) {
            projectMap[key].lastPaidDate = paidDate;
          }
        }
  
        projectMap[key].milestones.push({
          amount,
          dueDate: row["Milestone Due Date"],
          paidDate: row["Paid Out"],
          estimate: row["Estimate"]
        });
      });
  
      allGrants = Object.values(projectMap).map((grant) => {
        const completedMilestones = grant.milestones.filter((m) => m.paidDate).length;
        const totalMilestones = grant.milestones.length;
        let status;
        if (completedMilestones === totalMilestones) status = "completed";
        else if (completedMilestones > 0) status = "in-progress";
        else status = "waiting";
        return {
          ...grant,
          status,
          completedMilestones,
          totalMilestones,
          category: grant.category || "",
          submissionDate: grant.submissionDate || null
        };
      });
  
      filteredGrants = [...allGrants];
      sortGrants();
      setupCategoryFilters();
    } catch (error) {
      console.error("Error in loadGrants:", error);
      document.getElementById("grantsContainer").innerHTML =
        '<div class="loading">Error loading grants data</div>';
    }
  }
  
  /* ===== Grant Sorting ===== */
  function cycleSortMode() {
    currentSortMode = (currentSortMode + 1) % 4;
    const mode = sortModes[currentSortMode];
  
    const desktopSortBtn = document.getElementById("sortBtn");
    if (desktopSortBtn) desktopSortBtn.innerHTML = `${mode.icon} ${mode.text}`;
  
    const mobileSortBtn = document.querySelector(".mobile-filters .sort-btn");
    if (mobileSortBtn) mobileSortBtn.innerHTML = `${mode.icon} ${mode.text}`;
  
    sortGrants();
  }
  
  function sortGrants() {
    const mode = sortModes[currentSortMode];
  
    switch (mode.key) {
      case "newest":
        filteredGrants.sort((a, b) => {
          if (!a.lastPaidDate && !b.lastPaidDate) return 0;
          if (!a.lastPaidDate) return 1;
          if (!b.lastPaidDate) return -1;
          return b.lastPaidDate - a.lastPaidDate;
        });
        break;
      case "oldest":
        filteredGrants.sort((a, b) => {
          if (!a.lastPaidDate && !b.lastPaidDate) return 0;
          if (!a.lastPaidDate) return -1;
          if (!b.lastPaidDate) return 1;
          return a.lastPaidDate - b.lastPaidDate;
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
  function filterGrantsBySearch(query) {
    if (!allGrants.length) return;
  
    query = (query || "").toLowerCase();
  
    let searchFiltered = allGrants.filter((grant) => {
      const cat = (grant.category || "").toLowerCase();
      return (
        grant.project.toLowerCase().includes(query) ||
        grant.grantee.toLowerCase().includes(query) ||
        cat.includes(query)
      );
    });
  
    if (currentStatusFilter !== "all") {
      searchFiltered = searchFiltered.filter((g) => g.status === currentStatusFilter);
    }
  
    switch (currentBudgetFilter) {
      case "small":
        searchFiltered = searchFiltered.filter((g) => g.totalAmount < 50000);
        break;
      case "medium":
        searchFiltered = searchFiltered.filter(
          (g) => g.totalAmount >= 50000 && g.totalAmount <= 200000
        );
        break;
      case "large":
        searchFiltered = searchFiltered.filter((g) => g.totalAmount > 200000);
        break;
    }
  
    filteredGrants = searchFiltered;
    sortGrants();
  }
  
  function filterGrants(status) {
    currentStatusFilter = status;
  
    document
      .querySelectorAll(".filter-pills .pill")
      .forEach((p) => p.classList.remove("active"));
    event.target.classList.add("active");
  
    document.querySelectorAll("#mobileFilters .pill").forEach((p, i) => {
      if (i < 4) p.classList.remove("active");
    });
    const mobileIndex = ["all", "completed", "in-progress", "waiting"].indexOf(status);
    if (mobileIndex >= 0) {
      document
        .querySelectorAll("#mobileFilters .pill")
        [mobileIndex].classList.add("active");
    }
  
    applyFilters();
  }
  
  function filterGrantsByBudget(range) {
    currentBudgetFilter = range;
  
    document
      .querySelectorAll(".budget-pills .pill")
      .forEach((p) => p.classList.remove("active"));
    event.target.classList.add("active");
  
    document.querySelectorAll("#mobileFilters .pill").forEach((p, i) => {
      if (i >= 4 && i < 8) p.classList.remove("active");
    });
    const mobileIndex = ["all", "small", "medium", "large"].indexOf(range);
    if (mobileIndex >= 0) {
      document
        .querySelectorAll("#mobileFilters .pill")
        [4 + mobileIndex].classList.add("active");
    }
  
    applyFilters();
  }
  
  function applyFilters() {
    let filtered = [...allGrants];
  
    if (currentStatusFilter !== "all") {
      filtered = filtered.filter((g) => g.status === currentStatusFilter);
    }
  
    switch (currentBudgetFilter) {
      case "small":
        filtered = filtered.filter((g) => g.totalAmount < 50000);
        break;
      case "medium":
        filtered = filtered.filter(
          (g) => g.totalAmount >= 50000 && g.totalAmount <= 200000
        );
        break;
      case "large":
        filtered = filtered.filter((g) => g.totalAmount > 200000);
        break;
    }
  
    if (currentCategoryFilter !== "all") {
      const catNorm = currentCategoryFilter.toLowerCase();
      filtered = filtered.filter(
        (g) => (g.category || "").toLowerCase() === catNorm
      );
    }
  
    filteredGrants = filtered;
    sortGrants();
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
  
    const base = `<div class="pill ${currentCategoryFilter === "all" ? "active" : ""}" data-cat="all">All Categories</div>`;
    const pills = cats
      .map(
        (c) =>
          `<div class="pill ${currentCategoryFilter === c ? "active" : ""}" data-cat="${c}">${c}</div>`
      )
      .join("");
  
    container.innerHTML = base + pills;
  
    container.querySelectorAll(".pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        container.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        currentCategoryFilter = pill.dataset.cat || "all";
        applyFilters();
      });
    });
  }
  
  /* ===== Render Grants ===== */
  function renderGrants(grants) {
    const container = document.getElementById("grantsContainer");
    updateGrantsCounter(grants.length, allGrants.length);
  
    if (!grants.length) {
      container.innerHTML = '<div class="loading">No grants found</div>';
      return;
    }
  
    container.innerHTML = grants
      .map((grant) => {
        const progressPercent =
          grant.totalMilestones > 0
            ? (grant.completedMilestones / grant.totalMilestones) * 100
            : 0;
  
        const esc = (s) =>
          String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
  
        return `
        <div class="grant-card ${grant.status}" onclick="showGrantDetails('${esc(
          grant.project
        )}', '${esc(grant.grantee)}')">
          <div class="grant-title">${esc(grant.project)}</div>
          <div class="progress-bar">
            <div class="progress-fill ${grant.status}" style="width: ${progressPercent}%;"></div>
          </div>
          <div class="grant-grantee">${esc(grant.grantee)}</div>
          ${grant.submissionDate ? `<div class="grant-date">Opened: ${new Date(grant.submissionDate).toLocaleDateString()}</div>` : ""}
          <div class="grant-amount">${formatUSD(grant.totalAmount)}</div>
          ${grant.category ? `<div class="category-pill">${esc(grant.category)}</div>` : ``}
          <div class="grant-status ${grant.status}">
            ${grant.status.replace("-", " ").toUpperCase()} 
            (${grant.completedMilestones}/${grant.totalMilestones})
          </div>
          <div class="grant-plus-btn"><span>+</span></div>
        </div>`;
      })
      .join("");
  }
  
  function updateGrantsCounter(filtered, total) {
    const counter = document.getElementById("grantsCounter");
    if (counter) {
      const percent = total > 0 ? ((filtered / total) * 100).toFixed(1) : 0;
      counter.textContent = `Showing ${filtered} of ${total} grants (${percent}%)`;
    }
  }
  
  /* ===== View Toggle ===== */
  function toggleView(viewType) {
    document.querySelectorAll(".view-btn").forEach((b) => b.classList.remove("active"));
    event.target.classList.add("active");
  
    const container = document.getElementById("grantsContainer");
    if (viewType === "list") {
      container.classList.add("list-view");
    } else {
      container.classList.remove("list-view");
    }
  }
  
  /* ===== Grant Details Modal (with GitHub) ===== */
  async function findGitHubIssueByTitle(title) {
    if (githubIssueCache[title]) return githubIssueCache[title];
  
    try {
      const searchGitHub = async (queryTitle) => {
        const query = encodeURIComponent(
          `"${queryTitle}" repo:ZcashCommunityGrants/zcashcommunitygrants`
        );
        const url = `https://api.github.com/search/issues?q=${query}`;
        const res = await fetch(url, {
          headers: { Accept: "application/vnd.github.v3+json" }
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
        headers: { Accept: "application/vnd.github.v3+json" }
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
  
      let sectionLines = [];
      for (let i = startIndex + 1; i < lines.length; i++) {
        if (/^#{1,6}\s+/.test(lines[i]) || /^\*\*.+\*\*$/.test(lines[i].trim())) break;
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
  
    const progressPercent =
      grant.totalMilestones > 0
        ? (grant.completedMilestones / grant.totalMilestones) * 100
        : 0;
  
    const now = new Date();
    const paidMilestones = grant.milestones.filter((m) => !!m.paidDate);
    const futureMilestones = grant.milestones.filter((m) => !m.paidDate);
  
    const renderPaid = (m, i) => `
      <div class="milestone-item">
        <span>#${i + 1} — ${formatUSD(m.amount)}</span>
        <span style="color:#28a745;">Paid ${fmtDateCell(m.paidDate)}</span>
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
  
    let content = `
      <div class="modal-header-grid">
        <h2 class="modal-title">${project}</h2>
        <div class="modal-header-spacer"></div>
        <div class="modal-header-actions">
          <span id="githubBtnSlot"></span>
        </div>
      </div>
      <div class="progress-bar" style="margin: 8px 0 8px;">
        <div class="progress-fill ${grant.status}" style="width: ${progressPercent}%;"></div>
      </div>
      <div class="modal-grantee-row">
        <div class="modal-grantee">${grantee}</div>
      </div>
      <div class="modal-stats-row">
        ${grant.submissionDate ? `<span><strong>Opened:</strong> ${new Date(grant.submissionDate).toLocaleDateString()}</span>` : ""}
        <span><strong>Budget:</strong> ${formatUSD(grant.paidAmount)} / ${formatUSD(grant.totalAmount)}</span>
        ${grant.lastPaidDate ? `<span><strong>Last Payment:</strong> ${fmtDateCell(grant.lastPaidDate)}</span>` : ""}
        <span><strong>Milestones:</strong> ${grant.completedMilestones}/${grant.totalMilestones} completed</span>
        ${grant.category ? `<span class="category-pill">${grant.category}</span>` : ""}
        <span class="grant-status ${grant.status}">${grant.status.replace("-", " ").toUpperCase()}</span>
      </div>
      <div id="githubSection" style="margin-bottom: 20px;">
        <div style="color: var(--text-tertiary); font-size: 0.85rem;">Loading GitHub details...</div>
      </div>
      ${paidMilestones.length ? `
        <h3 style="margin-top: 10px; margin-bottom: 10px; color: var(--text-secondary);">Paid Milestones</h3>
        <div class="milestone-list">
          ${paidMilestones.map((m, idx) => renderPaid(m, idx)).join("")}
        </div>
      ` : ""}
      ${futureMilestones.length ? `
        <h3 style="margin-top: 16px; margin-bottom: 10px; color: var(--text-secondary);">Future Milestones</h3>
        <div class="milestone-list">
          ${futureMilestones.map((m, idx) => renderFuture(m, idx + paidMilestones.length)).join("")}
        </div>
      ` : ""}
    `;
  
    openModal(content);
  
    const issue = await findGitHubIssueByTitle(grant.project);
    const githubContainer = document.getElementById("githubSection");
    const btnSlot = document.getElementById("githubBtnSlot");
  
    if (issue) {
      const issueData = await fetchGitHubIssueBody(issue.number);
  
      if (btnSlot && issueData && issueData.html_url) {
        btnSlot.innerHTML = `
          <a class="github-btn github-btn--accent" href="${issueData.html_url}" target="_blank" rel="noopener">
            <svg viewBox="0 0 16 16" aria-hidden="true" style="width:18px;height:18px;fill:currentColor;">
              <path d="M8 .2a8 8 0 00-2.53 15.6c.4.07.55-.17.55-.38 0-.18-.01-.78-.01-1.42-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.12-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.58.82-2.14-.08-.2-.36-1.01.08-2.1 0 0 .67-.21 2.2.82a7.6 7.6 0 012 0c1.53-1.03 2.2-.82 2.2-.82.44 1.09.16 1.9.08 2.1.51.56.82 1.27.82 2.14 0 3.07-1.87 3.75-3.65 3.95.29.25.54.74.54 1.5 0 1.08-.01 1.95-.01 2.22 0 .21.15.46.55.38A8 8 0 008 .2z"></path>
            </svg>
            More info
          </a>
        `;
      }
  
      if (issueData && issueData.body) {
        let githubHTML = `
          <div id="githubDescription" style="color: var(--text-tertiary); font-size: 0.85rem;">
            Loading description...
          </div>
        `;
        githubContainer.innerHTML = githubHTML;
  
        const summary = extractProjectSummary(issueData.body);
        const descContainer = document.getElementById("githubDescription");
  
        function mdToPlain(md) {
          return (md || "")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/`[^`]*`/g, "")
            .replace(/^>+\s?/gm, "")
            .replace(/^#{1,6}\s*/gm, "")
            .replace(/\*\*|__/g, "")
            .replace(/\*|_/g, "")
            .replace(/!\[.*?\]\(.*?\)/g, "")
            .replace(/\[(.*?)\]\(.*?\)/g, "$1")
            .replace(/\r?\n\s*\r?\n/g, "\n\n")
            .trim();
        }
  
        function renderMarkdownSnippet(md, maxChars, readMoreHref) {
          const plain = mdToPlain(md);
          if (plain.length <= maxChars) {
            return marked.parse(md);
          }
          let cut = maxChars;
          const nextSpace = plain.indexOf(" ", maxChars);
          if (nextSpace !== -1 && nextSpace - maxChars < 100) cut = nextSpace;
          const shortPlain = plain.slice(0, cut).trim();
          const html = marked.parse(shortPlain);
          const link = `<a href="${readMoreHref}" target="_blank" rel="noopener" style="color: var(--accent-secondary); text-decoration: none;">Read more on GitHub →</a>`;
          return `${html}<p style="margin-top:8px;">${link}</p>`;
        }
  
        if (summary) {
          const MAX = 1000;
          descContainer.innerHTML = `
            <h3 style="margin-top: 24px; color: var(--text-secondary);">Project Summary</h3>
            <div style="margin-bottom: 15px;">
              ${renderMarkdownSnippet(summary, MAX, issueData.html_url)}
            </div>
          `;
        } else {
          descContainer.textContent = "No Project Summary section found.";
        }
      } else {
        githubContainer.innerHTML = `<div style="color: var(--text-tertiary); font-size: 0.85rem;">No GitHub details found.</div>`;
      }
    } else {
      githubContainer.innerHTML = `<div style="color: var(--text-tertiary); font-size: 0.85rem;">No GitHub issue found.</div>`;
    }
  }
  
  /* ===== Modal Functions ===== */
  function openModal(content) {
    document.getElementById("modalBody").innerHTML = content;
    document.getElementById("modalOverlay").classList.add("active");
    document.body.style.overflow = "hidden";
  }
  
  function closeModal() {
    document.getElementById("modalOverlay").classList.remove("active");
    document.body.style.overflow = "auto";
  }
  
  /* ===== PAYMENTS ===== */
  function currentPaymentsRangeLabel() {
    switch (currentPaymentsTimeFilter) {
      case "1m": return " (Last 1m)";
      case "3m": return " (Last 3m)";
      case "ytd": return ` (YTD ${new Date().getFullYear()})`;
      default: return " (Max)";
    }
  }
  
  function applyTimeFilter(rawRows, range) {
    if (!Array.isArray(rawRows)) return [];
    if (range === "max") return rawRows.slice();
  
    const now = new Date();
    let start = new Date();
  
    switch (range) {
      case "1m": start.setMonth(now.getMonth() - 1); break;
      case "3m": start.setMonth(now.getMonth() - 3); break;
      case "ytd": start = new Date(now.getFullYear(), 0, 1); break;
      default: return rawRows.slice();
    }
    return rawRows.filter((row) => {
      const d = toDate(row.date);
      return d && d >= start;
    });
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
      case "small":  return aggregated.filter((d) => d.amount < 50000);
      case "medium": return aggregated.filter((d) => d.amount >= 50000 && d.amount <= 200000);
      case "large":  return aggregated.filter((d) => d.amount > 200000);
      default:       return aggregated.slice();
    }
  }
  
  function getPaidOutDataForChart() {
    const sourceRaw = currentPaymentsTimeFilter === "max"
      ? paidOutRawFunds
      : paidOutRawGrants;
  
    const timeFiltered = applyTimeFilter(sourceRaw, currentPaymentsTimeFilter);
    const aggregated = aggregateByGrantee(timeFiltered);
    const amountFiltered = applyAmountFilter(aggregated, currentPaidOutAmountFilter);
    return amountFiltered;
  }
  
  function renderPaidOutChart(data) {
    const ctx = document.getElementById("paidOutChart");
    if (!ctx) return;
    if (ctx.chart) ctx.chart.destroy();
  
    const titleEl = document.getElementById("paidOutTitle");
    if (titleEl) titleEl.textContent = "Total Paid Out" + currentPaymentsRangeLabel();
  
    ctx.parentElement.style.height = Math.max(200, data.length * 30) + "px";
  
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
            borderWidth: 1
          }
        ]
      },
      options: {
        ...getChartOptions(),
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                const value = ctx.parsed.x || 0;
                const pct = totalPaid > 0 ? ((value / totalPaid) * 100).toFixed(1) : "0.0";
                return `${formatUSD(value)} (${pct}%)`;
              }
            }
          },
          datalabels: {
            anchor: "end",
            align: "right",
            color: getComputedStyle(document.documentElement)
              .getPropertyValue("--text-secondary")
              .trim(),
            formatter: function (value) {
              const pct = totalPaid > 0 ? ((value / totalPaid) * 100).toFixed(1) : "0.0";
              return `${pct}%`;
            },
            font: {
              weight: "600",
              size: 11
            },
            offset: 4,
            display: function (ctx) {
              const v = ctx.dataset.data[ctx.dataIndex] || 0;
              return v > 0;
            }
          }
        },
        scales: {
          x: {
            ...getChartOptions().scales.x,
            title: { display: true, text: "USD" },
            ticks: {
              ...getChartOptions().scales.x.ticks,
              callback: (v) => formatUSD(v)
            }
          }
        }
      },
      plugins: [ChartDataLabels]
    });
  }
  
  function renderFutureChart(data) {
    const ctx = document.getElementById("futureMilestonesChart");
    if (!ctx) return;
    if (ctx.chart) ctx.chart.destroy();
  
    ctx.parentElement.style.height = Math.max(200, data.length * 30) + "px";
  
    const totalFuture = data.reduce((sum, d) => sum + (d.amount || 0), 0);
  
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
            borderWidth: 1
          }
        ]
      },
      options: {
        ...getChartOptions(),
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                const value = ctx.parsed.x || 0;
                const pct = totalFuture > 0 ? ((value / totalFuture) * 100).toFixed(1) : "0.0";
                return `${formatUSD(value)} (${pct}%)`;
              }
            }
          }
        },
        scales: {
          x: {
            ...getChartOptions().scales.x,
            ticks: {
              ...getChartOptions().scales.x.ticks,
              callback: (v) => formatUSD(v)
            }
          }
        }
      }
    });
  }
  
  function setupPaymentsTimeFilters() {
    const container = document.getElementById("paymentsTimeFilters");
    if (!container) return;
    container.querySelectorAll(".pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        container.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        currentPaymentsTimeFilter = pill.dataset.range || "max";
        renderPaidOutChart(getPaidOutDataForChart());
      });
    });
  }
  
  function setupPaidOutAmountFilters() {
    const container = document.getElementById("paidOutFilters");
    if (!container) return;
    container.querySelectorAll(".pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        container.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        currentPaidOutAmountFilter = pill.dataset.range || "all";
        renderPaidOutChart(getPaidOutDataForChart());
      });
    });
  }
  
  function setupChartFilters(containerId, originalData, renderFn) {
    document.querySelectorAll(`#${containerId} .pill`).forEach((pill) => {
      pill.addEventListener("click", () => {
        document.querySelectorAll(`#${containerId} .pill`).forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
  
        const range = pill.dataset.range;
        let filtered = [...originalData];
  
        if (range === "small") filtered = filtered.filter((d) => d.amount < 50000);
        if (range === "medium") filtered = filtered.filter((d) => d.amount >= 50000 && d.amount <= 200000);
        if (range === "large") filtered = filtered.filter((d) => d.amount > 200000);
  
        renderFn(filtered);
      });
    });
  }
  
  async function loadPayouts() {
    try {
      await loadWorkbook();
  
      const aoaFunds = sheetToAoA(SHEETS.FUNDS);
      if (aoaFunds.length >= 3) {
        const headersF = (aoaFunds[2] || []).map((h) => (h || "").toString().replace(/\u00A0/g, " ").trim());
        const dataRowsF = aoaFunds.slice(3).filter((r) => r.some((c) => c !== null && c !== undefined && c !== ""));
        const objF = dataRowsF.map((r) => {
          const o = {};
          headersF.forEach((h, i) => { if (h) o[h] = r[i]; });
          return o;
        });
  
        const recipientColF   = headersF.find((h) => /recipient|classification/i.test(h));
        const paidOutAmtColF  = headersF.find((h) => /paid\s*out/i.test(h));
        const paidOutDateColF = headersF.find((h) => /(paid\s*out.*date|date.*paid\s*out|paid\s*out)/i.test(h)) || "Paid Out";
        const futureColF      = headersF.find((h) => /future\s*milestones/i.test(h));
  
        paidOutRawFunds = objF
          .filter((r) => cleanNumber(r[paidOutAmtColF]) > 0 && r[recipientColF])
          .map((r) => ({
            grantee: (r[recipientColF] || "").toString().trim(),
            amount: cleanNumber(r[paidOutAmtColF]),
            date: r[paidOutDateColF]
          }));
  
        const aggF = {};
        paidOutRawFunds.forEach((r) => { aggF[r.grantee] = (aggF[r.grantee] || 0) + r.amount; });
        paidOutOriginal = Object.entries(aggF).map(([grantee, amount]) => ({ grantee, amount })).sort((a, b) => b.amount - a.amount);
  
        futureOriginal = objF
          .map((r) => ({
            grantee: (r[recipientColF] || "").toString().trim(),
            amount: cleanNumber(r[futureColF])
          }))
          .filter((r) => r.amount > 0 && r.grantee !== "")
          .sort((a, b) => b.amount - a.amount);
      }
  
      const rowsG = sheetToObjects(SHEETS.GRANTS_ZCG, 0);
      const granteeGetter = (r) =>
        (r["Grantee"] || r["Applicant(s)"] || r["Applicant"] || r["Recipient"] || "").toString().trim();
  
      paidOutRawGrants = rowsG
        .filter((r) => cleanNumber(r["Amount (USD)"]) > 0 && r["Paid Out"])
        .map((r) => ({
          grantee: granteeGetter(r),
          amount: cleanNumber(r["Amount (USD)"]),
          date: r["Paid Out"]
        }))
        .filter((r) => r.grantee);
  
      renderPaidOutChart(getPaidOutDataForChart());
      renderFutureChart(futureOriginal);
  
      setupPaidOutAmountFilters();
      setupPaymentsTimeFilters();
      setupChartFilters("futureFilters", futureOriginal, renderFutureChart);
    } catch (error) {
      console.error("Error loading payouts data:", error);
    }
  }
  
  /* ===== LIQUIDITY ===== */
  async function loadLiquidity() {
    try {
      await loadWorkbook();
      const aoa = sheetToAoA(SHEETS.LIQUIDITY);
      if (!aoa.length) {
        document.getElementById("liquidityContent").innerHTML =
          '<div class="loading">No liquidity data</div>';
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
  
      for (let r = 0; r < aoa.length; r++) {
        const label = aoa[r]?.[COL_KPI_LABEL];
        const value = aoa[r]?.[COL_KPI_VALUE];
  
        if (!label && !value) continue;
  
        const k = norm(label);
        const v = cleanNumber(value);
  
        if (k === "zec") zecBalance = v;
        else if (k === "cacao") cacaoBalance = v;
        else if (k === "usd value in wallet") usdValueWallet = v;
        else if (k.includes("gain/loss")) gainLossKPI = v;
      }
  
      let totalLiquidityAdded = 0;
      for (let r = 0; r < aoa.length; r++) {
        const proj = aoa[r]?.[COL_PROJECT];
        if (!proj) continue;
        const amt = cleanNumber(aoa[r]?.[COL_AMOUNT_USD]);
        if (amt > 0) totalLiquidityAdded += amt;
      }
  
      const profitLoss = usdValueWallet - totalLiquidityAdded;
  
      const html = `
        <div class="liquidity-cards">
          <div class="liquidity-card">
            <div class="liquidity-content">
              <div class="liquidity-icon liquidity-icon-bg">🌊</div>
              <div class="liquidity-text">
                <div class="liquidity-label">Total Liquidity Added</div>
                <div class="liquidity-value">${formatUSD(totalLiquidityAdded)}</div>
              </div>
            </div>
          </div>
          <div class="liquidity-card">
            <div class="liquidity-content">
              <div class="liquidity-icon liquidity-icon-bg">💵</div>
              <div class="liquidity-text">
                <div class="liquidity-label">Current USD Value in Wallet</div>
                <div class="liquidity-value">${formatUSD(usdValueWallet)}</div>
              </div>
            </div>
          </div>
          <div class="liquidity-card">
            <div class="liquidity-content">
              <div class="liquidity-icon liquidity-icon-bg">⚡</div>
              <div class="liquidity-text">
                <div class="liquidity-label">Current Liquidity (ZEC)</div>
                <div class="liquidity-value">${formatZEC(zecBalance)}</div>
              </div>
            </div>
          </div>
          <div class="liquidity-card">
            <div class="liquidity-content">
              <div class="liquidity-icon liquidity-icon-bg">☕</div>
              <div class="liquidity-text">
                <div class="liquidity-label">Current Liquidity (CACAO)</div>
                <div class="liquidity-value">${cacaoBalance.toLocaleString()}</div>
              </div>
            </div>
          </div>
          <div class="liquidity-card ${profitLoss >= 0 ? "positive" : "negative"}">
            <div class="liquidity-content">
              <div class="liquidity-icon liquidity-icon-bg">${profitLoss >= 0 ? "📈" : "📉"}</div>
              <div class="liquidity-text">
                <div class="liquidity-label">Profit / Loss (USD)</div>
                <div class="liquidity-value">${profitLoss >= 0 ? "+" : ""}${formatUSD(profitLoss)}</div>
              </div>
            </div>
          </div>
          <div class="liquidity-card ${gainLossKPI >= 0 ? "positive" : "negative"}">
            <div class="liquidity-content">
              <div class="liquidity-icon liquidity-icon-bg">🔻</div>
              <div class="liquidity-text">
                <div class="liquidity-label">Impermanent Loss (USD)</div>
                <div class="liquidity-value">${gainLossKPI >= 0 ? "+" : ""}${formatUSD(gainLossKPI)}</div>
              </div>
            </div>
          </div>
        </div>
      `;
  
      document.getElementById("liquidityContent").innerHTML = html;
    } catch (error) {
      console.error("Error loading liquidity data:", error);
      document.getElementById("liquidityContent").innerHTML =
        '<div class="loading">Error loading liquidity data</div>';
    }
  }
  
  /* ===== STIPENDS ===== */
  function renderStipendsChart(months, totalUSD, perPersonUSD, zecPerPersonUSD) {
    const perPersonTotalUSD = totalUSD.map((v) => v / 5);
  
    const ctx = document.getElementById("stipendsChart");
    if (ctx.chart) ctx.chart.destroy();
  
    ctx.chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: months,
        datasets: [
          {
            label: "Total Stipends (USD)",
            data: totalUSD,
            backgroundColor: "rgba(243, 166, 34, 0.7)",
            borderColor: "#f3a622",
            borderWidth: 1,
            yAxisID: "y",
            order: 4
          },
          {
            label: "USD Portion per Person (Fixed)",
            data: Array(months.length).fill(perPersonUSD),
            type: "line",
            borderColor: "#4caf50",
            backgroundColor: "rgba(76, 175, 80, 1)",
            fill: false,
            yAxisID: "y",
            tension: 0.3,
            order: 3
          },
          {
            label: "10 ZEC Portion per Person (USD value)",
            data: zecPerPersonUSD,
            type: "line",
            borderColor: "#2196f3",
            backgroundColor: "rgba(33, 150, 243, 1)",
            fill: false,
            yAxisID: "y",
            tension: 0.3,
            order: 2
          },
          {
            label: "Per Person Total USD",
            data: perPersonTotalUSD,
            type: "line",
            borderColor: "#e91e63",
            backgroundColor: "rgba(233, 30, 99, 0.8)",
            fill: false,
            yAxisID: "y",
            tension: 0.3,
            borderDash: [5, 5],
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              label: function (context) {
                return `${context.dataset.label}: $${context.parsed.y.toLocaleString()}`;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: "USD" }
          }
        }
      }
    });
  }
  
  async function loadStipends() {
    try {
      await loadWorkbook();
      const rows = sheetToObjects(SHEETS.STIPENDS, 0);
  
      const monthly = {};
      let totalUSDYTD = 0;
  
      rows.forEach((r) => {
        const date = toDate(r["Date"]);
        if (!date) return;
        const monthKey = date.toLocaleString("default", {
          month: "long",
          year: "numeric"
        });
        monthly[monthKey] = monthly[monthKey] || { usd: 0 };
        const usd = cleanNumber(r["USD Amount"]);
        monthly[monthKey].usd += usd;
        totalUSDYTD += usd;
      });
  
      const months = Object.keys(monthly);
      const totalUSD = months.map((m) => monthly[m].usd);
  
      const perPersonUSD = 1725;
      const members = 5;
      const fixedUSDTotal = perPersonUSD * members;
      const zecPerPersonUSD = totalUSD.map((total) => (total - fixedUSDTotal) / members);
  
      document.getElementById("stipendsContent").innerHTML = `
        <div class="stipends-cards">
          <div class="stipend-card">
            <div class="stipend-label">Total Paid YTD</div>
            <div class="stipend-value">${formatUSD(totalUSDYTD)}</div>
          </div>
          <div class="stipend-card">
            <div class="stipend-label">Per Committee Member YTD</div>
            <div class="stipend-value">${formatUSD(totalUSDYTD / members)}</div>
          </div>
          <div class="stipend-card">
            <div class="stipend-label">Avg Monthly per Member</div>
            <div class="stipend-value">${formatUSD(
              (totalUSDYTD / members) / Math.max(1, months.length)
            )}</div>
          </div>
        </div>
        <p style="color: var(--text-secondary); margin-bottom: 20px;">
          ${members} committee members each receive <strong>$${perPersonUSD.toLocaleString()} USD + 10 ZEC</strong> per month.
        </p>
        <div class="stipends-chart-wrapper">
          <div class="stipends-chart-title">Monthly Stipend Breakdown</div>
          <div class="stipends-chart-subtitle">(USD portion vs. ZEC portion per person)</div>
          <div class="chart-container">
            <canvas id="stipendsChart"></canvas>
          </div>
        </div>
      `;
  
      renderStipendsChart(months, totalUSD, perPersonUSD, zecPerPersonUSD);
    } catch (error) {
      console.error(error);
      document.getElementById("stipendsContent").innerHTML =
        '<div class="loading">Error loading stipends data</div>';
    }
  }
  
  /* ===== IC PAYOUTS (AUDIT) ===== */
  function renderAuditPaymentsChart(rows) {
    const monthly = {};
    rows.forEach((r) => {
      const date = toDate(r["Paid Out"]);
      if (!date) return;
  
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  
      const usd = cleanNumber(r["Amount (USD)"]);
      const zec = cleanNumber(r["ZEC Disbursed"]);
  
      if (!monthly[monthKey]) {
        monthly[monthKey] = { usd: 0, zec: 0 };
      }
      monthly[monthKey].usd += usd;
      monthly[monthKey].zec += zec;
    });
  
    const labels = Object.keys(monthly).sort();
    const usdData = labels.map((m) => monthly[m].usd);
    const zecData = labels.map((m) => monthly[m].zec);
  
    const ctx = document.getElementById("auditPaymentsChart").getContext("2d");
    if (ctx.chart) ctx.chart.destroy();
  
    ctx.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Total Audit Payments (USD)",
            data: usdData,
            yAxisID: "yUSD",
            borderColor: "#4caf50",
            backgroundColor: "rgba(76, 175, 80, 0.2)",
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            pointHoverRadius: 5
          },
          {
            label: "Total Audit Payments (ZEC)",
            data: zecData,
            yAxisID: "yZEC",
            borderColor: "#f3a622",
            backgroundColor: "rgba(243, 166, 34, 0.2)",
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            pointHoverRadius: 5
          }
        ]
      },
      options: {
        ...getChartOptions(),
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                const isZEC = ctx.dataset.yAxisID === "yZEC";
                const val = ctx.parsed.y || 0;
                return isZEC
                  ? `${ctx.dataset.label}: ${val.toLocaleString(undefined, { maximumFractionDigits: 2 })} ZEC`
                  : `${ctx.dataset.label}: ${formatUSD(val)}`;
              }
            }
          }
        },
        scales: {
          yUSD: {
            type: "linear",
            position: "left",
            title: { display: true, text: "USD" },
            beginAtZero: true,
            grid: {
              color: getComputedStyle(document.documentElement).getPropertyValue("--grid-color").trim()
            },
            ticks: {
              color: getComputedStyle(document.documentElement).getPropertyValue("--text-tertiary").trim(),
              callback: (v) => formatUSD(v)
            }
          },
          yZEC: {
            type: "linear",
            position: "right",
            title: { display: true, text: "ZEC" },
            grid: { drawOnChartArea: false },
            beginAtZero: true,
            ticks: {
              color: getComputedStyle(document.documentElement).getPropertyValue("--text-tertiary").trim(),
              callback: (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })
            }
          },
          x: {
            ...getChartOptions().scales.x
          }
        }
      }
    });
  }
  
  async function loadICPayouts() {
    try {
      await loadWorkbook();
      const rows = sheetToObjects(SHEETS.IC_PAYOUTS, 0);
  
      const filteredRows = rows.filter(
        (r) => !(r["Project"] || "").toLowerCase().includes("arborist call meeting notes")
      );
  
      let totalUSD = 0;
      let totalZEC = 0;
  
      filteredRows.forEach((r) => {
        const usd = cleanNumber(r["Amount (USD)"]);
        const zec = cleanNumber(r["ZEC Disbursed"]);
  
        totalUSD += usd;
        totalZEC += zec;
      });
  
      let html = `<div class="chart-card">
        <h3 class="chart-title">Audit Payments Over Time</h3>
        <div class="chart-container">
          <canvas id="auditPaymentsChart"></canvas>
        </div>
      </div>
      <table class="data-table">
        <tr>
          <th>Project</th>
          <th>Recipient</th>
          <th>Amount USD</th>
          <th>ZEC</th>
          <th>Date</th>
        </tr>`;
  
      filteredRows.forEach((r) => {
        html += `<tr>
          <td>${r["Project"] || ""}</td>
          <td>${r["Independent Contractor (IC)"] || ""}</td>
          <td>${formatUSD(cleanNumber(r["Amount (USD)"]))}</td>
          <td>${formatZEC(cleanNumber(r["ZEC Disbursed"]))}</td>
          <td>${fmtDateCell(r["Paid Out"])}</td>
        </tr>`;
      });
  
      html += `
        <tr style="background: rgba(255, 193, 124, 0.1); font-weight: 600;">
          <td colspan="2">Total</td>
          <td>${formatUSD(totalUSD)}</td>
          <td>${formatZEC(totalZEC)}</td>
          <td></td>
        </tr>
      </table>`;
  
      document.getElementById("icPayoutsContent").innerHTML = html;
      renderAuditPaymentsChart(filteredRows);
    } catch (error) {
      console.error(error);
      document.getElementById("icPayoutsContent").innerHTML =
        '<div class="loading">Error loading IC payouts data</div>';
    }
  }
  
  /* ===== NOTETAKER ===== */
  async function loadNotetaker() {
    try {
      await loadWorkbook();
      const rows = sheetToObjects(SHEETS.IC_PAYOUTS, 0);
      const filtered = rows.filter((r) =>
        (r["Project"] || "").includes("Arborist Call Meeting Notes")
      );
  
      let totalUSD = 0,
        totalZEC = 0;
      let html = `<table class="data-table">
        <tr>
          <th>Date</th>
          <th>Amount USD</th>
          <th>ZEC</th>
          <th>ZEC/USD</th>
        </tr>`;
  
      filtered.forEach((r) => {
        const usd = cleanNumber(r["Amount (USD)"]);
        const zec = cleanNumber(r["ZEC Disbursed"]);
        totalUSD += usd;
        totalZEC += zec;
        html += `<tr>
          <td>${fmtDateCell(r["Paid Out"])}</td>
          <td>${formatUSD(usd)}</td>
          <td>${formatZEC(zec)}</td>
          <td>${r["ZEC/USD"]}</td>
        </tr>`;
      });
  
      html += `<tr style="background: rgba(255, 193, 124, 0.1); font-weight: 600;">
        <th>Total</th>
        <th>${formatUSD(totalUSD)}</th>
        <th>${formatZEC(totalZEC)}</th>
        <th></th>
      </tr></table>`;
  
      document.getElementById("notetakerContent").innerHTML = html;
    } catch (error) {
      document.getElementById("notetakerContent").innerHTML =
        '<div class="loading">Error loading notetaker data</div>';
    }
  }
  
  /* ===== Safety Check ===== */
  if (typeof marked === "undefined") {
    window.marked = { parse: (s) => s };
  }
  
  /* ===== Expose Functions to Window ===== */
  window.toggleMobileMenu = toggleMobileMenu;
  window.filterPayoutsByTime = filterPayoutsByTime;
  window.cycleSortMode = cycleSortMode;
  window.filterGrants = filterGrants;
  window.filterGrantsByBudget = filterGrantsByBudget;
  window.toggleView = toggleView;
  window.showGrantDetails = showGrantDetails;
  window.closeModal = closeModal;
  window.toggleDarkMode = toggleDarkMode;
