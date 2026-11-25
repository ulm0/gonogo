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

  it('the key back to the room is not named like a group (the index and the group headings are one pair, see rules-nav.test.ts)', () => {
    expect(source).toMatch(/className="btn loop-room"[^>]*>\s*<HugeiconsIcon icon=\{ArrowLeft01Icon\}[^>]*\/> Back to the room/);
  });

  it('draws a block\'s own title and value line only for a screen reader when the block is in a row', () => {
    expect(css).toMatch(/\.lay-row-body :is\(\.rules-block, \.wall-block\) > h2\.label:first-child[^{]*\{[^}]*clip: rect\(0 0 0 0\)/);
    expect(css).toMatch(/\.lay-row-body \.rules-value \{\s*position: absolute;[^}]*clip: rect\(0 0 0 0\)/);
  });
});

describe('long placeholders and selects are not cut', () => {
  it('the password fields stack on a phone and say the 12 characters in the hint, not in a placeholder that is cut', () => {
    const account = readFileSync('src/client/AccountBlock.tsx', 'utf8');
    expect(account).toContain('rules-row rules-row-stack');
    expect(account).not.toContain('placeholder="New password (12 or more)"');
    expect(readFileSync('src/client/rules.css', 'utf8')).toMatch(/\.rules-row-stack :is\(\[data-slot=input\], \[data-slot=native-select\]\) \{\s*flex-basis: 100%;/);
  });

  it('a tool of the permissions grid has room for its name and its select', () => {
    expect(readFileSync('src/client/forms.css', 'utf8')).toMatch(/\.perm-tools \{[^}]*minmax\(190px, 1fr\)/);
  });
});

describe('Automation and connections holds the real controls', () => {
  it('has the schedules, the webhooks, Relay and Docking in rows, each the component of its own, and no key that only opens another view', () => {
    for (const row of ['Schedules', 'Uplink webhooks', 'Relay: Slack, Telegram, GitHub, Linear']) expect(source, row).toContain(`<Row name="${row}"`);
    // the Docking row takes its name from the constant the docked chip also opens it by
    expect(source).toContain('<Row name={DOCKING_ROW.row}');
    expect(readFileSync('src/client/rulesTarget.ts', 'utf8')).toContain("row: 'Docking: other stations'");
    for (const block of ['<SchedulesBlock />', '<UplinkPanel />', '<RelayPanel />', '<DockingPanel />']) expect(source, block).toContain(block);
    expect(source).not.toContain('Open Launch Window');
    expect(source).not.toMatch(/onClick=\{showWindow\}/);
  });

  it('a row of a feature that is switched off is not drawn', () => {
    for (const feature of ['launch-window', 'uplink', 'relay', 'docking']) expect(source).toContain(`!off.includes('${feature}')`);
  });
});
