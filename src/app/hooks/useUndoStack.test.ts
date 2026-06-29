import { describe, it, expect, vi } from 'vitest';
import { appendUndoEntry, type UndoEntry, type PushUndoEntry } from './useUndoStack';

const NOW = 1_700_000_000_000;

const makeEntry = (
  label: string,
  undo: () => Promise<void>,
  groupToken?: string | number,
): PushUndoEntry => ({ label, undo, groupToken });

const makeRedoableEntry = (
  label: string,
  undo: () => Promise<void>,
  redo: () => Promise<void>,
  groupToken?: string | number,
): PushUndoEntry => ({ label, undo, redo, groupToken });

const noop = () => Promise.resolve();

describe('appendUndoEntry', () => {
  it('appends a plain entry (no token) to an empty stack', () => {
    const next = appendUndoEntry([], makeEntry('A', noop), 20, NOW);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ label: 'A', timestamp: NOW });
    expect(next[0].count).toBeUndefined();
  });

  it('keeps two entries separate when tokens differ or are absent', () => {
    let stack: UndoEntry[] = [];
    stack = appendUndoEntry(stack, makeEntry('A', noop), 20, NOW);
    stack = appendUndoEntry(stack, makeEntry('B', noop, 7), 20, NOW);
    stack = appendUndoEntry(stack, makeEntry('C', noop, 8), 20, NOW);
    expect(stack.map((e) => e.label)).toEqual(['A', 'B', 'C']);
  });

  it('coalesces two entries sharing a token into one composite step', () => {
    let stack: UndoEntry[] = [];
    stack = appendUndoEntry(stack, makeEntry('Description updated', noop, 1), 20, NOW);
    stack = appendUndoEntry(stack, makeEntry('Description updated', noop, 1), 20, NOW);
    expect(stack).toHaveLength(1);
    expect(stack[0].label).toBe('Description updated (2 cells)');
    expect(stack[0].count).toBe(2);
    expect(stack[0].groupToken).toBe(1);
    expect(stack[0].baseLabel).toBe('Description updated');
  });

  it('composite undo reverts every coalesced cell regardless of push order', async () => {
    const calls: string[] = [];
    const undoA = vi.fn(async () => { calls.push('A'); });
    const undoB = vi.fn(async () => { calls.push('B'); });
    const undoC = vi.fn(async () => { calls.push('C'); });

    let stack: UndoEntry[] = [];
    stack = appendUndoEntry(stack, makeEntry('Qty updated', undoA, 5), 20, NOW);
    stack = appendUndoEntry(stack, makeEntry('Qty updated', undoB, 5), 20, NOW);
    stack = appendUndoEntry(stack, makeEntry('Qty updated', undoC, 5), 20, NOW);

    expect(stack).toHaveLength(1);
    expect(stack[0].count).toBe(3);
    expect(stack[0].label).toBe('Qty updated (3 cells)');

    await stack[0].undo();
    expect(undoA).toHaveBeenCalledTimes(1);
    expect(undoB).toHaveBeenCalledTimes(1);
    expect(undoC).toHaveBeenCalledTimes(1);
    expect(calls.sort()).toEqual(['A', 'B', 'C']);
  });

  it('starts a fresh entry when a new token lands on a coalesced group', () => {
    let stack: UndoEntry[] = [];
    stack = appendUndoEntry(stack, makeEntry('paste', noop, 1), 20, NOW);
    stack = appendUndoEntry(stack, makeEntry('paste', noop, 1), 20, NOW);
    stack = appendUndoEntry(stack, makeEntry('next paste', noop, 2), 20, NOW);
    expect(stack).toHaveLength(2);
    expect(stack[0].count).toBe(2);
    expect(stack[1].label).toBe('next paste');
    expect(stack[1].count).toBeUndefined();
  });

  it('only merges with the top entry, not a buried same-token entry', () => {
    let stack: UndoEntry[] = [];
    stack = appendUndoEntry(stack, makeEntry('A', noop, 1), 20, NOW);
    stack = appendUndoEntry(stack, makeEntry('B', noop, 2), 20, NOW);
    // token 1 no longer on top → must not merge into the buried entry
    stack = appendUndoEntry(stack, makeEntry('A again', noop, 1), 20, NOW);
    expect(stack.map((e) => e.label)).toEqual(['A', 'B', 'A again']);
  });

  it('surfaces a failure if any coalesced revert rejects, but still runs the others', async () => {
    const undoOk = vi.fn(async () => {});
    const undoBad = vi.fn(async () => { throw new Error('save failed'); });

    let stack: UndoEntry[] = [];
    stack = appendUndoEntry(stack, makeEntry('X', undoOk, 9), 20, NOW);
    stack = appendUndoEntry(stack, makeEntry('X', undoBad, 9), 20, NOW);

    await expect(stack[0].undo()).rejects.toThrow(/revert/i);
    expect(undoOk).toHaveBeenCalledTimes(1);
    expect(undoBad).toHaveBeenCalledTimes(1);
  });

  it('carries a redo closure through on a plain (non-coalesced) push', () => {
    const redo = vi.fn(async () => {});
    const next = appendUndoEntry([], makeRedoableEntry('A', noop, redo), 20, NOW);
    expect(next[0].redo).toBe(redo);
  });

  it('leaves redo undefined when the pushed entry has none', () => {
    const next = appendUndoEntry([], makeEntry('A', noop), 20, NOW);
    expect(next[0].redo).toBeUndefined();
  });

  it('composes the redo of both coalesced edits into the merged entry', async () => {
    const calls: string[] = [];
    const redoA = vi.fn(async () => { calls.push('A'); });
    const redoB = vi.fn(async () => { calls.push('B'); });

    let stack: UndoEntry[] = [];
    stack = appendUndoEntry(stack, makeRedoableEntry('Qty updated', noop, redoA, 5), 20, NOW);
    stack = appendUndoEntry(stack, makeRedoableEntry('Qty updated', noop, redoB, 5), 20, NOW);

    expect(stack).toHaveLength(1);
    expect(stack[0].redo).toBeDefined();
    await stack[0].redo!();
    expect(redoA).toHaveBeenCalledTimes(1);
    expect(redoB).toHaveBeenCalledTimes(1);
    expect(calls.sort()).toEqual(['A', 'B']);
  });

  it('keeps the merged entry redoable even if only one member has a redo', async () => {
    const redoB = vi.fn(async () => {});
    let stack: UndoEntry[] = [];
    stack = appendUndoEntry(stack, makeEntry('paste', noop, 1), 20, NOW); // no redo
    stack = appendUndoEntry(stack, makeRedoableEntry('paste', noop, redoB, 1), 20, NOW);
    expect(stack[0].redo).toBeDefined();
    await stack[0].redo!();
    expect(redoB).toHaveBeenCalledTimes(1);
  });

  it('merged entry stays non-redoable when neither member has a redo', () => {
    let stack: UndoEntry[] = [];
    stack = appendUndoEntry(stack, makeEntry('paste', noop, 1), 20, NOW);
    stack = appendUndoEntry(stack, makeEntry('paste', noop, 1), 20, NOW);
    expect(stack[0].redo).toBeUndefined();
  });

  it('surfaces a failure if any coalesced redo rejects, but still runs the others', async () => {
    const redoOk = vi.fn(async () => {});
    const redoBad = vi.fn(async () => { throw new Error('reapply failed'); });

    let stack: UndoEntry[] = [];
    stack = appendUndoEntry(stack, makeRedoableEntry('X', noop, redoOk, 9), 20, NOW);
    stack = appendUndoEntry(stack, makeRedoableEntry('X', noop, redoBad, 9), 20, NOW);

    await expect(stack[0].redo!()).rejects.toThrow(/re-apply/i);
    expect(redoOk).toHaveBeenCalledTimes(1);
    expect(redoBad).toHaveBeenCalledTimes(1);
  });

  it('respects maxSize for non-coalesced pushes and never grows it on merge', () => {
    let stack: UndoEntry[] = [];
    for (let i = 0; i < 25; i += 1) {
      stack = appendUndoEntry(stack, makeEntry(`e${i}`, noop), 20, NOW);
    }
    expect(stack).toHaveLength(20);
    expect(stack[0].label).toBe('e5'); // oldest 5 dropped
    // merging a token into the (untokened) top does not exceed the cap
    const tokened = appendUndoEntry(stack, makeEntry('t', noop, 42), 20, NOW);
    expect(tokened).toHaveLength(20); // pushed (no token on top), oldest dropped
    const merged = appendUndoEntry(tokened, makeEntry('t', noop, 42), 20, NOW);
    expect(merged).toHaveLength(20);
    expect(merged[merged.length - 1].count).toBe(2);
  });
});
