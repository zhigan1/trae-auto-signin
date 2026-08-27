/**
 * trae-auto-signin — TRAE SOLO CN 每日签到积分自动领取
 *
 * 零依赖 · 纯 Node.js 标准库 · 跨平台 · 幂等安全
 *
 * 命令：
 *   node signin.js auto     每日自动化：签到（默认）
 *   node signin.js status   仅查询签到状态（调试用）
 *   node signin.js claim    仅领取签到奖励（调试用）
 *   node signin.js refresh  仅刷新 Token（调试用，需先关闭 Trae）
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  apiHost: 'api.trae.cn',
  clientId: 'en1oxy7wnw8j9n',
  appVersion: '1.107.1',
  deviceId: '1448485154478571',
  // 存储文件路径（可通过环境变量覆盖，供 GitHub Actions 使用）
  get storageJsonPath() {
    if (process.env.TRAE_STORAGE_JSON) return process.env.TRAE_STORAGE_JSON;
    if (process.env.APPDATA) {
      return path.join(process.env.APPDATA, 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json');
    }
    return path.join(os.homedir(), '.config', 'TRAE SOLO CN', 'storage.json');
  },
};

// ============================================================
// 加密常量（从 Trae 客户端 main.js 逆向提取）
// ============================================================

// AES 模式 pepper 表 (ure ^ dre)
const PEPPER_AES_URE = [82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37];
const PEPPER_AES_DRE = [31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125];

// AES_PRIVATE 模式 pepper 表 (cre ^ lre)
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
  const blob = Buffer.from(blobBase64, 'base64');

  const isPrivate = HEADER_AES_PRIV.every((v, i) => blob[i] === v);
  const isAES = HEADER_AES.every((v, i) => blob[i] === v);

  if (!isPrivate && !isAES) {
    // 明文 JSON 直接返回
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

  // 前 64 字节为 SHA-512 完整性标签
  const tag = decrypted.slice(0, 64);
  const body = decrypted.slice(64);
  if (!tag.equals(sha512(body))) throw new Error('完整性校验失败（SHA-512 不匹配）');

  return body.toString('utf8');
}

// ============================================================
// HTTP
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

// ============================================================
// 凭证加载
// ============================================================

function findDeviceKeyPair(creds) {
  for (const [key, value] of Object.entries(creds)) {
    if (key.includes('icube-dc') && value && value.privateKeyPEM) return value;
  }
  return null;
}

async function loadCredentials() {
  const storagePath = CONFIG.storageJsonPath;
  if (!fs.existsSync(storagePath)) {
    throw new Error(`NO_STORAGE 未找到凭证文件: ${storagePath}，请先在本地登录 Trae 并导出`);
  }

  const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
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
  if (!authInfo || !authInfo.token) throw new Error('NO_AUTH 凭证解密失败或未登录，请先登录 Trae 客户端');

  return { authInfo, deviceCreds: findDeviceKeyPair(creds) };
}

// ============================================================
// 设备证明签名（ECDSA P-256 SHA-256）
// 签名原文：method\npath\nclientId\nrefreshToken\ntimestamp\nnonce
// timestamp 为秒级 Unix 时间戳，nonce 为 16 字节随机 hex
// ============================================================

function signDeviceProof(method, apiPath, refreshToken, deviceCreds, timestamp, nonce) {
  const content = [method, apiPath, CONFIG.clientId, refreshToken, String(timestamp), nonce].join('\n');
  return crypto.createSign('SHA256').update(content).end().sign(deviceCreds.privateKeyPEM, 'base64');
}

// ============================================================
// Token 刷新
// ============================================================

async function exchangeToken(authInfo, deviceCreds) {
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
        DeviceID: CONFIG.deviceId,
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
// 签到接口
// ============================================================

function ugHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Cloud-IDE-JWT ${token}`,
    'x-device-id': CONFIG.deviceId,
    'User-Agent': `Trae/${CONFIG.appVersion}`,
  };
}

async function checkinStatus(token) {
  const res = await request(`https://${CONFIG.apiHost}/trae/api/v2/ug/checkin_credits/status`, {
    method: 'POST',
    headers: ugHeaders(token),
    body: '{}',
  });
  if (res.status === 401 || res.status === 403) throw new Error('NO_SESSION 登录态已过期，请重新导出凭证');
  if (res.status !== 200) throw new Error(`STATUS_FAIL 查询签到状态失败 (${res.status})`);
  return JSON.parse(res.body);
}

async function checkinClaim(token) {
  const res = await request(`https://${CONFIG.apiHost}/trae/api/v2/ug/checkin_credits/claim`, {
    method: 'POST',
    headers: ugHeaders(token),
    body: '{}',
  });
  if (res.status === 401 || res.status === 403) throw new Error('NO_SESSION 登录态已过期，请重新导出凭证');
  if (res.status !== 200) throw new Error(`CLAIM_FAIL 领取签到奖励失败 (${res.status})`);
  return JSON.parse(res.body);
}

// ============================================================
// 工具
// ============================================================

/** 单行 JSON 结果汇总（仿 WorkBuddy 风格，脱敏账号信息） */
function report(result) {
  console.log('[RESULT] ' + JSON.stringify(result));
}

/** 辅助：更易读的状态输出（GitHub Actions 日志友好） */
function printSummary(status) {
  const messages = {
    already_checked_in: '✅ 今天已经签到过了',
    signed_in: '🎉 签到成功',
    verify_failed: '⚠️  签到可能未完成，请手动检查',
    inactive: '⚠️  签到活动未开启',
    failed: '❌ 签到失败',
  };
  console.log((messages[status] || status) + (status !== 'already_checked_in' ? ` [${new Date().toLocaleTimeString()}]` : ''));
}

/** 判断 Token 是否临期（7 天内需刷新） */
function daysToExpire(authInfo) {
  if (!authInfo.expiredAt) return Infinity;
  return (new Date(authInfo.expiredAt).getTime() - Date.now()) / 86400000;
}

// ============================================================
// 主流程
// ============================================================

/** 查询签到状态 */
async function cmdStatus() {
  const { authInfo } = await loadCredentials();
  const status = await checkinStatus(authInfo.token);
  report({
    ok: true,
    checked_in: status.checked_in ?? false,
    enabled: status.enable ?? false,
    credits: status.credits ?? 0,
  });
}

/** 领取签到奖励 */
async function cmdClaim() {
  const { authInfo } = await loadCredentials();
  const claim = await checkinClaim(authInfo.token);
  report({ ok: true, claim });
}

/** 刷新 Token */
async function cmdRefresh() {
  const { authInfo, deviceCreds } = await loadCredentials();
  const { token } = await exchangeToken(authInfo, deviceCreds);
  report({ ok: true, token_preview: token.slice(0, 24) + '...' });
}

/** 脱敏账号信息 */
function maskAccount(authInfo) {
  const account = typeof authInfo.account === 'object'
    ? (authInfo.account?.username || authInfo.userId)
    : authInfo.userId;
  // 只显示前 3 位
  return account ? account.substring(0, 3) + '***' : 'N/A';
}

/** 每日自动化：签到（幂等） */
async function cmdAuto() {
  const result = {
    command: 'auto',
    status: '',           // 状态描述：已签到/未签到/活动未开启/失败
    signed_in: false,
    credits_gained: 0,
    token_refreshed: false,
    error: null,
  };

  try {
    const { authInfo, deviceCreds } = await loadCredentials();

    let token = authInfo.token;

    // Token 临期时尝试刷新
    if (daysToExpire(authInfo) < 7 && !deviceCreds === false) {
      try {
        const refreshed = await exchangeToken(authInfo, deviceCreds);
        token = refreshed.token;
        result.token_refreshed = true;
      } catch (e) {
        if (process.env.DEBUG) console.error(`[WARN] Token 刷新失败: ${e.message}`);
      }
    }

    // 幂等：先查状态，已签则跳过
    const status = await checkinStatus(token);

    if ((status.enable ?? false) !== true) {
      result.status = 'inactive';
      result.skipped = 'INACTIVE 签到活动未开启';
    } else if (status.checked_in === true) {
      result.status = 'already_checked_in';
    } else {
      const claim = await checkinClaim(token);
      result.status = 'signed_in';
      result.signed_in = true;
      result.credits_gained = claim.credits ?? 200;

      // 复核确认
      const verify = await checkinStatus(token);
      if (verify.checked_in !== true) {
        result.status = 'verify_failed';
        result.signed_in = false;
      }
    }
  } catch (e) {
    result.status = 'failed';
    result.error = e.message;
  }

  report(result);
  if (result.status && !result.error) printSummary(result.status);
  if (result.error) process.exit(1);
}

// ============================================================
// 入口
// ============================================================

const COMMANDS = {
  auto: ['每日自动化（签到）', cmdAuto],
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
