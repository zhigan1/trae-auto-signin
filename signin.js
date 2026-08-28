/**
 * trae-auto-signin — TRAE SOLO CN 每日签到积分自动领取（支持多人多账号）
 *
 * 零依赖 · 纯 Node.js 标准库 · 跨平台 · 幂等安全 · 多账号批量处理 · 严格失败拦截
 *
 * 命令：
 *   node signin.js auto     每日自动化：全账号签到（默认）
 *   node signin.js status   查询全账号签到状态（调试用）
 *   node signin.js claim    直接领取全账号签到奖励（调试用）
 *   node signin.js refresh  刷新全账号 Token（调试用，需先关闭 Trae）
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

// ============================================================
// 配置常量
// ============================================================

const CONFIG = {
  apiHost: 'api.trae.cn',
  clientId: 'en1oxy7wnw8j9n',
  appVersion: '1.107.1',
  defaultStoragePath: (() => {
    if (process.env.APPDATA) {
      return path.join(process.env.APPDATA, 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json');
    }
    return path.join(os.homedir(), '.config', 'TRAE SOLO CN', 'storage.json');
  })(),
};

// ============================================================
// 加密常量（从 Trae 客户端 main.js 逆向提取）
// ============================================================

const PEPPER_AES_URE = [82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37];
const PEPPER_AES_DRE = [31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125];
const PEPPER_PRIV_CRE = [191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209];
const PEPPER_PRIV_LRE = [246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170];

const HEADER_AES = [116, 99, 5, 16, 0, 0];
const HEADER_AES_PRIV = [18, 57, 18, 32, 2, 3];

// ============================================================
// 解密（byteCrypto 信封格式：6B 头 + 32B 随机数 + AES-128-CBC 载荷）
// ============================================================

function sha512(data) {
  return crypto.createHash('sha512').update(data).digest();
}

function getPepper(isPrivate) {
  const a = isPrivate ? PEPPER_PRIV_CRE : PEPPER_AES_URE;
  const b = isPrivate ? PEPPER_PRIV_LRE : PEPPER_AES_DRE;
  const out = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) out[i] = a[i] ^ b[i];
  return out;
}

async function decryptBlob(blobBase64) {
  if (!blobBase64 || typeof blobBase64 !== 'string') {
    throw new Error('无效的加密数据');
  }
  const blob = Buffer.from(blobBase64, 'base64');

  const isPrivate = HEADER_AES_PRIV.every((v, i) => blob[i] === v);
  const isAES = HEADER_AES.every((v, i) => blob[i] === v);

  if (!isPrivate && !isAES) {
    const text = blob.toString('utf8');
    if (text.startsWith('{') || text.startsWith('[')) return text;
    throw new Error('未知加密格式 header=' + Array.from(blob.slice(0, 6)).join(','));
  }

  const random = blob.slice(6, 38);
  const ciphertext = blob.slice(38);

  const pepper = getPepper(isPrivate);
  const n = Buffer.concat([sha512(random), pepper]);
  const c = sha512(n);

  const decipher = crypto.createDecipheriv('aes-128-cbc', c.slice(0, 16), c.slice(16, 32));
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  const tag = decrypted.slice(0, 64);
  const body = decrypted.slice(64);
  if (!tag.equals(sha512(body))) throw new Error('完整性校验失败（SHA-512 不匹配）');

  return body.toString('utf8');
}

// ============================================================
// 设备 ID 解析（风控关键：必须是 16 位数字 Aha 设备号，非 UUID）
// ============================================================

function extractDeviceId(storage) {
  if (storage && typeof storage === 'object') {
    for (const key of Object.keys(storage)) {
      if (key.startsWith('iCubeAuthInfo://icube-dc:')) {
        const id = key.replace('iCubeAuthInfo://icube-dc:', '').trim();
        if (/^\d{8,20}$/.test(id)) return id;
      }
    }
  }
  // 若未找到，生成一个随机 16 位十进制 Aha 设备号，避免 UUID 触发 9074
  return String(Math.floor(1000000000000000 + Math.random() * 9000000000000000));
}

// ============================================================
// HTTP 请求封装
// ============================================================

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// 多账号凭证加载
// ============================================================

function findDeviceKeyPair(creds) {
  for (const [key, value] of Object.entries(creds)) {
    if (key.includes('icube-dc') && value && value.privateKeyPEM) return value;
  }
  return null;
}

function maskAccount(authInfo, index) {
  if (!authInfo) return `账号#${index}`;
  const account = typeof authInfo.account === 'object'
    ? (authInfo.account?.username || authInfo.userId)
    : authInfo.userId;
  if (!account) return `账号#${index}`;
  const str = String(account);
  return str.length > 4 ? str.substring(0, 3) + '***' + str.slice(-2) : str.substring(0, 2) + '***';
}

/** 解析单个 storage 对象的认证凭证 */
async function parseAccountFromStorage(storage, sourceLabel, index) {
  if (!storage || typeof storage !== 'object') {
    return {
      index,
      source: sourceLabel,
      name: `账号#${index}`,
      loadError: `[${sourceLabel}] 无效的凭据数据格式`,
    };
  }

  try {
    const creds = {};
    for (const [key, value] of Object.entries(storage)) {
      if (!key.startsWith('iCubeAuthInfo://')) continue;
      try {
        creds[key] = JSON.parse(await decryptBlob(value));
      } catch {
        creds[key] = null;
      }
    }

    const authInfo = creds['iCubeAuthInfo://icube.cloudide'];
    if (!authInfo || !authInfo.token) {
      return {
        index,
        source: sourceLabel,
        name: `账号#${index}`,
        loadError: `NO_AUTH [${sourceLabel}] 凭证解密失败或未登录，请先登录 Trae 客户端`,
      };
    }

    const deviceId = extractDeviceId(storage);
    const deviceCreds = findDeviceKeyPair(creds);
    const accountName = maskAccount(authInfo, index);

    return {
      index,
      source: sourceLabel,
      name: accountName,
      authInfo,
      deviceCreds,
      deviceId,
      loadError: null,
    };
  } catch (err) {
    return {
      index,
      source: sourceLabel,
      name: `账号#${index}`,
      loadError: `[${sourceLabel}] 凭证解析失败: ${err.message}`,
    };
  }
}

/** 智能加载所有账号凭证（支持单账号、多行 Base64、JSON 数组、多环境变量、多文件） */
async function loadAllAccounts() {
  const rawStorages = [];

  // 1. 检查环境变量 TRAE_CREDENTIALS_BASE64
  if (process.env.TRAE_CREDENTIALS_BASE64) {
    const rawVal = process.env.TRAE_CREDENTIALS_BASE64.trim();
    // 尝试解析为 JSON 数组
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      try {
        const arr = JSON.parse(rawVal);
        arr.forEach((item, idx) => {
          if (typeof item === 'string') {
            try {
              const decoded = Buffer.from(item.trim(), 'base64').toString('utf8');
              rawStorages.push({ data: JSON.parse(decoded), label: `Secret_Array[${idx + 1}]` });
            } catch {
              rawStorages.push({ data: JSON.parse(item), label: `Secret_Array[${idx + 1}]` });
            }
          } else if (typeof item === 'object') {
            rawStorages.push({ data: item, label: `Secret_Array[${idx + 1}]` });
          }
        });
      } catch (e) {
        // 解析数组失败，按普通字符串处理
      }
    }

    if (rawStorages.length === 0) {
      // 尝试按换行拆分多个 Base64（多账号）
      const lines = rawVal.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
      lines.forEach((line, idx) => {
        try {
          const decoded = Buffer.from(line, 'base64').toString('utf8');
          rawStorages.push({ data: JSON.parse(decoded), label: `Secret_Line_${idx + 1}` });
        } catch {
          try {
            rawStorages.push({ data: JSON.parse(line), label: `Secret_Line_${idx + 1}` });
          } catch {
            rawStorages.push({ data: null, label: `Secret_Line_${idx + 1}` });
          }
        }
      });
    }
  }

  // 2. 检查多环境变量 TRAE_CREDENTIALS_BASE64_1, TRAE_CREDENTIALS_BASE64_2, ...
  for (let i = 1; i <= 20; i++) {
    const envKey = `TRAE_CREDENTIALS_BASE64_${i}`;
    if (process.env[envKey]) {
      const val = process.env[envKey].trim();
      try {
        const decoded = Buffer.from(val, 'base64').toString('utf8');
        rawStorages.push({ data: JSON.parse(decoded), label: envKey });
      } catch {
        try {
          rawStorages.push({ data: JSON.parse(val), label: envKey });
        } catch {
          rawStorages.push({ data: null, label: envKey });
        }
      }
    }
  }

  // 3. 检查环境变量 TRAE_STORAGE_DIR（本地多账号目录）
  if (process.env.TRAE_STORAGE_DIR && fs.existsSync(process.env.TRAE_STORAGE_DIR)) {
    const dir = process.env.TRAE_STORAGE_DIR;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        rawStorages.push({ data: JSON.parse(content), label: f });
      } catch {
        rawStorages.push({ data: null, label: f });
      }
    }
  }

  // 4. 检查环境变量 TRAE_STORAGE_JSON（可逗号/分号分隔多个路径）
  if (process.env.TRAE_STORAGE_JSON) {
    const paths = process.env.TRAE_STORAGE_JSON.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    for (const p of paths) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          rawStorages.push({ data: JSON.parse(content), label: path.basename(p) });
        } catch {
          rawStorages.push({ data: null, label: path.basename(p) });
        }
      } else {
        rawStorages.push({ data: null, label: path.basename(p) });
      }
    }
  }

  // 5. 默认回退到本地单账号存储
  if (rawStorages.length === 0) {
    if (fs.existsSync(CONFIG.defaultStoragePath)) {
      try {
        const content = fs.readFileSync(CONFIG.defaultStoragePath, 'utf8');
        rawStorages.push({ data: JSON.parse(content), label: 'LocalDefault' });
      } catch (e) {
        throw new Error(`NO_STORAGE 本地凭据文件读取失败: ${e.message}`);
      }
    } else {
      throw new Error(`NO_STORAGE 未找到凭证文件，请先在本地登录 Trae 客户端或配置 TRAE_CREDENTIALS_BASE64 Secret`);
    }
  }

  // 解析并构建账号列表
  const accounts = [];
  for (let i = 0; i < rawStorages.length; i++) {
    const { data, label } = rawStorages[i];
    const acc = await parseAccountFromStorage(data, label, i + 1);
    accounts.push(acc);
  }

  return accounts;
}

// ============================================================
// 设备证明签名与 Token 刷新
// ============================================================

function signDeviceProof(method, apiPath, refreshToken, deviceCreds, timestamp, nonce) {
  const content = [method, apiPath, CONFIG.clientId, refreshToken, String(timestamp), nonce].join('\n');
  return crypto.createSign('SHA256').update(content).end().sign(deviceCreds.privateKeyPEM, 'base64');
}

async function exchangeToken(authInfo, deviceCreds, deviceId) {
  if (!deviceCreds) throw new Error('NO_DEVICE_KEY 未找到设备密钥对');

  const apiPath = '/trae/api/v3/oauth/ExchangeToken';
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signDeviceProof('POST', apiPath, authInfo.refreshToken, deviceCreds, timestamp, nonce);

  const res = await request(`https://${CONFIG.apiHost}${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cloudide-token': '',
      'User-Agent': `Trae/${CONFIG.appVersion}`,
    },
    body: JSON.stringify({
      ClientID: CONFIG.clientId,
      ClientSecret: '',
      RefreshToken: authInfo.refreshToken,
      DeviceInfo: {
        DeviceID: deviceId,
        PlatformCode: 'SOLO_PC',
        DeviceType: 'PC',
        DeviceName: os.hostname(),
        DeviceModel: '',
        ClientVersion: CONFIG.appVersion,
        DevicePublicKey: deviceCreds.publicKeyPEM || '',
        OSInfo: 'Windows',
        OSVersion: os.release(),
      },
      DeviceProof: { Signature: signature, Timestamp: timestamp, Nonce: nonce },
      IDEVersion: CONFIG.appVersion,
    }),
  });

  if (res.status !== 200) {
    const errCode = (() => { try { return JSON.parse(res.body)?.ResponseMetadata?.Error?.Message || res.body.slice(0, 120); } catch { return res.body.slice(0, 120); } })();
    throw new Error(`REFRESH_FAIL Token 刷新失败 (${res.status}): ${errCode}`);
  }

  const result = JSON.parse(res.body);
  const token = result.result?.Token || result.Token;
  const refreshToken = result.result?.RefreshToken || result.RefreshToken;
  if (!token) throw new Error('REFRESH_FAIL 响应中无 Token');

  return { token, refreshToken };
}

// ============================================================
// 签到 API
// ============================================================

function ugHeaders(token, deviceId) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Cloud-IDE-JWT ${token}`,
    'X-User-Region': 'cn',
    'x-device-id': deviceId,
    'User-Agent': `Trae/${CONFIG.appVersion}`,
  };
}

async function checkinStatus(token, deviceId) {
  const res = await request(`https://${CONFIG.apiHost}/trae/api/v2/ug/checkin_credits/status`, {
    method: 'POST',
    headers: ugHeaders(token, deviceId),
    body: '{}',
  });
  if (res.status === 401 || res.status === 403) throw new Error('NO_SESSION 登录态已过期，请重新导出凭证');
  if (res.status !== 200) throw new Error(`STATUS_FAIL 查询签到状态失败 (${res.status})`);
  return JSON.parse(res.body);
}

async function checkinClaim(token, deviceId) {
  const res = await request(`https://${CONFIG.apiHost}/trae/api/v2/ug/checkin_credits/claim`, {
    method: 'POST',
    headers: ugHeaders(token, deviceId),
    body: '{}',
  });
  if (res.status === 401 || res.status === 403) throw new Error('NO_SESSION 登录态已过期，请重新导出凭证');
  if (res.status !== 200) throw new Error(`CLAIM_FAIL 领取签到奖励失败 (${res.status})`);
  return JSON.parse(res.body);
}

function daysToExpire(authInfo) {
  if (!authInfo.expiredAt) return Infinity;
  return (new Date(authInfo.expiredAt).getTime() - Date.now()) / 86400000;
}

function report(result) {
  console.log('[RESULT] ' + JSON.stringify(result));
}

// ============================================================
// 单账号执行逻辑
// ============================================================

async function processSingleAccountAuto(account) {
  const result = {
    account_id: account.index,
    account_name: account.name,
    status: '',
    signed_in: false,
    credits_gained: 0,
    token_refreshed: false,
    error: null,
  };

  if (account.loadError) {
    result.status = 'failed';
    result.error = account.loadError;
    return result;
  }

  try {
    const { authInfo, deviceCreds, deviceId } = account;
    let token = authInfo.token;

    // 1. Token 临期尝试刷新
    if (daysToExpire(authInfo) < 7 && deviceCreds) {
      try {
        const refreshed = await exchangeToken(authInfo, deviceCreds, deviceId);
        token = refreshed.token;
        result.token_refreshed = true;
      } catch (e) {
        // 刷新失败不中断后续签到尝试
      }
    }

    // 2. 查询今日签到状态（幂等）
    const status = await checkinStatus(token, deviceId);

    if ((status.enable ?? false) !== true) {
      result.status = 'inactive';
      result.error = '签到活动未开启';
    } else if (status.checked_in === true) {
      result.status = 'already_checked_in';
    } else {
      // 3. 执行领取
      const claim = await checkinClaim(token, deviceId);

      if (claim.code === 9095) {
        result.status = 'already_checked_in';
      } else if (claim.code === 9074) {
        result.status = 'server_busy';
        result.error = claim.message || '当前参与用户太多，请稍后再试';
      } else if (claim.code === 0 || claim.credits) {
        result.status = 'signed_in';
        result.signed_in = true;
        result.credits_gained = claim.credits || status.credits || 0;
      } else {
        result.status = 'verify_failed';
        result.error = claim.message || '签到状态未确认';
      }
    }
  } catch (e) {
    result.status = 'failed';
    result.error = e.message;
  }

  return result;
}

// ============================================================
// 命令实现
// ============================================================

/** 每日自动化：多账号依次签到 */
async function cmdAuto() {
  const accounts = await loadAllAccounts();
  console.log(`📦 检测到 ${accounts.length} 个 Trae 账号，开始批量签到...`);

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (i > 0) await sleep(1500); // 账号间隔 1.5s，平滑请求避免频控

    const res = await processSingleAccountAuto(acc);
    results.push(res);

    // 格式化输出单账号结果
    const icon = (res.status === 'signed_in') ? '🎉' : (res.status === 'already_checked_in') ? '✅' : '❌';
    const detail = res.signed_in
      ? `签到成功 (+${res.credits_gained} 积分)`
      : res.status === 'already_checked_in'
      ? '今日已签到'
      : `失败: ${res.error || res.status}`;
    console.log(`[${acc.index}/${accounts.length}] ${icon} 账号 [${acc.name}]: ${detail}`);
  }

  // 汇总判断：所有账号必须均为 signed_in 或 already_checked_in 且无 error
  const successfulCount = results.filter(r => (r.status === 'signed_in' || r.status === 'already_checked_in') && !r.error).length;
  const allSuccess = results.length > 0 && successfulCount === results.length;

  const summary = {
    command: 'auto',
    total_accounts: results.length,
    successful_accounts: successfulCount,
    failed_accounts: results.length - successfulCount,
    all_success: allSuccess,
    results: results.length === 1 ? results[0] : results,
  };

  report(summary);

  // 严格拦截：只要有任一账号未成功，立即退出码 1 标记工作流失败
  if (!allSuccess) {
    console.error(`\n❌ 部分或全部账号签到未成功 (${successfulCount}/${results.length})，工作流标记为失败`);
    process.exit(1);
  } else {
    console.log(`\n✨ 全部账号签到成功 (${successfulCount}/${results.length})`);
  }
}

/** 查询签到状态 */
async function cmdStatus() {
  const accounts = await loadAllAccounts();
  const list = [];
  for (const acc of accounts) {
    if (acc.loadError) {
      list.push({ account: acc.name, ok: false, error: acc.loadError });
      continue;
    }
    try {
      const status = await checkinStatus(acc.authInfo.token, acc.deviceId);
      list.push({
        account: acc.name,
        ok: true,
        checked_in: status.checked_in ?? false,
        enabled: status.enable ?? false,
        credits: status.credits ?? 0,
      });
    } catch (e) {
      list.push({ account: acc.name, ok: false, error: e.message });
    }
  }
  const allOk = list.every(i => i.ok);
  report({ ok: allOk, accounts: list });
  if (!allOk) process.exit(1);
}

/** 直接领取奖励 */
async function cmdClaim() {
  const accounts = await loadAllAccounts();
  const list = [];
  for (const acc of accounts) {
    if (acc.loadError) {
      list.push({ account: acc.name, ok: false, error: acc.loadError });
      continue;
    }
    try {
      const claim = await checkinClaim(acc.authInfo.token, acc.deviceId);
      list.push({ account: acc.name, ok: true, claim });
    } catch (e) {
      list.push({ account: acc.name, ok: false, error: e.message });
    }
  }
  const allOk = list.every(i => i.ok);
  report({ ok: allOk, accounts: list });
  if (!allOk) process.exit(1);
}

/** 刷新 Token */
async function cmdRefresh() {
  const accounts = await loadAllAccounts();
  const list = [];
  for (const acc of accounts) {
    if (acc.loadError) {
      list.push({ account: acc.name, ok: false, error: acc.loadError });
      continue;
    }
    try {
      const { token } = await exchangeToken(acc.authInfo, acc.deviceCreds, acc.deviceId);
      list.push({ account: acc.name, ok: true, token_preview: token.slice(0, 24) + '...' });
    } catch (e) {
      list.push({ account: acc.name, ok: false, error: e.message });
    }
  }
  const allOk = list.every(i => i.ok);
  report({ ok: allOk, accounts: list });
  if (!allOk) process.exit(1);
}

// ============================================================
// 入口
// ============================================================

const COMMANDS = {
  auto: ['每日自动化（多账号签到，全成功才通过）', cmdAuto],
  status: ['查询签到状态', cmdStatus],
  claim: ['领取签到奖励', cmdClaim],
  refresh: ['刷新 Token（需先关闭 Trae）', cmdRefresh],
};

async function main() {
  const cmd = process.argv[2] || 'auto';
  const entry = COMMANDS[cmd];

  if (!entry) {
    console.log('用法: node signin.js <命令>\n');
    console.log('命令列表:');
    for (const [name, [desc]] of Object.entries(COMMANDS)) {
      console.log(`  ${name.padEnd(8)} ${desc}`);
    }
    process.exit(2);
  }

  try {
    await entry[1]();
  } catch (e) {
    report({ ok: false, command: cmd, error: e.message });
    process.exit(1);
  }
}

main();
