import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipientIds, buildMailPayload, pickRowsToNotify, shouldEmitOnce } from './mailWatchUtil.js';

describe('parseRecipientIds', () => {
  it('extracts lowercase ids from plain, display-name and multi-recipient strings', () => {
    assert.deepEqual(parseRecipientIds('Hong@Example.com'), ['hong']);
    assert.deepEqual(parseRecipientIds('홍길동 <hong@example.com>; kim@example.com, hong@example.com'), ['hong', 'kim']);
  });

  it('accepts a bare id and ignores empty input', () => {
    assert.deepEqual(parseRecipientIds('hong'), ['hong']);
    assert.deepEqual(parseRecipientIds(''), []);
    assert.deepEqual(parseRecipientIds(null), []);
    assert.deepEqual(parseRecipientIds(' ; , '), []);
  });

  it('caps the number of recipients', () => {
    const many = Array.from({ length: 150 }, (_, i) => `u${i}@x.com`).join(',');
    assert.equal(parseRecipientIds(many).length, 100);
  });
});

describe('buildMailPayload', () => {
  const row = { mm_id: 'AB-1', mm_fromname: '홍길동', mm_fromaddr: 'hong@x.com', mm_subject: '회의 자료' };

  it('includes the subject only when allowed', () => {
    assert.deepEqual(buildMailPayload(row, true), { mailId: 'AB-1', from: '홍길동', subject: '회의 자료' });
    assert.equal(buildMailPayload(row, false).subject, '');
  });

  it('falls back to the address and truncates long subjects', () => {
    assert.equal(buildMailPayload({ ...row, mm_fromname: ' ' }, true).from, 'hong@x.com');
    assert.equal(buildMailPayload({ mm_id: 'x' }, true).from, '알 수 없음');
    const long = buildMailPayload({ ...row, mm_subject: 'a'.repeat(300) }, true).subject;
    assert.equal(long.length, 121);
    assert.ok(long.endsWith('…'));
  });
});

describe('pickRowsToNotify', () => {
  it('skips already seen mails and stale mails, and remembers what it saw', () => {
    const seen = new Set();
    const rows = [
      { mm_id: 'A', age_sec: 5 },
      { mm_id: 'B', age_sec: 5000 },
      { mm_id: 'C', age_sec: 10 },
    ];
    assert.deepEqual(pickRowsToNotify(rows, seen, 600).map((r) => r.mm_id), ['A', 'C']);
    assert.deepEqual(pickRowsToNotify(rows, seen, 600), []);
  });

  it('matches ids case-insensitively', () => {
    const seen = new Set(['abc']);
    assert.deepEqual(pickRowsToNotify([{ mm_id: 'ABC', age_sec: 1 }], seen, 600), []);
  });
});

describe('shouldEmitOnce', () => {
  it('blocks duplicates for the same user within the window but not other users or later', () => {
    const recent = new Map();
    const p = { from: '홍길동', subject: '회의' };
    assert.equal(shouldEmitOnce(recent, 'u1', p, 1000), true);
    assert.equal(shouldEmitOnce(recent, 'u1', p, 2000), false);
    assert.equal(shouldEmitOnce(recent, 'u2', p, 2000), true);
    assert.equal(shouldEmitOnce(recent, 'u1', { ...p, subject: '다른 제목' }, 2000), true);
    assert.equal(shouldEmitOnce(recent, 'u1', p, 1000 + 120_000), true);
  });
});
