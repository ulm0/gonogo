/** Flight Rules in groups: every block of the page is in exactly one group, so nothing was lost in the move to rows. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/client/Rules.tsx', 'utf8');
const grouped = source.slice(source.indexOf('<Group id="room"'), source.indexOf('</section>', source.indexOf('<Group id="system"')));

describe('Flight Rules groups', () => {
  it('has the seven groups', () => {
    expect([...grouped.matchAll(/<Group id="([a-z]+)" title="([^"]+)"/g)].map((m) => m[1])).toEqual(['room', 'agents', 'budget', 'auto', 'knowledge', 'security', 'system']);
  });

  it('Group is one component for good, not one made again at every render (that would rebuild every block each time a value arrives)', () => {
    expect(source).toMatch(/^function Group\(/m);
    expect(source).not.toMatch(/const Group = /);
  });

  it('puts each block in one place only', () => {
    const blocks = [...grouped.matchAll(/<([A-Z][A-Za-z]+Block|PhoneApprovals|MaxQ|Propellant)\b/g)].map((m) => m[1]);
    expect(new Set(blocks).size).toBe(blocks.length);
  });

  it('keeps the blocks the old page had', () => {
    for (const block of ['TabNameBlock', 'ModelDefaultsBlock', 'RoomRulesBlock', 'RitualTemplateBlock', 'KnowledgeBlock', 'SemanticBlock', 'PermissionDefaultsBlock', 'PayloadDefaultsBlock', 'SkillsBlock', 'RoomKeysBlock', 'StartupBlock', 'VersionCheckBlock', 'AutoUpdateBlock', 'SubagentsBlock', 'CoauthorBlock', 'AccountBlock', 'AllStopBlock', 'FeaturesBlock', 'PhoneApprovals', 'ReloadBlock', 'MaxQ', 'Propellant']) {
      expect(grouped, block).toContain(`<${block}`);
    }
  });
});

describe('Flight Rules says nothing twice', () => {
  const css = readFileSync('src/client/layout.css', 'utf8');

  it('has no index of the groups beside their headings, and the key back to the room is not named like a group', () => {
    expect(source).not.toContain('lay-group-nav');
    expect(source).toMatch(/className="btn loop-room"[^>]*>\s*← Room/);
  });

  it('draws a block\'s own title and value line only for a screen reader when the block is in a row', () => {
    expect(css).toMatch(/\.lay-row-body :is\(\.rules-block, \.wall-block\) > h2\.label:first-child[^{]*\{[^}]*clip: rect\(0 0 0 0\)/);
    expect(css).toMatch(/\.lay-row-body \.rules-value \{ display: none; \}/);
  });
});
