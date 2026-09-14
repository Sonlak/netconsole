import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

export const templatesRouter = Router();

/** Vendor detection patterns */
const VENDOR_PATTERNS = {
  JUNIPER: [
    /^set\s+(interfaces|protocols|system|vlans|firewall|routing-options|policy-options|class-of-service)/im,
    /^delete\s+/m,
    /^edit\s+/m,
    /junos:/i,
  ],
  CISCO: [
    /^interface\s+(GigabitEthernet|FastEthernet|Ethernet)/m,
    /^ip\s+(address|route|nat|ospf|bgp)/m,
    /^no\s+switchport$/m,
    /^(hostname|version|crypto|aaa)/m,
  ],
  ARISTA: [
    /^interface\s+Ethernet\d/m,
    /^switchport\s+(mode|trunk|access)/m,
    /^spanning-tree/m,
    /^vlan\s+\d+/m,
    /^arp\s+aging/m,
  ],
} as const;

/**
 * Detect vendor family from raw config content.
 * Returns the most likely vendor based on pattern matching.
 */
export function detectVendorFamily(content: string): 'JUNIPER' | 'CISCO' | 'ARISTA' | 'UNKNOWN' {
  const normalized = content.trim();
  if (!normalized) return 'UNKNOWN';

  let maxScore = 0;
  let detected: 'JUNIPER' | 'CISCO' | 'ARISTA' | 'UNKNOWN' = 'UNKNOWN';

  for (const [vendor, patterns] of Object.entries(VENDOR_PATTERNS)) {
    const score = patterns.filter((pattern) => pattern.test(normalized)).length;
    if (score > maxScore) {
      maxScore = score;
      detected = vendor as 'JUNIPER' | 'CISCO' | 'ARISTA';
    }
  }

  return maxScore > 0 ? detected : 'UNKNOWN';
}

/**
 * Render / standardize raw config content.
 * Cleans up indentation, removes duplicates, organizes by section.
 */
export function renderConfig(content: string): string {
  const lines = content.split('\n');
  const seen = new Set<string>();
  const cleaned: string[] = [];

  // Section headers
  const sectionOrder = ['interface', 'hostname', 'vlan', 'ip address', 'set system', 'set interfaces', 'set protocols', 'set vlans', 'set routing-options', 'set policy-options', 'set firewall', 'set class-of-service'];

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines, comments, and duplicates
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('!')) {
      // Keep comment/header lines that look like section separators
      if (trimmed.startsWith('!') && trimmed.length > 2 && trimmed !== '!') {
        cleaned.push(trimmed);
      }
      continue;
    }
    
    // Skip exact duplicates
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }

  // Sort by section (interfaces first, then general configs)
  const interfaceLines = cleaned.filter(l => l.toLowerCase().startsWith('interface') || l.startsWith('set interfaces'));
  const systemLines = cleaned.filter(l => l.startsWith('hostname') || l.startsWith('set system') || l.startsWith('version'));
  const vlanLines = cleaned.filter(l => l.toLowerCase().startsWith('vlan') || l.startsWith('set vlans'));
  const protocolLines = cleaned.filter(l => l.startsWith('set protocols') || l.startsWith('ip ') || l.startsWith('set routing-options'));
  const otherLines = cleaned.filter(l => 
    !interfaceLines.includes(l) && 
    !systemLines.includes(l) && 
    !vlanLines.includes(l) && 
    !protocolLines.includes(l)
  );

  const sections: string[][] = [interfaceLines, systemLines, vlanLines, protocolLines, otherLines];
  const result: string[] = [];
  
  for (const section of sections) {
    if (section.length > 0) {
      if (result.length > 0) result.push('');
      result.push(...section);
    }
  }

  return result.join('\n');
}

// --- CRUD Endpoints ---

// GET /api/templates - List all templates
templatesRouter.get('/', async (_req, res) => {
  const templates = await prisma.configTemplate.findMany({
    orderBy: { name: 'asc' },
  });
  res.json(templates);
});

// GET /api/templates/:id - Get single template
templatesRouter.get('/:id', async (req, res) => {
  const id = req.params.id as string;
  const template = await prisma.configTemplate.findUnique({
    where: { id },
  });
  if (!template) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json(template);
});

// POST /api/templates - Create template from uploaded file
// Body: { name, description, content } or { name, description, fileContent, originalFilename }
templatesRouter.post('/', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { name, description, content, fileContent, originalFilename } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'Template name is required' });
    return;
  }

  // Use fileContent if uploaded file, otherwise use content directly
  const rawContent = typeof fileContent === 'string' ? fileContent : (typeof content === 'string' ? content : '');
  if (!rawContent.trim()) {
    res.status(400).json({ error: 'Template content is required' });
    return;
  }

  // Detect vendor and render config
  const vendor = detectVendorFamily(rawContent);
  const rendered = renderConfig(rawContent);

  try {
    const template = await prisma.configTemplate.create({
      data: {
        name: name.trim(),
        description: typeof description === 'string' ? description.trim() : null,
        content: rendered,
        vendor,
      },
    });
    res.status(201).json(template);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: `Template "${name}" already exists` });
      return;
    }
    throw err;
  }
});

// PUT /api/templates/:id - Update template
templatesRouter.put('/:id', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const { name, description, content } = req.body;
  const id = req.params.id as string;

  const existing = await prisma.configTemplate.findUnique({
    where: { id },
  });
  if (!existing) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }

  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    res.status(400).json({ error: 'Template name cannot be empty' });
    return;
  }

  // If content is being updated, re-detect vendor and render
  let vendor = existing.vendor;
  let renderedContent = existing.content;
  if (content !== undefined && typeof content === 'string' && content !== existing.content) {
    vendor = detectVendorFamily(content);
    renderedContent = renderConfig(content);
  }

  try {
    const updated = await prisma.configTemplate.update({
      where: { id },
      data: {
        name: name?.trim() ?? existing.name,
        description: description !== undefined ? (typeof description === 'string' ? description.trim() : null) : existing.description,
        content: content !== undefined ? renderedContent : existing.content,
        vendor: content !== undefined ? vendor : existing.vendor,
      },
    });
    res.json(updated);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: `Template "${name}" already exists` });
      return;
    }
    throw err;
  }
});

// DELETE /api/templates/:id
templatesRouter.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res) => {
  const id = req.params.id as string;
  const existing = await prisma.configTemplate.findUnique({
    where: { id },
  });
  if (!existing) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }

  await prisma.configTemplate.delete({
    where: { id },
  });

  res.status(204).send();
});

// POST /api/templates/render - Preview render without saving
// Body: { content } - returns { content, vendor, rendered }
templatesRouter.post('/render', (req, res) => {
  const { content } = req.body;

  if (!content || typeof content !== 'string') {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  const vendor = detectVendorFamily(content);
  const rendered = renderConfig(content);

  res.json({
    vendor,
    rendered,
    rawLength: content.length,
    renderedLength: rendered.length,
  });
});
