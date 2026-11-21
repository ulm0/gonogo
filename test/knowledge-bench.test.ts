// scripts/knowledge-bench.mjs: its arguments. The harness itself makes 100,000 files and runs in the workflow (.github/workflows/knowledge-bench.yml), not here.
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../scripts/knowledge-bench.mjs';

describe('knowledge-bench arguments', () => {
  it('defaults to 100,000 files; takes --files N, --keep and --help; refuses a number out of range, a word and an unknown option', () => {
    expect(parseArgs([])).toEqual({ files: 100_000, keep: false, help: false, error: null });
    expect(parseArgs(['--files', '5000', '--keep'])).toMatchObject({ files: 5000, keep: true, error: null });
    expect(parseArgs(['--files=250000'])).toMatchObject({ files: 250_000 });
    expect(parseArgs(['-h']).help).toBe(true);
    for (const bad of [['--files', '99'], ['--files', '1000001'], ['--files', 'many'], ['--files', '1.5'], ['--files'], ['--nope']]) expect(parseArgs(bad).error, bad.join(' ')).not.toBeNull();
  });
});
