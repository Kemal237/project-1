import accountManager from './AccountManager'
import groupManager   from './GroupManager'
import botAutomation  from './BotAutomation'
import workerManager  from './WorkerManager'

// Relative coordinates of CS2 UI elements at 640×480.
// Adjust if clicks miss — use Task 5 calibration steps from the plan.
const UI_POS = {
  FRIEND_PANEL: { rx: 0.966, ry: 0.520 },  // friend icon in right panel
  INVITE_BTN:   { rx: 0.855, ry: 0.340 },  // «Пригласить» button in popup
  ACCEPT_BTN:   { rx: 0.855, ry: 0.167 },  // ✓ accept invitation button
}

const POPUP_OPEN_MS   = 700   // wait for friend popup to open after icon click
const INVITE_SEND_MS  = 2500  // wait for invite to reach recipient
const ACCEPT_DONE_MS  = 3000  // wait for accept to register

class PartyManager {
  async gatherGroup(groupId) {
    const group = groupManager.get(groupId)
    if (!group) return { ok: false, error: 'Группа не найдена' }

    const accounts = group.accounts
    if (accounts.length < 2) return { ok: false, error: 'Нужно минимум 2 аккаунта для пати' }

    const pairs = this._splitIntoPairs(accounts)

    const hwnds = new Map()
    for (const account of accounts) {
      hwnds.set(account.id, botAutomation.getHwndForAccount(account.id))
    }

    this._emit('start', { groupId, pairs: pairs.map(p => p.map(a => a.id)) })

    const results = []
    for (const pair of pairs) {
      if (pair.length === 1) {
        results.push({ leaderId: pair[0].id, memberId: null, ok: true, solo: true })
        continue
      }
      const [leader, member] = pair
      this._emit('pair', { leaderId: leader.id, memberId: member.id, status: 'gathering' })
      try {
        await this._gatherPair(leader.id, member.id, hwnds)
        results.push({ leaderId: leader.id, memberId: member.id, ok: true })
        this._emit('pair', { leaderId: leader.id, memberId: member.id, status: 'done' })
      } catch (e) {
        results.push({ leaderId: leader.id, memberId: member.id, ok: false, error: e.message })
        this._emit('pair', { leaderId: leader.id, memberId: member.id, status: 'error', error: e.message })
      }
    }

    const allOk = results.every(r => r.ok)
    this._emit('done', { groupId, allOk, results })
    return { ok: allOk, results }
  }

  _splitIntoPairs(accounts) {
    const pairs = []
    for (let i = 0; i < accounts.length; i += 2) {
      pairs.push(accounts.slice(i, i + 2))
    }
    return pairs
  }

  async _gatherPair(leaderId, memberId, hwnds) {
    this._requireLobbyStatus(leaderId)
    this._requireLobbyStatus(memberId)

    const leaderHwnd = hwnds.get(leaderId)
    if (!leaderHwnd) throw new Error(`Нет HWND для лидера #${leaderId}`)
    const memberHwnd = hwnds.get(memberId)
    if (!memberHwnd) throw new Error(`Нет HWND для участника #${memberId}`)

    console.log(`[PartyManager] pair ${leaderId}→${memberId}: click friend panel`)
    await botAutomation.clickAt(leaderHwnd, UI_POS.FRIEND_PANEL.rx, UI_POS.FRIEND_PANEL.ry)
    await this._sleep(POPUP_OPEN_MS)

    console.log(`[PartyManager] pair ${leaderId}→${memberId}: click invite btn`)
    await botAutomation.clickAt(leaderHwnd, UI_POS.INVITE_BTN.rx, UI_POS.INVITE_BTN.ry)
    await this._sleep(INVITE_SEND_MS)

    console.log(`[PartyManager] pair ${leaderId}→${memberId}: click accept btn on member`)
    if (!await botAutomation.clickAt(memberHwnd, UI_POS.ACCEPT_BTN.rx, UI_POS.ACCEPT_BTN.ry))
      throw new Error(`Клик accept btn не прошёл для участника #${memberId}`)
    await this._sleep(ACCEPT_DONE_MS)

    console.log(`[PartyManager] pair ${leaderId}→${memberId}: done`)
  }

  _requireLobbyStatus(accountId) {
    const status = accountManager.getStatus(accountId)
    if (status !== 'cs2_lobby') {
      throw new Error(`Аккаунт #${accountId} не в cs2_lobby (статус: ${status})`)
    }
  }

  _emit(type, payload) {
    workerManager.send('party:progress', { type, ...payload })
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
  }
}

export default new PartyManager()
