// =====================================================================
//  KURALLAR & ALARMLAR – "EĞER koşul → O ZAMAN aksiyon"
//  Sunucu tarafında çalışır; kullanıcı çevrimdışıyken de tetiklenir.
// =====================================================================
import { prisma } from '../lib/prisma.js'
import { feed } from '../market/feed.js'
import { toApi, num } from '../lib/serialize.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { hub } from '../realtime/hub.js'
import { logActivity } from '../services/activity.js'
import { placeOrder, closePosition, cancelAll } from '../trading/orders.js'
import { positionMetrics } from '../trading/portfolio.js'
import { riskState, setKillSwitch } from '../trading/risk.js'
import { log } from '../lib/logger.js'

const TRIGGERS = ['price_above', 'price_below', 'change_above', 'change_below', 'position_pnl_below', 'portfolio_drawdown']
const ACTIONS = ['notify', 'market_buy', 'market_sell', 'close_position', 'cancel_orders', 'pause_exchange', 'kill_switch']
const TRADE_ACTIONS = ['market_buy', 'market_sell', 'close_position']

export const ruleToApi = (r) =>
  toApi({
    id: r.id, name: r.name, enabled: r.enabled, exchangeId: r.exchangeId, symbol: r.symbol,
    trigger: { type: r.triggerType, value: r.triggerValue },
    action: { type: r.actionType, qty: r.actionQty ?? undefined, percent: r.actionPercent ?? undefined },
    repeat: r.repeat, cooldownSec: r.cooldownSec, triggerCount: r.triggerCount, lastTriggeredAt: r.lastTriggeredAt, createdAt: r.createdAt,
  })

/** API gövdesi → veritabanı alanları (doğrulamalı) */
async function toData(userId, body) {
  if (!body.name?.trim()) throw badRequest('Kural adı gerekli')
  const t = body.trigger || {}
  const a = body.action || {}
  if (!TRIGGERS.includes(t.type)) throw badRequest('Geçersiz koşul tipi')
  if (t.value === '' || t.value === undefined || Number.isNaN(+t.value)) throw badRequest('Koşul değeri gerekli')
  if (!ACTIONS.includes(a.type)) throw badRequest('Geçersiz aksiyon')
  const portfolio = t.type === 'portfolio_drawdown'
  if (!portfolio && !feed.instrument(body.symbol)) throw badRequest('Geçerli bir sembol seçin')
  if (portfolio && TRADE_ACTIONS.includes(a.type)) throw badRequest('Portföy koşulu ile alım-satım aksiyonu kullanılamaz')
  if ([...TRADE_ACTIONS, 'pause_exchange'].includes(a.type) && !body.exchangeId) throw badRequest('Borsa hesabı seçin')
  if (body.exchangeId) {
    const ex = await prisma.exchangeAccount.findFirst({ where: { id: body.exchangeId, userId } })
    if (!ex) throw badRequest('Borsa hesabı bulunamadı')
  }
  if (a.type === 'market_buy' && !(+a.qty > 0)) throw badRequest('Alış miktarı gerekli')
  if (a.type === 'market_sell' && !(+a.percent > 0 || +a.qty > 0)) throw badRequest('Satış oranı veya miktarı gerekli')
  return {
    name: body.name.trim(),
    enabled: body.enabled ?? true,
    exchangeId: body.exchangeId || null,
    symbol: portfolio ? null : body.symbol,
    triggerType: t.type,
    triggerValue: +t.value,
    actionType: a.type,
    actionQty: a.qty ? +a.qty : null,
    actionPercent: a.percent ? Math.min(100, +a.percent) : null,
    repeat: body.repeat === 'always' ? 'always' : 'once',
    cooldownSec: body.repeat === 'always' ? Math.max(0, Math.round(+body.cooldownSec || 0)) : 0,
  }
}

async function checkLimit(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { plan: true } })
  const used = await prisma.rule.count({ where: { userId } })
  if (u.plan.maxRules !== -1 && used >= u.plan.maxRules) throw forbidden(`${u.plan.name} planı en fazla ${u.plan.maxRules} kural oluşturmaya izin veriyor`, 'PLAN_LIMIT')
}

export async function listRules(userId) {
  return (await prisma.rule.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })).map(ruleToApi)
}

export async function createRule(userId, body) {
  await checkLimit(userId)
  const r = await prisma.rule.create({ data: { userId, ...(await toData(userId, body)) } })
  await logActivity(userId, { message: `Yeni kural oluşturuldu: ${r.name}`, ruleId: r.id })
  hub.toUser(userId, 'rules')
  return ruleToApi(r)
}

export async function updateRule(userId, id, body) {
  const r = await prisma.rule.findFirst({ where: { id, userId } })
  if (!r) throw notFound('Kural bulunamadı')
  const merged = { ...ruleToApi(r), ...body, trigger: { ...ruleToApi(r).trigger, ...(body.trigger || {}) }, action: body.action ? body.action : ruleToApi(r).action }
  const u = await prisma.rule.update({ where: { id }, data: await toData(userId, merged) })
  armed.delete(id)
  hub.toUser(userId, 'rules')
  return ruleToApi(u)
}

export async function deleteRule(userId, id) {
  const r = await prisma.rule.findFirst({ where: { id, userId } })
  if (!r) throw notFound('Kural bulunamadı')
  await prisma.rule.delete({ where: { id } })
  hub.toUser(userId, 'rules')
  return { ok: true }
}

// ------------------------------------------------------------------ motor
const armed = new Map()
const condText = (r) =>
  ({
    price_above: `≥ ${r.triggerValue}`,
    price_below: `≤ ${r.triggerValue}`,
    change_above: `24s değişim ≥ %${r.triggerValue}`,
    change_below: `24s değişim ≤ %${r.triggerValue}`,
    position_pnl_below: `pozisyon K/Z ≤ %${r.triggerValue}`,
    portfolio_drawdown: `günlük K/Z ≤ %${r.triggerValue}`,
  })[r.triggerType]

async function evaluate(r, drawdownCache) {
  if (r.triggerType === 'portfolio_drawdown') {
    if (!drawdownCache.has(r.userId)) drawdownCache.set(r.userId, (await riskState(r.userId)).state.dayPnlPct)
    return drawdownCache.get(r.userId) <= r.triggerValue
  }
  const t = feed.ticker(r.symbol)
  if (!t) return null
  switch (r.triggerType) {
    case 'price_above':
      return t.last >= r.triggerValue
    case 'price_below':
      return t.last <= r.triggerValue
    case 'change_above':
      return t.changePct >= r.triggerValue
    case 'change_below':
      return t.changePct <= r.triggerValue
    case 'position_pnl_below': {
      const pos = await prisma.position.findFirst({ where: { userId: r.userId, symbol: r.symbol, ...(r.exchangeId ? { exchangeId: r.exchangeId } : {}) } })
      return pos ? positionMetrics(pos).pnlPct <= r.triggerValue : null
    }
    default:
      return null
  }
}

async function run(r) {
  await prisma.rule.update({
    where: { id: r.id },
    data: { triggerCount: { increment: 1 }, lastTriggeredAt: new Date(), ...(r.repeat === 'once' ? { enabled: false } : {}) },
  })
  const tag = { exchangeId: r.exchangeId, symbol: r.symbol, ruleId: r.id }
  try {
    switch (r.actionType) {
      case 'notify':
        await logActivity(r.userId, { level: 'warning', source: 'rule', notify: true, ...tag, message: `${r.name}: koşul gerçekleşti (${r.symbol || 'portföy'} ${condText(r)})` })
        break
      case 'market_buy':
        await placeOrder(r.userId, { exchangeId: r.exchangeId, symbol: r.symbol, side: 'buy', type: 'market', qty: r.actionQty }, { source: 'rule', ruleId: r.id, silent: true })
        await logActivity(r.userId, { level: 'success', source: 'rule', notify: true, ...tag, message: `${r.name}: ${r.actionQty} ${r.symbol} alındı` })
        break
      case 'market_sell':
      case 'close_position': {
        const pos = await prisma.position.findFirst({ where: { userId: r.userId, exchangeId: r.exchangeId, symbol: r.symbol } })
        if (!pos) throw new Error('kapatılacak pozisyon bulunamadı')
        const pct = r.actionType === 'close_position' ? 100 : r.actionPercent ?? Math.min(100, ((r.actionQty || 0) / num(pos.qty)) * 100)
        const risk = await prisma.riskSettings.findUnique({ where: { userId: r.userId } })
        if (risk?.killSwitchActive) throw new Error('acil durdurma aktif olduğu için işlem yapılmadı')
        await closePosition(r.userId, pos.id, pct, 'rule')
        await logActivity(r.userId, { level: 'success', source: 'rule', notify: true, ...tag, message: `${r.name}: ${r.symbol} pozisyonunun %${Math.round(pct)}'i kapatıldı` })
        break
      }
      case 'cancel_orders':
        await cancelAll(r.userId, { exchangeId: r.exchangeId || undefined, symbol: r.symbol || undefined }, 'rule')
        await logActivity(r.userId, { level: 'warning', source: 'rule', notify: true, ...tag, message: `${r.name}: açık emirler iptal edildi` })
        break
      case 'pause_exchange':
        await prisma.exchangeAccount.update({ where: { id: r.exchangeId }, data: { paused: true } })
        await prisma.bot.updateMany({ where: { exchangeId: r.exchangeId, status: 'running' }, data: { status: 'paused' } })
        await logActivity(r.userId, { level: 'warning', source: 'rule', notify: true, ...tag, message: `${r.name}: hesap duraklatıldı` })
        hub.toUser(r.userId, 'exchanges')
        hub.toUser(r.userId, 'bots')
        break
      case 'kill_switch':
        await setKillSwitch(r.userId, { active: true, reason: `Kural: ${r.name}`, cancelOrders: true }, 'rule')
        break
      default:
        break
    }
  } catch (e) {
    await logActivity(r.userId, { level: 'danger', source: 'rule', notify: true, ...tag, message: `${r.name} çalıştırılamadı: ${e.message}` })
  }
  hub.toUser(r.userId, 'rules')
}

let busy = false
export async function processRules() {
  if (busy) return
  busy = true
  try {
    const rules = await prisma.rule.findMany({ where: { enabled: true, user: { status: { in: ['active', 'trading_halted'] } } } })
    const drawdown = new Map()
    for (const r of rules) {
      const cond = await evaluate(r, drawdown)
      if (cond === null) continue
      const isArmed = armed.has(r.id) ? armed.get(r.id) : true
      if (!cond) {
        armed.set(r.id, true)
        continue
      }
      if (!isArmed) continue
      if (r.lastTriggeredAt && r.cooldownSec && Date.now() - r.lastTriggeredAt.getTime() < r.cooldownSec * 1000) continue
      armed.set(r.id, false)
      await run(r)
    }
  } catch (e) {
    log.error({ err: e }, 'kural motoru hatası')
  } finally {
    busy = false
  }
}
