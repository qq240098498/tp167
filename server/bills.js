const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const pricing = require('./pricing');
const zones = require('./zones');
const { findCustomer } = require('./customers');

// 账期：按运单创建时刻的年月
function periodOf(waybill) {
  const date = new Date(String(waybill.createdAt || ''));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 7);
}

function candidateWaybills(data, period, customerId) {
  return data.waybills.filter((waybill) => waybill.customerId === customerId && periodOf(waybill) === period);
}

// 出账计费：分区归属走 zones 模块的统一口径（别名先归到正式城市再定分区）。
// 认不出分区的运单按「未归属」处理，直接挡住出账并把城市列出来，不再默算到某个分区。
// 其余运单按分区分组，组内合起来算一次首重续重，再按各自的计费重量分摊。
function priceBill(data, customer, waybills) {
  const settings = pricing.settingsOf(data);
  const permille = pricing.discountPermilleOf(customer);
  if (waybills.length === 0) return { lines: [], amountYuan: 0, permille };
  const routed = waybills.map((waybill) => ({
    waybill,
    zone: zones.zoneOfCity(data, waybill.toCity),
    resolvedCity: zones.resolveCity(data, waybill.toCity) || '',
  }));
  const unknown = routed.filter((item) => !item.zone);
  if (unknown.length > 0) {
    const cities = Array.from(new Set(unknown.map((item) => item.waybill.toCity)));
    throw badRequest(
      'BILL_ZONE_UNKNOWN',
      '有 ' + unknown.length + ' 条运单的收件城市没有归属到任何分区（' + cities.join('、') + '），先在分区里登记这些城市或配置别名，再重新出账',
      { count: unknown.length, cities, waybillCodes: unknown.map((item) => item.waybill.code) }
    );
  }
  const groups = [];
  routed.forEach((item) => {
    let group = groups.find((entry) => entry.zone.id === item.zone.id);
    if (!group) {
      group = { zone: item.zone, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  });
  const lineByWaybillId = new Map();
  let amountYuan = 0;
  groups.forEach((group) => {
    const zone = group.zone;
    const weights = group.items.map((item) => pricing.billableWeightKg(item.waybill, settings));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const freightAll = pricing.freightYuan(zone, totalWeight, settings);
    const surchargeAll = group.items.reduce((sum, item, index) => (
      sum + pricing.surchargeYuan(zone, item.waybill, weights[index], settings)
    ), 0);
    amountYuan += (freightAll + surchargeAll) * permille / 1000;
    group.items.forEach((item, index) => {
      const weight = weights[index];
      const share = totalWeight > 0 ? weight / totalWeight : 0;
      const raw = (freightAll * share + pricing.surchargeYuan(zone, item.waybill, weight, settings)) * permille / 1000;
      const cached = Number(item.waybill.quoteCacheYuan);
      const amount = cached > 0 ? cached : pricing.roundFen(raw);
      lineByWaybillId.set(item.waybill.id, {
        waybillId: item.waybill.id,
        code: item.waybill.code,
        toCity: item.waybill.toCity,
        resolvedCity: item.resolvedCity,
        zoneName: zone.name,
        billableKg: weight,
        amountYuan: amount,
        fromCache: cached > 0,
      });
    });
  });
  const lines = waybills.map((waybill) => lineByWaybillId.get(waybill.id));
  return { lines, amountYuan: pricing.roundFen(amountYuan), permille };
}

function summarizeBill(bill, data) {
  const customer = findCustomer(data, bill.customerId);
  const lines = Array.isArray(bill.lines) ? bill.lines : [];
  const lineSum = lines.reduce((sum, line) => sum + Number(line.amountYuan || 0), 0);
  const waybills = (bill.waybillIds || [])
    .map((id) => data.waybills.find((waybill) => waybill.id === id))
    .filter(Boolean);
  return Object.assign({}, bill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    lineSumYuan: pricing.roundFen(lineSum),
    amountText: Number(bill.amountYuan || 0).toFixed(2),
    lineSumText: pricing.roundFen(lineSum).toFixed(2),
    waybillCount: (bill.waybillIds || []).length,
    lines: lines.map((line) => Object.assign({}, line, {
      amountText: Number(line.amountYuan || 0).toFixed(2),
      billableText: Number(line.billableKg).toFixed(2) + ' kg',
    })),
    waybills: waybills.map((waybill) => ({
      id: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      weightKg: Number(waybill.weightKg),
      createdAt: waybill.createdAt,
      quoteCacheYuan: waybill.quoteCacheYuan,
    })),
  });
}

function listBills(query) {
  const data = load();
  const customerId = String((query && query.customerId) || '').trim();
  const status = String((query && query.status) || '').trim();
  let bills = data.bills.map((bill) => summarizeBill(bill, data));
  if (customerId) bills = bills.filter((bill) => bill.customerId === customerId);
  if (status) bills = bills.filter((bill) => bill.status === status);
  bills.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(b.code).localeCompare(String(a.code)));
  return {
    bills,
    total: bills.length,
    issued: bills.filter((bill) => bill.status === '已出账').length,
    voided: bills.filter((bill) => bill.status === '已作废').length,
  };
}

function findBill(data, id) {
  return data.bills.find((bill) => bill.id === id) || null;
}

function getBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  return summarizeBill(bill, data);
}

function generateBill(payload) {
  const data = load();
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const targets = candidateWaybills(data, period, customerId);
  if (targets.length === 0) throw badRequest('BILL_NO_WAYBILL', '这个账期里这个客户没有可以出账的运单', { field: 'period' });
  const priced = priceBill(data, customer, targets);
  const samePeriod = data.bills.filter((bill) => bill.period === period && bill.customerId === customerId).length;
  const bill = {
    id: nextId('bill', data.bills),
    code: 'ZD' + period.replace('-', '') + '-' + customer.code + String(samePeriod + 1).padStart(2, '0'),
    period,
    customerId,
    status: '已出账',
    createdAt: new Date().toISOString(),
    waybillIds: targets.map((waybill) => waybill.id),
    lines: priced.lines,
    amountYuan: priced.amountYuan,
    discountPermille: priced.permille,
  };
  data.bills.push(bill);
  targets.forEach((waybill) => {
    waybill.billId = bill.id;
  });
  save(data);
  return summarizeBill(bill, load());
}

function voidBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  if (bill.status === '已作废') throw badRequest('BILL_ALREADY_VOID', '这张账单已经作废了');
  bill.status = '已作废';
  bill.voidedAt = new Date().toISOString();
  save(data);
  return summarizeBill(bill, load());
}

function listPeriods() {
  const data = load();
  const periods = new Set();
  data.waybills.forEach((waybill) => {
    const period = periodOf(waybill);
    if (period) periods.add(period);
  });
  data.bills.forEach((bill) => periods.add(bill.period));
  return { periods: Array.from(periods).sort() };
}

module.exports = { listBills, getBill, generateBill, voidBill, listPeriods, periodOf, priceBill };
