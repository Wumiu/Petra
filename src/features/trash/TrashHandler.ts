import { invoke } from "@tauri-apps/api/core";
import type { Window } from "@tauri-apps/api/window";
import type { PetView } from "../../live2d/PetDriver";
import { toast } from "../../ui/Toast";

/**
 * 垃圾桶功效 + PSD 导入分流：
 * 拖 .psd 给桌宠 = 导入新模型；拖其他文件 = 进回收站（可撤销）。
 * 走 Tauri 原生 drag-drop 事件拿真实路径；系统关键路径在 Rust 侧拦截。
 * getView 为视图获取器（模型热切换后仍指向当前实例）。
 */
export function setupTrashDrop(
  getView: () => PetView,
  win: Window,
  onImportPsd?: (path: string) => void,
) {
  win.onDragDropEvent((event) => {
    switch (event.payload.type) {
      case "over":
        getView().playClick();
        break;
      case "drop": {
        const paths = event.payload.paths;
        if (!paths.length) return;
        const psd = paths.find((p) => p.toLowerCase().endsWith(".psd"));
        if (psd && onImportPsd) {
          onImportPsd(psd);
          return;
        }
        getView().playGobble();
        handleTrash(paths, getView());
        break;
      }
    }
  });
}

async function handleTrash(paths: string[], view: PetView) {
  try {
    const res = await invoke<{ ok: boolean; count: number }>("trash_files", { paths });
    if (res.ok) {
      toast(res.count > 1 ? `咕咚咕咚，吃了 ${res.count} 个文件 → 回收站` : "咕咚，送进回收站了");
    }
  } catch (err) {
    view.playClick();
    toast(String(err), "warn");
  }
}