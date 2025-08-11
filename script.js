// === Global Variables ===
let allGrants = [];
let filteredGrants = [];
let allMilestones = [];
let currentPayoutData = [];
let currentTimeFilter = 'ytd';
let currentSortMode = 0;
let lastUpdateTime = null;
let updateTimeTimeout = null;
let currentStatusFilter = 'all';
let currentBudgetFilter = 'all';
let loadedTabs = new Set();
let lastScrollTop = 0;
window.addEventListener("scroll", function () {
  const header = document.querySelector(".mobile-header");
  let st = window.pageYOffset || document.documentElement.scrollTop;
  if (st > lastScrollTop && st > 50) {
    header.style.transform = "translateY(-100%)"; // hide
  } else {
    header.style.transform = "translateY(0)"; // show
  }
  lastScrollTop = st <= 0 ? 0 : st;
}, false);

const sortModes = [
  { key: 'newest', icon: '📅', text: 'Newest' },
  { key: 'oldest', icon: '📅', text: 'Oldest' },
  { key: 'biggest', icon: '💰', text: 'Biggest' },
  { key: 'smallest', icon: '💰', text: 'Smallest' }
];

// === Tab Routes with updated IDs ===
const tabRoutes = {
  'dashboard': { id: 'dashboard', load: loadOverview },
  'grants': { id: 'grants', load: loadGrants },
  'payments': { id: 'payments', load: loadPayouts },
  'audit-payments': { id: 'audit-payments', load: loadICPayouts },
  'liquidity': { id: 'liquidity', load: loadLiquidity },
  'stipends': { id: 'stipends', load: loadStipends },
  'notetaker': { id: 'notetaker', load: loadNotetaker }
};

// === Data Sources ===
const DASHBOARD_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ8usf0eqwhPTGxP_j_-AWCPu05PlOonPUeYnlXE5NcipAm73Vz-BHEa33wgeldeROioU9_-wBChRo-/pub?gid=7542155&single=true&output=csv";
const GRANTS_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ8usf0eqwhPTGxP_j_-AWCPu05PlOonPUeYnlXE5NcipAm73Vz-BHEa33wgeldeROioU9_-wBChRo-/pub?gid=1871548102&single=true&output=csv";
const FUNDS_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ8usf0eqwhPTGxP_j_-AWCPu05PlOonPUeYnlXE5NcipAm73Vz-BHEa33wgeldeROioU9_-wBChRo-/pub?gid=1521309413&single=true&output=csv";
const LIQUIDITY_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ8usf0eqwhPTGxP_j_-AWCPu05PlOonPUeYnlXE5NcipAm73Vz-BHEa33wgeldeROioU9_-wBChRo-/pub?gid=1024670602&single=true&output=csv";
const STIPENDS_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ8usf0eqwhPTGxP_j_-AWCPu05PlOonPUeYnlXE5NcipAm73Vz-BHEa33wgeldeROioU9_-wBChRo-/pub?gid=214399476&single=true&output=csv";
const IC_PAYOUTS_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ8usf0eqwhPTGxP_j_-AWCPu05PlOonPUeYnlXE5NcipAm73Vz-BHEa33wgeldeROioU9_-wBChRo-/pub?gid=1267338970&single=true&output=csv";

// === Router Functions ===
function initRouter() {
  const initialTab = getTabFromHash();
  navigateToTab(initialTab, false);

  window.addEventListener('popstate', (e) => {
    const tab = e.state?.tab || getTabFromHash();
    navigateToTab(tab, false);
  });

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = link.getAttribute('href').substring(1);
      navigateToTab(tab, true);
    });
  });
}

function getTabFromHash() {
  const hash = window.location.hash.substring(1);
  return tabRoutes[hash] ? hash : 'dashboard';
}

function navigateToTab(tabName, pushState = true) {
  closeMobileMenu();

  if (pushState) {
    const newUrl = `${window.location.pathname}#${tabName}`;
    history.pushState({ tab: tabName }, '', newUrl);
  }

  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

  const tabElement = document.getElementById(tabName);
  const navElement = document.querySelector(`[href="#${tabName}"]`);

  if (tabElement) tabElement.classList.add('active');
  if (navElement) navElement.classList.add('active');

  // ✅ Show mobile search bar only on Grants page AND only on mobile
  const mobileSearchBar = document.querySelector('.mobile-search-bar');
  if (window.innerWidth <= 768 && tabName === 'grants') {
    mobileSearchBar.style.display = 'block';
  } else {
    mobileSearchBar.style.display = 'none';
  }

  const tabInfo = tabRoutes[tabName];
  if (tabInfo && !loadedTabs.has(tabName)) {
    tabInfo.load();
    loadedTabs.add(tabName);
  }

  if (tabName === 'dashboard' && loadedTabs.has('dashboard')) {
    loadPayoutsChart();
    loadCategoryChart();
    loadZecPriceTrend();
  }

  const tabTitles = {
    'dashboard': 'Dashboard',
    'grants': 'Grants',
    'payments': 'Payments',
    'audit-payments': 'Audit Payments',
    'liquidity': 'Maya Liquidity',
    'stipends': 'Stipends',
    'notetaker': 'Notetaker Payments'
  };
  if (tabTitles[tabName]) {
    document.title = `${tabTitles[tabName]} - Zcash Community Grants Dashboard`;
  }
}
// === Mobile Menu Functions ===
function toggleMobileMenu() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  const hamburger = document.querySelector('.hamburger');
  
  sidebar.classList.toggle('active');
  overlay.classList.toggle('active');
  hamburger.classList.toggle('active');
}

function closeMobileMenu() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  const hamburger = document.querySelector('.hamburger');
  
  sidebar.classList.remove('active');
  overlay.classList.remove('active');
  hamburger.classList.remove('active');
}

// === Dark Mode Functions ===
function toggleDarkMode() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  
  const icon = document.getElementById('darkModeIcon');
  const text = document.getElementById('darkModeText');
  
  if (newTheme === 'dark') {
    icon.textContent = '☀️';
    text.textContent = 'Light Mode';
  } else {
    icon.textContent = '🌙';
    text.textContent = 'Dark Mode';
  }
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  
  const icon = document.getElementById('darkModeIcon');
  const text = document.getElementById('darkModeText');
  
  if (savedTheme === 'dark') {
    icon.textContent = '☀️';
    text.textContent = 'Light Mode';
  }
}

// === Update Time Functions ===
function updateLastUpdateTime() {
  const desktopEl = document.getElementById('desktopUpdateTime');
  const mobileEl = document.getElementById('mobileUpdateTime');

  if (lastUpdateTime) {
    const timeString = lastUpdateTime.toLocaleString();
    desktopEl.textContent = `Last updated: ${timeString}`;
    mobileEl.textContent = `Updated: ${timeString}`;
  } else {
    desktopEl.textContent = `Last updated: Unavailable`;
    mobileEl.textContent = `Updated: Unavailable`;
  }
}

// Call this when CSV finishes loading and you have the real time
function setLastUpdateTimeFromCSV(csvTimeString) {
  clearTimeout(updateTimeTimeout); // stop the fallback
  lastUpdateTime = new Date(csvTimeString);
  updateLastUpdateTime();
}

// Start a 10s fallback timer when page loads
function startUpdateTimeFallback() {
  updateTimeTimeout = setTimeout(() => {
    if (!lastUpdateTime) {
      updateLastUpdateTime(); // will show "Unavailable"
    }
  }, 10000);
}
// === Utility Functions ===
const cleanNumber = (val) =>
  parseFloat((val || "0").toString().replace(/[$,]/g, "")) || 0;

const formatUSD = (num) =>
  "$" + num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const formatZEC = (num) =>
  num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ZEC";
// === Sort Functions ===
function cycleSortMode() {
  currentSortMode = (currentSortMode + 1) % 4;
  const mode = sortModes[currentSortMode];

  // ✅ Update desktop sort button
  const desktopSortBtn = document.getElementById('sortBtn');
  if (desktopSortBtn) {
    desktopSortBtn.innerHTML = `${mode.icon} ${mode.text}`;
  }

  // ✅ Update mobile sort button
  const mobileSortBtn = document.querySelector('.mobile-filters .sort-btn');
  if (mobileSortBtn) {
    mobileSortBtn.innerHTML = `${mode.icon} ${mode.text}`;
  }

  sortGrants();
}

function sortGrants() {
  const mode = sortModes[currentSortMode];
  
  switch(mode.key) {
    case 'newest':
      filteredGrants.sort((a, b) => {
        if (!a.lastPaidDate && !b.lastPaidDate) return 0;
        if (!a.lastPaidDate) return 1;
        if (!b.lastPaidDate) return -1;
        return b.lastPaidDate - a.lastPaidDate;
      });
      break;
    case 'oldest':
      filteredGrants.sort((a, b) => {
        if (!a.lastPaidDate && !b.lastPaidDate) return 0;
        if (!a.lastPaidDate) return -1;
        if (!b.lastPaidDate) return 1;
        return a.lastPaidDate - b.lastPaidDate;
      });
      break;
    case 'biggest':
      filteredGrants.sort((a, b) => b.totalAmount - a.totalAmount);
      break;
    case 'smallest':
      filteredGrants.sort((a, b) => a.totalAmount - b.totalAmount);
      break;
  }
  
  renderGrants(filteredGrants);
}

// === Modal Functions ===
function openModal(content) {
  document.getElementById('modalBody').innerHTML = content;
  document.getElementById('modalOverlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
  document.body.style.overflow = 'auto';
}

// === Search Functions ===
function setupSearch() {
  const desktopSearch = document.getElementById('desktopSearch');
  const mobileSearch = document.getElementById('mobileSearch');
  
  [desktopSearch, mobileSearch].forEach(input => {
    input.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      if (input === desktopSearch) mobileSearch.value = query;
      if (input === mobileSearch) desktopSearch.value = query;
      filterGrantsBySearch(query);
    });
  });
}

function filterGrantsBySearch(query) {
  if (!allGrants.length) return;
  
  let searchFiltered = allGrants.filter(grant => 
    grant.project.toLowerCase().includes(query) ||
    grant.grantee.toLowerCase().includes(query)
  );
  
  if (currentStatusFilter !== 'all') {
    searchFiltered = searchFiltered.filter(g => g.status === currentStatusFilter);
  }
  
  switch(currentBudgetFilter) {
    case 'small':
      searchFiltered = searchFiltered.filter(g => g.totalAmount < 50000);
      break;
    case 'medium':
      searchFiltered = searchFiltered.filter(g => g.totalAmount >= 50000 && g.totalAmount <= 200000);
      break;
    case 'large':
      searchFiltered = searchFiltered.filter(g => g.totalAmount > 200000);
      break;
  }
  
  filteredGrants = searchFiltered;
  sortGrants();
}
// === Setup Mobile Filters ===
function setupMobileFilters() {
  const mobileFilters = document.getElementById('mobileFilters');
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

// === Chart Configuration ===
const getChartOptions = () => ({
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      labels: {
        color: getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim(),
        font: { size: 12, weight: '400' }
      }
    }
  },
  scales: {
    x: {
      grid: { color: getComputedStyle(document.documentElement).getPropertyValue('--grid-color').trim() },
      ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--text-tertiary').trim(), font: { size: 11 } }
    },
    y: {
      grid: { color: getComputedStyle(document.documentElement).getPropertyValue('--grid-color').trim() },
      ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--text-tertiary').trim(), font: { size: 11 } }
    }
  }
});

// === Dashboard Functions (was loadOverview for overview tab) ===

function updateLastUpdateTime() {
  const desktopEl = document.getElementById('desktopUpdateTime');
  const mobileEl = document.getElementById('mobileUpdateTime');

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
      updateLastUpdateTime(); // will show "Unavailable"
    }
  }, 10000); // 10 seconds
}

async function loadOverview() {
  try {
    const csv = await fetch(DASHBOARD_CSV).then(r => r.text());
    const data = Papa.parse(csv).data;

    // ✅ Robust label matching
    const getValue = (label) => {
      const normalize = (str) =>
        (str || "")
          .toString()
          .replace(/\u00A0/g, " ") // replace non-breaking spaces
          .trim()
          .toLowerCase();

      const row = data.find(r => normalize(r[0]).includes(normalize(label)));
      return row ? row[1] : "N/A";
    };

    // ✅ Get block time from CSV
    const blockTimeUTC = getValue("Block time (UTC):");
    if (blockTimeUTC && blockTimeUTC !== "N/A") {
      clearTimeout(updateTimeTimeout); // stop fallback
      lastUpdateTime = new Date(blockTimeUTC + " UTC");
      updateLastUpdateTime();
    }

    // === Your existing metrics code ===
    const futureLiabilities = getValue("Future grant liabilities");
    const unhedgedLiabilities = getValue("Unhedged grant liabilities (USD)");

    const metrics = [
      { label: "Grants Approved", value: getValue("Total USD value of grants approved") },
      { label: "Grants Paid Out", value: getValue("USD value of grant milestones paid out so far") },
      { label: "Native ZEC Balance", value: getValue("Current ZEC balance") },
      { label: "ZEC Balance value", value: getValue("USD value of Current ZEC balance") },
      { label: "Current $ Balance", value: getValue("Current USD balance") },
      { 
        label: "Future Liabilities", 
        value: `${futureLiabilities}<br><span style="font-size:0.8rem; color:var(--text-tertiary); font-style:italic;">Unhedged: ${unhedgedLiabilities}</span>`
      },
      { label: "ZEC Price in USD", value: getValue("ZECUSD price") },
      { label: "Total ZEC Accrued", value: getValue("Total ZEC accrued to date") },
      { label: "ZEC Paid to Recipients", value: getValue("Total ZEC paid to grant recipients") },
      { label: "USD Reserves", value: getValue("USD reserves") },
      { label: "ZEC from 1st Dev Fund", value: getValue("ZEC accrued from 1st Dev Fund") },
      { label: "ZEC from 2nd Dev Fund", value: getValue("ZEC accrued from 2nd Dev Fund") }
    ];

    document.getElementById("overviewMetrics").innerHTML = metrics.map(m =>
      `<div class="metric-card">
        <div class="metric-label">${m.label}</div>
        <div class="metric-number">${m.value}</div>
      </div>`
    ).join("");

  } catch (error) {
    console.error('Error in loadOverview:', error);
    document.getElementById("overviewMetrics").innerHTML = '<div class="loading">Error loading metrics</div>';
  }
}
// === Time Filter for Payouts Chart ===
function filterPayoutsByTime(period) {
  currentTimeFilter = period;
  document.querySelectorAll('#timeFilters .pill').forEach(p => p.classList.remove('active'));
  event.target.classList.add('active');
  loadPayoutsChart();
}

// === Payouts Chart ===
async function loadPayoutsChart() {
  try {
    if (!currentPayoutData.length) {
      const csv = await fetch(GRANTS_CSV).then(r => r.text());
      const rows = Papa.parse(csv, { header: true }).data;
      currentPayoutData = rows;
    }
    
    const now = new Date();
    let startDate = new Date();
    
    switch (currentTimeFilter) {
      case '1m': startDate.setDate(now.getDate() - 30); break;
      case '3m': startDate.setDate(now.getDate() - 90); break;
      case '1y': startDate.setFullYear(now.getFullYear() - 1); break;
      case 'ytd': startDate = new Date(now.getFullYear(), 0, 1); break;
      case 'max': startDate = new Date(2020, 0, 1); break;
    }
    
    const monthlyMap = {};
    currentPayoutData.forEach(row => {
      if (!row["Paid Out"]) return;
      const date = new Date(row["Paid Out"]);
      if (date < startDate) return;
      
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[monthKey]) monthlyMap[monthKey] = { amount: 0, milestones: 0 };
      monthlyMap[monthKey].amount += cleanNumber(row["Amount (USD)"]);
      monthlyMap[monthKey].milestones++;
    });
    
    const sorted = Object.entries(monthlyMap).sort(([a], [b]) => a.localeCompare(b));
    const labels = sorted.map(([m]) => m);
    const amounts = sorted.map(([_, v]) => v.amount);
    const milestones = sorted.map(([_, v]) => v.milestones);

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
            borderColor: getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim(),
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
            beginAtZero: true,
            grid: { 
              color: getComputedStyle(document.documentElement)
                .getPropertyValue('--grid-color')
                .trim() 
            }, 
            ticks: { 
              color: getComputedStyle(document.documentElement)
                .getPropertyValue('--text-tertiary')
                .trim() 
            }
          },
          y2: { 
            type: "linear", 
            position: "right", 
            grid: { drawOnChartArea: false }, 
            ticks: { 
              color: getComputedStyle(document.documentElement)
                .getPropertyValue('--text-tertiary')
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

// === Category Bar Chart ===
async function loadCategoryChart() {
  try {
    const csv = await fetch(FUNDS_CSV).then(r => r.text());
    const rows = Papa.parse(csv, { header: true }).data;
    const categoryTotals = {};
    
    rows.forEach(row => {
      const cat = (row["Grant Classification"] || "").trim();
      const amount = cleanNumber(row["Category Amount"]);
      if (cat && amount > 0) categoryTotals[cat] = (categoryTotals[cat] || 0) + amount;
    });
    
    const sorted = Object.entries(categoryTotals).sort((a,b) => b[1] - a[1]);
    const labels = sorted.map(([cat]) => cat);
    const data = sorted.map(([_,amount]) => amount);
    
    const ctx = document.getElementById("categoryChart");
    if (ctx.chart) ctx.chart.destroy();
    
    ctx.chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: labels.map((_, i) => {
            const opacity = 0.8 - (i * 0.1);
            return `rgba(255, 193, 124, ${Math.max(opacity, 0.3)})`;
          }),
          borderColor: getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim(),
          borderWidth: 1
        }]
      },
      options: {
        ...getChartOptions(),
        indexAxis: 'y',
        plugins: {
          legend: { display: false }
        }
      }
    });
  } catch (error) {
    console.error("Error loading category chart:", error);
  }
}

// === ZEC Price Chart ===
async function loadZecPriceTrend() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/coins/zcash/market_chart?vs_currency=usd&days=30");
    const data = await res.json();
    
    const filtered = data.prices.filter((_, i) => i % 24 === 0);
    const furtherFiltered = filtered.filter((_, i) => i % 3 === 0);
    const prices = furtherFiltered.map(p => ({ date: new Date(p[0]), price: p[1] }));
    
    const ctx = document.getElementById("zecPriceChart");
    if (ctx.chart) ctx.chart.destroy();
    
    ctx.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: prices.map(p => p.date.toLocaleDateString()),
        datasets: [{
          label: "ZEC/USD",
          data: prices.map(p => p.price),
          borderColor: getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim(),
          backgroundColor: "rgba(255,193,124,0.2)",
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5
        }]
      },
      options: getChartOptions()
    });
  } catch (error) {
    console.error("Error loading ZEC price:", error);
  }
}
// === Grants Functions ===
async function loadGrants() {
  try {
    const csv = await fetch(GRANTS_CSV).then(r => r.text());
    const rows = Papa.parse(csv, { header: true }).data;
    
    const projectMap = {};
    rows.forEach(row => {
      const project = row["Project"];
      const grantee = row["Grantee"];
      if (!project || !grantee) return;
      
      const key = `${project}_${grantee}`;
      if (!projectMap[key]) {
        projectMap[key] = {
          project,
          grantee,
          totalAmount: 0,
          paidAmount: 0,
          milestones: [],
          lastPaidDate: null
        };
      }
      
      const amount = cleanNumber(row["Amount (USD)"]);
      projectMap[key].totalAmount += amount;
      
      if (row["Paid Out"]) {
        projectMap[key].paidAmount += amount;
        const paidDate = new Date(row["Paid Out"]);
        if (!projectMap[key].lastPaidDate || paidDate > projectMap[key].lastPaidDate) {
          projectMap[key].lastPaidDate = paidDate;
        }
      }
      
      projectMap[key].milestones.push({
        amount,
        dueDate: row["Milestone Due Date"],
        paidDate: row["Paid Out"]
      });
    });
    
    allGrants = Object.values(projectMap).map(grant => {
      const completedMilestones = grant.milestones.filter(m => m.paidDate).length;
      const totalMilestones = grant.milestones.length;
      
      let status;
      if (completedMilestones === totalMilestones) {
        status = 'completed';
      } else if (completedMilestones > 0) {
        status = 'in-progress';
      } else {
        status = 'waiting';
      }
      
      return { ...grant, status, completedMilestones, totalMilestones };
    });
    
    filteredGrants = [...allGrants];
    sortGrants();
  } catch (error) {
    console.error('Error in loadGrants:', error);
    document.getElementById("grantsContainer").innerHTML = '<div class="loading">Error loading grants data</div>';
  }
}

function renderGrants(grants) {
  const container = document.getElementById('grantsContainer');
  updateGrantsCounter(grants.length, allGrants.length);
  
  if (!grants.length) {
    container.innerHTML = '<div class="loading">No grants found</div>';
    return;
  }
  
  container.innerHTML = grants.map(grant => {
    const progressPercent = grant.totalMilestones > 0 
      ? (grant.completedMilestones / grant.totalMilestones) * 100 
      : 0;

    return `
      <div class="grant-card ${grant.status}" onclick="showGrantDetails('${grant.project}', '${grant.grantee}')">
        <div class="grant-title">${grant.project}</div>
        <div class="grant-grantee">${grant.grantee}</div>
        <div class="grant-amount">${formatUSD(grant.totalAmount)}</div>
        <div class="grant-status ${grant.status}">
          ${grant.status.replace('-', ' ').toUpperCase()} 
          (${grant.completedMilestones}/${grant.totalMilestones})
        </div>
        
        <!-- Progress Bar -->
        <div class="progress-bar">
          <div class="progress-fill ${grant.status}" style="width: ${progressPercent}%;"></div>
        </div>

        <div class="grant-plus-btn"><span>+</span></div>
      </div>
    `;
  }).join('');
}

function updateGrantsCounter(filtered, total) {
  const counter = document.getElementById('grantsCounter');
  if (counter) {
    const percent = total > 0 ? ((filtered / total) * 100).toFixed(1) : 0;
    counter.textContent = `Showing ${filtered} of ${total} grants (${percent}%)`;
  }
}

// === GitHub Issue Fetching ===// Simple in-memory cache for GitHub search results
const githubIssueCache = {};

async function findGitHubIssueByTitle(title) {
  // 0️⃣ Check cache first
  if (githubIssueCache[title]) {
    return githubIssueCache[title];
  }

  try {
    const searchGitHub = async (queryTitle) => {
      const query = encodeURIComponent(`"${queryTitle}" repo:ZcashCommunityGrants/zcashcommunitygrants`);
      const url = `https://api.github.com/search/issues?q=${query}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github.v3+json' } });
      if (!res.ok) throw new Error(`GitHub search failed: ${res.status}`);
      const data = await res.json();
      if (data.items && data.items.length > 0) {
        const normalizedGrantTitle = queryTitle.trim().toLowerCase();
        const exactMatch = data.items.find(issue => issue.title.trim().toLowerCase() === normalizedGrantTitle);
        return exactMatch || data.items[0]; // return first if no exact match
      }
      return null;
    };

    // 1️⃣ First try with the exact title
    let issue = await searchGitHub(title);

    // 2️⃣ If not found, try with "Grant Application - " prefix
    if (!issue) {
      issue = await searchGitHub(`Grant Application - ${title}`);
    }

    // ✅ Store in cache (even if null, so we don't retry failed searches)
    githubIssueCache[title] = issue;

    return issue;
  } catch (err) {
    console.error("Error searching GitHub issue:", err);
    githubIssueCache[title] = null; // cache the failure too
    return null;
  }
}

async function fetchGitHubIssueBody(issueNumber) {
  try {
    const url = `https://api.github.com/repos/ZcashCommunityGrants/zcashcommunitygrants/issues/${issueNumber}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github.v3+json' } });
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

    const startIndex = lines.findIndex(line => {
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
  if (!summary) {
    summary = findSection("description");
  }

  return summary || null;
}

async function showGrantDetails(project, grantee) {
  const grant = allGrants.find(g => g.project === project && g.grantee === grantee);
  if (!grant) return;

  const progressPercent = grant.totalMilestones > 0 
    ? (grant.completedMilestones / grant.totalMilestones) * 100 
    : 0;

  let content = `
    <h2 style="color: var(--text-primary); margin-bottom: 16px;">${grant.project}</h2>

    <!-- Grantee + Status -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <div style="font-size: 0.95rem; font-weight: 500; color: var(--text-secondary);">
        ${grant.grantee}
      </div>
      <span class="grant-status ${grant.status}">
        ${grant.status.replace('-', ' ').toUpperCase()}
      </span>
    </div>

    <!-- Details Grid -->
    <div class="modal-details-grid">
      <div><strong>Budget:</strong> ${formatUSD(grant.paidAmount)} / ${formatUSD(grant.totalAmount)}</div>
      <div><strong>Milestones:</strong> ${grant.completedMilestones}/${grant.totalMilestones} completed</div>
      ${grant.lastPaidDate ? `<div><strong>Last Payment:</strong> ${grant.lastPaidDate.toLocaleDateString()}</div>` : ''}
    </div>

    <!-- Progress Bar -->
    <div class="progress-bar" style="margin-bottom: 20px;">
      <div class="progress-fill ${grant.status}" style="width: ${progressPercent}%;"></div>
    </div>

    <!-- GitHub Section -->
    <div id="githubSection" style="margin-bottom: 20px;">
      <div style="color: var(--text-tertiary); font-size: 0.85rem;">Loading GitHub details...</div>
    </div>

    <h3 style="margin-top: 10px; margin-bottom: 10px; color: var(--text-secondary);">Milestone Breakdown</h3>
    <div class="milestone-list">
      ${grant.milestones.map((m, i) => `
        <div class="milestone-item">
          <span>#${i + 1} — ${formatUSD(m.amount)}</span>
          <span style="color: ${m.paidDate ? '#28a745' : 'var(--text-tertiary)'};">
            ${m.paidDate 
              ? `Paid ${new Date(m.paidDate).toLocaleDateString()}` 
              : (m.dueDate 
                  ? `Due ${new Date(m.dueDate).toLocaleDateString()}` 
                  : 'Future milestone')}
          </span>
        </div>
      `).join('')}
    </div>
  `;
  openModal(content);

  const issue = await findGitHubIssueByTitle(grant.project);
  const githubContainer = document.getElementById('githubSection');

  if (issue) {
    const issueData = await fetchGitHubIssueBody(issue.number);
    if (issueData && issueData.body) {
      let githubHTML = `
        <div style="margin-top: 10px; margin-bottom: 10px;">
          <strong>Full grant details on GitHub:</strong> 
          <a href="${issueData.html_url}" target="_blank" style="color: var(--accent-secondary); text-decoration: none;">
            ${issueData.html_url}
          </a>
        </div>
        <div id="githubDescription" style="color: var(--text-tertiary); font-size: 0.85rem;">
          Loading description...
        </div>
      `;
      githubContainer.innerHTML = githubHTML;

      const summary = extractProjectSummary(issueData.body);
      const descContainer = document.getElementById('githubDescription');

      if (summary) {
        descContainer.innerHTML = `
          <h3 style="margin-top: 10px; color: var(--text-secondary);">Project Summary</h3>
          <div style="margin-bottom: 15px;">${marked.parse(summary)}</div>
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

// === Filter Functions ===
function filterGrants(status) {
  currentStatusFilter = status;
  
  document.querySelectorAll('.filter-pills .pill').forEach(p => p.classList.remove('active'));
  event.target.classList.add('active');
  
  document.querySelectorAll('#mobileFilters .pill').forEach((p, i) => {
    if (i < 4) p.classList.remove('active');
  });
  const mobileIndex = ['all', 'completed', 'in-progress', 'waiting'].indexOf(status);
  if (mobileIndex >= 0) {
    document.querySelectorAll('#mobileFilters .pill')[mobileIndex].classList.add('active');
  }
  
  applyFilters();
}

function filterGrantsByBudget(range) {
  currentBudgetFilter = range;
  
  document.querySelectorAll('.budget-pills .pill').forEach(p => p.classList.remove('active'));
  event.target.classList.add('active');
  
  document.querySelectorAll('#mobileFilters .pill').forEach((p, i) => {
    if (i >= 4 && i < 8) p.classList.remove('active');
  });
  const mobileIndex = ['all', 'small', 'medium', 'large'].indexOf(range);
  if (mobileIndex >= 0) {
    document.querySelectorAll('#mobileFilters .pill')[4 + mobileIndex].classList.add('active');
  }
  
  applyFilters();
}

function applyFilters() {
  let filtered = [...allGrants];
  
  if (currentStatusFilter !== 'all') {
    filtered = filtered.filter(g => g.status === currentStatusFilter);
  }

  switch(currentBudgetFilter) {
    case 'small':
      filtered = filtered.filter(g => g.totalAmount < 50000);
      break;
    case 'medium':
      filtered = filtered.filter(g => g.totalAmount >= 50000 && g.totalAmount <= 200000);
      break;
    case 'large':
      filtered = filtered.filter(g => g.totalAmount > 200000);
      break;
  }
  
  filteredGrants = filtered;
  sortGrants();
}

function toggleView(viewType) {
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  
  const container = document.getElementById('grantsContainer');
  if (viewType === 'list') {
    container.classList.add('list-view');
  } else {
    container.classList.remove('list-view');
  }
}
// === Other Tab Loading Functions ===
async function loadLiquidity() {
  try {
    const csv = await fetch(LIQUIDITY_CSV).then(r => r.text());
    const rows = Papa.parse(csv, { header: true }).data;

    const headers = Object.keys(rows[0]);
    const kpiColumnName = headers.find(k => k && k.startsWith("KPIs as of"));
    if (!kpiColumnName) {
      console.error("KPI column not found in CSV");
      document.getElementById("liquidityContent").innerHTML =
        '<div class="loading">Error: KPI column not found</div>';
      return;
    }

    const kpiIndex = headers.indexOf(kpiColumnName);
    const valueColumnName = headers[kpiIndex + 1] || "";

    let zecBalance = 0,
      cacaoBalance = 0,
      usdValueWallet = 0,
      gainLoss = 0;

    rows.forEach(r => {
      const key = (r[kpiColumnName] || "").trim();
      const val = cleanNumber(r[valueColumnName]);
      if (key === "ZEC") {
        zecBalance = val;
      }
      if (key === "CACAO") {
        cacaoBalance = val;
      }
      if (key === "USD Value in Wallet") {
        usdValueWallet = val;
      }
      if (key.includes("Gain/Loss")) {
        gainLoss = val;
      }
    });

    const transactions = rows.filter(r => r["Project"]);
    const totalLiquidity = transactions.reduce(
      (sum, r) => sum + cleanNumber(r["Amount (USD)"]),
      0
    );

    let summaryHTML = `
      <div class="liquidity-cards">
        <div class="liquidity-card">
          <div class="liquidity-content">
            <div class="liquidity-icon liquidity-icon-bg">🌊</div>
            <div class="liquidity-text">
              <div class="liquidity-label">Total Liquidity Added</div>
              <div class="liquidity-value">${formatUSD(totalLiquidity)}</div>
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
        <div class="liquidity-card">
          <div class="liquidity-content">
            <div class="liquidity-icon liquidity-icon-bg">💵</div>
            <div class="liquidity-text">
              <div class="liquidity-label">Total Value of Liquidity</div>
              <div class="liquidity-value">${formatUSD(usdValueWallet)}</div>
            </div>
          </div>
        </div>
        <div class="liquidity-card ${gainLoss >= 0 ? 'positive' : 'negative'}">
          <div class="liquidity-content">
            <div class="liquidity-icon liquidity-icon-bg">${gainLoss >= 0 ? '📈' : '📉'}</div>
            <div class="liquidity-text">
              <div class="liquidity-label">Profit / Loss (USD)</div>
              <div class="liquidity-value">
                ${gainLoss >= 0 ? "+" : ""}${formatUSD(gainLoss)}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById("liquidityContent").innerHTML = summaryHTML;
  } catch (error) {
    console.error("Error loading liquidity data:", error);
    document.getElementById("liquidityContent").innerHTML =
      '<div class="loading">Error loading liquidity data</div>';
  }
}

function renderStipendsChart(months, totalUSD, perPersonUSD, zecPerPersonUSD) {
  const perPersonTotalUSD = totalUSD.map(v => v / 5);

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
            label: function(context) {
              return `${context.dataset.label}: $${context.parsed.y.toLocaleString()}`;
            }
          }
        },
        datalabels: {
          display: ctx => ctx.dataset.type !== 'line',
          anchor: 'end',
          align: 'top',
          color: '#333',
          font: { weight: 'bold' },
          formatter: value => `$${value.toLocaleString()}`
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "USD" }
        }
      }
    },
    plugins: typeof ChartDataLabels !== 'undefined' ? [ChartDataLabels] : []
  });
}

async function loadStipends() {
  try {
    const csv = await fetch(STIPENDS_CSV).then(r => r.text());
    const rows = Papa.parse(csv, { header: true }).data;

    const monthly = {};
    let totalUSDYTD = 0;

    rows.forEach(r => {
      const date = new Date(r["Date"]);
      const monthKey = date.toLocaleString('default', { month: 'long', year: 'numeric' });
      monthly[monthKey] = monthly[monthKey] || { usd: 0 };
      const usd = cleanNumber(r["USD Amount"]);
      monthly[monthKey].usd += usd;
      totalUSDYTD += usd;
    });

    const months = Object.keys(monthly);
    const totalUSD = months.map(m => monthly[m].usd);

    const perPersonUSD = 1725;
    const members = 5;
    const fixedUSDTotal = perPersonUSD * members;

    const zecPerPersonUSD = totalUSD.map(total => (total - fixedUSDTotal) / members);

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
          <div class="stipend-value">${formatUSD((totalUSDYTD / members) / months.length)}</div>
        </div>
      </div>
      <p style="color: var(--text-secondary); margin-bottom: 20px;">
        ${members} committee members each receive <strong>$${perPersonUSD.toLocaleString()} USD + 10 ZEC</strong> per month 
        for their ongoing work to manage the Zcash Community Grants program. Learn more about committee members <a href="https://zcashcommunitygrants.org/committee/" target="_blank">here</a>.
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
    document.getElementById("stipendsContent").innerHTML = '<div class="loading">Error loading stipends data</div>';
  }
}
let paidOutOriginal = [];
let futureOriginal = [];

async function loadPayouts() {
  try {
    const csv = await fetch(FUNDS_CSV).then(r => r.text());
    let parsed = Papa.parse(csv, { header: false }).data;
    parsed = parsed.filter(row => row.some(cell => cell && cell.trim() !== ""));
    const headers = parsed[2].map(h => h ? h.replace(/\u00A0/g, " ").trim() : "");
    const dataRows = parsed.slice(3);

    const rows = dataRows.map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });

    const recipientCol = headers.find(h => /recipient|classification/i.test(h));
    const paidOutCol = headers.find(h => /paid\s*out/i.test(h));
    const futureCol = headers.find(h => /future\s*milestones/i.test(h));

    // Build datasets without "Total"
    paidOutOriginal = rows
      .map(r => ({
        grantee: r[recipientCol]?.trim() || "",
        amount: cleanNumber(r[paidOutCol])
      }))
      .filter(r => r.amount > 0 && r.grantee !== "")
      .sort((a, b) => b.amount - a.amount);

    futureOriginal = rows
      .map(r => ({
        grantee: r[recipientCol]?.trim() || "",
        amount: cleanNumber(r[futureCol])
      }))
      .filter(r => r.amount > 0 && r.grantee !== "")
      .sort((a, b) => b.amount - a.amount);

    renderPaidOutChart(paidOutOriginal);
    renderFutureChart(futureOriginal);

    setupChartFilters("paidOutFilters", paidOutOriginal, renderPaidOutChart);
    setupChartFilters("futureFilters", futureOriginal, renderFutureChart);

  } catch (error) {
    console.error("Error loading payouts data:", error);
  }
}

function setupChartFilters(containerId, originalData, renderFn) {
  document.querySelectorAll(`#${containerId} .pill`).forEach(pill => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(`#${containerId} .pill`).forEach(p => p.classList.remove("active"));
      pill.classList.add("active");

      const range = pill.dataset.range;
      let filtered = [...originalData];

      if (range === "small") filtered = filtered.filter(d => d.amount < 50000);
      if (range === "medium") filtered = filtered.filter(d => d.amount >= 50000 && d.amount <= 200000);
      if (range === "large") filtered = filtered.filter(d => d.amount > 200000);

      renderFn(filtered);
    });
  });
}

function renderPaidOutChart(data) {
  const ctx = document.getElementById("paidOutChart");
  if (ctx.chart) ctx.chart.destroy();

  ctx.parentElement.style.height = Math.max(200, data.length * 30) + "px";

  ctx.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map(d => d.grantee),
      datasets: [{
        label: "Total Paid Out (USD)",
        data: data.map(d => d.amount),
        backgroundColor: "rgba(243, 166, 34, 0.7)",
        borderColor: "#f3a622",
        borderWidth: 1
      }]
    },
    options: {
      ...getChartOptions(),
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { callback: value => formatUSD(value) } } }
    }
  });
}

function renderFutureChart(data) {
  const ctx = document.getElementById("futureMilestonesChart");
  if (ctx.chart) ctx.chart.destroy();

  ctx.parentElement.style.height = Math.max(200, data.length * 30) + "px";

  ctx.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map(d => d.grantee),
      datasets: [{
        label: "Future Milestones (USD)",
        data: data.map(d => d.amount),
        backgroundColor: "rgba(124, 176, 255, 0.7)",
        borderColor: "#7cb0ff",
        borderWidth: 1
      }]
    },
    options: {
      ...getChartOptions(),
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { callback: value => formatUSD(value) } } }
    }
  });
}

function renderAuditPaymentsChart(rows) {
  const monthlyTotals = {};

  rows.forEach(r => {
    const date = new Date(r["Paid Out"]);
    if (isNaN(date)) return;

    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const contractor = r["Independent Contractor (IC)"] || "Unknown";
    const amount = cleanNumber(r["Amount (USD)"]);

    if (!monthlyTotals[monthKey]) {
      monthlyTotals[monthKey] = { total: 0, contractors: {} };
    }

    monthlyTotals[monthKey].total += amount;
    monthlyTotals[monthKey].contractors[contractor] = 
      (monthlyTotals[monthKey].contractors[contractor] || 0) + amount;
  });

  const labels = Object.keys(monthlyTotals).sort();
  const data = labels.map(m => monthlyTotals[m].total);

  const ctx = document.getElementById("auditPaymentsChart").getContext("2d");
  if (ctx.chart) ctx.chart.destroy();

  ctx.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Total Audit Payments (USD)",
        data,
        borderColor: "#f3a622",
        backgroundColor: "rgba(243, 166, 34, 0.2)",
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      ...getChartOptions(),
      plugins: {
        tooltip: {
          callbacks: {
            label: function(context) {
              const month = context.label;
              const total = formatUSD(monthlyTotals[month].total);
              const breakdown = Object.entries(monthlyTotals[month].contractors)
                .map(([name, amt]) => `${name}: ${formatUSD(amt)}`)
                .join(", ");
              return `${total} (${breakdown})`;
            }
          }
        }
      }
    }
  });
}

async function loadICPayouts() {
  try {
    const csv = await fetch(IC_PAYOUTS_CSV).then(r => r.text());
    const rows = Papa.parse(csv, { header: true }).data;

    // ✅ Remove Arborist Call Meeting Notes
    const filteredRows = rows.filter(r =>
      !(r["Project"] || "").toLowerCase().includes("arborist call meeting notes")
    );

    // ✅ Build table HTML
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
        <th>ZEC/USD</th>
        <th>Date</th>
      </tr>`;

    filteredRows.forEach(r => {
      html += `<tr>
        <td>${r["Project"]}</td>
        <td>${r["Independent Contractor (IC)"]}</td>
        <td>${formatUSD(cleanNumber(r["Amount (USD)"]))}</td>
        <td>${formatZEC(cleanNumber(r["ZEC Disbursed"]))}</td>
        <td>${r["ZEC/USD"]}</td>
        <td>${r["Paid Out"]}</td>
      </tr>`;
    });

    html += "</table>";

    // ✅ Insert HTML into DOM first
    document.getElementById("icPayoutsContent").innerHTML = html;

    // ✅ Now that the canvas exists, render the chart
    renderAuditPaymentsChart(filteredRows);

  } catch (error) {
    console.error(error);
    document.getElementById("icPayoutsContent").innerHTML =
      '<div class="loading">Error loading IC payouts data</div>';
  }
}

async function loadNotetaker() {
  try {
    const csv = await fetch(IC_PAYOUTS_CSV).then(r => r.text());
    const rows = Papa.parse(csv, { header: true }).data;
    const filtered = rows.filter(r => (r["Project"] || "").includes("Arborist Call Meeting Notes"));
    
    let totalUSD = 0, totalZEC = 0;
    let html = `<table class="data-table">
      <tr>
        <th>Date</th>
        <th>Amount USD</th>
        <th>ZEC</th>
        <th>ZEC/USD</th>
      </tr>`;
    
    filtered.forEach(r => {
      const usd = cleanNumber(r["Amount (USD)"]);
      const zec = cleanNumber(r["ZEC Disbursed"]);
      totalUSD += usd;
      totalZEC += zec;
      html += `<tr>
        <td>${r["Paid Out"]}</td>
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
    document.getElementById("notetakerContent").innerHTML = '<div class="loading">Error loading notetaker data</div>';
  }
}

// === Event Listeners ===
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Close modal if open
    if (document.getElementById('modalOverlay').classList.contains('active')) {
      closeModal();
    }
    // Close mobile menu if open
    if (document.getElementById('sidebar').classList.contains('active')) {
      closeMobileMenu();
    }
  }
});

document.querySelector('.sidebar-overlay').addEventListener('click', () => {
  closeMobileMenu();
});
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (!e.target.closest('.modal-content')) {
    closeModal();
  }
});

// === Initialize ===
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initRouter();
  setupSearch();
  setupMobileFilters();
  startUpdateTimeFallback(); // ✅ start 10s timer
});
