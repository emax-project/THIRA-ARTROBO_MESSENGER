import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://x:x@localhost:1/x';

const { actorKey, loginKey, ipKey } = await import('./authRateLimit.js');
const { signToken } = await import('../auth.js');

test('세션 토큰이면 사용자 단위 키', () => {
  const token = signToken({ userId: 'u1', sessionId: 's1' });
  assert.equal(actorKey({ headers: { authorization: `Bearer ${token}` }, ip: '1.2.3.4' }), 'user:u1');
});

test('토큰이 없거나 위조·형식 오류면 IP 단위 키', () => {
  assert.equal(actorKey({ headers: {}, ip: '9.9.9.9' }), 'ip:9.9.9.9');
  assert.equal(actorKey({ headers: { authorization: 'Bearer not-a-jwt' }, ip: '9.9.9.9' }), 'ip:9.9.9.9');
});

test('다른 비밀키로 서명한 토큰은 신뢰하지 않는다(키 조작으로 남의 한도를 쓰지 못함)', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const forged = jwt.sign({ userId: 'victim', sessionId: 'x' }, 'other-secret');
  assert.equal(actorKey({ headers: { authorization: `Bearer ${forged}` }, ip: '5.5.5.5' }), 'ip:5.5.5.5');
});

test('로그인 키는 입력 이메일(대소문자·공백 무시) 단위, 없으면 IP', () => {
  assert.equal(loginKey({ body: { email: ' A@b.com ' }, ip: '1.1.1.1' }), 'login:a@b.com');
  assert.equal(loginKey({ body: {}, ip: '1.1.1.1' }), 'ip:1.1.1.1');
  assert.equal(loginKey({ body: { email: 123 }, ip: '1.1.1.1' }), 'ip:1.1.1.1');
});

test('가입 키는 항상 IP', () => {
  assert.equal(ipKey({ body: { email: 'a@b.com' }, ip: '2.2.2.2' }), 'ip:2.2.2.2');
});
