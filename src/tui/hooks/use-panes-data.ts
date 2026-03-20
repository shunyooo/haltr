import { useState, useEffect } from "react";
import { readFileSync, existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import type { PaneEntry } from "../../lib/panes-manager.js";

interface PanesFile {
  panes: PaneEntry[];
}

export function loadPanes(epicDir: string): PaneEntry[] {
  const panesPath = join(epicDir, ".panes.yaml");
  if (!existsSync(panesPath)) return [];
  const raw = readFileSync(panesPath, "utf-8");
  const data = yaml.load(raw) as PanesFile | null;
  return data?.panes ?? [];
}

export function usePanesData(epicDir: string): PaneEntry[] {
  const [panes, setPanes] = useState<PaneEntry[]>(() => loadPanes(epicDir));

  useEffect(() => {
    setPanes(loadPanes(epicDir));
    const panesPath = join(epicDir, ".panes.yaml");
    let watcher: FSWatcher;
    try {
      watcher = watch(panesPath, () => {
        setPanes(loadPanes(epicDir));
      });
    } catch {
      return;
    }
    return () => watcher.close();
  }, [epicDir]);

  return panes;
}
