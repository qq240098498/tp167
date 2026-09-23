const { badRequest, notFound } = require('./errors');
const { load, save, nextId } = require('./store');

function cleanCity(value) {
  return String(value == null ? '' : value).trim();
}

function listZones() {
  const data = load();
  return {
    zones: data.zones.map((zone) => ({
      id: zone.id,
      code: zone.code,
      name: zone.name,
      cities: zone.cities.slice(),
      aliases: Object.assign({}, zone.aliases),
      firstWeightKg: Number(zone.firstWeightKg),
      firstPriceYuan: Number(zone.firstPriceYuan),
      addUnitKg: Number(zone.addUnitKg),
      addPriceYuan: Number(zone.addPriceYuan),
      remoteFeeYuan: Number(zone.remoteFeeYuan || 0),
      status: zone.status,
      citiesText: zone.cities.join('、'),
      aliasesText: Object.keys(zone.aliases || {}).join('、'),
    })),
    total: data.zones.length,
  };
}

function findZone(data, id) {
  return data.zones.find((zone) => zone.id === id) || null;
}

// 城市归一：别名先归到正式城市。所有要定分区的地方都先过这一步，保证口径一致。
// 输入不是别名时原样返回；认不出的城市也原样返回，由 zoneOfCity 判「未归属」。
function resolveCity(data, city) {
  const target = cleanCity(city);
  if (!target) return null;
  const aliases = new Map();
  (data.zones || []).forEach((zone) => {
    Object.keys(zone.aliases || {}).forEach((alias) => {
      const key = cleanCity(alias);
      if (key && !aliases.has(key)) aliases.set(key, cleanCity(zone.aliases[alias]));
    });
  });
  const seen = new Set();
  let current = target;
  while (current && aliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = aliases.get(current);
  }
  return current || null;
}

// 城市归属：先归一到正式城市，再按各分区登记的正式城市定分区。
// 认不出来的城市返回 null（未归属），不允许拿清单里的第一个分区充数。
function zoneOfCity(data, city) {
  const canonical = resolveCity(data, city);
  if (!canonical) return null;
  return (data.zones || []).find((zone) => (zone.cities || []).map(cleanCity).includes(canonical)) || null;
}

function validateZonePayload(payload, current) {
  const next = Object.assign({}, current || {}, payload || {});
  const code = String(next.code || '').trim();
  const name = String(next.name || '').trim();
  const status = next.status === undefined ? (current ? current.status : '启用') : String(next.status).trim();
  if (!code) throw badRequest('ZONE_CODE_REQUIRED', '分区编码必填', { field: 'code' });
  if (!/^Z[0-9]{1,2}$/.test(code)) throw badRequest('ZONE_CODE_INVALID', '分区编码要用 Z 加数字，例如 Z5', { field: 'code' });
  if (!name) throw badRequest('ZONE_NAME_REQUIRED', '分区名称必填', { field: 'name' });
  if (status !== '启用' && status !== '停用') throw badRequest('ZONE_STATUS_INVALID', '分区状态只能是启用或停用', { field: 'status' });
  const firstWeightKg = Number(next.firstWeightKg);
  const firstPriceYuan = Number(next.firstPriceYuan);
  const addUnitKg = Number(next.addUnitKg);
  const addPriceYuan = Number(next.addPriceYuan);
  const remoteFeeYuan = Number(next.remoteFeeYuan === undefined ? 0 : next.remoteFeeYuan);
  if (!(firstWeightKg > 0)) throw badRequest('ZONE_FIRST_WEIGHT_INVALID', '首重必须是大于 0 的数字', { field: 'firstWeightKg' });
  if (!(firstPriceYuan >= 0)) throw badRequest('ZONE_FIRST_PRICE_INVALID', '首重价必须是不小于 0 的数字', { field: 'firstPriceYuan' });
  if (!(addUnitKg > 0)) throw badRequest('ZONE_ADD_UNIT_INVALID', '续重单位必须是大于 0 的数字', { field: 'addUnitKg' });
  if (!(addPriceYuan >= 0)) throw badRequest('ZONE_ADD_PRICE_INVALID', '续重价必须是不小于 0 的数字', { field: 'addPriceYuan' });
  if (!(remoteFeeYuan >= 0)) throw badRequest('ZONE_REMOTE_FEE_INVALID', '偏远附加必须是不小于 0 的数字', { field: 'remoteFeeYuan' });
  const cities = Array.isArray(next.cities) ? next.cities.map(cleanCity).filter(Boolean) : [];
  const aliases = {};
  const rawAliases = next.aliases && typeof next.aliases === 'object' ? next.aliases : {};
  Object.keys(rawAliases).forEach((key) => {
    const alias = cleanCity(key);
    const target = cleanCity(rawAliases[key]);
    if (!alias) return;
    if (!target) throw badRequest('ZONE_ALIAS_TARGET_REQUIRED', '别名要写明对应哪个城市：' + alias, { field: 'aliases' });
    aliases[alias] = target;
  });
  // 别名必须先归到正式城市再定分区，所以别名指向的城市要登记在本分区的覆盖城市里
  Object.keys(aliases).forEach((alias) => {
    if (!cities.includes(aliases[alias])) {
      throw badRequest('ZONE_ALIAS_TARGET_UNKNOWN', '别名 ' + alias + ' 指向的城市「' + aliases[alias] + '」不在本分区的覆盖城市里', { field: 'aliases' });
    }
  });
  return { code, name, status, firstWeightKg, firstPriceYuan, addUnitKg, addPriceYuan, remoteFeeYuan, cities, aliases };
}

// 别名不能和别的分区的别名重复，也不能和任何正式城市同名，否则同一个名字会归到两个地方
function assertAliasesUsable(data, zoneId, aliases, ownCities) {
  const keys = Object.keys(aliases);
  if (keys.length === 0) return;
  const takenCities = new Set(ownCities);
  data.zones.forEach((zone) => {
    if (zone.id === zoneId) return;
    (zone.cities || []).forEach((city) => takenCities.add(cleanCity(city)));
    const otherAliases = Object.keys(zone.aliases || {}).map(cleanCity);
    keys.forEach((alias) => {
      if (otherAliases.includes(alias)) {
        throw badRequest('ZONE_ALIAS_DUPLICATE', '别名 ' + alias + ' 已经在分区 ' + zone.code + '（' + zone.name + '）登记了', { field: 'aliases' });
      }
    });
  });
  keys.forEach((alias) => {
    if (takenCities.has(alias)) {
      throw badRequest('ZONE_ALIAS_CONFLICT', '别名 ' + alias + ' 和已登记的正式城市同名，归属会有歧义', { field: 'aliases' });
    }
  });
}

function createZone(payload) {
  const data = load();
  const clean = validateZonePayload(payload, null);
  if (data.zones.some((zone) => zone.code === clean.code)) {
    throw badRequest('ZONE_CODE_DUPLICATE', '分区编码 ' + clean.code + ' 已经存在', { field: 'code' });
  }
  assertAliasesUsable(data, null, clean.aliases, clean.cities);
  const zone = Object.assign({ id: nextId('zone', data.zones) }, clean);
  data.zones.push(zone);
  save(data);
  return zone;
}

function updateZone(id, payload) {
  const data = load();
  const current = findZone(data, id);
  if (!current) throw notFound('ZONE_NOT_FOUND', '分区不存在');
  const clean = validateZonePayload(payload, current);
  if (data.zones.some((zone) => zone.id !== id && zone.code === clean.code)) {
    throw badRequest('ZONE_CODE_DUPLICATE', '分区编码 ' + clean.code + ' 已经存在', { field: 'code' });
  }
  assertAliasesUsable(data, id, clean.aliases, clean.cities);
  Object.assign(current, clean);
  save(data);
  return current;
}

function removeZone(id) {
  const data = load();
  const current = findZone(data, id);
  if (!current) throw notFound('ZONE_NOT_FOUND', '分区不存在');
  const used = data.waybills.filter((waybill) => {
    const zone = zoneOfCity(data, waybill.toCity);
    return zone && zone.id === id;
  });
  if (used.length > 0) {
    throw badRequest('ZONE_IN_USE', '这个分区下的城市还有 ' + used.length + ' 条运单在用，先处理完再删', { count: used.length });
  }
  data.zones = data.zones.filter((zone) => zone.id !== id);
  save(data);
  return { removed: id };
}

module.exports = { listZones, findZone, resolveCity, zoneOfCity, createZone, updateZone, removeZone, cleanCity };
