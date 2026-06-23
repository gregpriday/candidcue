import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PromptMeta {
  id: string;
  version: string;
  modelFamily: string;
  updatedAt: string;
}

export interface LoadedPrompt {
  meta: PromptMeta;
  body: string;
}

let promptsRoot = defaultPromptsRoot();

function defaultPromptsRoot(): string {
  if (process.env.CANDIDCUE_PROMPTS_ROOT) return process.env.CANDIDCUE_PROMPTS_ROOT;
  return join(process.cwd(), 'prompts');
}

/** Set the directory prompts are loaded from (main bootstrap / packaging). */
export function setPromptsRoot(root: string): void {
  promptsRoot = root;
}

export function getPromptsRoot(): string {
  return promptsRoot;
}

/** Parse YAML-ish frontmatter delimited by `---` lines. */
export function parsePrompt(raw: string): LoadedPrompt {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      meta: { id: 'unknown', version: '0.0.0', modelFamily: 'unknown', updatedAt: '' },
      body: raw.trim(),
    };
  }
  const [, front, body] = match;
  const fields: Record<string, string> = {};
  for (const line of (front ?? '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  return {
    meta: {
      id: fields.id ?? 'unknown',
      version: fields.version ?? '0.0.0',
      modelFamily: fields.model_family ?? 'unknown',
      updatedAt: fields.updated_at ?? '',
    },
    body: (body ?? '').trim(),
  };
}

export function loadPrompt(name: string, root: string = promptsRoot): LoadedPrompt {
  const file = name.endsWith('.md') ? name : `${name}.md`;
  const raw = readFileSync(join(root, file), 'utf8');
  return parsePrompt(raw);
}

export function loadPromptBody(name: string, root: string = promptsRoot): string {
  return loadPrompt(name, root).body;
}

/** Fill `{{token}}` placeholders. Unknown tokens are left untouched. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : whole,
  );
}
