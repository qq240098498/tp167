// 城市归一与出账分区口径的回归测试
// 背景：出账曾经按城市名字面比对、比不到就回退到分区清单第一个（同城），
// 别名运单（如「云岭高新区」）被静默按同城计价。这些测试锁住修复后的口径。
const test = require('node:test');
const assert = require('node:assert/strict');
const zones = require('../server/zones');
const bills = require('../server/bills');

function fixture() {
  return {
    settings: {},
    zones: [
      { id: 'zone-0001', code: 'Z1', name: '同城', cities: ['江城', '海陵'], aliases: { 江城城区: '江城' }, firstWeightKg: 1, firstPriceYuan: 8, addUnitKg: 0.5, addPriceYuan: 1.5, remoteFeeYuan: 0, status: '启用' },
      { id: 'zone-0002', code: 'Z2', name: '省内', cities: ['云岭'], aliases: { 云岭高新区: '云岭' }, firstWeightKg: 1, firstPriceYuan: 10, addUnitKg: 0.5, addPriceYuan: 2, remoteFeeYuan: 0, status: '启用' },
    ],
    customers: [],
    waybills: [],
    bills: [],
  };
}

function waybill(id, toCity, extra) {
  return Object.assign({
    id,
    code: 'YD20260800000',
    customerId: 'cust-1',
    fromCity: '江城',
    toCity,
    weightKg: 1,
    volumeM3: 0.001,
    pieces: 1,
    insuredAmountYuan: 0,
    services: [],
    status: '已签收',
    createdAt: '2026-08-05T09:15:00+08:00',
    billId: null,
    quoteCacheYuan: null,
  }, extra || {});
}

const customer = { id: 'cust-1', code: 'C01', name: '测试客户', settle: '月结', discountPermille: 1000 };

test('别名先归到正式城市', () => {
  const data = fixture();
  assert.equal(zones.resolveCity(data, '云岭高新区'), '云岭');
  assert.equal(zones.resolveCity(data, '江城城区'), '江城');
  assert.equal(zones.resolveCity(data, '云岭'), '云岭');
  assert.equal(zones.resolveCity(data, ' 云岭高新区 '), '云岭');
});

test('别名链能归到正式城市，循环别名不会死循环', () => {
  const data = fixture();
  data.zones[0].aliases = { 甲: '乙' };
  data.zones[1].aliases = { 乙: '云岭' };
  assert.equal(zones.resolveCity(data, '甲'), '云岭');
  data.zones[0].aliases = { 甲: '乙' };
  data.zones[1].aliases = { 乙: '甲' };
  assert.equal(zones.resolveCity(data, '甲'), '甲');
});

test('分区归属：别名城市归到正式城市所在的分区', () => {
  const data = fixture();
  assert.equal(zones.zoneOfCity(data, '云岭高新区').id, 'zone-0002');
  assert.equal(zones.zoneOfCity(data, '云岭高新区').name, '省内');
  assert.equal(zones.zoneOfCity(data, '江城城区').id, 'zone-0001');
  assert.equal(zones.zoneOfCity(data, '海陵').id, 'zone-0001');
});

test('认不出的城市是未归属，不会回退到第一个分区', () => {
  const data = fixture();
  assert.equal(zones.zoneOfCity(data, '火星城'), null);
  assert.equal(zones.zoneOfCity(data, ''), null);
  assert.equal(zones.zoneOfCity(data, null), null);
  assert.equal(zones.zoneOfCity(data, undefined), null);
});

test('出账按每条运单的真实分区计价，别名运单不再按同城算', () => {
  const data = fixture();
  const list = [
    waybill('wb-1', '云岭高新区', { weightKg: 2.4, volumeM3: 0.008 }), // 2.5kg → 省内 10 + 3×2 = 16
    waybill('wb-2', '江城'),                                          // 1kg   → 同城首重 8
  ];
  const priced = bills.priceBill(data, customer, list);
  assert.equal(priced.lines.length, 2);
  assert.equal(priced.lines[0].waybillId, 'wb-1');
  assert.equal(priced.lines[0].zoneName, '省内');
  assert.equal(priced.lines[0].resolvedCity, '云岭');
  assert.equal(priced.lines[0].amountYuan, 16);
  assert.equal(priced.lines[1].zoneName, '同城');
  assert.equal(priced.lines[1].amountYuan, 8);
  assert.equal(priced.amountYuan, 24);
});

test('同一分区的运单仍然合算一次首重续重', () => {
  const data = fixture();
  const list = [waybill('wb-1', '江城'), waybill('wb-2', '海陵')]; // 各 1kg，同城合 2kg：8 + 2×1.5 = 11
  const priced = bills.priceBill(data, customer, list);
  assert.equal(priced.amountYuan, 11);
  assert.deepEqual(priced.lines.map((line) => line.amountYuan), [5.5, 5.5]);
});

test('运单上缓存的计费结果优先沿用', () => {
  const data = fixture();
  const list = [waybill('wb-1', '云岭高新区', { quoteCacheYuan: 15.2 })];
  const priced = bills.priceBill(data, customer, list);
  assert.equal(priced.lines[0].amountYuan, 15.2);
  assert.equal(priced.lines[0].fromCache, true);
  assert.equal(priced.lines[0].zoneName, '省内');
});

test('有未归属城市的运单时挡住出账，并把城市与运单列出来', () => {
  const data = fixture();
  const list = [
    waybill('wb-1', '云岭高新区'),
    waybill('wb-2', '火星城', { code: 'YD20260800009' }),
  ];
  assert.throws(
    () => bills.priceBill(data, customer, list),
    (err) => {
      assert.equal(err.code, 'BILL_ZONE_UNKNOWN');
      assert.match(err.message, /火星城/);
      assert.deepEqual(err.details.cities, ['火星城']);
      assert.deepEqual(err.details.waybillCodes, ['YD20260800009']);
      return true;
    }
  );
});
