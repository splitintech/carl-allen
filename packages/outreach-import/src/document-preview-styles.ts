import postcss, { type AtRule, type Container, type Declaration, type Rule } from 'postcss';

const FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'calc', 'min', 'max', 'clamp', 'var', 'env', 'repeat', 'minmax', 'fit-content', 'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient', 'matrix', 'matrix3d', 'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scale', 'scalex', 'scaley', 'scalez', 'scale3d', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d', 'skew', 'skewx', 'skewy', 'perspective', 'cubic-bezier', 'steps', 'counter', 'counters']);
const SAFE_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'keyframes', '-webkit-keyframes', 'starting-style']);
const forbiddenText = (value: string) => /[\\<>]/.test(value) || value.includes('/*') || [...value].some((char) => { const code = char.charCodeAt(0); return code < 32 && ![9, 10, 13].includes(code) || code === 127; });

function safeValue(value: string): boolean {
  if (forbiddenText(value) || value.length > 20_000) return false;
  const functions = value.matchAll(/([a-z_-][a-z0-9_-]*)\s*\(/gi);
  for (const match of functions) if (!FUNCTIONS.has(match[1]!.toLowerCase())) return false;
  return !/(?:https?|file|data|javascript)\s*:/i.test(value);
}

function clean(container: Container, omit: () => void, depth = 0): void {
  if (depth > 32) { container.removeAll(); omit(); return; }
  for (const child of [...container.nodes ?? []]) {
    if (child.type === 'comment') { child.remove(); continue; }
    if (child.type === 'decl') {
      const declaration = child as Declaration;
      if (forbiddenText(declaration.prop) || !/^(?:--)?[a-z_-][a-z0-9_-]*$/i.test(declaration.prop) || /^(?:behavior|-moz-binding|src)$/i.test(declaration.prop) || !safeValue(declaration.value)) { child.remove(); omit(); }
      continue;
    }
    if (child.type === 'atrule') {
      const rule = child as AtRule;
      if (!SAFE_AT_RULES.has(rule.name.toLowerCase()) || forbiddenText(rule.params) || rule.params.length > 2000 || !rule.nodes) { child.remove(); omit(); continue; }
      clean(rule, omit, depth + 1); continue;
    }
    if (child.type === 'rule') {
      const rule = child as Rule;
      if (forbiddenText(rule.selector) || rule.selector.length > 4000) { child.remove(); omit(); continue; }
      clean(rule, omit, depth + 1); continue;
    }
  }
}

/** CSS is parsed as data; resource-bearing values and escaped constructs are excluded. */
export function sanitizePreviewStyles(source: string, inline: boolean, omit: () => void): string {
  if (source.length > 300_000) { omit(); return ''; }
  try {
    const root = postcss.parse(inline ? `preview{${source}}` : source);
    if (inline && (root.nodes.length !== 1 || root.first?.type !== 'rule')) { omit(); return ''; }
    clean(root, omit);
    if (inline) {
      const rule = root.first;
      return rule?.type === 'rule' ? (rule as Rule).nodes.filter((node) => node.type === 'decl').map((node) => node.toString()).join(';') : '';
    }
    return root.toString();
  } catch { omit(); return ''; }
}
