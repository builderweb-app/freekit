// v2.6.0 (FIX 3): proiecte sugerate pentru „Open a folder" — când utilizatorul
// nu are niciun folder deschis, cardul din chat îi oferă direct proiectele
// găsite în Home / Desktop / Documents (folder care conține .git / package.json
// / pyproject.toml / composer.json / Cargo.toml / go.mod), sortate după cât de
// recente sunt, plus ieșirea „Choose another folder..." către dialogul nativ.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { logLine } from './log';

/** Markerii care transformă un folder în „proiect" + eticheta afișată. */
const MARKERS: Array<{ file: string; kind: string; dir?: boolean }> = [
  { file: 'package.json', kind: 'node' },
  { file: 'pyproject.toml', kind: 'python' },
  { file: 'composer.json', kind: 'php' },
  { file: 'Cargo.toml', kind: 'rust' },
  { file: 'go.mod', kind: 'go' },
  { file: '.git', kind: 'git', dir: true }
];

/** Câte intrări scanăm per folder (Home poate avea sute de subfoldere). */
const MAX_ENTRIES_PER_DIR = 200;
/** Câte sugestii afișăm în quick pick. */
const MAX_SUGGESTIONS = 12;
/** Câte subfoldere intră în scan (Desktop / Documents / Home). */
const MAX_DIRS_SCANNED = 400;

export interface ProjectSuggestion {
  /** Folderul (sau fișierul .code-workspace) propus. */
  uri: vscode.Uri;
  /** Eticheta din quick pick — codiconi $(...) + calea + tipul proiectului. */
  label: string;
  /** Momentul ultimei modificări a markerului (sortare „recent"). */
  mtimeMs: number;
}

export type FolderPickResult =
  | { kind: 'picked'; uri: vscode.Uri }
  | { kind: 'browse' }
  | { kind: 'cancelled' };

/** Compune eticheta unei sugestii: $(folder) C:\...\proiect (node). */
function suggestionLabel(target: string, kind: string, workspaceFile: boolean): string {
  const name = path.basename(target) || target;
  const suffix = workspaceFile ? 'workspace' : kind;
  return '$(folder) ' + name + '  ·  ' + target + ' (' + suffix + ')';
}

/** Tipul proiectului + momentul modificării markerului (best-effort). */
async function detectMarker(folder: string): Promise<{ kind: string; mtimeMs: number } | null> {
  for (const marker of MARKERS) {
    const p = path.join(folder, marker.file);
    try {
      const st = await fs.promises.stat(p);
      if (marker.dir && !st.isDirectory()) continue;
      if (!marker.dir && !st.isFile()) continue;
      return { kind: marker.kind, mtimeMs: st.mtimeMs };
    } catch {
      /* marker lipsă — încercăm următorul */
    }
  }
  return null;
}

/** Subfolderele directe ale unui folder (fără ascunse / zgomot de sistem). */
async function listSubDirectories(folder: string): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIR)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    out.push(path.join(folder, entry.name));
  }
  return out;
}

/** Fișierele *.code-workspace dintr-un folder (deschise direct ca workspace). */
async function listWorkspaceFiles(folder: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const entries = await fs.promises.readdir(folder, { withFileTypes: true });
    for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIR)) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.code-workspace')) {
        out.push(path.join(folder, entry.name));
      }
    }
  } catch {
    /* folder inaccesibil — ignorăm */
  }
  return out;
}

/**
 * Scanează Home / Desktop / Documents (un singur nivel) și întoarce proiectele
 * detectate, cele mai recente primele. Best-effort: orice eroare de acces e
 * ignorată, iar lista poate fi și goală (atunci mergem direct la dialogul nativ).
 */
export async function findProjectSuggestions(): Promise<ProjectSuggestion[]> {
  const home = os.homedir();
  const roots = [home, path.join(home, 'Desktop'), path.join(home, 'Documents')];
  const seen = new Set<string>();
  const suggestions: ProjectSuggestion[] = [];
  let scanned = 0;

  const push = (target: string, kind: string, mtimeMs: number, workspaceFile = false) => {
    const key = path.normalize(target).replace(/[\\/]+$/, '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    suggestions.push({
      uri: vscode.Uri.file(target),
      label: suggestionLabel(target, kind, workspaceFile),
      mtimeMs
    });
  };

  for (const root of roots) {
    // fișierele .code-workspace (numele lor e deja o „categorie" bună)
    if (root === home) {
      for (const file of await listWorkspaceFiles(root)) {
        try {
          const st = await fs.promises.stat(file);
          push(file, 'workspace', st.mtimeMs, true);
        } catch {
          /* ignorăm */
        }
      }
    }
    for (const dir of await listSubDirectories(root)) {
      if (scanned++ > MAX_DIRS_SCANNED) break;
      const marker = await detectMarker(dir);
      if (marker) push(dir, marker.kind, marker.mtimeMs);
    }
  }

  suggestions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  logLine(
    'chat',
    'project suggestions: ' + suggestions.length + ' found in Home/Desktop/Documents'
  );
  return suggestions.slice(0, MAX_SUGGESTIONS);
}

/**
 * Alegerea folderului: întâi quick pick-ul cu proiectele recente (codiconi în
 * etichete, ca în meniurile VS Code), apoi „Choose another folder..." →
 * dialogul nativ VS Code. Esc / închidere = anulare.
 */
export async function pickProjectFolder(): Promise<FolderPickResult> {
  const suggestions = await findProjectSuggestions().catch(() => []);
  if (!suggestions.length) return { kind: 'browse' };

  const browseItem: vscode.QuickPickItem = {
    label: '$(folder-opened) Choose another folder...',
    alwaysShow: true
  };
  const items: vscode.QuickPickItem[] = [
    { label: 'Projects found recently:', kind: vscode.QuickPickItemKind.Separator },
    ...suggestions.map((s) => ({ label: s.label })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    browseItem
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Freekit: open a project folder',
    placeHolder: 'Pick a recent project, or choose another folder',
    ignoreFocusOut: true
  });
  if (!pick) return { kind: 'cancelled' };
  if (pick === browseItem || pick.label === browseItem.label) return { kind: 'browse' };
  const match = suggestions.find((s) => s.label === pick.label);
  if (!match) return { kind: 'browse' };
  return { kind: 'picked', uri: match.uri };
}
