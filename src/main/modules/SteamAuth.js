import SteamUser from 'steam-user'
import SteamTotp from 'steam-totp'

export const FATAL_ERESULTS = new Set([
  SteamUser.EResult.Banned,
  SteamUser.EResult.InvalidPassword,
  SteamUser.EResult.RateLimitExceeded,
  SteamUser.EResult.AccountLoginDeniedNeedTwoFactor,
  SteamUser.EResult.AccountDisabled,
])

export const RETRY_ERESULTS = new Set([
  SteamUser.EResult.TryAnotherCM,
  SteamUser.EResult.NoConnection,
  SteamUser.EResult.ServiceUnavailable,
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
      () => {
        client.removeListener('loggedOn', onLogged)
        client.removeListener('error', onError)
        reject(Object.assign(new Error('Login timeout'), { code: 'ERR_LOGIN_TIMEOUT' }))
      },
      ms
    )
    function onLogged() {
      clearTimeout(t)
      client.removeListener('error', onError)
      resolve()
    }
    function onError(err) {
      clearTimeout(t)
      client.removeListener('loggedOn', onLogged)
      reject(err)
    }
    client.once('loggedOn', onLogged)
    client.once('error', onError)
  })
}

export async function login(creds, proxyUrl, { onSteamGuard, onLicenses } = {}) {
  if (!proxyUrl) {
    throw Object.assign(new Error('Прокси обязателен'), { code: 'ERR_NO_PROXY' })
  }

  if (creds.refreshToken) {
    const client = makeClient(proxyUrl)
    // Регистрируем licenses ДО logOn — иначе событие придёт раньше чем _setupClientEvents
    // Передаём client явно чтобы избежать TDZ в замыкании вызывающего кода
    if (onLicenses) client.once('licenses', (licenses) => onLicenses(licenses, client))
    try {
      const p = waitLoggedOn(client)
      client.logOn({ refreshToken: creds.refreshToken })
      await p
      return { client, refreshToken: creds.refreshToken }
    } catch (err) {
      client.logOff()
      client.removeAllListeners()
      if (FATAL_ERESULTS.has(err.eresult)) throw err
      // Временная ошибка — падаем на полный логин
    }
  }

  const client = makeClient(proxyUrl)
  let newToken = null
  client.once('refreshToken', t => { newToken = t })

  // Регистрируем licenses ДО logOn — race condition fix
  if (onLicenses) client.once('licenses', (licenses) => onLicenses(licenses, client))

  if (onSteamGuard) {
    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      onSteamGuard(domain, callback, lastCodeWrong)
    })
  }

  try {
    const twoFactorCode = creds.sharedSecret
      ? SteamTotp.generateAuthCode(creds.sharedSecret)
      : undefined

    // Если есть обработчик Steam Guard — ждём до 10 минут (пользователь вводит код вручную)
    const p = waitLoggedOn(client, onSteamGuard ? 600_000 : 30_000)
    client.logOn({ accountName: creds.login, password: creds.password, twoFactorCode })
    await p
  } catch (err) {
    client.logOff()
    client.removeAllListeners()
    throw err
  }

  return { client, refreshToken: newToken }
}
