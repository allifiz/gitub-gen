import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excelWibDate, excelCalendarDate, withTimeout } from '../src/export-utils.ts';
test('WIB serial preserves midnight rollover and seconds', () => {
 const value = excelWibDate('2026-08-28T17:20:52Z');
 const wall = new Date(Math.round(Date.UTC(1899,11,30) + value * 86400000));
 assert.equal(wall.toISOString(), '2026-08-29T00:20:52.000Z');
 assert.ok(Math.abs((excelWibDate('2026-08-29T03:26:05Z') - excelWibDate('2026-08-29T02:20:52Z')) * 86400 - 3913) < 0.001);
});
test('calendar dates, blanks and invalid values', () => {
 assert.equal(excelCalendarDate('29-08-2026'), excelWibDate('2026-08-28T17:00:00Z'));
 assert.equal(excelWibDate(null), '');
 assert.equal(excelWibDate('bad'), '');
 assert.equal(excelCalendarDate('31-02-2026'), '31-02-2026');
});
test('timeout rejects hung work and preserves normal results/errors', async () => {
 assert.equal(await withTimeout(Promise.resolve(42), 100, 'ok'), 42);
 await assert.rejects(withTimeout(Promise.reject(new Error('original')),100,'x'), /original/);
 await assert.rejects(withTimeout(new Promise(() => {}),10,'timeline'), /Timeout: timeline/);
});

test('Excel display keeps both timestamp formats identical', async () => {
 const { default: XLSX } = await import('xlsx');
 assert.equal(XLSX.SSF.format('dd/mm/yyyy hh:mm:ss', excelWibDate('2026-08-29T02:20:52Z')), '29/08/2026 09:20:52');
 assert.equal(XLSX.SSF.format('dd/mm/yyyy hh:mm:ss', excelWibDate('2026-08-29T03:26:05Z')), '29/08/2026 10:26:05');
});
