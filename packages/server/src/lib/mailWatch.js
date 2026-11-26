/**
 * 새 메일 팝업 알림 — 메일 서버(MailCarrier) DB의 받은편지함을 주기적으로 읽어,
 * 메신저에 접속 중인 수신자에게 `mail` 소켓 이벤트를 보낸다.
 *
 * - MAIL_WATCH_ENABLED=true 일 때만 동작한다(기본 꺼짐). 다른 서버 배포에는 영향이 없다.
 * - 읽는 것은 받는 주소·보낸 사람·제목·수신 시각뿐이며 본문은 조회하지 않는다.
 * - 메일 제목은 접속 중인 수신자에게 소켓으로만 보내고, 메신저 DB·로그에는 저장하지 않는다.
 * - 오프라인 사용자는 건너뛴다(팝업은 접속 중일 때만 의미가 있다).
 */
import sql from 'mssql';
import { prisma } from '../db.js';
import { parseRecipientIds, buildMailPayload, pickRowsToNotify, shouldEmitOnce } from './mailWatchUtil.js';

const CURSOR_KEY = 'mail_watch_cursor';
const MAX_RECIPIENTS = 100;

export function isMailWatchEnabled() {
  return String(process.env.MAIL_WATCH_ENABLED || '').trim().toLowerCase() === 'true';
}

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

let poolPromise = null;

function buildConfig() {
  const server = process.env.MAIL_MSSQL_SERVER || process.env.PARTNER_MSSQL_SERVER || '';
  const user = process.env.MAIL_MSSQL_USER || '';
  if (!server || !user) throw new Error('MAIL_MSSQL_SERVER / MAIL_MSSQL_USER required');
  return {
    server,
    port: Number(process.env.MAIL_MSSQL_PORT || process.env.PARTNER_MSSQL_PORT || 1433),
    database: process.env.MAIL_MSSQL_DATABASE || 'MC7',
    user,
    password: process.env.MAIL_MSSQL_PASSWORD || '',
    options: {
      encrypt: String(process.env.MAIL_MSSQL_ENCRYPT || 'false').toLowerCase() === 'true',
      trustServerCertificate: String(process.env.MAIL_MSSQL_TRUST_CERT || 'true').toLowerCase() !== 'false',
      enableArithAbort: true,
    },
    pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 15000,
  };
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(buildConfig()).connect().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

async function resetPool() {
  const p = poolPromise;
  poolPromise = null;
  try {
    (await p)?.close();
  } catch {
    // 이미 끊긴 연결은 무시
  }
}

async function loadCursor(pool) {
  const saved = await prisma.appSetting.findUnique({ where: { key: CURSOR_KEY }, select: { value: true } });
  if (saved?.value) {
    const d = new Date(saved.value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // 처음 켤 때는 지금까지의 메일을 알리지 않도록 DB의 가장 최근 수신 시각에서 시작한다.
  // (서버 시계가 아니라 DB 값을 쓰므로 시간대가 달라도 어긋나지 않는다.)
  const r = await pool.request().query('SELECT MAX(mm_rstime) AS m FROM dbo.MavInbox');
  const m = r.recordset[0]?.m;
  return m instanceof Date ? m : new Date(0);
}

async function saveCursor(date) {
  const value = date.toISOString();
  await prisma.appSetting.upsert({
    where: { key: CURSOR_KEY },
    create: { key: CURSOR_KEY, value },
    update: { value },
  });
}

async function resolveUserIds(sentTo) {
  const ids = parseRecipientIds(sentTo);
  if (!ids.length) return [];
  const users = await prisma.user.findMany({
    where: { OR: ids.map((id) => ({ email: { startsWith: `${id}@`, mode: 'insensitive' } })) },
    select: { id: true },
    take: MAX_RECIPIENTS,
  });
  return users.map((u) => u.id);
}

/** 한 번 조회해서 알린다. 테스트와 시작 코드에서 쓰도록 분리했다. */
export async function pollMailOnce(io, state) {
  const pool = await getPool();
  if (!state.cursor) state.cursor = await loadCursor(pool);
  const limit = intEnv('MAIL_WATCH_BATCH', 200, 1, 1000);
  const maxAgeSec = intEnv('MAIL_WATCH_MAX_AGE_SEC', 600, 30, 86400);
  const showSubject = String(process.env.MAIL_WATCH_SHOW_SUBJECT || 'true').toLowerCase() !== 'false';

  const result = await pool
    .request()
    .input('since', sql.DateTime, state.cursor)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit)
        mm_id, mm_sentto, mm_fromname, mm_fromaddr, mm_subject, mm_rstime,
        DATEDIFF(SECOND, mm_rstime, GETDATE()) AS age_sec
      FROM dbo.MavInbox
      WHERE mm_rstime >= @since
      ORDER BY mm_rstime ASC
    `);
  const rows = result.recordset;
  if (!rows.length) return 0;

  if (!state.primed) {
    // 저장된 기준 시각과 같은 시각의 메일은 이미 알린 것이므로, 서버를 재시작해도 다시 울리지 않게 처리 완료로 표시한다.
    for (const row of rows) {
      if (row.mm_rstime instanceof Date && row.mm_rstime.getTime() === state.cursor.getTime()) {
        state.seen.add(String(row.mm_id).toLowerCase());
      }
    }
    state.primed = true;
  }
  const fresh = pickRowsToNotify(rows, state.seen, maxAgeSec);
  let sent = 0;
  for (const row of fresh) {
    const userIds = await resolveUserIds(row.mm_sentto);
    if (!userIds.length) continue;
    const payload = buildMailPayload(row, showSubject);
    for (const uid of userIds) {
      if (shouldEmitOnce(state.recent, uid, payload, Date.now())) io.to(`user:${uid}`).emit('mail', payload);
    }
    sent += 1;
  }

  const last = rows[rows.length - 1].mm_rstime;
  if (last instanceof Date && last.getTime() > state.cursor.getTime()) {
    state.cursor = last;
    await saveCursor(last);
  }
  return sent;
}

export function startMailWatch(io) {
  if (!isMailWatchEnabled()) return;
  const intervalMs = intEnv('MAIL_WATCH_INTERVAL_SEC', 15, 5, 300) * 1000;
  const state = { cursor: null, seen: new Set(), recent: new Map() };
  let running = false;
  let lastErrorAt = 0;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await pollMailOnce(io, state);
    } catch (e) {
      // 같은 오류가 15초마다 쌓이지 않도록 5분에 한 번만 남기고, 연결은 다시 만든다.
      if (Date.now() - lastErrorAt > 5 * 60 * 1000) {
        lastErrorAt = Date.now();
        console.error('[mail-watch]', e?.message || e);
      }
      await resetPool();
    } finally {
      running = false;
    }
  }

  console.log(`[startup] mail watch: enabled (every ${intervalMs / 1000}s)`);
  void tick();
  setInterval(tick, intervalMs).unref();
}
