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

// 出账计费：城市解析与运单页、单条计费走同一套口径（zones.resolveCity，别名先归到正式城市再定分区）。
// 同一账期同一客户的运单按分区分组，每组内合起来算一次首重续重，再按各自的计费重量分摊。
// 只要有运单的收件城市未归属分区，整张账单不出，把这几条运单明确列出来。
function priceBill(data, customer, waybills) {
  const settings = pricing.settingsOf(data);
  const permille = pricing.discountPermilleOf(customer);
  if (waybills.length === 0) return { lines: [], amountYuan: 0, permille };
  const resolvedList = waybills.map((waybill) => ({ waybill, resolved: zones.resolveCity(data, waybill.toCity) }));
  const unzoned = resolvedList.filter((item) => !item.resolved.zone);
  if (unzoned.length > 0) {
    throw badRequest(
      'BILL_ZONE_UNKNOWN',
      '有 ' + unzoned.length + ' 条运单的收件城市未归属分区，不能出账：' +
        unzoned.map((item) => item.waybill.code + '（' + item.waybill.toCity + '）').join('、') +
        '。请先在分区里登记这些城市或别名。',
      { waybills: unzoned.map((item) => ({ id: item.waybill.id, code: item.waybill.code, toCity: item.waybill.toCity })) }
    );
  }
  const weights = resolvedList.map((item) => pricing.billableWeightKg(item.waybill, settings));
  const groups = new Map();
  resolvedList.forEach((item, index) => {
    const zoneId = item.resolved.zone.id;
    if (!groups.has(zoneId)) groups.set(zoneId, { zone: item.resolved.zone, entries: [] });
    groups.get(zoneId).entries.push({ index, weight: weights[index] });
  });
  const freightOf = new Array(waybills.length).fill(0);
  let freightAll = 0;
  groups.forEach((group) => {
    const totalWeight = group.entries.reduce((sum, entry) => sum + entry.weight, 0);
    const groupFreight = pricing.freightYuan(group.zone, totalWeight, settings);
    freightAll += groupFreight;
    group.entries.forEach((entry) => {
      freightOf[entry.index] = totalWeight > 0 ? (groupFreight * entry.weight) / totalWeight : 0;
    });
  });
  const surchargeOf = resolvedList.map((item, index) => pricing.surchargeYuan(item.resolved.zone, item.waybill, weights[index], settings));
  const surchargeAll = surchargeOf.reduce((sum, value) => sum + value, 0);
  const grossAll = freightAll + surchargeAll;
  const amountYuan = (grossAll * permille) / 1000;
  const lines = resolvedList.map((item, index) => {
    const raw = ((freightOf[index] + surchargeOf[index]) * permille) / 1000;
    const cached = Number(item.waybill.quoteCacheYuan);
    const amount = cached > 0 ? cached : pricing.roundFen(raw);
    return {
      waybillId: item.waybill.id,
      code: item.waybill.code,
      toCity: item.waybill.toCity,
      resolvedCity: item.resolved.city,
      zoneId: item.resolved.zone.id,
      zoneName: item.resolved.zone.name,
      billableKg: weights[index],
      amountYuan: amount,
      fromCache: cached > 0,
    };
  });
  return { lines, amountYuan, permille };
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
