/** 새 메일 알림의 순수 로직(DB·소켓 없이 테스트 가능). */
import { emailLocalPart } from './ssoToken.js';

const SEEN_LIMIT = 1000;
const MAX_RECIPIENTS = 100;
const SUBJECT_MAX = 120;

/**
 * 받는 주소 문자열("a@x.com; 홍길동 <b@x.com>, c")에서 아이디(@ 앞부분)만 뽑는다.
 * 소문자·중복 제거. 메신저 사용자의 아이디는 이메일의 @ 앞부분이다.
 */
export function parseRecipientIds(sentTo) {
  const out = new Set();
  for (const part of String(sentTo || '').split(/[;,]/)) {
    const m = part.match(/<([^>]+)>/);
    const addr = (m ? m[1] : part).trim();
    if (!addr) continue;
    const id = emailLocalPart(addr).trim().toLowerCase();
    if (id) out.add(id);
  }
  return [...out].slice(0, MAX_RECIPIENTS);
}

/** 소켓으로 보낼 알림 내용. showSubject가 false면 제목은 보내지 않는다. */
export function buildMailPayload(row, showSubject) {
  const from = String(row.mm_fromname || '').trim() || String(row.mm_fromaddr || '').trim() || '알 수 없음';
  const subject = String(row.mm_subject || '').trim();
  return {
    mailId: String(row.mm_id),
    from,
    subject: showSubject ? (subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX)}…` : subject) : '',
  };
}

/**
 * 이번에 알릴 행만 고른다. 이미 처리한 메일(seen)과, 서버가 오래 꺼져 있다가 켜졌을 때
 * 쏟아지는 오래된 메일(maxAgeSec 초과)은 알리지 않는다.
 */
export function pickRowsToNotify(rows, seen, maxAgeSec) {
  const fresh = [];
  for (const row of rows) {
    const id = String(row.mm_id).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    if (Number(row.age_sec) > maxAgeSec) continue;
    fresh.push(row);
  }
  while (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
  return fresh;
}

/**
 * 같은 사용자에게 같은 메일(보낸 사람+제목)을 짧은 시간 안에 두 번 알리지 않는다.
 * 메일 서버가 받는 사람마다 행을 따로 저장하는 구조여도 팝업이 중복되지 않게 하는 안전장치다.
 * @returns {boolean} 알려도 되면 true (그리고 기록한다)
 */
export function shouldEmitOnce(recent, userId, payload, now, ttlMs = 120_000) {
  const key = `${userId}|${payload.from}|${payload.subject}`;
  const at = recent.get(key);
  if (at !== undefined && now - at < ttlMs) return false;
  recent.set(key, now);
  if (recent.size > 2000) {
    for (const [k, t] of recent) if (now - t >= ttlMs) recent.delete(k);
  }
  return true;
}
