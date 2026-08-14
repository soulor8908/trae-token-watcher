import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken, hashToken } from '../src/session.js';
import { buildAuthorizeUrl, encryptToken, decryptToken } from '../src/github.js';
import { httpError } from '../src/http.js';

test('generateToken: 64位hex', () => {
  const t = generateToken();
  assert.equal(t.length, 64);
  assert.match(t, /^[0-9a-f]+$/);
  assert.notEqual(t, generateToken()); // 随机性
});

test('hashToken: 确定性 + 盐', async () => {
  const env = { SESSION_SECRET: 'salty' };
  assert.equal(await hashToken('a', env), await hashToken('a', env));
  assert.notEqual(await hashToken('a', env), await hashToken('b', env));
  assert.notEqual(await hashToken('a', env), await hashToken('a', { SESSION_SECRET: 'other' }));
});

test('httpError: status 传递', () => {
  const e = httpError(403, 'forbidden');
  assert.equal(e.status, 403);
  assert.equal(e.message, 'forbidden');
});

test('buildAuthorizeUrl: 构造正确', () => {
  const env = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'sec' };
  const url = buildAuthorizeUrl(env, 'st', 'https://cb.example.com/auth/callback');
  assert.ok(url.startsWith('https://github.com/login/oauth/authorize?'));
  assert.ok(url.includes('client_id=cid'));
  assert.ok(url.includes('state=st'));
  assert.ok(url.includes('redirect_uri=')); // URL 编码后的回调地址
});

test('buildAuthorizeUrl: 缺少 secret 抛 500（防 client_id=undefined 跳转）', () => {
  assert.throws(
    () => buildAuthorizeUrl({}, 'st', 'https://cb.example.com/auth/callback'),
    (err) => err.status === 500 && /GITHUB_CLIENT_ID/.test(err.message),
  );
});

test('encryptToken/decryptToken: 可逆 + 受 SESSION_SECRET 约束', async () => {
  const env = { SESSION_SECRET: 'salty-secret-32bytes-long-xxxx' };
  const token = 'gho_abcdef1234567890';
  const { enc, iv } = await encryptToken(token, env);
  // 密文与 IV 均为 hex，且不等于明文
  assert.match(enc, /^[0-9a-f]+$/);
  assert.match(iv, /^[0-9a-f]{24}$/);
  assert.notEqual(enc, token);
  // 同一 secret 可解回原文
  const dec = await decryptToken(enc, iv, env);
  assert.equal(dec, token);
  // 换 secret 则解密失败（GCM 抛错）
  await assert.rejects(decryptToken(enc, iv, { SESSION_SECRET: 'other-secret' }));
});
