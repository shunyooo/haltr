import { useState, useEffect } from "react";
import { readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import type { TaskYaml } from "../../types.js";

export function loadTasks(epicDir: string): TaskYaml[] {
  const entries = readdirSync(epicDir)
    .filter((f) => f.endsWith("_task.yaml"))
    .sort();
  return entries.map((f) => {
    const raw = readFileSync(join(epicDir, f), "utf-8");
    return yaml.load(raw) as TaskYaml;
  });
}

export function useTaskData(epicDir: string): TaskYaml[] {
  const [tasks, setTasks] = useState<TaskYaml[]>(() => loadTasks(epicDir));

  useEffect(() => {
    setTasks(loadTasks(epicDir));
    let watcher: FSWatcher;
    try {
      watcher = watch(epicDir, (_eventType, filename) => {
        if (filename?.endsWith("_task.yaml")) {
          setTasks(loadTasks(epicDir));
        }
      });
    } catch {
      return;
    }
    return () => watcher.close();
  }, [epicDir]);

  return tasks;
}
