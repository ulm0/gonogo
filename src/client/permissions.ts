/**
 * Tool permissions in the forms (docs/features/permissions.md): the rules of an agent are one text, a rule on each line as
 * `<allow|ask|deny> <rule>`, such as `allow Bash(git:*)`. The checklist of common tools reads and writes the lines that name a
 * bare tool; the text field is for the rest. The server reads the same rules again and has the last word.
 */
import { COMMON_TOOLS, PERMISSION_LISTS, PERMISSION_RULE_PATTERN, PERMISSION_RULES_MAX } from '../shared/protocol.js';
import type { PermissionList, PermissionRules } from '../shared/protocol.js';

const RULE_RE = new RegExp(PERMISSION_RULE_PATTERN);
const GONOGO_TOOLS = /^mcp__gonogo(__|$|\()/;
const isList = (word: string): word is PermissionList => (PERMISSION_LISTS as readonly string[]).includes(word);

/** The lines of a text that are not blank, trimmed. */
const linesOf = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line !== '');

/** The rules a text says, and the first thing wrong with it (a line number and why), or null. */
export function parseRulesText(text: string): { rules: PermissionRules; problem: string | null } {
  const rules: PermissionRules = {};
  let count = 0;
  for (const [index, line] of linesOf(text).entries()) {
    const space = line.indexOf(' ');
    const list = space < 0 ? line : line.slice(0, space);
    const rule = space < 0 ? '' : line.slice(space + 1).trim();
    if (!isList(list)) return { rules, problem: `Line ${index + 1}: start with allow, ask or deny, then the rule (allow Bash(git:*)).` };
    if (!RULE_RE.test(rule)) return { rules, problem: `Line ${index + 1}: "${rule.slice(0, 40)}" is not a rule: a tool name, then optionally (a pattern), such as Bash or Bash(git:*).` };
    if (GONOGO_TOOLS.test(rule)) return { rules, problem: `Line ${index + 1}: gonogo's own tools cannot be changed here.` };
    const found = rules[list] ?? [];
    if (!found.includes(rule)) {
      found.push(rule);
      count += 1;
    }
    rules[list] = found;
  }
  if (count > PERMISSION_RULES_MAX * 3) return { rules, problem: `At most ${PERMISSION_RULES_MAX} rules in each list.` };
  for (const list of PERMISSION_LISTS) if ((rules[list]?.length ?? 0) > PERMISSION_RULES_MAX) return { rules, problem: `At most ${PERMISSION_RULES_MAX} rules in ${list}.` };
  return { rules, problem: null };
}

/** The rules as the text of the form, in the order allow, ask, deny. */
export const rulesToText = (rules: PermissionRules | null | undefined): string =>
  PERMISSION_LISTS.flatMap((list) => (rules?.[list] ?? []).map((rule) => `${list} ${rule}`)).join('\n');

/** The rules the form describes, or null when there are none. A text with a problem describes none: the form shows the problem. */
export function rulesOf(text: string): PermissionRules | null {
  const { rules, problem } = parseRulesText(text);
  return problem !== null || Object.keys(rules).length === 0 ? null : rules;
}

/** What the lines say of one bare tool: its list, or '' (the harness's own default). The first line wins. */
export function toolState(text: string, tool: string): '' | PermissionList {
  for (const line of linesOf(text)) {
    const [list, rule] = [line.slice(0, Math.max(line.indexOf(' '), 0)), line.slice(line.indexOf(' ') + 1).trim()];
    if (rule === tool && isList(list)) return list;
  }
  return '';
}

/** The text with the lines of one bare tool replaced by one line for `list` (or none for ''). Other lines stay as they are. */
export function setToolState(text: string, tool: string, list: '' | PermissionList): string {
  const kept = linesOf(text).filter((line) => !PERMISSION_LISTS.some((l) => line === `${l} ${tool}`));
  return [...kept, ...(list === '' ? [] : [`${list} ${tool}`])].join('\n');
}

export { COMMON_TOOLS };
