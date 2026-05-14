// src/main/modules/SteamAuth.js
import SteamUser from 'steam-user'
import SteamTotp from 'steam-totp'

// EResult-коды → немедленная остановка, не повторять
export const FATAL_ERESULTS = new Set([
  SteamUser.EResult.Banned,                          // 76
  SteamUser.EResult.InvalidPassword,                 // 5
  SteamUser.EResult.RateLimitExceeded,               // 84
  SteamUser.EResult.AccountLoginDeniedNeedTwoFactor, // 65
  SteamUser.EResult.AccountDisabled,                 // 43
])

// EResult-коды → временная ошибка, можно повторить
export const RETRY_ERESULTS = new Set([
  SteamUser.EResult.TryAnotherCM,       // 92
  SteamUser.EResult.NoConnection,       // 3
  SteamUser.EResult.ServiceUnavailable, // 41
])

function makeClient(proxyUrl) {
  return new SteamUser({
    dataDirectory: null,
    autoRelogin: false,
    enablePicsCache: false,
    ...(proxyUrl && { socksProxy: proxyUrl }),
  })
}

function waitLoggedOn(client, ms = 30_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(Object.assign(new Error('Login timeout'), { code: 'ERR_LOGIN_TIMEOUT' })),
      ms
    )
    client.once('loggedOn', () => { clearTimeout(t); resolve() })
    client.once('error', err => { clearTimeout(t); reject(err) })
  })
}

/**
 * @param {object} creds - { login, password, sharedSecret, refreshToken }
 * @param {string|null} proxyUrl - 'socks5://user:pass@host:port' или null
 * @returns {Promise<{ client: SteamUser, refreshToken: string|null }>}
 */
export async function login(creds, proxyUrl) {
  if (!proxyUrl) {
    throw Object.assign(new Error('Прокси обязателен'), { code: 'ERR_NO_PROXY' })
  }

  // Попытка через refreshToken (без пароля и 2FA)
  if (creds.refreshToken) {
    const client = makeClient(proxyUrl)
    try {
      client.login({ refreshToken: creds.refreshToken })
      await waitLoggedOn(client)
      return { client, refreshToken: creds.refreshToken }
    } catch {
      client.logOff()
      client.removeAllListeners()
      // Падаем на полный логин ниже
    }
  }

  // Полный логин с паролем и 2FA
  const client = makeClient(proxyUrl)
  let newToken = null
  client.once('refreshToken', t => { newToken = t })

  const twoFactorCode = creds.sharedSecret
    ? SteamTotp.generateAuthCode(creds.sharedSecret)
    : undefined

  client.login({ accountName: creds.login, password: creds.password, twoFactorCode })
  await waitLoggedOn(client)

  return { client, refreshToken: newToken }
}
