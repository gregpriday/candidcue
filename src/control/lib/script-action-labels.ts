/**
 * What the per-script commands are called in the window's own menus: the
 * editor's Script actions menu, and the Library row's ⋯ and right-click menus.
 *
 * One definition because the same command reached four ways has to have one
 * name. The editor's menu had drifted to "Reveal data folder" and an
 * "Export Markdown" without its ellipsis while the Library and the File menu
 * said "Reveal in Finder" and "Export Markdown…", and nobody opens both menus
 * to notice. The native File menu (`src-tauri/src/menu.rs`) is the contract:
 * macOS title case, an ellipsis on a command that asks for more before it acts
 * (a save panel, the revision browser), none on one that acts or only
 * confirms, and the platform's own name for revealing a file.
 *
 * Contextual menus drop the File menu's "Script" noun ("Duplicate", not
 * "Duplicate Script"): the menu's name already says which script it is about.
 */
export interface ScriptActionLabels {
  duplicate: string;
  revisionHistory: string;
  exportMarkdown: string;
  reveal: string;
  moveToTrash: string;
  restore: string;
  deletePermanently: string;
}

export function scriptActionLabels(isMac: boolean): ScriptActionLabels {
  return {
    duplicate: 'Duplicate',
    revisionHistory: 'Revision History…',
    exportMarkdown: 'Export Markdown…',
    reveal: isMac ? 'Reveal in Finder' : 'Show in File Explorer',
    moveToTrash: 'Move to Trash',
    restore: 'Restore',
    deletePermanently: 'Delete Permanently',
  };
}
