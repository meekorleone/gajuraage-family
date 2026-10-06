/* Gajuraage calculations: rent schedule, fines, compliance, distribution waterfall.
   Pure functions so they can be tested outside the browser. Dates are 'YYYY-MM-DD' strings. */
(function (root) {
  const pad = n => String(n).padStart(2, '0');
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const ymd = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
  const monthKey = s => s.slice(0, 7);
  const addMonths = (key, n) => {
    let [y, m] = key.split('-').map(Number); m += n;
    y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1;
    return y + '-' + pad(m);
  };
  const monthsBetween = (a, b) => { const out = []; for (let k = a; k <= b; k = addMonths(k, 1)) out.push(k); return out; };
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const addDays = (s, n) => ymd(parse(s) + n * 86400000);
  const maxS = (a, b) => (a > b ? a : b);
  const minS = (a, b) => (a < b ? a : b);
  const lastDay = key => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

  function fineFor(lease, daysLate, settings) {
    if (daysLate <= 0) return 0;
    const rent = +lease.monthly_rent, v = +lease.fine_value || 0;
    switch (lease.fine_type) {
      case 'daily': {
        const cap = rent * (+settings.fine_cap_pct || 0) / 100;
        return r2(cap > 0 ? Math.min(daysLate * v, cap) : daysLate * v);
      }
      case 'percent': return r2(rent * v / 100);
      case 'flat': return r2(v);
      default: return 0;
    }
  }

  // Fine owed if the rent for this row is completed on `date` (used when recording a payment)
  function fineIfPaidOn(lease, row, date, settings) {
    const days = Math.max(0, daysBetween(row.deadline, date));
    return r2(Math.max(0, fineFor(lease, days, settings) - row.finePaid - row.fineWaived));
  }

  function depositSummary(lease, deposits, payments) {
    const d = deposits.filter(x => x.lease_id === lease.id);
    const sum = k => r2(d.filter(x => x.kind === k).reduce((a, x) => a + +x.amount, 0));
    const applied = r2(payments.filter(p => p.lease_id === lease.id && p.source === 'advance').reduce((a, p) => a + +p.rent_amount + +p.fine_amount, 0));
    const s = { securityIn: sum('security_in'), securityRefunded: sum('security_refund'), securityRetained: sum('security_retained'),
      advanceIn: sum('advance_in'), advanceRefunded: sum('advance_refund'), advanceApplied: applied };
    s.securityHeld = r2(s.securityIn - s.securityRefunded - s.securityRetained);
    s.advanceBalance = r2(s.advanceIn - s.advanceRefunded - s.advanceApplied);
    return s;
  }

  function leaseStatus(lease, today) {
    if (lease.start_date > today) return { key: 'upcoming', label: 'Starts ' + lease.start_date };
    if (lease.end_date && lease.end_date < today) return { key: 'ended', label: 'Ended' };
    if (lease.end_date && daysBetween(today, lease.end_date) <= 90) return { key: 'expiring', label: 'Expiring soon' };
    return { key: 'active', label: 'Active' };
  }

  function leaseSchedule(lease, payments, settings, today, waivers) {
    waivers = (waivers || []).filter(w => w.lease_id === lease.id);
    const startK = maxS(monthKey(lease.start_date), monthKey(settings.tracking_start));
    const endK = minS(monthKey(today), lease.end_date ? monthKey(lease.end_date) : '9999-12');
    const pays = payments.filter(p => p.lease_id === lease.id);
    const rent = +lease.monthly_rent;
    const rows = [];
    for (const k of (startK <= endK ? monthsBetween(startK, endK) : [])) {
      const due = k + '-' + pad(Math.min(+lease.due_day || 1, lastDay(k)));
      const deadline = addDays(due, +lease.grace_days || 0);
      const ps = pays.filter(p => monthKey(p.period) === k)
        .sort((a, b) => (a.received_on < b.received_on ? -1 : 1));
      let rentPaid = 0, finePaid = 0, fullOn = null;
      for (const p of ps) {
        rentPaid += +p.rent_amount; finePaid += +p.fine_amount;
        if (!fullOn && rentPaid >= rent - 0.005) fullOn = p.received_on;
      }
      let status, daysLate = 0;
      if (rent === 0) status = 'ontime';
      else if (fullOn) { daysLate = Math.max(0, daysBetween(deadline, fullOn)); status = daysLate > 0 ? 'late' : 'ontime'; }
      else if (today <= deadline) status = rentPaid > 0 ? 'partdue' : 'due';
      else { daysLate = daysBetween(deadline, today); status = rentPaid > 0 ? 'partial' : 'unpaid'; }
      const fineAccrued = fineFor(lease, daysLate, settings);
      const fineWaived = r2(waivers.filter(w => monthKey(w.period) === k).reduce((a, w) => a + +w.amount, 0));
      rows.push({
        month: k, due, deadline, rent, rentPaid: r2(rentPaid), rentOutstanding: r2(Math.max(0, rent - rentPaid)),
        fullOn, status, daysLate, fineAccrued, finePaid: r2(finePaid), fineWaived,
        fineOutstanding: r2(Math.max(0, fineAccrued - finePaid - fineWaived)), payments: ps
      });
    }
    const overdue = rows.filter(r => r.status === 'partial' || r.status === 'unpaid');
    const late = rows.filter(r => r.status === 'late');
    const settled = rows.filter(r => r.status !== 'due' && r.status !== 'partdue');
    const summary = {
      monthsDue: settled.length,
      rentDue: r2(settled.reduce((a, r) => a + r.rent, 0)),
      rentPaid: r2(rows.reduce((a, r) => a + r.rentPaid, 0)),
      arrears: r2(overdue.reduce((a, r) => a + r.rentOutstanding, 0)),
      finesAccrued: r2(rows.reduce((a, r) => a + r.fineAccrued, 0)),
      finesPaid: r2(rows.reduce((a, r) => a + r.finePaid, 0)),
      finesWaived: r2(rows.reduce((a, r) => a + r.fineWaived, 0)),
      finesOutstanding: r2(rows.reduce((a, r) => a + r.fineOutstanding, 0)),
      overdueMonths: overdue.length, lateMonths: late.length
    };
    let record;
    if (!settled.length) record = { key: 'none', label: 'No rent due yet' };
    else if (overdue.length) record = { key: 'arrears', label: 'Arrears outstanding' };
    else if (late.length) record = { key: 'late', label: 'Paid in full, ' + late.length + ' late' };
    else record = { key: 'clean', label: 'Paid in full and on time' };
    return { rows, summary, record };
  }

  function waterfall(members, payments, expenses, settings, today, other) {
    other = other || [];
    const active = members.filter(m => m.active);
    const fixed = active.filter(m => m.share_type === 'fixed');
    const equal = active.filter(m => m.share_type === 'equal');
    const firstPay = [...payments.map(p => ({ received_on: p.received_on })), ...other.map(o => ({ received_on: o.date }))].reduce((a, p) => minS(a, monthKey(p.received_on)), '9999-12');
    const startK = minS(monthKey(settings.tracking_start), firstPay);
    const endK = monthKey(today);
    const carry = {}; fixed.forEach(m => (carry[m.id] = 0));
    let deficit = 0;
    const months = [];
    for (const k of (startK <= endK ? monthsBetween(startK, endK) : [])) {
      const mp = payments.filter(p => monthKey(p.received_on) === k);
      const rent = mp.reduce((a, p) => a + +p.rent_amount, 0);
      const fines = mp.reduce((a, p) => a + +p.fine_amount, 0);
      const oth = other.filter(o => monthKey(o.date) === k).reduce((a, o) => a + +o.amount, 0);
      const exp = expenses.filter(e => monthKey(e.spent_on) === k).reduce((a, e) => a + +e.amount, 0);
      const net = rent + fines + oth - exp;
      let pool = net - deficit; deficit = 0;
      if (pool < 0) { deficit = -pool; pool = 0; }
      const shares = {};
      for (const m of fixed) {
        const due = +settings.fixed_amount + carry[m.id];
        const pay = Math.min(due, pool);
        shares[m.id] = r2(pay); carry[m.id] = r2(due - pay); pool -= pay;
      }
      const each = equal.length ? pool / equal.length : 0;
      for (const m of equal) shares[m.id] = r2(each);
      months.push({
        month: k, inProgress: k === endK, rent: r2(rent), fines: r2(fines), other: r2(oth), expenses: r2(exp), net: r2(net),
        shares, perSibling: r2(each), fixedShortfall: Object.values(carry).reduce((a, b) => a + b, 0), deficitCarried: r2(deficit)
      });
    }
    return { months, fixedIds: fixed.map(m => m.id), equalIds: equal.map(m => m.id) };
  }

  function memberStatement(member, wf, distributions) {
    const mine = distributions.filter(d => d.member_id === member.id);
    let bal = 0;
    const rows = wf.months.map(m => {
      const ent = m.shares[member.id] || 0;
      const paid = mine.filter(d => monthKey(d.for_month) === m.month);
      const paidAmt = r2(paid.reduce((a, d) => a + +d.amount, 0));
      bal = r2(bal + ent - paidAmt);
      return { month: m.month, inProgress: m.inProgress, buildingNet: m.net, entitlement: ent, paid: paidAmt, payouts: paid, balance: bal };
    });
    const entitled = r2(rows.reduce((a, r) => a + r.entitlement, 0));
    const paid = r2(mine.reduce((a, d) => a + +d.amount, 0));
    return { rows, entitled, paid, balance: r2(entitled - paid) };
  }

  const api = { r2, monthKey, fineIfPaidOn, depositSummary, addMonths, monthsBetween, daysBetween, addDays, fineFor, leaseStatus, leaseSchedule, waterfall, memberStatement };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Calc = api;
})(typeof window !== 'undefined' ? window : globalThis);
