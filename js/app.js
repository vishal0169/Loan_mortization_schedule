
/* ============================================================
   EMI PRO — Application Logic
   Fixes: PDF superscript bug, number formatting, 0% interest,
          rounding accuracy, year dropdown, light UI wiring
   ============================================================ */
'use strict';

/* ────────────────────────────────────────────────────────────
   CONSTANTS
   ──────────────────────────────────────────────────────────── */
const STORAGE_KEY  = 'emiPro_v2_inputs';

const MONTHS_LONG  = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];

/* ────────────────────────────────────────────────────────────
   STATE
   ──────────────────────────────────────────────────────────── */
let emiSchedule  = [];
let pieChartInst = null;
let lineChartInst= null;

/* ────────────────────────────────────────────────────────────
   DOM SHORTCUTS
   ──────────────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const form           = $('emiForm');
const loadingOverlay = $('loadingOverlay');
const summarySection = $('summarySection');
const chartsSection  = $('charts');
const scheduleSection= $('schedule');
const emiTableBody   = $('emiTableBody');
const tableFooter    = $('tableFooter');
const tableSearch    = $('tableSearch');
const downloadPdfBtn = $('downloadPdfBtn');
const printBtn       = $('printBtn');
const resetBtn       = $('resetBtn');
const repayProgress  = $('repaymentProgress');
const progressPercent= $('progressPercent');
const progressInfo   = $('progressInfo');
const paidPrincipal  = $('paidPrincipal');
const remainingBal   = $('remainingBalance');
const detailGrid     = $('detailGrid');
const zeroIntBadge   = $('zeroInterestBadge');

/* ────────────────────────────────────────────────────────────
   CURRENCY FORMATTING
   ──────────────────────────────────────────────────────────── */

/**
 * Format a number as Indian Rupee string for the UI.
 * Returns "₹1,23,456.78" style.
 */
function formatINR(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '₹0.00';
  const n = Math.round(Math.abs(+amount) * 100) / 100;      // round to 2 dp
  return '₹' + n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

/**
 * Safe numeric string for PDF — strips every non-digit / non-dot / non-comma char.
 * Eliminates the ₹ sign and any locale artefacts that cause superscript "¹" in PDF.
 * E.g. formatINR(13125) → "₹13,125.00"
 *      pdfNum(13125)    → "13,125.00"
 */
function pdfNum(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '0.00';
  const n = Math.round(Math.abs(+amount) * 100) / 100;
  // Build string WITHOUT the ₹ prefix so jsPDF's Latin-1 encoder never sees it.
  // Use en-US locale for PDF because en-IN can embed non-ASCII chars in some
  // JS engines which jsPDF encodes incorrectly as superscripts.
  const raw = n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  // Extra safety: strip any char that is not a digit, dot, comma, or minus.
  return 'Rs.' + String(raw).replace(/[^\d.,\-]/g, '');
}

/**
 * Compact form for chart axis labels.
 */
function fmtCompact(amount) {
  if (isNaN(amount)) return '0';
  const a = Math.abs(amount);
  if (a >= 1e7) return 'Rs.' + (a / 1e7).toFixed(2) + 'Cr';
  if (a >= 1e5) return 'Rs.' + (a / 1e5).toFixed(2) + 'L';
  if (a >= 1e3) return 'Rs.' + (a / 1e3).toFixed(1) + 'K';
  return 'Rs.' + a.toFixed(0);
}

/* ────────────────────────────────────────────────────────────
   DATE HELPERS
   ──────────────────────────────────────────────────────────── */
function getPaymentDate(startMonth1, startYear, emiIndex, emiDay) {
  // startMonth1 is 1-based; emiIndex is 0-based
  const totalMonths = (startMonth1 - 1) + emiIndex;
  const year  = startYear + Math.floor(totalMonths / 12);
  const month = totalMonths % 12;                     // 0-based
  const maxDay = new Date(year, month + 1, 0).getDate();
  const day    = Math.min(emiDay, maxDay);
  return new Date(year, month, day);
}

function formatDate(date) {
  return `${String(date.getDate()).padStart(2,'0')} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

/* ────────────────────────────────────────────────────────────
   EMI CALCULATION
   ──────────────────────────────────────────────────────────── */
function calcEMI(principal, annualRate, n) {
  if (annualRate === 0) {
    return { emi: principal / n, totalInterest: 0, totalPayable: principal };
  }
  const r       = annualRate / 12 / 100;
  const factor  = Math.pow(1 + r, n);
  const emi     = (principal * r * factor) / (factor - 1);
  const total   = emi * n;
  return { emi, totalInterest: total - principal, totalPayable: total };
}

/**
 * Generate full amortisation schedule.
 * Ensures final balance is exactly 0.00 regardless of floating-point drift.
 */
function generateSchedule(principal, annualRate, n, startMonth, startYear, emiDay) {
  const { emi } = calcEMI(principal, annualRate, n);
  const r = annualRate / 12 / 100;

  let balance          = principal;
  let totalInterestSum = 0;
  const schedule       = [];

  for (let i = 0; i < n; i++) {
    const isLast = (i === n - 1);
    let interest, principalPaid, emiAmt;

    if (annualRate === 0) {
      interest      = 0;
      // Ensure last instalment absorbs any tiny rounding residue
      principalPaid = isLast ? balance : Math.round((principal / n) * 100) / 100;
      emiAmt        = principalPaid;
    } else {
      interest      = balance * r;
      principalPaid = emi - interest;
      emiAmt        = emi;

      // Last EMI: drain exact balance to reach ₹0
      if (isLast) {
        principalPaid = balance;
        emiAmt        = balance + interest;
      }
    }

    totalInterestSum += interest;

    // Update balance; clamp sub-penny noise to 0
    balance = balance - principalPaid;
    if (Math.abs(balance) < 0.005) balance = 0;

    schedule.push({
      no           : i + 1,
      date         : getPaymentDate(startMonth, startYear, i, emiDay),
      emi          : emiAmt,
      principal    : principalPaid,
      interest     : interest,
      balance      : balance,
      zeroInterest : annualRate === 0
    });
  }

  return {
    schedule,
    emi,
    totalInterest : totalInterestSum,
    totalPayable  : principal + totalInterestSum
  };
}

/* ────────────────────────────────────────────────────────────
   VALIDATION
   ──────────────────────────────────────────────────────────── */
function setError(id, errId, msg) {
  const el  = $(id);
  const err = $(errId);
  if (msg) {
    el.classList.add('is-invalid');
    el.classList.remove('is-valid');
    err.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${msg}`;
    return false;
  }
  el.classList.remove('is-invalid');
  el.classList.add('is-valid');
  err.innerHTML = '';
  return true;
}

function validateForm() {
  let ok = true;

  const name   = $('fullName').value.trim();
  const amt    = parseFloat($('loanAmount').value);
  const rateV  = $('interestRate').value;
  const rate   = parseFloat(rateV);
  const tenure = parseInt($('tenure').value);
  const month  = parseInt($('startMonth').value);
  const year   = parseInt($('startYear').value);
  const day    = parseInt($('emiDay').value);

  if (!name || name.length < 2)
    { setError('fullName','fullNameError','Enter a valid full name (min 2 characters)'); ok = false; }
  else setError('fullName','fullNameError','');

  if (isNaN(amt) || amt < 1000)
    { setError('loanAmount','loanAmountError','Loan amount must be at least ₹1,000'); ok = false; }
  else if (amt > 1e9)
    { setError('loanAmount','loanAmountError','Maximum loan amount is ₹100 Crore'); ok = false; }
  else setError('loanAmount','loanAmountError','');

  if (rateV === '' || isNaN(rate) || rate < 0)
    { setError('interestRate','interestRateError','Enter 0 or a positive interest rate'); ok = false; }
  else if (rate > 100)
    { setError('interestRate','interestRateError','Interest rate cannot exceed 100%'); ok = false; }
  else setError('interestRate','interestRateError','');

  if (isNaN(tenure) || tenure < 1)
    { setError('tenure','tenureError','Tenure must be at least 1 month'); ok = false; }
  else if (tenure > 360)
    { setError('tenure','tenureError','Maximum tenure is 360 months (30 years)'); ok = false; }
  else setError('tenure','tenureError','');

  if (!$('startMonth').value || isNaN(month) || month < 1 || month > 12)
    { setError('startMonth','startMonthError','Please select a start month'); ok = false; }
  else setError('startMonth','startMonthError','');

  if (!$('startYear').value || isNaN(year) || year < 2000 || year > 2050)
    { setError('startYear','startYearError','Please select a start year'); ok = false; }
  else setError('startYear','startYearError','');

  if (isNaN(day) || day < 1 || day > 31)
    { setError('emiDay','emiDayError','EMI debit day must be between 1 and 31'); ok = false; }
  else setError('emiDay','emiDayError','');

  return ok;
}

function validateField(id, errId) {
  const val = $(id).value;
  const num = parseFloat(val);
  switch (id) {
    case 'fullName':
      return setError(id, errId, val.trim().length < 2 ? 'Enter a valid name (min 2 chars)' : '');
    case 'loanAmount':
      if (!val || isNaN(num)) return setError(id, errId, 'Enter a valid loan amount');
      if (num < 1000)         return setError(id, errId, 'Minimum ₹1,000');
      if (num > 1e9)          return setError(id, errId, 'Maximum ₹100 Crore');
      return setError(id, errId, '');
    case 'interestRate':
      if (val === '' || isNaN(num) || num < 0) return setError(id, errId, 'Enter 0 or a positive rate');
      if (num > 100) return setError(id, errId, 'Max 100%');
      return setError(id, errId, '');
    case 'tenure':
      if (!val || isNaN(parseInt(val)) || parseInt(val) < 1) return setError(id, errId, 'Min 1 month');
      if (parseInt(val) > 360) return setError(id, errId, 'Max 360 months');
      return setError(id, errId, '');
    case 'startMonth':
      return setError(id, errId, (!val || isNaN(num) || num < 1 || num > 12) ? 'Select a month' : '');
    case 'startYear':
      return setError(id, errId, (!val || isNaN(num) || num < 2000 || num > 2050) ? 'Select a year' : '');
    case 'emiDay':
      { const d = parseInt(val);
        return setError(id, errId, (isNaN(d) || d < 1 || d > 31) ? 'Day must be 1–31' : ''); }
  }
}

/* ────────────────────────────────────────────────────────────
   SUMMARY SECTION
   ──────────────────────────────────────────────────────────── */
function updateSummary(principal, emi, totalInterest, totalPayable, tenure, annualRate, name, startMonth, startYear, emiDay) {
  // Animate card values
  animateCounter('summaryEMI',       emi,          formatINR);
  animateCounter('summaryPrincipal', principal,    formatINR);
  animateCounter('summaryInterest',  totalInterest,formatINR);
  animateCounter('summaryTotal',     totalPayable, formatINR);

  // Zero-interest badge
  zeroIntBadge.style.display = annualRate === 0 ? 'inline-flex' : 'none';

  // Detail panel
  const items = [
    { label: 'Borrower Name',  value: name },
    { label: 'Loan Amount',    value: formatINR(principal) },
    { label: 'Interest Rate',  value: annualRate === 0 ? '0% (Zero Interest)' : `${annualRate}% p.a.` },
    { label: 'Tenure',         value: `${tenure} months` },
    { label: 'Start Date',     value: `${MONTHS_LONG[startMonth - 1]} ${startYear}` },
    { label: 'EMI Debit Day',  value: `${emiDay}${ordSuffix(emiDay)} of every month` },
    { label: 'Monthly EMI',    value: formatINR(emi) },
    { label: 'Total Payable',  value: formatINR(totalPayable) },
  ];

  detailGrid.innerHTML = items.map(it => `
    <div class="detail-item">
      <span class="detail-label">${it.label}</span>
      <span class="detail-value">${it.value}</span>
    </div>
  `).join('');

  // Progress bar
  const today = new Date();
  const paid  = emiSchedule.filter(r => r.date < today).length;
  const pct   = tenure > 0 ? (paid / tenure) * 100 : 0;
  const paidPrin = emiSchedule.slice(0, paid).reduce((s, r) => s + r.principal, 0);

  setTimeout(() => {
    repayProgress.style.width     = pct + '%';
    progressPercent.textContent   = pct.toFixed(1) + '%';
  }, 250);

  progressInfo.textContent    = `${paid} of ${tenure} EMIs paid`;
  paidPrincipal.textContent   = formatINR(paidPrin);
  remainingBal.textContent    = formatINR(Math.max(0, principal - paidPrin));
}

function animateCounter(elId, target, formatter) {
  const el = $(elId);
  const duration = 800;
  const t0 = performance.now();
  function step(now) {
    const p = Math.min((now - t0) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = formatter(target * ease);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = formatter(target);
  }
  requestAnimationFrame(step);
}

/* ────────────────────────────────────────────────────────────
   TABLE RENDERING
   ──────────────────────────────────────────────────────────── */
function renderTable(schedule) {
  emiTableBody.innerHTML = '';
  const today    = new Date();
  const currNo   = getCurrentEMINo(schedule, today);

  schedule.forEach((row, idx) => {
    const isCurrent = row.no === currNo;
    const isPast    = row.date < today && !isCurrent;

    const tr = document.createElement('tr');
    if (isCurrent) tr.classList.add('row-current');
    else if (isPast) tr.classList.add('row-paid');

    const statusHtml = isCurrent
      ? `<span class="status-badge status-current"><i class="fas fa-play-circle"></i> Current</span>`
      : isPast
        ? `<span class="status-badge status-paid"><i class="fas fa-check"></i> Paid</span>`
        : `<span class="status-badge status-upcoming">Upcoming</span>`;

    const interestCell = row.zeroInterest
      ? `<span style="color:var(--success);font-weight:600;">—</span>`
      : `<span class="amount-interest">${formatINR(row.interest)}</span>`;

    tr.innerHTML = `
      <td class="td-no"><span class="emi-no">${row.no}</span></td>
      <td class="td-date">${formatDate(row.date)}</td>
      <td class="td-emi"><span class="amount-emi">${formatINR(row.emi)}</span></td>
      <td class="td-principal"><span class="amount-principal">${formatINR(row.principal)}</span></td>
      <td class="td-interest">${interestCell}</td>
      <td class="td-balance"><span class="amount-balance">${formatINR(row.balance)}</span></td>
      <td class="td-status">${statusHtml}</td>
    `;

    if (idx < 60) tr.style.animationDelay = `${idx * 15}ms`;
    emiTableBody.appendChild(tr);
  });

  updateTableFooter(schedule);
}

function getCurrentEMINo(schedule, today) {
  for (const row of schedule) {
    if (row.date >= today) return row.no;
  }
  return schedule[schedule.length - 1]?.no || 1;
}

function updateTableFooter(schedule) {
  const total   = schedule.length;
  const today   = new Date();
  const paid    = schedule.filter(r => r.date < today).length;
  const rem     = total - paid;
  const paidP   = schedule.slice(0, paid).reduce((s, r) => s + r.principal, 0);
  const paidI   = schedule.slice(0, paid).reduce((s, r) => s + r.interest,  0);

  tableFooter.innerHTML = `
    <span>${total} EMIs total &nbsp;|&nbsp; <strong>${paid}</strong> paid &nbsp;|&nbsp; <strong>${rem}</strong> remaining</span>
    <span>Principal paid: <strong>${formatINR(paidP)}</strong> &nbsp;|&nbsp; Interest paid: <strong>${formatINR(paidI)}</strong></span>
  `;
}

/* ────────────────────────────────────────────────────────────
   CHARTS
   ──────────────────────────────────────────────────────────── */
function renderCharts(principal, totalInterest, schedule) {
  renderPieChart(principal, totalInterest);
  renderLineChart(schedule);
}

function renderPieChart(principal, totalInterest) {
  if (pieChartInst) { pieChartInst.destroy(); pieChartInst = null; }
  const ctx    = $('pieChart').getContext('2d');
  const isZero = totalInterest === 0;
  const data   = isZero ? [principal] : [principal, totalInterest];
  const labels = isZero ? ['Principal (100%)'] : ['Principal', 'Total Interest'];
  const colors = isZero ? ['#4f46e5'] : ['#4f46e5', '#db2777'];

  pieChartInst = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor : colors,
        borderColor     : ['#fff','#fff'],
        borderWidth     : 3,
        hoverOffset     : 10
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor : '#1e293b',
          titleColor      : '#f1f5f9',
          bodyColor       : '#94a3b8',
          borderColor     : '#334155',
          borderWidth     : 1,
          padding         : 10,
          callbacks: {
            label: ctx => `  ${ctx.label}: ${formatINR(ctx.raw)}`
          }
        }
      },
      animation: { animateRotate: true, duration: 900 }
    }
  });

  $('pieLegend').innerHTML = labels.map((l, i) => `
    <div class="legend-item">
      <div class="legend-dot" style="background:${colors[i]}"></div>
      <span>${l}: ${fmtCompact(data[i])}</span>
    </div>
  `).join('');
}

function renderLineChart(schedule) {
  if (lineChartInst) { lineChartInst.destroy(); lineChartInst = null; }

  // Smart-sample for large schedules
  const maxPts = 60;
  const step   = Math.max(1, Math.ceil(schedule.length / maxPts));
  const pts    = schedule.filter((_, i) => i % step === 0 || i === schedule.length - 1);

  const labels   = pts.map(r => `${MONTHS_SHORT[r.date.getMonth()]} ${r.date.getFullYear()}`);
  const balances = pts.map(r => +r.balance.toFixed(2));
  const ctx      = $('lineChart').getContext('2d');

  lineChartInst = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label           : 'Remaining Balance',
        data            : balances,
        borderColor     : '#4f46e5',
        backgroundColor : 'rgba(79,70,229,.08)',
        fill            : true,
        tension         : 0.4,
        pointRadius     : schedule.length > 60 ? 0 : 3,
        pointHoverRadius: 5,
        borderWidth     : 2.5
      }]
    },
    options: {
      responsive           : true,
      maintainAspectRatio  : false,
      interaction          : { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display : true,
          labels  : {
            color    : '#64748b',
            font     : { family: 'Inter', size: 11 },
            boxWidth : 12,
            usePointStyle: true
          }
        },
        tooltip: {
          backgroundColor : '#1e293b',
          titleColor      : '#f1f5f9',
          bodyColor       : '#94a3b8',
          borderColor     : '#334155',
          borderWidth     : 1,
          padding         : 10,
          callbacks: {
            label: ctx => `  Balance: ${formatINR(ctx.raw)}`
          }
        }
      },
      scales: {
        x: {
          grid : { color: '#f1f5f9' },
          ticks: { color: '#94a3b8', font: { family: 'Inter', size: 10 }, maxRotation: 45 }
        },
        y: {
          grid : { color: '#f1f5f9' },
          ticks: {
            color   : '#94a3b8',
            font    : { family: 'Inter', size: 10 },
            callback: v => fmtCompact(v)
          }
        }
      },
      animation: { duration: 1000 }
    }
  });
}

/* ────────────────────────────────────────────────────────────
   PDF EXPORT
   ──────────────────────────────────────────────────────────── */
function exportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const PW     = 210;           // page width mm
  const PH     = 297;           // page height mm
  const ML     = 14;            // left margin
  const MR     = 14;            // right margin
  const CW     = PW - ML - MR;  // content width

  /* ── Collect form values ─────────────────────────────────── */
  const name       = $('fullName').value.trim();
  const principal  = parseFloat($('loanAmount').value);
  const annualRate = parseFloat($('interestRate').value);
  const tenure     = parseInt($('tenure').value);
  const startMonth = parseInt($('startMonth').value);
  const startYear  = parseInt($('startYear').value);
  const emiDay     = parseInt($('emiDay').value);

  const { emi, totalInterest, totalPayable } = calcEMI(principal, annualRate, tenure);

  /* ── IMPORTANT: always use Helvetica (Latin-1 safe) ─────── */
  /*   Never use special Unicode fonts that cause "¹" bug      */
  doc.setFont('helvetica', 'normal');

  /* ── Page 1 header band ──────────────────────────────────── */
  doc.setFillColor(79, 70, 229);
  doc.rect(0, 0, PW, 46, 'F');

  /* Logo box */
  doc.setFillColor(255, 255, 255, 0.15);
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(ML, 10, 28, 16, 3, 3, 'F');
  doc.setTextColor(79, 70, 229);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('EMIPro', ML + 14, 20, { align: 'center' });

  /* Title */
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.text('EMI PAYMENT SCHEDULE', PW / 2, 20, { align: 'center' });

  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(200, 210, 255);
  doc.text('Loan Repayment Statement', PW / 2, 27, { align: 'center' });

  /* Generated date — ASCII safe */
  const now = new Date();
  const genDate = `Generated: ${String(now.getDate()).padStart(2,'0')} ${MONTHS_SHORT[now.getMonth()]} ${now.getFullYear()}`;
  doc.setFontSize(7.5);
  doc.setTextColor(180, 190, 255);
  doc.text(genDate, PW - MR, 40, { align: 'right' });

  /* ── Borrower details box ────────────────────────────────── */
  let y = 54;
  doc.setFillColor(241, 245, 249);
  doc.roundedRect(ML, y, CW, 34, 3, 3, 'F');
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(ML, y, CW, 34, 3, 3, 'S');

  doc.setTextColor(79, 70, 229);
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.text('BORROWER DETAILS', ML + 4, y + 7);

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(11);
  doc.text(name, ML + 4, y + 15);

  /* 5 columns of loan info */
  const cols = [
    ['LOAN AMOUNT',   pdfNum(principal)],
    ['INTEREST RATE', annualRate === 0 ? '0% (Zero Interest)' : `${annualRate}% p.a.`],
    ['TENURE',        `${tenure} months`],
    ['START DATE',    `${MONTHS_SHORT[startMonth - 1]} ${startYear}`],
    ['EMI DEBIT DAY', `${emiDay}${ordSuffix(emiDay)} of month`],
  ];

  const cw = CW / cols.length;
  cols.forEach(([label, value], i) => {
    const cx = ML + i * cw + 4;
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(label, cx, y + 24);
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text(value, cx, y + 30);
  });

  /* ── Summary cards (3 boxes) ─────────────────────────────── */
  y += 42;
  const cards = [
    { label: 'MONTHLY EMI',    value: pdfNum(emi),           bg: [79,70,229]  },
    { label: 'TOTAL INTEREST', value: pdfNum(totalInterest), bg: [219,39,119] },
    { label: 'TOTAL PAYABLE',  value: pdfNum(totalPayable),  bg: [217,119,6]  },
  ];

  const cardW = (CW - 8) / 3;
  cards.forEach((card, i) => {
    const cx = ML + i * (cardW + 4);
    doc.setFillColor(...card.bg);
    doc.roundedRect(cx, y, cardW, 20, 3, 3, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(6.5);
    doc.setFont('helvetica', 'normal');
    doc.text(card.label, cx + cardW / 2, y + 7, { align: 'center' });
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text(card.value, cx + cardW / 2, y + 15, { align: 'center' });
  });

  y += 28;

  /* ── Zero-interest note ──────────────────────────────────── */
  if (annualRate === 0) {
    doc.setFillColor(209, 250, 229);
    doc.roundedRect(ML, y, CW, 9, 2, 2, 'F');
    doc.setTextColor(5, 150, 105);
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.text('Zero-Interest Loan: Equal principal instalments. No interest charged.', PW / 2, y + 6, { align: 'center' });
    y += 15;
  }

  /* ── Table heading ───────────────────────────────────────── */
  doc.setTextColor(79, 70, 229);
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'bold');
  doc.text('EMI REPAYMENT SCHEDULE', ML, y + 5);
  y += 10;

  /* ── Build table data — no ₹ symbol, use "Rs." prefix ─────
     This is the CRITICAL fix: jsPDF's built-in fonts (Helvetica,
     Courier, Times) are Latin-1. The ₹ glyph (U+20B9) is NOT in
     Latin-1 and gets mis-rendered as superscript "¹" (U+00B9).
     Solution: use "Rs." ASCII prefix everywhere in the PDF.        */
  const head = [['#', 'Payment Date', 'EMI Amount', 'Principal', 'Interest', 'Balance']];
  const rows = emiSchedule.map(r => [
    String(r.no),
    formatDate(r.date),
    pdfNum(r.emi),
    pdfNum(r.principal),
    r.zeroInterest ? '--' : pdfNum(r.interest),
    pdfNum(r.balance)
  ]);

  doc.autoTable({
    head       : head,
    body       : rows,
    startY     : y,
    margin     : { left: ML, right: MR },
    tableWidth : 'auto',
    styles: {
      font      : 'helvetica',
      fontSize  : 7.5,
      cellPadding: { top: 3, bottom: 3, left: 4, right: 4 },
      textColor : [30, 41, 59],
      lineColor : [226, 232, 240],
      lineWidth : 0.2
    },
    headStyles: {
      fillColor : [79, 70, 229],
      textColor : [255, 255, 255],
      fontStyle : 'bold',
      fontSize  : 7.5,
      halign    : 'center'
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { halign: 'center', cellWidth: 10  },
      1: { halign: 'center', cellWidth: 30  },
      2: { halign: 'right',  cellWidth: 33  },
      3: { halign: 'right',  cellWidth: 33  },
      4: { halign: 'right',  cellWidth: 28  },
      5: { halign: 'right',  cellWidth: 33  }
    },
    /* Highlight first data row */
    didParseCell: data => {
      if (data.section === 'body' && data.row.index === 0) {
        data.cell.styles.fillColor = [237, 233, 254];
        data.cell.styles.fontStyle = 'bold';
      }
    },
    /* Footer on every page */
    didDrawPage: () => {
      const pn  = doc.getCurrentPageInfo().pageNumber;
      const tot = doc.getNumberOfPages();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(148, 163, 184);
      doc.text(
        `EMIPro - Smart Loan Planner  |  Page ${pn} of ${tot}`,
        PW / 2, PH - 8, { align: 'center' }
      );
      doc.text(
        'Figures are indicative. Please verify with your lender.',
        PW / 2, PH - 4, { align: 'center' }
      );
    }
  });

  const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 30);
  doc.save(`EMI_Schedule_${safeName}_${startYear}.pdf`);
}

/* ────────────────────────────────────────────────────────────
   PRINT VIEW
   ──────────────────────────────────────────────────────────── */
function openPrintView() {
  const name       = $('fullName').value.trim();
  const principal  = parseFloat($('loanAmount').value);
  const annualRate = parseFloat($('interestRate').value);
  const tenure     = parseInt($('tenure').value);
  const startMonth = parseInt($('startMonth').value);
  const startYear  = parseInt($('startYear').value);
  const emiDay     = parseInt($('emiDay').value);

  const { emi, totalInterest, totalPayable } = calcEMI(principal, annualRate, tenure);

  // Generate HTML for print view
  const printHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EMI Schedule - ${name}</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    @media print {
      body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .no-print { display: none !important; }
    }
    body {
      font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: #ffffff;
      color: #0f172a;
      margin: 0;
      padding: 20px;
      line-height: 1.6;
    }
    .print-header {
      text-align: center;
      border-bottom: 2px solid #4f46e5;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    .print-title {
      font-size: 24px;
      font-weight: 700;
      color: #4f46e5;
      margin: 0;
    }
    .print-subtitle {
      font-size: 14px;
      color: #64748b;
      margin: 5px 0 0 0;
    }
    .user-details {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
      padding: 20px;
      background: #f8fafc;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
    }
    .detail-item {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .detail-label {
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .detail-value {
      font-size: 16px;
      font-weight: 500;
      color: #0f172a;
    }
    .summary-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
    }
    .summary-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 15px;
      text-align: center;
    }
    .summary-label {
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
    }
    .summary-value {
      font-size: 18px;
      font-weight: 700;
      color: #0f172a;
    }
    .emi-table {
      width: 100%;
      border-collapse: collapse;
      min-width: 680px;
      margin-top: 20px;
    }
    .emi-table thead tr {
      background: linear-gradient(90deg, #4f46e5 0%, #0891b2 100%);
    }
    .emi-table th {
      padding: 12px 14px;
      font-size: .73rem;
      font-weight: 700;
      color: rgba(255,255,255,.92);
      text-transform: uppercase;
      letter-spacing: .07em;
      white-space: nowrap;
      text-align: center;
    }
    .emi-table th.th-emi, .emi-table th.th-principal, .emi-table th.th-interest, .emi-table th.th-balance {
      text-align: right;
    }
    .emi-table th.th-emi, .emi-table th.th-principal, .emi-table th.th-interest, .emi-table th.th-balance {
      text-align: right;
    }
    .emi-table td {
      padding: 11px 14px;
      font-size: .86rem;
      color: #334155;
      border-bottom: 1px solid #f1f5f9;
      white-space: nowrap;
    }
    .emi-table tbody tr:nth-child(even) {
      background: #f8fafc;
    }
    .emi-table tbody tr.row-current td {
      background: #ede9fe !important;
      font-weight: 600;
      color: #3730a3;
    }
    .emi-table tbody tr.row-current {
      border-left: 3px solid #4f46e5;
    }
    .emi-table tbody tr.row-paid td {
      color: #94a3b8;
    }
    td.td-no, td.td-date {
      text-align: center;
    }
    td.td-emi, td.td-principal, td.td-interest, td.td-balance {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    td.td-status {
      text-align: center;
    }
    .emi-no {
      font-weight: 700;
      color: #4f46e5;
    }
    .amount-emi {
      font-weight: 600;
    }
    .amount-principal {
      color: #0891b2;
      font-weight: 600;
    }
    .amount-interest {
      color: #db2777;
      font-weight: 600;
    }
    .amount-balance {
      color: #64748b;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 9px;
      border-radius: 50px;
      font-size: .7rem;
      font-weight: 600;
    }
    .status-upcoming {
      background: #ede9fe;
      color: #4f46e5;
    }
    .status-paid {
      background: #d1fae5;
      color: #059669;
    }
    .status-current {
      background: #4f46e5;
      color: #fff;
    }
    .zero-interest-note {
      background: #d1fae5;
      color: #059669;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      text-align: center;
      font-weight: 600;
    }
    .print-footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      font-size: 12px;
      color: #64748b;
    }
    .print-btn {
      position: fixed;
      top: 20px;
      right: 20px;
      background: #059669;
      color: white;
      border: none;
      padding: 10px 15px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      box-shadow: 0 2px 8px rgba(5,150,105,0.3);
    }
    .print-btn:hover {
      background: #047857;
    }
  </style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">🖨️ Print</button>

  <div class="print-header">
    <h1 class="print-title">EMI Payment Schedule</h1>
    <p class="print-subtitle">Loan Repayment Statement</p>
  </div>
<div style="font-family: Arial, sans-serif; font-size: 20px; font-weight: bold; margin-bottom: 10px;">
  Loan Summary
</div>
  <div class="user-details">
    
    <div class="detail-item">
      <div class="detail-label">Borrower Name</div>
      <div class="detail-value">${name}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Loan Amount</div>
      <div class="detail-value">${formatINR(principal)}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Interest Rate</div>
      <div class="detail-value">${annualRate === 0 ? '0% (Zero Interest)' : annualRate + '% p.a.'}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Tenure</div>
      <div class="detail-value">${tenure} months</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">Start Date</div>
      <div class="detail-value">${MONTHS_LONG[startMonth - 1]} ${startYear}</div>
    </div>
    <div class="detail-item">
      <div class="detail-label">EMI Debit Day</div>
      <div class="detail-value">${emiDay}${ordSuffix(emiDay)} of every month</div>
    </div>
  </div>

  <div class="summary-cards">
    <div class="summary-card">
      <div class="summary-label">Monthly EMI</div>
      <div class="summary-value">${formatINR(emi)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Total Interest</div>
      <div class="summary-value">${formatINR(totalInterest)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">Total Payable</div>
      <div class="summary-value">${formatINR(totalPayable)}</div>
    </div>
  </div>

  ${annualRate === 0 ? '<div class="zero-interest-note">Zero-Interest Loan — Equal principal instalments, no interest charged.</div>' : ''}

  <table class="emi-table">
    <thead>
      <tr>
        <th class="th-no">#</th>
        <th class="th-date">Payment Date</th>
        <th class="th-emi">EMI Amount</th>
        <th class="th-principal">Principal</th>
        <th class="th-interest">Interest</th>
        <th class="th-balance">Balance</th>
        <th class="th-status">Status</th>
      </tr>
    </thead>
    <tbody>
      ${emiSchedule.map((row, idx) => {
        const today = new Date();
        const currNo = getCurrentEMINo(emiSchedule, today);
        const isCurrent = row.no === currNo;
        const isPast = row.date < today && !isCurrent;

        let rowClass = '';
        if (isCurrent) rowClass = 'row-current';
        else if (isPast) rowClass = 'row-paid';

        const statusHtml = isCurrent
          ? `<span class="status-badge status-current"><i class="fas fa-play-circle"></i> Current</span>`
          : isPast
            ? `<span class="status-badge status-paid"><i class="fas fa-check"></i> Paid</span>`
            : `<span class="status-badge status-upcoming">Upcoming</span>`;

        const interestCell = row.zeroInterest
          ? `<span style="color:#059669;font-weight:600;">—</span>`
          : `<span class="amount-interest">${formatINR(row.interest)}</span>`;

        return `
          <tr class="${rowClass}">
            <td class="td-no"><span class="emi-no">${row.no}</span></td>
            <td class="td-date">${formatDate(row.date)}</td>
            <td class="td-emi"><span class="amount-emi">${formatINR(row.emi)}</span></td>
            <td class="td-principal"><span class="amount-principal">${formatINR(row.principal)}</span></td>
            <td class="td-interest">${interestCell}</td>
            <td class="td-balance"><span class="amount-balance">${formatINR(row.balance)}</span></td>
            <td class="td-status">${statusHtml}</td>
          </tr>
        `;
      }).join('')}
    </tbody>
  </table>

  <div class="print-footer">
    <p><strong>EMIPro</strong> — Smart Loan Planner</p>
    <p>Calculations are indicative. Please verify all figures with your lender before making financial decisions.</p>
  </div>
</body>
</html>`;

  // Open in new tab
  const printWindow = window.open('', '_blank');
  printWindow.document.write(printHtml);
  printWindow.document.close();
}

/* ────────────────────────────────────────────────────────────
   HELPERS
   ──────────────────────────────────────────────────────────── */
function ordSuffix(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function showSection(el) {
  el.classList.remove('hidden');
  el.style.animation = 'none';
  requestAnimationFrame(() => { el.style.animation = ''; });
}

function showLoading() { loadingOverlay.classList.remove('hidden'); }
function hideLoading() { loadingOverlay.classList.add('hidden');    }

/* ────────────────────────────────────────────────────────────
   SLIDERS
   ──────────────────────────────────────────────────────────── */
function initSliders() {
  const loanIn  = $('loanAmount');
  const loanSl  = $('loanSlider');
  const tenIn   = $('tenure');
  const tenSl   = $('tenureSlider');

  loanSl.addEventListener('input', () => {
    loanIn.value = loanSl.value;
    syncSliderBg(loanSl);
    loanIn.dispatchEvent(new Event('input'));
  });
  loanIn.addEventListener('input', () => {
    const v = parseFloat(loanIn.value);
    if (!isNaN(v) && v >= 1000 && v <= 10000000) { loanSl.value = v; syncSliderBg(loanSl); }
  });

  tenSl.addEventListener('input', () => {
    tenIn.value = tenSl.value;
    syncSliderBg(tenSl);
    tenIn.dispatchEvent(new Event('input'));
  });
  tenIn.addEventListener('input', () => {
    const v = parseInt(tenIn.value);
    if (!isNaN(v) && v >= 1 && v <= 360) { tenSl.value = v; syncSliderBg(tenSl); }
  });

  syncSliderBg(loanSl);
  syncSliderBg(tenSl);
}

function syncSliderBg(slider) {
  const min = +slider.min, max = +slider.max, val = +slider.value;
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background =
    `linear-gradient(to right, #4f46e5 ${pct}%, #e2e8f0 ${pct}%)`;
}

/* ────────────────────────────────────────────────────────────
   YEAR DROPDOWN  (2000 – 2050, allows past years)
   ──────────────────────────────────────────────────────────── */
function buildYearDropdown() {
  const sel = $('startYear');
  for (let yr = 2000; yr <= 2050; yr++) {
    const opt = document.createElement('option');
    opt.value       = yr;
    opt.textContent = yr;
    sel.appendChild(opt);
  }
}

/* ────────────────────────────────────────────────────────────
   DEFAULT DATE  (current month / year)
   ──────────────────────────────────────────────────────────── */
function setDefaultDate() {
  const now = new Date();
  if (!$('startMonth').value) $('startMonth').value = now.getMonth() + 1;
  if (!$('startYear').value)  $('startYear').value  = now.getFullYear();
}

/* ────────────────────────────────────────────────────────────
   PARTICLES
   ──────────────────────────────────────────────────────────── */
function initParticles() {
  const container = $('particles');
  const count     = window.innerWidth < 768 ? 10 : 20;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.classList.add('particle');
    const size = Math.random() * 8 + 3;
    Object.assign(p.style, {
      width           : size + 'px',
      height          : size + 'px',
      left            : Math.random() * 100 + '%',
      bottom          : -size + 'px',
      animationDuration: (Math.random() * 10 + 6) + 's',
      animationDelay  : (Math.random() * 8) + 's'
    });
    container.appendChild(p);
  }
}

/* ────────────────────────────────────────────────────────────
   LOCAL STORAGE
   ──────────────────────────────────────────────────────────── */
function saveInputs() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    fullName    : $('fullName').value,
    loanAmount  : $('loanAmount').value,
    interestRate: $('interestRate').value,
    tenure      : $('tenure').value,
    startMonth  : $('startMonth').value,
    startYear   : $('startYear').value,
    emiDay      : $('emiDay').value
  }));
}

function loadInputs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.fullName)               $('fullName').value     = d.fullName;
    if (d.loanAmount)             $('loanAmount').value   = d.loanAmount;
    if (d.interestRate !== undefined) $('interestRate').value = d.interestRate;
    if (d.tenure)                 $('tenure').value       = d.tenure;
    if (d.startMonth)             $('startMonth').value   = d.startMonth;
    if (d.startYear)              $('startYear').value    = d.startYear;
    if (d.emiDay)                 $('emiDay').value       = d.emiDay;
    // Sync sliders
    if (d.loanAmount) { $('loanSlider').value = Math.min(+d.loanAmount, 10000000); syncSliderBg($('loanSlider')); }
    if (d.tenure)     { $('tenureSlider').value = +d.tenure; syncSliderBg($('tenureSlider')); }
  } catch (_) { /* ignore */ }
}

/* ────────────────────────────────────────────────────────────
   TABLE SEARCH
   ──────────────────────────────────────────────────────────── */
tableSearch.addEventListener('input', () => {
  const q = tableSearch.value.trim().toLowerCase();
  emiTableBody.querySelectorAll('tr').forEach(tr => {
    tr.classList.toggle('row-filtered-out', q.length > 0 && !tr.textContent.toLowerCase().includes(q));
  });
});

/* ────────────────────────────────────────────────────────────
   FORM SUBMIT
   ──────────────────────────────────────────────────────────── */
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!validateForm()) return;

  showLoading();
  saveInputs();
  await new Promise(r => setTimeout(r, 550));   // brief UX delay

  const principal  = parseFloat($('loanAmount').value);
  const annualRate = parseFloat($('interestRate').value);
  const tenure     = parseInt($('tenure').value);
  const startMonth = parseInt($('startMonth').value);
  const startYear  = parseInt($('startYear').value);
  const emiDay     = parseInt($('emiDay').value);
  const name       = $('fullName').value.trim();

  const result    = generateSchedule(principal, annualRate, tenure, startMonth, startYear, emiDay);
  emiSchedule     = result.schedule;

  hideLoading();

  showSection(summarySection);
  updateSummary(principal, result.emi, result.totalInterest, result.totalPayable,
                tenure, annualRate, name, startMonth, startYear, emiDay);

  showSection(chartsSection);
  renderCharts(principal, result.totalInterest, emiSchedule);

  showSection(scheduleSection);
  renderTable(emiSchedule);

  setTimeout(() => summarySection.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
});

/* ────────────────────────────────────────────────────────────
   RESET
   ──────────────────────────────────────────────────────────── */
resetBtn.addEventListener('click', () => {
  if (!confirm('Reset all fields and clear the schedule?')) return;

  form.reset();
  $('emiDay').value = 4;
  setDefaultDate();

  ['fullName','loanAmount','interestRate','tenure','startMonth','startYear','emiDay'].forEach(id => {
    $(id).classList.remove('is-valid','is-invalid');
  });
  ['fullNameError','loanAmountError','interestRateError','tenureError','startMonthError','startYearError','emiDayError'].forEach(id => {
    $(id).innerHTML = '';
  });

  $('loanSlider').value   = 500000;
  $('tenureSlider').value = 12;
  syncSliderBg($('loanSlider'));
  syncSliderBg($('tenureSlider'));

  [summarySection, chartsSection, scheduleSection].forEach(s => s.classList.add('hidden'));
  if (pieChartInst)  { pieChartInst.destroy();  pieChartInst  = null; }
  if (lineChartInst) { lineChartInst.destroy(); lineChartInst = null; }
  emiTableBody.innerHTML = '';
  emiSchedule = [];
  localStorage.removeItem(STORAGE_KEY);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ────────────────────────────────────────────────────────────
   PDF BUTTON
   ──────────────────────────────────────────────────────────── */
downloadPdfBtn.addEventListener('click', () => {
  if (emiSchedule.length === 0) { alert('Please generate the schedule first.'); return; }
  showLoading();
  setTimeout(() => {
    try   { exportPDF(); }
    catch (err) { console.error('PDF error:', err); alert('PDF generation failed. Please try again.'); }
    hideLoading();
  }, 350);
});

/* ────────────────────────────────────────────────────────────
   PRINT BUTTON
   ──────────────────────────────────────────────────────────── */
printBtn.addEventListener('click', () => {
  if (emiSchedule.length === 0) { alert('Please generate the schedule first.'); return; }
  openPrintView();
});

/* ────────────────────────────────────────────────────────────
   REAL-TIME VALIDATION
   ──────────────────────────────────────────────────────────── */
function wireValidation() {
  const fields = [
    ['fullName','fullNameError'],
    ['loanAmount','loanAmountError'],
    ['interestRate','interestRateError'],
    ['tenure','tenureError'],
    ['startMonth','startMonthError'],
    ['startYear','startYearError'],
    ['emiDay','emiDayError']
  ];
  fields.forEach(([id, errId]) => {
    const el = $(id);
    el.addEventListener('blur',  () => validateField(id, errId));
    el.addEventListener('input', () => { if (el.classList.contains('is-invalid')) validateField(id, errId); });
  });
}

/* ────────────────────────────────────────────────────────────
   INIT
   ──────────────────────────────────────────────────────────── */
function init() {
  buildYearDropdown();   // must run BEFORE loadInputs so dropdown exists
  initParticles();
  initSliders();
  loadInputs();
  setDefaultDate();
  wireValidation();

  // Re-sync sliders after loading saved inputs
  const savedAmt = parseFloat($('loanAmount').value);
  if (!isNaN(savedAmt) && savedAmt > 0) {
    $('loanSlider').value = Math.min(savedAmt, 10000000);
    syncSliderBg($('loanSlider'));
  }
  const savedTen = parseInt($('tenure').value);
  if (!isNaN(savedTen) && savedTen > 0) {
    $('tenureSlider').value = savedTen;
    syncSliderBg($('tenureSlider'));
  }
}

document.addEventListener('DOMContentLoaded', init);
