import { describe, expect, it } from 'vitest';
import { computeBackoffSeconds } from '../../src/jobs/backoff';
import { createLogger } from '../../src/observability/logger';

describe('computeBackoffSeconds', () => {
  it('grows exponentially with a cap', () => {
    const noJitter = () => 0;
    expect(computeBackoffSeconds(1, noJitter)).toBe(60);
    expect(computeBackoffSeconds(2, noJitter)).toBe(120);
    expect(computeBackoffSeconds(3, noJitter)).toBe(240);
    expect(computeBackoffSeconds(10, noJitter)).toBe(3600);
    expect(computeBackoffSeconds(50, () => 0.99)).toBe(3600);
  });
  it('adds bounded jitter', () => {
    const value = computeBackoffSeconds(1, () => 0.999);
    expect(value).toBeGreaterThanOrEqual(60);
    expect(value).toBeLessThanOrEqual(90);
  });
});

describe('logger', () => {
  it('emits JSON with base context and redacts sensitive keys', () => {
    const lines: string[] = [];
    const logger = createLogger({ requestId: 'r1' }, (line) => lines.push(line)).child({
      jobId: 'j1',
    });
    logger.info('test.event', {
      password: 'hunter2',
      cookie: 'abc',
      authorization: 'Bearer x',
      count: 3,
    });
    const record = JSON.parse(lines[0] ?? '{}');
    expect(record.event).toBe('test.event');
    expect(record.requestId).toBe('r1');
    expect(record.jobId).toBe('j1');
    expect(record.password).toBe('[redacted]');
    expect(record.cookie).toBe('[redacted]');
    expect(record.authorization).toBe('[redacted]');
    expect(record.count).toBe(3);
    expect(record.level).toBe('info');
  });
  it('truncates very long strings so article content is not reproduced', () => {
    const lines: string[] = [];
    createLogger({}, (line) => lines.push(line)).info('x', { body: 'a'.repeat(5000) });
    expect(JSON.parse(lines[0] ?? '{}').body.length).toBeLessThan(2100);
  });
});
