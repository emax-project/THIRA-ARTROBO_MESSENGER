/**
 * 로그인·가입·파일 업로드의 요청 속도 제한(무차별 대입·자원 소모 방어).
 *
 * 계정 단위 잠금(loginAttempts: 연속 실패 시 잠금)과는 별개의 안전장치다.
 * 토큰에서 사용자를 알 수 있으면 사용자 단위로, 아니면 IP 단위로 센다.
 * (리버스 프록시 뒤에 둘 경우 IP가 모두 같아지므로 index.js의 'trust proxy' 설정이 필요하다.)
 */
import rateLimit from 'express-rate-limit';
import { verifyToken } from '../auth.js';

/** 요청을 보낸 주체의 제한 키. 서명이 맞는 세션 토큰의 사용자 id를 우선한다. */
export function actorKey(req) {
  const header = req.headers?.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = bearer ? verifyToken(bearer)?.userId : null;
  return userId ? `user:${userId}` : `ip:${req.ip}`;
}

/** 로그인 요청의 제한 키: 시도 대상 계정(입력한 이메일). 없으면 IP. */
export function loginKey(req) {
  const id = req.body?.email ?? req.body?.username;
  return typeof id === 'string' && id.trim() ? `login:${id.trim().toLowerCase().slice(0, 200)}` : `ip:${req.ip}`;
}

/** 가입 요청의 제한 키: 항상 IP. */
export function ipKey(req) {
  return `ip:${req.ip}`;
}

function limiter({ windowMs, limit, message, keyGenerator = actorKey }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler: (_req, res) => res.status(429).json({ error: message }),
  });
}

const MINUTE = 60_000;
const TOO_MANY = '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';

/** 로그인 — 계정(입력 이메일)당 분당 20회. 계정 잠금(loginAttempts)과 별개 */
export const loginLimiter = limiter({ windowMs: MINUTE, limit: 20, message: TOO_MANY, keyGenerator: loginKey });
/** 회원가입 — IP당 시간당 20회 (공개 가입을 열어 둔 서버의 계정 대량 생성 방어) */
export const registerLimiter = limiter({ windowMs: 60 * MINUTE, limit: 20, message: TOO_MANY, keyGenerator: ipKey });
/** 파일 업로드 — 사용자당 분당 60회(자원 소모 방어) */
export const fileUploadLimiter = limiter({ windowMs: MINUTE, limit: 60, message: TOO_MANY });
