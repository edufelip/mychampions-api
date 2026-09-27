import { describe, expect, it } from 'bun:test';

import { ExerciseSuggestionLimiter } from '../src/integrations/exercise-suggestion-limits';

describe('exercise suggestion limits', () => {
  it('limits one user and global concurrency without queueing', () => {
    let now = 0;
    const limiter = new ExerciseSuggestionLimiter({ now: () => now, userLimit: 2, globalLimit: 1 });
    const first = limiter.tryAcquire('user-1');
    expect(first).not.toBeNull();
    const second = limiter.tryAcquire('user-1');
    expect(second).toBeNull();
    expect(limiter.tryAcquire('user-2')).toBeNull();
    limiter.release(first!, 'success');
    const other = limiter.tryAcquire('user-2');
    expect(other).not.toBeNull();
    limiter.release(other!, 'success');
    now = 60_001;
    expect(limiter.tryAcquire('user-1')).not.toBeNull();
  });

  it('opens after failures and permits one half-open probe only', () => {
    let now = 0;
    const limiter = new ExerciseSuggestionLimiter({ now: () => now, globalLimit: 2, circuitFailureLimit: 2, circuitOpenMs: 100 });
    const one = limiter.tryAcquire('one')!;
    limiter.release(one, 'failure');
    const two = limiter.tryAcquire('two')!;
    limiter.release(two, 'failure');
    expect(limiter.tryAcquire('three')).toBeNull();
    now = 101;
    const probe = limiter.tryAcquire('probe');
    expect(probe).not.toBeNull();
    expect(limiter.tryAcquire('second-probe')).toBeNull();
    limiter.release(probe!, 'failure');
    expect(limiter.tryAcquire('after-failed-probe')).toBeNull();
  });
});
