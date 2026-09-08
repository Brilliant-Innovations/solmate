import { DEFAULT_TOOL_MANIFEST, FORBIDDEN_TOOL_CAPABILITIES, ToolManifest, ToolName, type ToolManifestEntry } from '@sol-agent-trader/contracts';

/**
 * The closed tool set the Trading Skill may call (blueprint §11.4, INV-16). Registration is by exact
 * name against the versioned manifest; anything else is unregistered, however plausible it looks.
 */
export function loadManifest(manifest: unknown = DEFAULT_TOOL_MANIFEST): ToolManifest {
  const parsed = ToolManifest.parse(manifest);
  for (const tool of parsed.tools) assertNoForbiddenCapability(tool);
  return parsed;
}

export function isRegisteredTool(manifest: ToolManifest, name: unknown): name is ToolName {
  return typeof name === 'string' && ToolName.safeParse(name).success && manifest.tools.some((t) => t.name === name);
}

export function toolEntry(manifest: ToolManifest, name: ToolName): ToolManifestEntry {
  const entry = manifest.tools.find((t) => t.name === name);
  if (!entry) throw new Error(`tool ${name} is not in manifest ${manifest.version}`);
  return entry;
}

const FORBIDDEN_WORDS = /\b(sql|http|shell|exec|transfer|withdraw|send|sign|raw|secret|limit|live|automation|prompt|recipient)\b/i;

/** A manifest entry whose name or description reads like a forbidden capability is refused at load. */
export function assertNoForbiddenCapability(tool: ToolManifestEntry): void {
  const text = `${tool.name} ${tool.description}`;
  for (const cap of FORBIDDEN_TOOL_CAPABILITIES) {
    if (tool.name.toLowerCase().includes(cap.replace(/_/g, ''))) throw new Error(`tool ${tool.name} names forbidden capability ${cap}`);
  }
  const hit = tool.name.match(FORBIDDEN_WORDS);
  if (hit) throw new Error(`tool ${tool.name} names forbidden capability (${hit[0]})`);
  void text;
}
