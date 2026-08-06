import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateToken, hashToken } from '../src/session.js';
import { httpError, buildAuthorizeUrl } from '../src/github.js';

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
  const url = buildAuthorizeUrl({ GITHUB_CLIENT_ID: 'cid' }, 'st', 'https://cb.example.com/auth/callback');
  assert.ok(url.startsWith('https://github.com/login/oauth/authorize?'));
  assert.ok(url.includes('client_id=cid'));
  assert.ok(url.includes('state=st'));
  assert.ok(url.includes('redirect_uri=')); // URL 编码后的回调地址
});
